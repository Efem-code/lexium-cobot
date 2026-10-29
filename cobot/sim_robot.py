"""Virtual Lexium Cobot: state machine + motion generator running at 100 Hz.

This is the "PC as a simulated controller". It behaves like the real arm
closely enough that the same client code can drive either:
  * power / enable sequence, e-stop, protective stop, control source
  * continuous joint jog and Cartesian jog (base or tool frame)
  * joint moves (PTP), linear moves (MoveL) with trapezoidal profiles
  * soft joint limits, speed override (rapid rate), digital/analog I/O
"""
import math
import random
import threading
import time

from . import kinematics as K

TICK = 0.01  # 100 Hz


class Trapezoid:
    """1-D trapezoidal profile over distance D (>=0)."""

    def __init__(self, D, vmax, amax):
        self.D = D
        vmax = max(vmax, 1e-6)
        amax = max(amax, 1e-6)
        ta = vmax / amax
        da = 0.5 * amax * ta * ta
        if 2 * da > D:  # triangular
            ta = math.sqrt(D / amax)
            vmax = amax * ta
            da = D / 2
        self.v, self.a, self.ta = vmax, amax, ta
        self.tc = (D - 2 * da) / vmax if vmax > 0 else 0
        self.T = 2 * ta + self.tc

    def s(self, t):
        if self.D <= 0 or t >= self.T:
            return 1.0
        if t < self.ta:
            d = 0.5 * self.a * t * t
        elif t < self.ta + self.tc:
            d = 0.5 * self.a * self.ta ** 2 + self.v * (t - self.ta)
        else:
            tr = self.T - t
            d = self.D - 0.5 * self.a * tr * tr
        return d / self.D


class SimRobot:
    def __init__(self, model="LXMRL03"):
        self.arm = K.Arm(model)
        self.lock = threading.RLock()
        self.q = list(K.HOME)
        self.qd = [0.0] * 6
        self.tcp = self.arm.fk(self.q)
        self.tcp_speed = [0.0] * 6
        self.powered = False
        self.enabled = False
        self.estop = False
        self.protective_stop = False
        self.on_soft_limit = False
        self.control_source = "remote"  # remote | local  (Cobot Expert "Remote Control")
        self.rapid_rate = 1.0
        self.errcode = 0
        self.errmsg = ""
        self.din = [0] * 128
        self.dout = [0] * 128
        self.ain = [0.0] * 64
        self.aout = [0.0] * 64
        self.motion = None     # active motion dict
        self.jog = None        # active jog dict
        self.last_cmd_id = 0
        self.log = []          # recent events for the UI
        self._stop = False
        self._t0 = time.time()
        self.cab_temp = 32.0
        self.joint_temp = [30.0] * 6
        # controller configuration (what Cobot Expert's setup pages edit)
        self.payload = dict(mass=1.0, centroid=[0.0, 0.0, 90.0])
        self.tool_offsets = [[0.0] * 6 for _ in range(11)]   # slot 0 = flange
        self.tool_id = 0
        self.user_offsets = [[0.0] * 6 for _ in range(11)]   # slot 0 = base
        self.user_id = 0
        self.clsn_level = 3
        # a stored program is faked as N lines that tick by once a second (no motion)
        self.program = dict(name="", state="idle", line=0, t=0.0, lines=10)

    # ------------------------------------------------------------ helpers
    def _event(self, msg):
        self.log.append((time.time(), msg))
        del self.log[:-50]

    def _fault(self, code, msg):
        self.errcode, self.errmsg = code, msg
        self.motion = None
        self.jog = None
        self.qd = [0.0] * 6
        self._event(f"ERROR {code}: {msg}")

    def _ready(self, need_remote=True):
        if self.estop:
            return "emergency stop active"
        if not self.powered:
            return "robot not powered on"
        if not self.enabled:
            return "robot not enabled"
        if self.protective_stop:
            return "protective stop active - clear error first"
        if self.errcode:
            return f"error {self.errcode} active - clear error first"
        if need_remote and self.control_source != "remote":
            return "control source is not Remote"
        return None

    # ------------------------------------------------------------ commands
    def power_on(self):
        with self.lock:
            if self.estop:
                return "emergency stop active"
            self.powered = True
            self._event("power on")

    def power_off(self):
        with self.lock:
            self.powered = self.enabled = False
            self.motion = self.jog = None
            self.qd = [0.0] * 6
            self._event("power off")

    def enable(self):
        with self.lock:
            if self.estop:
                return "emergency stop active"
            if not self.powered:
                return "robot not powered on"
            self.enabled = True
            self._event("robot enabled")

    def disable(self):
        with self.lock:
            self.enabled = False
            self.motion = self.jog = None
            self.qd = [0.0] * 6
            self._event("robot disabled")

    def set_estop(self, on):
        with self.lock:
            self.estop = bool(on)
            if on:
                self.enabled = False
                self.powered = False
                self.motion = self.jog = None
                self.qd = [0.0] * 6
                self._event("EMERGENCY STOP pressed")
            else:
                self._event("emergency stop released")

    def set_protective_stop(self, on=True):
        with self.lock:
            self.protective_stop = bool(on)
            if on:
                self.motion = self.jog = None
                self.qd = [0.0] * 6
                self._event("protective stop (simulated collision)")

    def clear_error(self):
        with self.lock:
            self.errcode, self.errmsg = 0, ""
            self.protective_stop = False
            self.on_soft_limit = False
            self._event("errors cleared")

    def set_rapid_rate(self, r):
        with self.lock:
            self.rapid_rate = max(0.01, min(1.0, float(r)))

    def set_control_source(self, src):
        with self.lock:
            self.control_source = "remote" if src == "remote" else "local"
            self._event(f"control source -> {self.control_source}")

    def set_model(self, model):
        with self.lock:
            self.motion = self.jog = None
            self.arm.set_model(model)
            self._event(f"model -> {model}")

    def stop(self):
        with self.lock:
            self.motion = None
            self.jog = None
            self.qd = [0.0] * 6
            if self.program["state"] != "idle":
                self.program.update(state="idle", line=0)

    def jog_joint(self, j, vel):
        """Continuous joint jog. j 0..5, vel deg/s (signed). vel=0 stops."""
        with self.lock:
            if vel == 0:
                self.jog = None
                return
            err = self._ready()
            if err:
                return err
            self.motion = None
            self.jog = dict(kind="joint", axis=j, vel=float(vel), last=time.time())

    def jog_cart(self, axis, vel, frame="base"):
        """Continuous Cartesian jog. axis 0..5 (X,Y,Z,RX,RY,RZ), vel mm/s or deg/s."""
        with self.lock:
            if vel == 0:
                self.jog = None
                return
            err = self._ready()
            if err:
                return err
            self.motion = None
            self.jog = dict(kind="cart", axis=axis, vel=float(vel), frame=frame, last=time.time())

    def jog_increment(self, coord, axis, step, vel):
        """Single incremental jog step (JAKA jog_mode=2)."""
        with self.lock:
            if coord == "joint":
                tgt = list(self.q)
                tgt[axis] += step
                return self.move_joint(tgt, abs(vel) or 20, 200)
            pose = list(self.tcp)
            if coord == "tool":
                T = self.arm.pose_to_T(pose)
                if axis < 3:
                    for i in range(3):
                        pose[i] += T[i][axis] * step
                    return self.move_linear(pose, abs(vel) or 50, 500)
            pose[axis] += step
            return self.move_linear(pose, abs(vel) or 50, 500)

    def move_joint(self, target, speed=30.0, accel=100.0, rel=False, cmd_id=0):
        with self.lock:
            err = self._ready()
            if err:
                return err
            tgt = [self.q[i] + target[i] for i in range(6)] if rel else list(map(float, target))
            if not K.within_limits(tgt):
                return "target outside joint limits"
            D = max(abs(tgt[i] - self.q[i]) for i in range(6))
            vmax = min(speed, self.arm.profile["vmax"])
            self.jog = None
            self.motion = dict(kind="joint", start=list(self.q), target=tgt,
                               prof=Trapezoid(D, vmax, accel), t=0.0, id=cmd_id)
            self.last_cmd_id = cmd_id
            self._event(f"MoveJ -> {[round(v, 1) for v in tgt]}")

    def move_to_pose_joint(self, pose, speed=30.0, accel=100.0, cmd_id=0):
        """Point-to-point (joint interpolated) to a Cartesian pose (JAKA end_move)."""
        with self.lock:
            try:
                q = self.arm.ik(pose, self.q)
            except ValueError as e:
                return str(e)
            return self.move_joint(q, speed, accel, cmd_id=cmd_id)

    def move_linear(self, pose, speed=100.0, accel=500.0, rel=False, cmd_id=0):
        with self.lock:
            err = self._ready()
            if err:
                return err
            start = list(self.tcp)
            tgt = [start[i] + pose[i] for i in range(6)] if rel else list(map(float, pose))
            T0 = self.arm.pose_to_T(start)
            T1 = self.arm.pose_to_T(tgt)
            R0 = [r[:3] for r in T0[:3]]
            R1 = [r[:3] for r in T1[:3]]
            dR = K.mat_mul(R1, K.transpose(R0))
            rotvec = K.rot_to_axis_angle(dR)
            lin = math.dist(start[:3], tgt[:3])
            ang = math.sqrt(sum(x * x for x in rotvec)) * K.R2D
            # orientation-only moves use 1 deg == 2 mm of "path"
            D = max(lin, ang * 2.0)
            # check the end point is reachable before moving
            try:
                self.arm.ik(tgt, self.q)
            except ValueError as e:
                return str(e)
            self.jog = None
            self.motion = dict(kind="linear", p0=start[:3], p1=tgt[:3], R0=R0, rotvec=rotvec,
                               prof=Trapezoid(D, speed, accel), t=0.0, id=cmd_id)
            self.last_cmd_id = cmd_id
            self._event(f"MoveL -> {[round(v, 1) for v in tgt]}")

    def set_tool_offset(self, off, slot=None):
        with self.lock:
            slot = self.tool_id if slot is None else int(slot)
            if not 0 <= slot <= 10:
                return "tool id must be 0..10"
            self.tool_offsets[slot] = list(map(float, off))
            if slot == self.tool_id:
                self.arm.tool = list(self.tool_offsets[slot])

    def set_tool_id(self, slot):
        with self.lock:
            if not 0 <= int(slot) <= 10:
                return "tool id must be 0..10"
            self.tool_id = int(slot)
            self.arm.tool = list(self.tool_offsets[self.tool_id])
            self._event(f"tool -> {self.tool_id}")

    def set_user_offset(self, off, slot):
        with self.lock:
            if not 0 <= int(slot) <= 10:
                return "user frame id must be 0..10"
            self.user_offsets[int(slot)] = list(map(float, off))

    def set_user_id(self, slot):
        with self.lock:
            if not 0 <= int(slot) <= 10:
                return "user frame id must be 0..10"
            self.user_id = int(slot)

    def set_payload(self, mass, centroid):
        with self.lock:
            if not 0 <= float(mass) <= self.arm.profile["payload"]:
                return f"mass must be 0..{self.arm.profile['payload']} kg"
            self.payload = dict(mass=float(mass), centroid=list(map(float, centroid)))
            self._event(f"payload -> {self.payload['mass']} kg")

    # ------------------------------------------------------------ stored programs
    def load_program(self, name):
        with self.lock:
            if self.program["state"] != "idle":
                return "a program is running"
            if not name:
                return "program name is empty"
            self.program.update(name=str(name), line=0, t=0.0)
            self._event(f"loaded program {name}")

    def play_program(self):
        with self.lock:
            err = self._ready()
            if err:
                return err
            if not self.program["name"]:
                return "no program loaded"
            if self.program["state"] != "idle":
                return "a program is already running"
            self.program.update(state="running", line=1, t=0.0)
            self._event(f"run {self.program['name']}")

    def pause_program(self):
        with self.lock:
            if self.program["state"] == "running":
                self.program["state"] = "paused"

    def resume_program(self):
        with self.lock:
            if self.program["state"] != "paused":
                return "program is not paused"
            self.program["state"] = "running"

    def set_dout(self, idx, val):
        with self.lock:
            self.dout[idx] = 1 if val else 0

    def set_din(self, idx, val):
        with self.lock:
            self.din[idx] = 1 if val else 0

    # ------------------------------------------------------------ loop
    def start(self):
        threading.Thread(target=self._run, daemon=True, name="sim-robot").start()

    def shutdown(self):
        self._stop = True

    def _run(self):
        nxt = time.perf_counter()
        while not self._stop:
            nxt += TICK
            try:
                self.step(TICK)
            except Exception as e:  # never let the sim thread die
                self._fault(9999, f"sim internal error: {e}")
            delay = nxt - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            else:
                nxt = time.perf_counter()

    def step(self, dt):
        with self.lock:
            prev_q = list(self.q)
            prev_tcp = list(self.tcp)
            sdt = dt * self.rapid_rate  # speed override scales time
            pg = self.program
            if pg["state"] == "running":
                pg["t"] += sdt
                pg["line"] = 1 + int(pg["t"])
                if pg["line"] > pg["lines"]:
                    pg.update(state="idle", line=0)
                    self._event(f"program {pg['name']} finished")
            if self.motion:
                self._step_motion(sdt)
            elif self.jog:
                self._step_jog(dt)
            # limit check
            for i, (lo, hi) in enumerate(K.JOINT_LIMITS):
                if self.q[i] < lo or self.q[i] > hi:
                    self.q[i] = min(hi, max(lo, self.q[i]))
                    self.on_soft_limit = True
                    self.motion = self.jog = None
                    self._event(f"J{i+1} reached soft limit")
            self.tcp = self.arm.fk(self.q)
            self.qd = [(self.q[i] - prev_q[i]) / dt for i in range(6)]
            sp = [(self.tcp[i] - prev_tcp[i]) / dt for i in range(3)]
            sr = [((self.tcp[i] - prev_tcp[i] + 180) % 360 - 180) / dt for i in range(3, 6)]
            self.tcp_speed = sp + sr
            # thermal toy model
            for i in range(6):
                target = 30 + (8 if self.enabled else 0) + abs(self.qd[i]) * 0.05
                self.joint_temp[i] += (target - self.joint_temp[i]) * 0.0005
            self.cab_temp += ((35 if self.powered else 30) - self.cab_temp) * 0.0005

    def _step_motion(self, dt):
        m = self.motion
        m["t"] += dt
        s = m["prof"].s(m["t"])
        if m["kind"] == "joint":
            self.q = [m["start"][i] + (m["target"][i] - m["start"][i]) * s for i in range(6)]
        else:
            p = [m["p0"][i] + (m["p1"][i] - m["p0"][i]) * s for i in range(3)]
            Rs = K.mat_mul(K.axis_angle_to_R([v * s for v in m["rotvec"]]), m["R0"])
            rx, ry, rz = K.R_to_rpy(Rs)
            pose = p + [rx * K.R2D, ry * K.R2D, rz * K.R2D]
            try:
                q = self.arm.ik(pose, self.q, iters=30)
            except ValueError:
                self._fault(1101, "MoveL path not reachable (singularity)")
                return
            # joint speed sanity -- real controller faults on this too
            if max(abs(q[i] - self.q[i]) for i in range(6)) / dt > 400:
                self._fault(1102, "MoveL joint speed too high near singularity")
                return
            self.q = q
        if s >= 1.0:
            self.motion = None
            self._event("motion done (in position)")

    def _step_jog(self, dt):
        j = self.jog
        if j["kind"] == "joint":
            v = max(-self.arm.profile["vmax"], min(self.arm.profile["vmax"], j["vel"]))
            self.q[j["axis"]] += v * self.rapid_rate * dt
            return
        # Cartesian jog: desired twist -> joint rates through DLS jacobian
        twist = [0.0] * 6
        vel = j["vel"] * self.rapid_rate
        if j["axis"] < 3:
            twist[j["axis"]] = vel  # mm/s
        else:
            twist[j["axis"]] = vel * K.D2R  # rad/s
        if j["frame"] == "tool":
            T = self.arm.fk_T(self.q)
            R = [r[:3] for r in T[:3]]
            lin = [sum(R[i][k] * twist[k] for k in range(3)) for i in range(3)]
            ang = [sum(R[i][k] * twist[3 + k] for k in range(3)) for i in range(3)]
            twist = lin + ang
        J = self.arm.jacobian(self.q)
        JT = K.transpose(J)
        A = K.mat_mul(J, JT)
        for i in range(6):
            A[i][i] += 1.0
        try:
            y = K.solve(A, twist)
        except ValueError:
            self.jog = None
            return
        qdot = [sum(JT[i][k] * y[k] for k in range(6)) * K.R2D for i in range(6)]
        if max(abs(v) for v in qdot) > self.arm.profile["vmax"]:
            self._fault(1103, "Cartesian jog near singularity - jog joints instead")
            return
        self.q = [self.q[i] + qdot[i] * dt for i in range(6)]

    # ------------------------------------------------------------ snapshot
    def snapshot(self):
        with self.lock:
            moving = self.motion is not None or self.jog is not None
            return dict(
                model=self.arm.model,
                joints=list(self.q),
                joint_speed=list(self.qd),
                tcp=list(self.tcp),
                tcp_speed=list(self.tcp_speed),
                powered=self.powered,
                enabled=self.enabled,
                estop=self.estop,
                protective_stop=self.protective_stop,
                on_soft_limit=self.on_soft_limit,
                inpos=not moving,
                motion_mode=0 if self.jog else (4 if self.motion else 0),
                rapid_rate=self.rapid_rate,
                errcode=self.errcode,
                errmsg=self.errmsg,
                control_source=self.control_source,
                din=list(self.din),
                dout=list(self.dout),
                ain=list(self.ain),
                aout=list(self.aout),
                tool=list(self.arm.tool),
                joint_temp=list(self.joint_temp),
                cab_temp=self.cab_temp,
                cmd_id=self.last_cmd_id,
                log=[m for _, m in self.log[-10:]],
            )

    def modbus_values(self):
        """Values for the Lexium Modbus input-register block 300..479."""
        s = self.snapshot()
        v = dict(servo_version=10700, serial_no=20260001,
                 protective_stop=int(s["protective_stop"]), emergency_stop=int(s["estop"]),
                 power_on=int(s["powered"]), robot_enable=int(s["enabled"]),
                 on_soft_limit=int(s["on_soft_limit"]), inpos=int(s["inpos"]),
                 motion_mode=s["motion_mode"], reduction_level=0,
                 speed_ratio=s["rapid_rate"] * 100.0, motion_errcode=s["errcode"],
                 cab_temperature=s["cab_temp"], cab_avg_power=(120.0 if s["enabled"] else 25.0),
                 cab_avg_current=(2.5 if s["enabled"] else 0.4))
        for i in range(6):
            n = f"j{i+1}"
            v[f"{n}_voltage"] = 48 if s["powered"] else 0
            v[f"{n}_temperature"] = round(s["joint_temp"][i])
            v[f"{n}_enabled"] = int(s["enabled"])
            v[f"{n}_position"] = s["joints"][i]
            v[f"{n}_speed"] = s["joint_speed"][i]
            v[f"{n}_current"] = (0.6 + abs(s["joint_speed"][i]) * 0.01 +
                                 random.uniform(-0.02, 0.02)) if s["enabled"] else 0.0
        for i, n in enumerate(["x", "y", "z", "rx", "ry", "rz"]):
            v[f"tcp_{n}"] = s["tcp"][i]
            v[f"tcp_speed_{n}"] = s["tcp_speed"][i]
            v[f"tcp_offset_{n}"] = s["tool"][i]
        return v
