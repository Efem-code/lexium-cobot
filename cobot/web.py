"""Local web UI server for the PC controller (stdlib http.server).

GET  /                 UI
GET  /api/state        current status JSON
GET  /api/stream       Server-Sent Events, status at ~20 Hz
GET  /api/models       arm profiles
POST /api/connect      {host, mode, modbus_port, cmd_port, status_port, model}
POST /api/disconnect
POST /api/arm          {armed: bool}   (real hardware motion arming)
POST /api/cmd          {cmdName, ...}  raw JSON command passthrough
POST /api/jog          {coord, axis, dir, speed}
POST /api/jog/keepalive
POST /api/jog/stop
POST /api/stop
POST /api/ik           {pose, seed}
POST /api/model        {model}
"""
import hmac
import json
import os
import secrets
import socket
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import kinematics as K
from .driver import CobotDriver, to_json

STATIC = os.path.join(os.path.dirname(__file__), "static")
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".webmanifest": "application/manifest+json", ".png": "image/png", ".json": "application/json"}
OPEN_PATHS = {"/api/auth", "/api/login"}  # reachable without the PIN


_local_sims = []


def _ensure_local_sim(host, modbus_port, cmd_port, status_port, model):
    """Simulator picked in the page but none running (app started as 'ui', or the .exe in real-cobot use):
    start one here so Setup → Simulator → Connect always works."""
    if host not in ("127.0.0.1", "localhost", "::1"):
        return
    try:
        socket.create_connection(("127.0.0.1", cmd_port), timeout=0.5).close()
        return  # something already listens there
    except OSError:
        pass
    from .sim_server import VirtualController
    try:
        _local_sims.append(VirtualController("127.0.0.1", modbus_port, cmd_port, status_port, model).start())
        time.sleep(0.3)
    except OSError:
        pass  # a port is taken: connect() reports the error


class Handler(BaseHTTPRequestHandler):
    driver: CobotDriver = None
    pin: str = ""                       # empty = no PIN (localhost-only use)
    token: str = secrets.token_hex(16)  # session cookie value, new every run
    failures = {}                       # ip -> (count, last_time) for login throttling
    protocol_version = "HTTP/1.1"

    share = None                        # set by cli: share("status"|"on"|"off") -> dict

    def _local(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def _authed(self):
        if not self.pin or self._local():
            return True  # the PC itself never needs the PIN
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "cobot_token" and hmac.compare_digest(v, self.token):
                return True
        return False

    def _static(self, path):
        # /display = the same page in watch-only mode (app.js reads the path)
        rel = "index.html" if path in ("", "/", "/display") else path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC, rel))
        if not full.startswith(os.path.normpath(STATIC) + os.sep) or not os.path.isfile(full):
            return False
        ctype = TYPES.get(os.path.splitext(full)[1])
        if not ctype:
            return False
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)
        return True

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj, code=200):
        self._send(code, to_json(obj))

    def do_GET(self):
        d = self.driver
        path = self.path.split("?", 1)[0]
        if not path.startswith("/api/"):
            if path == "/display/":   # keep relative asset URLs working
                self.send_response(301)
                self.send_header("Location", "/display")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if self._static(path):
                return
            return self._send(404, "not found", "text/plain")
        if path == "/api/auth":
            return self._json({"need_pin": bool(self.pin), "ok": self._authed()})
        if not self._authed():
            return self._json({"error": "PIN required"}, 401)
        self.path = path
        if self.path == "/api/share":
            return self._json(dict(self.share("status") if self.share else {"on": False, "available": False},
                                   local=self._local()))
        if self.path == "/api/state":
            return self._json(d.status())
        if self.path == "/api/models":
            return self._json(dict(profiles=K.PROFILES, limits=K.JOINT_LIMITS, home=K.HOME))
        if self.path == "/api/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                while True:
                    self.wfile.write(("data: " + to_json(d.status()) + "\n\n").encode())
                    self.wfile.flush()
                    time.sleep(0.05)
            except OSError:
                return
        self._send(404, '{"error":"not found"}')

    def do_POST(self):
        d = self.driver
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        p = self.path.split("?", 1)[0]
        if p == "/api/login":
            return self._login(str(body.get("pin", "")))
        if not self._authed():
            return self._json({"error": "PIN required"}, 401)
        try:
            if p == "/api/connect":
                if body.get("mode", "sim") == "sim":
                    _ensure_local_sim(body.get("host", "127.0.0.1"), int(body.get("modbus_port", 502)),
                                      int(body.get("cmd_port", 10001)), int(body.get("status_port", 10000)),
                                      body.get("model") or "LXMRL03")
                r = d.connect(body.get("host", "127.0.0.1"), body.get("mode", "sim"),
                              int(body.get("modbus_port", 502)), int(body.get("cmd_port", 10001)),
                              int(body.get("status_port", 10000)), body.get("model"))
            elif p == "/api/disconnect":
                d.disconnect()
                r = {"ok": True}
            elif p == "/api/arm":
                d.motion_armed = bool(body.get("armed"))
                r = {"motion_armed": d.motion_armed}
            elif p == "/api/cmd":
                name = body.pop("cmdName")
                r = d.command(name, **body)
            elif p == "/api/share":
                # only someone at the PC itself may open (or close) the app to the network
                if not self._local():
                    return self._json({"errorCode": "403", "errorMsg": "Sharing can only be changed on the PC running the app"})
                if not self.share:
                    return self._json({"errorCode": "404", "errorMsg": "Restart the app with --lan to share it"})
                r = self.share("on" if body.get("on") else "off")
            elif p == "/api/limits":
                r = {"limits": d.set_limits(**body)}
            elif p == "/api/jog":
                r = d.jog_start(body["coord"], int(body["axis"]), int(body["dir"]),
                                float(body.get("speed", 10)))
            elif p == "/api/jog/keepalive":
                r = {"jogging": d.jog_keepalive()}
            elif p == "/api/jog/stop":
                r = d.jog_stop()
            elif p == "/api/stop":
                r = d.stop_all()
            elif p == "/api/ik":
                q = d.ik(body["pose"], body.get("seed") or d.status().get("joints") or K.HOME)
                r = {"joints": q, "ok": K.within_limits(q), "points": d.arm.joint_points(q)}
            elif p == "/api/fk":
                q = body["joints"]
                r = {"tcp": d.arm.fk(q), "points": d.arm.joint_points(q)}
            elif p == "/api/model":
                r = d.set_model(body["model"])
            else:
                return self._json({"error": "not found"}, 404)
            return self._json(r)
        except PermissionError as e:
            return self._json({"errorCode": "403", "errorMsg": str(e)}, 200)
        except Exception as e:
            return self._json({"errorCode": "500", "errorMsg": f"{type(e).__name__}: {e}"}, 200)


    def _login(self, pin):
        ip = self.client_address[0]
        n, last = self.failures.get(ip, (0, 0))
        if n >= 5 and time.time() - last < 60:
            return self._json({"ok": False, "error": "Too many tries - wait a minute"}, 429)
        if self.pin and hmac.compare_digest(pin, self.pin):
            self.failures.pop(ip, None)
            data = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Set-Cookie", f"cobot_token={self.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000")
            self.end_headers()
            return self.wfile.write(data)
        self.failures[ip] = (n + 1, time.time())
        return self._json({"ok": False, "error": "Wrong PIN"}, 403)


def serve(host="127.0.0.1", port=8765, driver=None, pin=""):
    Handler.driver = driver or CobotDriver()
    Handler.pin = pin
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    return httpd
