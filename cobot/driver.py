"""PC-side cobot driver: one API for the simulator and the real Lexium Cobot.

  state   <- Modbus TCP (Schneider's published register map, read-only, safe)
          <- JSON status stream on 10000 (optional, extra detail if present)
  command -> JSON commands on 10001 (JAKA-style protocol)

Safety rules built in:
  * Real hardware starts READ-ONLY. Motion must be explicitly armed.
  * Jog is hold-to-run: the UI must send a keepalive every ~100 ms; if it
    stops (mouse released, tab closed, network hiccup) the jog is stopped
    after JOG_TIMEOUT seconds.
"""
import json
import threading
import time

from . import kinematics as K
from . import regmap as RM
from .jaka_proto import JakaClient, JsonStream, detect_tls, open_socket
from .modbus import ModbusClient

JOG_TIMEOUT = 0.35
MOTION_CMDS = {"joint_move", "end_move", "moveL", "jog", "power_on", "enable_robot",
               "set_digital_output", "set_tool_offsets"}


class CobotDriver:
    def __init__(self):
        self.lock = threading.RLock()
        self.mode = None           # "sim" | "real" | None
        self.host = None
        self.tls = False
        self.ports = {}
        self.mb = None
        self.cmd = None
        self.arm = K.Arm("LXMRL03")
        self.state = {}
        self.extra = {}            # from status stream
        self.connected = False
        self.mb_ok = False
        self.cmd_ok = False
        self.stream_ok = False
        self.motion_armed = False
        self.last_error = ""
        self.jog_active = None
        self.jog_last = 0.0
        self._gen = 0              # connection generation; old threads exit
        self.history = []          # (t, joints) for plots

    # ----------------------------------------------------------- connection
    def connect(self, host, mode="sim", modbus_port=502, cmd_port=10001, status_port=10000,
                model=None, tls=None):
        """tls=None auto-detects: the real controller wraps the JSON ports in TLS."""
        self.disconnect()
        if tls is None:
            tls = mode == "real" and detect_tls(host, cmd_port)
        with self.lock:
            self._gen += 1
            gen = self._gen
            self.mode, self.host, self.tls = mode, host, tls
            self.ports = dict(modbus=modbus_port, cmd=cmd_port, status=status_port)
            self.mb = ModbusClient(host, modbus_port, timeout=1.5)
            self.cmd = JakaClient(host, cmd_port, timeout=2.0, tls=tls)
            self.motion_armed = (mode == "sim")
            self.connected = True
            self.last_error = ""
            if model:
                self.arm.set_model(model)
        threading.Thread(target=self._poll_modbus, args=(gen,), daemon=True).start()
        threading.Thread(target=self._poll_stream, args=(gen,), daemon=True).start()
        threading.Thread(target=self._jog_watchdog, args=(gen,), daemon=True).start()
        if mode == "sim" and model:
            try:
                self.command("sim_set_model", model=model)
            except Exception:
                pass
        return self.status()

    def disconnect(self):
        with self.lock:
            if self.jog_active and self.cmd:
                try:
                    self.cmd.send("jog", jog_mode=0)
                except Exception:
                    pass
            self._gen += 1
            self.connected = False
            self.mb_ok = self.cmd_ok = self.stream_ok = False
            self.jog_active = None
            for c in (self.mb, self.cmd):
                if c:
                    c.close()
            self.mb = self.cmd = None
            self.state, self.extra = {}, {}

    def set_model(self, model):
        self.arm.set_model(model)
        if self.mode == "sim":
            return self.command("sim_set_model", model=model)
        return {"errorCode": "0"}

    # ----------------------------------------------------------- pollers
    def _poll_modbus(self, gen):
        while gen == self._gen:
            try:
                words = self.mb.read_inputs(RM.ROBOT_DATA_START,
                                            RM.ROBOT_DATA_END - RM.ROBOT_DATA_START)
                vals = RM.parse_block(words)
                dout = self.mb.read_discrete(RM.DISCRETE_DO_BASE, 16)
                din = self.mb.read_coils(RM.COIL_DI_BASE, 16)
                vals["dout"], vals["din"] = dout, din
                with self.lock:
                    if gen != self._gen:
                        return
                    self.state = vals
                    self.mb_ok = True
                    j = [vals[f"j{i+1}_position"] for i in range(6)]
                    self.history.append((time.time(), j))
                    del self.history[:-600]
                time.sleep(0.05)
            except Exception as e:
                with self.lock:
                    self.mb_ok = False
                    self.state = {}
                    # Modbus is optional when the status stream already gives us the state
                    if not self.stream_ok:
                        self.last_error = f"Modbus: {e}"
                time.sleep(5.0 if self.stream_ok else 1.0)

    def _poll_stream(self, gen):
        while gen == self._gen:
            try:
                s = open_socket(self.host, self.ports["status"], 2, self.tls)
                js = JsonStream()
                last_hist = 0.0
                while gen == self._gen:
                    data = s.recv(65536)
                    if not data:
                        break
                    msgs = js.feed(data)
                    if msgs:
                        with self.lock:
                            self.extra = msgs[-1]
                            self.stream_ok = True
                            if self.last_error.startswith("Modbus"):
                                self.last_error = ""  # stream covers the state; Modbus is optional
                            j = self.extra.get("joint_position")
                            if not self.mb_ok and j and time.time() - last_hist > 0.05:
                                last_hist = time.time()
                                self.history.append((last_hist, j))
                                del self.history[:-600]
                s.close()
            except Exception:
                with self.lock:
                    self.stream_ok = False
                time.sleep(2.0)

    def _jog_watchdog(self, gen):
        while gen == self._gen:
            time.sleep(0.05)
            with self.lock:
                if self.jog_active and time.time() - self.jog_last > JOG_TIMEOUT:
                    self.jog_active = None
                    stop = True
                else:
                    stop = False
            if stop:
                try:
                    self.cmd.send("jog", jog_mode=0)
                except Exception as e:
                    self.last_error = f"jog stop failed: {e}"

    # ----------------------------------------------------------- commands
    def command(self, name, **fields):
        if not self.connected:
            raise RuntimeError("not connected")
        if self.mode == "real" and not self.motion_armed and name in MOTION_CMDS:
            raise PermissionError("Real cobot is READ-ONLY until motion is armed")
        if self.mode == "real" and name.startswith("sim_"):
            raise PermissionError("simulator-only command")
        try:
            r = self.cmd.send(name, **fields)
            self.cmd_ok = True
        except Exception as e:
            self.cmd_ok = False
            self.last_error = f"command port {self.ports.get('cmd')}: {e}"
            raise
        if r.get("errorCode") not in ("0", 0):
            self.last_error = f"{name}: {r.get('errorMsg')}"
        return r

    def jog_start(self, coord, axis, direction, speed):
        """coord: joint|base|tool ; axis 0..5 ; direction +1/-1 ; speed deg/s or mm/s"""
        cm = {"base": 0, "joint": 1, "tool": 2}[coord]
        r = self.command("jog", jog_mode=2, coord_map=cm, jnum=axis + 1,
                         jogvel=float(speed) * (1 if direction > 0 else -1))
        if r.get("errorCode") in ("0", 0):
            with self.lock:
                self.jog_active = (coord, axis, direction)
                self.jog_last = time.time()
        return r

    def jog_keepalive(self):
        with self.lock:
            self.jog_last = time.time()
            return bool(self.jog_active)

    def jog_stop(self):
        with self.lock:
            self.jog_active = None
        return self.command("jog", jog_mode=0)

    def stop_all(self):
        with self.lock:
            self.jog_active = None
        return self.command("stop_program")

    def ik(self, pose, seed):
        return self.arm.ik(pose, seed)

    # ----------------------------------------------------------- status
    def status(self):
        with self.lock:
            st = dict(self.state)
            ex = dict(self.extra)
            out = dict(connected=self.connected, mode=self.mode, host=self.host,
                       ports=self.ports, modbus_ok=self.mb_ok, cmd_ok=self.cmd_ok,
                       stream_ok=self.stream_ok, motion_armed=self.motion_armed,
                       last_error=self.last_error, jogging=bool(self.jog_active),
                       model=self.arm.model, model_name=self.arm.profile["name"],
                       tls=self.tls)
        if not st and ex.get("joint_position"):
            out.update(_state_from_stream(ex))
            try:
                out["points"] = self.arm.joint_points(out["joints"])
            except Exception:
                pass
        elif st:
            joints = [st[f"j{i+1}_position"] for i in range(6)]
            out.update(
                joints=joints,
                joint_speed=[st[f"j{i+1}_speed"] for i in range(6)],
                joint_current=[st[f"j{i+1}_current"] for i in range(6)],
                joint_temp=[st[f"j{i+1}_temperature"] for i in range(6)],
                joint_voltage=[st[f"j{i+1}_voltage"] for i in range(6)],
                tcp=[st[f"tcp_{n}"] for n in ("x", "y", "z", "rx", "ry", "rz")],
                tcp_speed=[st[f"tcp_speed_{n}"] for n in ("x", "y", "z", "rx", "ry", "rz")],
                powered=bool(st["power_on"]), enabled=bool(st["robot_enable"]),
                estop=bool(st["emergency_stop"]), protective_stop=bool(st["protective_stop"]),
                on_soft_limit=bool(st["on_soft_limit"]), inpos=bool(st["inpos"]),
                motion_mode=RM.MOTION_MODES.get(st["motion_mode"], str(st["motion_mode"])),
                speed_ratio=st["speed_ratio"], errcode=st["motion_errcode"],
                cab_temp=st["cab_temperature"], cab_power=st["cab_avg_power"],
                dout=st.get("dout", []), din=st.get("din", []),
                raw=st,
            )
            try:
                out["points"] = self.arm.joint_points(joints)
            except Exception:
                pass
        if ex:
            out["control_source"] = ex.get("control_source")
            out["errmsg"] = ex.get("errmsg", ex.get("error_msg"))
            out["log"] = ex.get("log", [])
            if ex.get("model") and ex.get("model") != out["model"] and self.mode == "sim":
                self.arm.set_model(ex["model"])
        return out


def _state_from_stream(ex):
    """Map the real controller's port-10000 JSON to the same keys the Modbus path produces.

    Field names were captured from a real Lexium Cobot (V1.7 firmware). The per-joint
    monitor layout [current, voltage, temperature, ...] follows the JAKA SDK and is
    unverified until the arm is powered on.
    """
    mon = ex.get("monitor_data") or []
    joints_mon = mon[5] if len(mon) > 5 and isinstance(mon[5], list) else []

    def jm(k):
        return [float(j[k]) if isinstance(j, list) and len(j) > k else 0.0
                for j in (joints_mon + [[]] * 6)[:6]]

    err = ex.get("error_code", "0x0")
    try:
        errcode = int(str(err), 0)
    except ValueError:
        errcode = 0
    tcp_speed = ex.get("tcp_speed", 0.0)
    return dict(
        joints=[float(v) for v in ex["joint_position"][:6]],
        tcp=[float(v) for v in ex.get("cartesian_position", [0.0] * 6)[:6]],
        joint_speed=[0.0] * 6,
        joint_current=jm(0), joint_voltage=jm(1), joint_temp=jm(2),
        tcp_speed=tcp_speed if isinstance(tcp_speed, list) else [float(tcp_speed)] + [0.0] * 5,
        powered=bool(ex.get("powered_on")), enabled=bool(ex.get("enabled")),
        estop=bool(ex.get("emergency_stop")),
        protective_stop=bool(ex.get("protective_stop") or ex.get("collision_stop")),
        on_soft_limit=bool(ex.get("on_soft_limit")), inpos=bool(ex.get("in_position")),
        motion_mode="drag" if ex.get("drag_status") else ("program" if ex.get("program_state") else "idle"),
        speed_ratio=float(ex.get("speed_rate", 1.0)) * 100,
        errcode=errcode,
        cab_temp=float(mon[2]) if len(mon) > 2 else 0.0,
        cab_power=float(mon[3]) if len(mon) > 3 else 0.0,
        dout=ex.get("dout", []), din=ex.get("din", []),
    )


def to_json(obj):
    return json.dumps(obj, default=str)
