"""Program the Lexium Cobot from Python.

    from cobot.sdk import Robot

    robot = Robot.simulator()              # built-in simulator: no hardware, no app
    robot = Robot.bridge()                 # through the running app (PC or iPad): the 3D view
                                           #   shows every move and the bridge limits apply
    robot = Robot.connect("10.5.5.100")    # straight to the real cobot (read-only until arm())

    robot.power_on(); robot.enable()
    robot.speed(20)                        # percent
    robot.move_joint([0, 90, -90, 90, 90, 0])
    robot.move_linear(z=250)               # keep x, y and orientation; change z
    robot.move_linear([0, 0, -50, 0, 0, 0], relative=True)
    robot.set_do(3, True)
    robot.wait_di(5, True, timeout=10)

Every move waits until the arm has stopped (wait=False to return straight away) and
raises CobotError if the controller refuses it, a bridge limit blocks it, or the arm
stops on an E-stop, protective stop or error. Units: mm and degrees.
"""
import http.cookiejar
import json
import socket
import time
import urllib.request

from . import kinematics as K
from .driver import CobotDriver

AXES = ("x", "y", "z", "rx", "ry", "rz")


class CobotError(RuntimeError):
    """The controller or the bridge refused a command, or the arm stopped on a fault."""


def _ok(r):
    return r.get("errorCode") in ("0", 0, None)


# ------------------------------------------------------------------ backends
class _DriverBackend:
    """In-process: this Python process talks to the controller (or simulator) itself."""

    def __init__(self, driver, owns=()):
        self.d, self._owns = driver, list(owns)

    def cmd(self, name, /, **f):
        try:
            return self.d.command(name, **f)
        except PermissionError as e:
            return {"errorCode": "403", "errorMsg": str(e)}

    def state(self):
        return self.d.status()

    def arm(self, on):
        self.d.motion_armed = bool(on)

    def limits(self, **kw):
        return self.d.set_limits(**kw) if kw else dict(self.d.limits)

    def stop(self):
        try:
            return self.d.stop_all()
        except PermissionError as e:
            return {"errorCode": "403", "errorMsg": str(e)}

    def close(self):
        self.d.disconnect()
        for o in self._owns:
            o.stop()


class _HttpBackend:
    """Through a running bridge (run.py / ipad.py / the installed app)."""

    def __init__(self, url, pin=None, timeout=10):
        self.url = url.rstrip("/")
        self.timeout = timeout
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        if pin:
            r = self._req("/api/login", {"pin": str(pin)})
            if not r.get("ok"):
                raise CobotError(r.get("error") or "bridge login failed")

    def _req(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, headers={"Content-Type": "application/json"})
        try:
            with self.op.open(req, timeout=self.timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise CobotError("the bridge wants its PIN: Robot.bridge(url, pin=...)") from None
            raise CobotError(f"bridge error {e.code}") from None
        except OSError as e:
            raise CobotError(f"bridge not reachable at {self.url}: {e}") from None

    def cmd(self, name, /, **f):
        return self._req("/api/cmd", dict(f, cmdName=name))

    def state(self):
        return self._req("/api/state")

    def arm(self, on):
        self._req("/api/arm", {"armed": bool(on)})

    def limits(self, **kw):
        return self._req("/api/limits", kw)["limits"] if kw else self.state().get("limits", {})

    def stop(self):
        return self._req("/api/stop", {})

    def close(self):
        pass


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ------------------------------------------------------------------ robot
class Robot:
    def __init__(self, backend, model="LXMRL03"):
        self._b = backend
        self.arm_model = K.Arm(model)
        self.default_joint_speed = 30.0    # deg/s
        self.default_linear_speed = 100.0  # mm/s

    # ---------- constructors
    @classmethod
    def simulator(cls, model="LXMRL03", powered=False):
        """Start a private simulator in this process (nothing else needed)."""
        from .sim_server import VirtualController
        mb, cp, sp = _free_port(), _free_port(), _free_port()
        vc = VirtualController("127.0.0.1", mb, cp, sp, model).start()
        time.sleep(0.2)
        d = CobotDriver()
        d.connect("127.0.0.1", "sim", mb, cp, sp, model)
        r = cls(_DriverBackend(d, owns=[vc]), model)
        r._wait_for_state()
        if powered:
            r.power_on()
            r.enable()
        return r

    @classmethod
    def bridge(cls, url="http://127.0.0.1:8765", pin=None):
        """Use the running app. Its 3D view, speed slider and limits all apply."""
        r = cls(_HttpBackend(url, pin))
        st = r.state
        if st.get("model"):
            r.arm_model.set_model(st["model"])
        return r

    @classmethod
    def connect(cls, host="10.5.5.100", model="LXMRL03"):
        """Talk to the real cobot directly. Read-only until robot.arm()."""
        d = CobotDriver()
        d.connect(host, "real", model=model)
        r = cls(_DriverBackend(d), model)
        try:
            r._wait_for_state(15, f" at {host}: is this computer on the cobot's Wi-Fi, and the cobot on?")
        except CobotError:
            d.disconnect()
            raise
        return r

    def close(self):
        self._b.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, *_):
        if exc_type is not None:
            try:
                self.stop()
            except Exception:
                pass
        self.close()

    # ---------- state
    @property
    def state(self):
        return self._b.state()

    @property
    def joints(self):
        return list(self.state["joints"])

    @property
    def pose(self):
        """TCP pose [x, y, z, rx, ry, rz] (mm, deg) as the controller reports it."""
        return list(self.state["tcp"])

    def _wait_for_state(self, timeout=8, hint=""):
        t = time.time()
        while time.time() - t < timeout:
            if self.state.get("joints"):
                return
            time.sleep(0.1)
        raise CobotError("no data from the controller" + hint)

    def _model(self):
        """Our kinematic model with the controller's active tool, so fk/ik match its TCP."""
        tool = self.state.get("tool")
        if tool:
            self.arm_model.tool = [float(v) for v in tool]
        return self.arm_model

    def fk(self, joints):
        return self._model().fk(joints)

    def ik(self, pose, seed=None):
        return self._model().ik(pose, seed or self.joints)

    # ---------- low level
    def command(self, name, /, **fields):
        """Send any controller command; raises CobotError if refused."""
        r = self._b.cmd(name, **fields)
        if not _ok(r):
            raise CobotError(f"{name}: {r.get('errorMsg') or r.get('errorCode')}")
        return r

    def arm(self, on=True):
        """Real cobot only: allow motion and setting changes (the app's 'Arm motion')."""
        self._b.arm(on)

    def limits(self, **kw):
        """Read, or change (z_min=..., joint_speed_max=..., linear_speed_max=...), the bridge limits."""
        return self._b.limits(**kw)

    # ---------- power / state
    def power_on(self):
        self.command("power_on")

    def power_off(self):
        self.command("power_off")

    def enable(self):
        self.command("enable_robot")

    def disable(self):
        self.command("disable_robot")

    def clear_error(self):
        self.command("clear_error")

    def stop(self):
        """Stop any move, jog or program now."""
        self._b.stop()

    def speed(self, percent):
        """Overall speed limit in percent (on the real cobot the bridge applies it)."""
        self.command("set_rapidrate", rapid_rate=max(1, min(100, percent)) / 100.0)

    # ---------- motion
    def wait_until_stopped(self, timeout=120):
        time.sleep(0.15)  # let the controller report the move as started
        t, still = time.time(), 0
        while time.time() - t < timeout:
            st = self.state
            if st.get("estop"):
                raise CobotError("emergency stop")
            if st.get("protective_stop"):
                raise CobotError("protective stop (collision?)")
            if st.get("errcode"):
                raise CobotError(f"controller error {st.get('errcode')}: {st.get('errmsg') or ''}")
            still = still + 1 if st.get("inpos") else 0
            if still >= 2:
                return
            time.sleep(0.05)
        raise CobotError(f"move did not finish within {timeout} s")

    def move_joint(self, joints, speed=None, accel=100, relative=False, wait=True):
        """Joint move (all joints arrive together). joints in degrees."""
        self.command("joint_move", relFlag=int(relative), jointPosition=[float(v) for v in joints],
                     speed=float(speed or self.default_joint_speed), accel=float(accel))
        if wait:
            self.wait_until_stopped()

    def move_linear(self, pose=None, speed=None, accel=500, relative=False, wait=True, **axes):
        """Straight-line TCP move. Give a full pose [x, y, z, rx, ry, rz], or only the axes
        that change: robot.move_linear(z=200). With relative=True values are offsets."""
        if pose is None:
            base = [0.0] * 6 if relative else self.pose
            pose = [axes.get(a, base[i]) for i, a in enumerate(AXES)]
        elif axes:
            raise TypeError("give either a pose list or axis keywords, not both")
        self.command("moveL", relFlag=int(relative), cartPosition=[float(v) for v in pose],
                     speed=float(speed or self.default_linear_speed), accel=float(accel))
        if wait:
            self.wait_until_stopped()

    def move_pose(self, pose, speed=None, accel=100, wait=True):
        """Reach a TCP pose with a joint move (curved path, avoids straight-line singularities)."""
        self.move_joint(self.ik(pose), speed, accel, wait=wait)

    def home(self, speed=None):
        self.move_joint(K.HOME, speed)

    def sleep(self, seconds):
        time.sleep(seconds)

    # ---------- I/O
    def set_do(self, index, value=True):
        self.command("set_digital_output", type=0, index=int(index), value=int(bool(value)))

    def do(self, index):
        return bool((self.state.get("dout") or [0] * 16)[index])

    def di(self, index):
        return bool((self.state.get("din") or [0] * 16)[index])

    def wait_di(self, index, value=True, timeout=None):
        t = time.time()
        while self.di(index) != bool(value):
            if timeout is not None and time.time() - t > timeout:
                raise CobotError(f"DI{index} did not become {int(bool(value))} within {timeout} s")
            time.sleep(0.02)

    # ---------- setup
    def set_payload(self, mass, centroid=(0, 0, 0)):
        self.command("set_payload", mass=float(mass), centroid=[float(v) for v in centroid])

    def payload(self):
        r = self.command("get_payload")
        return r["mass"], r["centroid"]

    def set_tool(self, slot, offset):
        """Store a TCP offset [x, y, z, rx, ry, rz] in tool slot 1-10."""
        self.command("set_tool_offsets", id=int(slot), tooloffset=[float(v) for v in offset], name=f"tool{slot}")

    def use_tool(self, slot):
        self.command("set_tool_id", tool_id=int(slot))

    # ---------- programs stored on the controller
    def load_program(self, name):
        self.command("load_program", programName=name)

    def run_program(self, name=None, wait=False, timeout=None):
        if name:
            self.load_program(name)
        self.command("play_program")
        if wait:
            t = time.time()
            time.sleep(0.3)
            while self.program_state() != "idle":
                if timeout is not None and time.time() - t > timeout:
                    raise CobotError("program did not finish in time")
                time.sleep(0.2)

    def pause_program(self):
        self.command("pause_program")

    def resume_program(self):
        self.command("resume_program")

    def program_state(self):
        return self.command("get_program_state")["programState"]
