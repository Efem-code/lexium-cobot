"""SICK sensingCam SEC110 (SEC100 family) camera reader for the bridge.

Sources: SICK operating instructions "sensingCam SEC100 / SEC110" (doc 9408724), datasheet SEC110-5C9D1SFZZZZ and
SICK Support Portal KA-10054 "REST API of the sensingCam SEC100" (Postman collection for firmware 2.2.0 and SICK's
Python example).

Two ways to get pictures, both need nothing outside the Python standard library except ffmpeg for RTSP:
  "jpeg"  GET http://<ip>/authenticationFree/liveJpegImage, polled at `fps` (firmware 2.1 or later; the camera's
          "authentication-free API" may have to be switched on: give the Service password and connect() does it)
  "rtsp"  rtsp://<ip>:554/live0 (the primary H.264/H.265 stream; RTSP must be enabled on the camera), decoded by
          ffmpeg into JPEG frames.
REST writes use SICK's challenge-response login (sha256, not HTTP Basic/Digest): POST /api/getChallenge/ then the
request with a {"header": {...}, "data": {...}} body. Plain GETs of /api/<name> need no login.
Defaults: DHCP, falling back to 192.168.136.100; users "Service" and "Maintenance".
"""
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request

SOI, EOI = b"\xff\xd8", b"\xff\xd9"


# ------------------------------------------------------------------ SICK challenge-response (KA-10054 / sec100client.py)
def _response(user, password, challenge, uri):
    realm, nonce, salt = challenge["realm"], challenge["nonce"], challenge.get("salt")
    if salt is None:
        ha1 = hashlib.sha256(f"{user}:{realm}:{password}".encode()).hexdigest()
    else:
        ha1 = hashlib.sha256(f"{user}:{realm}:{password}:".encode() + bytes(salt)).hexdigest()
    ha2 = hashlib.sha256(f"POST:{uri}".encode()).hexdigest()
    return hashlib.sha256(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()


def _http(url, data=None, timeout=3.0):
    rq = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(),
                                headers={"Content-Type": "application/json"} if data is not None else {},
                                method="GET" if data is None else "POST")
    with urllib.request.urlopen(rq, timeout=timeout) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read()


def api_get(host, name, timeout=3.0):
    """GET http://host/api/<name> -> parsed JSON (no login needed for reads)."""
    _, _, body = _http(f"http://{host}/api/{name}", timeout=timeout)
    return json.loads(body)


def api_post(host, name, data, user, password, timeout=3.0):
    """Authenticated POST http://host/api/<name>; returns the parsed reply. Raises PermissionError on a bad login."""
    for _ in range(2):
        _, _, body = _http(f"http://{host}/api/getChallenge/", {"data": {"user": user}}, timeout)
        ch = json.loads(body)["challenge"]
        head = {"nonce": ch["nonce"], "opaque": ch.get("opaque"), "realm": ch["realm"], "user": user,
                "response": _response(user, password, ch, name)}
        _, _, body = _http(f"http://{host}/api/{name}", {"header": head, "data": data}, timeout)
        rep = json.loads(body) if body else {}
        if (rep.get("header") or {}).get("status", 0) != 4:
            return rep
    raise PermissionError("the camera refused the login (user or password)")


# ------------------------------------------------------------------ reader
class SecReader:
    """Keeps the newest JPEG from the camera. mode: "jpeg" (poll the live picture) or "rtsp" (ffmpeg)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.ctl = threading.Lock()
        self.host, self.mode, self.fps, self.url = None, "jpeg", 5.0, None
        self.thread, self.stop_ev, self.proc = None, threading.Event(), None
        self.jpeg, self.t, self.seq = None, 0.0, 0
        self.error, self.connected, self.rate, self.info = "", False, 0.0, {}
        self._times = []

    def connect(self, host, mode="jpeg", fps=5, user="", password="", rtsp_path="live0", rtsp_port=554, url=None):
        with self.ctl:
            self._disconnect()
            stop = threading.Event()
            with self.lock:
                self.host, self.mode, self.fps = str(host), mode if mode in ("jpeg", "rtsp") else "jpeg", max(0.5, min(30.0, float(fps or 5)))
                self.url = url or (f"rtsp://{host}:{int(rtsp_port)}/{str(rtsp_path).lstrip('/')}" if self.mode == "rtsp"
                                   else f"http://{host}/authenticationFree/liveJpegImage")
                self.stop_ev, self.error, self.info, self.seq, self.jpeg = stop, "", {}, 0, None
            self.thread = threading.Thread(target=self._run, args=(stop, user, password), daemon=True, name="sec")
            self.thread.start()
        return self.status()

    def disconnect(self):
        with self.ctl:
            self._disconnect()
        return {"ok": True}

    def _disconnect(self):
        self.stop_ev.set()
        p = self.proc
        if p and p.poll() is None:
            p.kill()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=3)
        self.thread = self.proc = None
        with self.lock:
            self.connected, self.rate = False, 0.0

    def _mine(self, stop):
        return stop is self.stop_ev and not stop.is_set()

    def status(self):
        with self.lock:
            return {"host": self.host, "mode": self.mode, "url": self.url, "fps": self.fps, "connected": self.connected,
                    "error": self.error, "rate": round(self.rate, 1), "frames": self.seq, "info": self.info,
                    "age": round(time.time() - self.t, 2) if self.jpeg else None,
                    "ffmpeg": bool(shutil.which("ffmpeg"))}

    def frame(self, after=0, timeout=2.0):
        """Newest JPEG (bytes, seq), waiting up to timeout for one newer than `after`; (None, seq) if none."""
        with self.cond:
            self.cond.wait_for(lambda: self.seq > after, timeout)
            return (self.jpeg, self.seq) if self.jpeg and self.seq > after else (None, self.seq)

    def _store(self, jpeg, stop):
        now = time.time()
        with self.cond:
            if not self._mine(stop):
                return
            self.seq += 1
            self.jpeg, self.t, self.connected, self.error = jpeg, now, True, ""
            self._times = [t for t in self._times if now - t < 3] + [now]
            self.rate = (len(self._times) - 1) / max(1e-6, self._times[-1] - self._times[0]) if len(self._times) > 1 else 0.0
            self.cond.notify_all()

    def _fail(self, stop, msg):
        with self.lock:
            if self._mine(stop):
                self.error, self.connected = msg, False

    # -- worker
    def _run(self, stop, user, password):
        if self.mode == "jpeg" and self.url.startswith("http://") and self.host:
            try:   # what is it? (plain GETs need no login); not fatal if the camera doesn't answer these
                with self.lock:
                    self.info = {"firmware": api_get(self.host, "FirmwareVersion", 2), "serial": api_get(self.host, "SerialNumber", 2)}
            except Exception:
                pass
        tried_enable = False
        while not stop.is_set():
            try:
                if self.mode == "rtsp":
                    self._rtsp(stop)
                else:
                    self._poll(stop)
            except urllib.error.HTTPError as e:
                # the live picture is off until the authentication-free API is switched on (Service user)
                if e.code in (401, 403, 404) and password and not tried_enable:
                    tried_enable = True
                    try:
                        api_post(self.host, "SetAuthenticationFreeApiEnabled", {"SetAuthenticationFreeApiEnabled": True},
                                 user or "Service", password)
                        continue
                    except Exception as e2:
                        self._fail(stop, f"could not switch on the camera's authentication-free picture: {e2}")
                else:
                    self._fail(stop, f"HTTP {e.code} from the camera" + ("" if password else
                               " (switch on its authentication-free API in the camera's web page, Diagnostics > Cybersecurity, or give the Service password)"))
            except Exception as e:   # never die silently: report and retry
                self._fail(stop, f"{type(e).__name__}: {e}")
            stop.wait(2.0)

    def _poll(self, stop):
        period = 1.0 / self.fps
        while not stop.is_set():
            t0 = time.time()
            code, ctype, body = _http(self.url, timeout=3)
            if not body.startswith(SOI):
                raise ValueError(f"not a JPEG from {self.url} ({ctype or 'no type'}, {len(body)} bytes)")
            self._store(body, stop)
            stop.wait(max(0.0, period - (time.time() - t0)))

    def _rtsp(self, stop):
        ff = shutil.which("ffmpeg")
        if not ff:
            raise RuntimeError("RTSP needs ffmpeg on this PC (or use the JPEG mode)")
        args = [ff, "-loglevel", "error", "-nostdin"]
        if self.url.startswith("rtsp://"):
            args += ["-rtsp_transport", "tcp"]
        else:   # a file (tests): play it at its own speed, looped
            args += ["-re", "-stream_loop", "-1"]
        args += ["-i", self.url, "-an", "-vf", f"fps={self.fps},scale='min(1280,iw)':-2", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "-"]
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.proc = p
        buf = b""
        try:
            while not stop.is_set():
                chunk = p.stdout.read1(65536) if hasattr(p.stdout, "read1") else p.stdout.read(65536)
                if not chunk:
                    err = (p.stderr.read() or b"").decode(errors="replace").strip().splitlines()
                    raise ConnectionError(err[-1] if err else "the video stream ended")
                buf += chunk
                while True:
                    s = buf.find(SOI)
                    e = buf.find(EOI, s + 2) if s >= 0 else -1
                    if s < 0 or e < 0:
                        buf = buf[s:] if s >= 0 else b""
                        break
                    self._store(buf[s:e + 2], stop)
                    buf = buf[e + 2:]
                if len(buf) > 8_000_000:
                    buf = b""
        finally:
            if p.poll() is None:
                p.kill()
            p.wait(timeout=2)

    # -- pictures kept on this PC
    def save(self, folder, name="", meta=None):
        with self.lock:
            jpeg, t = self.jpeg, self.t
        if not jpeg:
            raise RuntimeError("no picture from the camera yet")
        os.makedirs(folder, exist_ok=True)
        stem = time.strftime("%Y%m%d-%H%M%S", time.localtime(t)) + f"-{int(t * 1000) % 1000:03d}" + (f"-{_safe(name)}" if name else "")
        path = os.path.join(folder, stem + ".jpg")
        with open(path, "wb") as f:
            f.write(jpeg)
        if meta:
            with open(os.path.join(folder, stem + ".json"), "w") as f:
                json.dump(dict(meta, time=t, camera=self.host), f, indent=1)
        return {"file": path, "name": stem + ".jpg"}


def _safe(s):
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in str(s))[:40]
