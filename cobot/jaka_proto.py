"""JAKA-style TCP/IP JSON protocol (port 10001 commands, port 10000 status).

The Lexium Cobot is built on JAKA hardware and Schneider's
LexiumCobotCommunication library (Machine Expert, used on the TM262)
"establishes a TCP connection to a Lexium Cobot controller". This module
implements the JAKA remote protocol in both directions:

  * JakaServer -- runs inside the simulator (the virtual controller)
  * JakaClient -- used by the PC controller to command a sim OR real cobot

IMPORTANT: the command names/fields follow the JAKA TCP/IP protocol doc
(jaka.com/docs/en/guide/tcpip.html). Whether the Schneider-branded
firmware exposes this port unchanged must be verified on your controller
(see docs/REAL_HARDWARE.md). Motion against real hardware is therefore off
until you explicitly arm it.

Framing: each message is one JSON object, no delimiter. Readers split on
balanced braces, and also tolerate newline-delimited JSON.

Verified on a real Lexium Cobot (Oct 2026): ports 10000/10001/10004 speak
this protocol wrapped in TLS 1.3 with a self-signed "LXM_Cobot" cert.
Plain TCP connects but gets no data. The simulator stays plain TCP.
"""
import json
import socket
import socketserver
import ssl
import threading
import time

CMD_PORT = 10001
STATUS_PORT = 10000


def _tls_context():
    # The controller presents a self-signed cert, so there is nothing to verify against.
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def open_socket(host, port, timeout, tls=False):
    s = socket.create_connection((host, port), timeout=timeout)
    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    if tls:
        try:
            s = _tls_context().wrap_socket(s)
        except Exception:
            s.close()
            raise
    s.settimeout(timeout)
    return s


def detect_tls(host, port, timeout=2.0):
    """True if the port completes a TLS handshake (real Schneider controller)."""
    try:
        open_socket(host, port, timeout, tls=True).close()
        return True
    except (ssl.SSLError, OSError):
        return False


class JsonStream:
    """Splits a TCP byte stream into JSON objects by brace counting."""

    def __init__(self):
        self.buf = ""

    def feed(self, data):
        self.buf += data.decode("utf-8", "replace")
        out = []
        depth, start, in_str, esc = 0, None, False, False
        consumed = 0
        for i, ch in enumerate(self.buf):
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                if depth == 0:
                    start = i
                depth += 1
            elif ch == "}" and depth:
                depth -= 1
                if depth == 0:
                    try:
                        out.append(json.loads(self.buf[start:i + 1]))
                    except json.JSONDecodeError:
                        pass
                    consumed = i + 1
        self.buf = self.buf[start:] if depth else self.buf[consumed:].lstrip()
        if len(self.buf) > 1_000_000:  # garbage protection
            self.buf = ""
        return out


# =================================================================== server
def _ok(cmd, **extra):
    d = {"errorCode": "0", "errorMsg": "", "cmdName": cmd}
    d.update(extra)
    return d


def _err(cmd, msg, code="2"):
    return {"errorCode": code, "errorMsg": msg, "cmdName": cmd}


def handle_command(robot, msg):
    """Execute one JAKA JSON command against a SimRobot. Returns reply dict."""
    cmd = msg.get("cmdName", "")
    s = robot.snapshot
    try:
        if cmd == "power_on":
            e = robot.power_on()
        elif cmd == "power_off":
            e = robot.power_off()
        elif cmd == "enable_robot":
            e = robot.enable()
        elif cmd == "disable_robot":
            e = robot.disable()
        elif cmd in ("stop_program", "stop_motion", "motion_abort"):
            e = robot.stop()
        elif cmd == "clear_error":
            e = robot.clear_error()
        elif cmd == "set_rapidrate":
            e = robot.set_rapid_rate(float(msg.get("rapid_rate", 1.0)))
        elif cmd == "get_rapidrate":
            return _ok(cmd, rapid_rate=s()["rapid_rate"])
        elif cmd == "joint_move":
            e = robot.move_joint(msg["jointPosition"], float(msg.get("speed", 20)),
                                 float(msg.get("accel", 100)), rel=bool(msg.get("relFlag", 0)),
                                 cmd_id=int(msg.get("id", 0)))
        elif cmd == "end_move":
            e = robot.move_to_pose_joint(msg["endPosition"], float(msg.get("speed", 20)),
                                         float(msg.get("accel", 100)), cmd_id=int(msg.get("id", 0)))
        elif cmd == "moveL":
            e = robot.move_linear(msg["cartPosition"], float(msg.get("speed", 50)),
                                  float(msg.get("accel", 500)), rel=bool(msg.get("relFlag", 0)),
                                  cmd_id=int(msg.get("id", 0)))
        elif cmd == "jog":
            # jog_mode: 0 stop, 1 incremental (poscmd), 2 continuous (sign of jogvel)
            # coord_map: 0 base/world, 1 joint, 2 tool ; jnum: axis 1..6
            mode = int(msg.get("jog_mode", 0))
            coord = {0: "base", 1: "joint", 2: "tool"}.get(int(msg.get("coord_map", 1)), "joint")
            axis = int(msg.get("jnum", 1)) - 1
            vel = float(msg.get("jogvel", 0))
            if not 0 <= axis <= 5 and mode != 0:
                return _err(cmd, "jnum must be 1..6")
            if mode == 0:
                e = robot.stop()
            elif mode == 1:
                e = robot.jog_increment(coord, axis, float(msg.get("poscmd", 0)), vel)
            elif coord == "joint":
                e = robot.jog_joint(axis, vel)
            else:
                e = robot.jog_cart(axis, vel, coord)
        elif cmd == "get_joint_pos":
            return _ok(cmd, joint_pos=s()["joints"])
        elif cmd == "get_tcp_pos":
            return _ok(cmd, tcp_pos=s()["tcp"])
        elif cmd == "get_robot_state":
            st = s()
            return _ok(cmd, enable="robot_enabled" if st["enabled"] else "robot_disabled",
                       power="powered_on" if st["powered"] else "powered_off")
        elif cmd == "protective_stop_status":
            return _ok(cmd, protective_stop=int(s()["protective_stop"]))
        elif cmd == "set_digital_output":
            e = robot.set_dout(int(msg["index"]), int(msg["value"]))
        elif cmd == "get_digital_input_status":
            return _ok(cmd, din_status=s()["din"][:16])
        elif cmd == "set_tool_offsets":
            e = robot.set_tool_offset(msg["tooloffset"])
        elif cmd == "get_data":
            return _ok(cmd, **status_payload(robot))
        elif cmd == "quit":
            return _ok(cmd)
        # --- simulator-only commands (not on the real robot)
        elif cmd == "sim_estop":
            e = robot.set_estop(bool(msg.get("on", True)))
        elif cmd == "sim_protective_stop":
            e = robot.set_protective_stop(True)
        elif cmd == "sim_control_source":
            e = robot.set_control_source(msg.get("source", "remote"))
        elif cmd == "sim_set_model":
            e = robot.set_model(msg["model"])
        elif cmd == "sim_set_din":
            e = robot.set_din(int(msg["index"]), int(msg["value"]))
        else:
            return _err(cmd, f"unknown command '{cmd}'", "1")
    except (KeyError, ValueError, TypeError, IndexError) as ex:
        return _err(cmd, f"bad parameters: {ex}", "1")
    return _err(cmd, e) if e else _ok(cmd)


def status_payload(robot):
    st = robot.snapshot()
    return {
        "joint_actual_position": st["joints"],
        "actual_position": st["tcp"],
        "joint_actual_speed": st["joint_speed"],
        "tcp_speed": st["tcp_speed"],
        "powered_on": int(st["powered"]),
        "enabled": st["enabled"],
        "emergency_stop": int(st["estop"]),
        "protective_stop": int(st["protective_stop"]),
        "on_soft_limit": int(st["on_soft_limit"]),
        "inpos": st["inpos"],
        "rapidrate": st["rapid_rate"],
        "errcode": hex(st["errcode"]),
        "errmsg": st["errmsg"],
        "dout": st["dout"][:16],
        "din": st["din"][:16],
        "tool_offset": st["tool"],
        "control_source": st["control_source"],
        "model": st["model"],
        "cmd_id": st["cmd_id"],
        "log": st["log"],
        "sim": True,
    }


class _CmdHandler(socketserver.BaseRequestHandler):
    def handle(self):
        srv = self.server
        with srv.client_lock:  # JAKA: newest client on 10001 replaces older one
            if srv.active is not None:
                try:
                    srv.active.close()
                except OSError:
                    pass
            srv.active = self.request
        stream = JsonStream()
        try:
            while True:
                data = self.request.recv(4096)
                if not data:
                    return
                for msg in stream.feed(data):
                    reply = handle_command(srv.robot, msg)
                    self.request.sendall(json.dumps(reply).encode())
        except OSError:
            return


class _StatusHandler(socketserver.BaseRequestHandler):
    def handle(self):
        period = self.server.period
        try:
            while True:
                self.request.sendall(json.dumps(status_payload(self.server.robot)).encode())
                time.sleep(period)
        except OSError:
            return


class _TS(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class JakaServer:
    def __init__(self, robot, host="127.0.0.1", cmd_port=CMD_PORT, status_port=STATUS_PORT,
                 status_hz=50):
        self.cmd = _TS((host, cmd_port), _CmdHandler)
        self.cmd.robot = robot
        self.cmd.client_lock = threading.Lock()
        self.cmd.active = None
        self.status = _TS((host, status_port), _StatusHandler)
        self.status.robot = robot
        self.status.period = 1.0 / status_hz

    def start(self):
        for s in (self.cmd, self.status):
            threading.Thread(target=s.serve_forever, daemon=True).start()


# =================================================================== client
class JakaClient:
    """Request/response client for port 10001."""

    def __init__(self, host, port=CMD_PORT, timeout=3.0, tls=False):
        self.host, self.port, self.timeout, self.tls = host, port, timeout, tls
        self.sock = None
        self.stream = JsonStream()
        self.lock = threading.Lock()

    def connect(self):
        self.close()
        self.sock = open_socket(self.host, self.port, self.timeout, self.tls)
        self.stream = JsonStream()

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None

    @property
    def connected(self):
        return self.sock is not None

    def send(self, cmd_name, **fields):
        msg = {"cmdName": cmd_name}
        msg.update(fields)
        with self.lock:
            if not self.sock:
                self.connect()
            try:
                self.sock.sendall(json.dumps(msg).encode())
                deadline = time.time() + self.timeout
                while time.time() < deadline:
                    data = self.sock.recv(65536)
                    if not data:
                        raise ConnectionError("controller closed the connection")
                    for reply in self.stream.feed(data):
                        if reply.get("cmdName") == cmd_name:
                            return reply
                raise TimeoutError(f"no reply to {cmd_name}")
            except (OSError, ConnectionError):
                self.close()
                raise
