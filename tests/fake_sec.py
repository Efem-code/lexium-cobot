"""A fake SICK sensingCam SEC110 for tests and demos: the parts of its HTTP interface the bridge uses.

  GET  /authenticationFree/liveJpegImage   a JPEG (a test pattern with the frame number in a comment segment);
                                            404 while `locked` (the authentication-free API is off)
  GET  /api/FirmwareVersion, /api/SerialNumber
  POST /api/getChallenge/                   SICK challenge-response: realm, nonce, opaque, salt
  POST /api/SetAuthenticationFreeApiEnabled  needs a valid Service login; unlocks the live picture

Run:  python -m tests.fake_sec --port 8080 [--locked]
"""
import argparse
import hashlib
import json
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PIC = open(os.path.join(os.path.dirname(__file__), "data", "fake_sec.jpg"), "rb").read()
USERS = {"Service": "servicelevel", "Maintenance": "main"}   # the factory passwords (SICK KA-10054)


def frame(n):
    com = f"fake SEC110 frame {n}".encode()
    return PIC[:2] + b"\xff\xfe" + (len(com) + 2).to_bytes(2, "big") + com + PIC[2:]


class FakeSec:
    def __init__(self, port=0, locked=False):
        fake = self
        self.locked, self.n, self.nonces, self.salt = locked, 0, {}, list(secrets.token_bytes(8))

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body, ctype):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == "/authenticationFree/liveJpegImage":
                    if fake.locked:
                        return self._send(404, b"not found", "text/plain")
                    fake.n += 1
                    return self._send(200, frame(fake.n), "image/jpeg")
                if self.path == "/api/FirmwareVersion":
                    return self._send(200, b'{"FirmwareVersion": "2.2.0 (fake)"}', "application/json")
                if self.path == "/api/SerialNumber":
                    return self._send(200, b'{"SerialNumber": "00000000"}', "application/json")
                self._send(404, b"not found", "text/plain")

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path == "/api/getChallenge/":
                    nonce = secrets.token_hex(8)
                    fake.nonces[nonce] = body["data"]["user"]
                    ch = {"realm": "SICK Sensor", "nonce": nonce, "opaque": "x", "salt": fake.salt}
                    return self._send(200, json.dumps({"challenge": ch}).encode(), "application/json")
                name = self.path[len("/api/"):]
                h = body.get("header") or {}
                user, nonce = h.get("user"), h.get("nonce")
                ok = False
                if fake.nonces.pop(nonce, None) == user and user in USERS:
                    ha1 = hashlib.sha256(f"{user}:SICK Sensor:{USERS[user]}:".encode() + bytes(fake.salt)).hexdigest()
                    ha2 = hashlib.sha256(f"POST:{name}".encode()).hexdigest()
                    ok = h.get("response") == hashlib.sha256(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()
                if not ok:
                    return self._send(200, b'{"header": {"status": 4}}', "application/json")
                if name == "SetAuthenticationFreeApiEnabled" and user == "Service":
                    fake.locked = not body["data"]["SetAuthenticationFreeApiEnabled"]
                return self._send(200, b'{"header": {"status": 0}}', "application/json")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), H)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--locked", action="store_true", help="start with the authentication-free picture off")
    a = ap.parse_args()
    f = FakeSec(a.port, a.locked)
    print(f"fake SEC110 on http://127.0.0.1:{f.port}/  (Service / servicelevel)  Ctrl+C to stop")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        f.close()
