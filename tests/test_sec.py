"""SICK SEC110 camera reader: JPEG polling, unlocking with SICK's challenge-response login, RTSP-style decoding with
ffmpeg (from a local video file), saving pictures, and the bridge's /api/cam endpoints, against a fake camera.

Run:  python -m tests.test_sec     (from the lexium-cobot folder)
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.request

sys.path.insert(0, ".")
os.environ["LEXIUM_COBOT_HOME"] = tempfile.mkdtemp(prefix="cobot-test-")
from cobot.sec import SecReader, _response  # noqa: E402
from tests.fake_sec import FakeSec  # noqa: E402

fails = []


def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))
    if not cond:
        fails.append(name)


def wait(pred, timeout=8.0):
    t = time.time()
    while time.time() - t < timeout:
        if pred():
            return True
        time.sleep(0.05)
    return False


# ---- SICK's response formula, the two salt cases (KA-10054)
import hashlib  # noqa: E402
ch = {"realm": "SICK Sensor", "nonce": "n1", "salt": None}
ha1 = hashlib.sha256(b"Service:SICK Sensor:pw").hexdigest(); ha2 = hashlib.sha256(b"POST:X").hexdigest()
check("challenge-response, no salt", _response("Service", "pw", ch, "X") == hashlib.sha256(f"{ha1}:n1:{ha2}".encode()).hexdigest())
ch = {"realm": "SICK Sensor", "nonce": "n1", "salt": [1, 2, 3]}
ha1 = hashlib.sha256(b"Service:SICK Sensor:pw:" + bytes([1, 2, 3])).hexdigest()
check("challenge-response, salted", _response("Service", "pw", ch, "X") == hashlib.sha256(f"{ha1}:n1:{ha2}".encode()).hexdigest())

# ---- JPEG polling
cam = FakeSec()
r = SecReader()
r.connect(f"127.0.0.1:{cam.port}", "jpeg", fps=10)
ok = wait(lambda: r.status()["frames"] >= 5)
st = r.status()
check("JPEG mode: pictures arrive", ok and st["connected"], st)
check("JPEG mode: about 10 per second", 6 <= st["rate"] <= 12, st["rate"])
check("JPEG mode: firmware read without a login", "fake" in json.dumps(st["info"]), st["info"])
jpeg, seq = r.frame(0, 1)
check("frame is a JPEG", jpeg and jpeg[:2] == b"\xff\xd8" and jpeg[-2:] == b"\xff\xd9")
j2, s2 = r.frame(seq, 2)
check("frame(after) waits for a newer one", j2 and s2 > seq and j2 != jpeg)
saved = r.save(os.path.join(os.environ["LEXIUM_COBOT_HOME"], "pictures"), "pass 1", {"pose": [1, 2, 3]})
check("save: picture and its pose on disk", os.path.getsize(saved["file"]) == len(r.frame(0, 0)[0]) or os.path.getsize(saved["file"]) > 1000)
check("save: metadata next to it", json.load(open(saved["file"][:-4] + ".json"))["pose"] == [1, 2, 3])
r.disconnect()
n = r.status()["frames"]; time.sleep(0.5)
check("disconnect stops it", r.status()["frames"] == n and not r.status()["connected"])
cam.close()

# ---- locked camera: no password -> a clear error; Service password -> unlocked by the reader
cam = FakeSec(locked=True)
r = SecReader(); r.connect(f"127.0.0.1:{cam.port}", "jpeg", fps=5)
check("locked, no password: says how to fix it", wait(lambda: "authentication-free" in r.status()["error"], 5), r.status()["error"])
r.disconnect()
r = SecReader(); r.connect(f"127.0.0.1:{cam.port}", "jpeg", fps=5, user="Service", password="wrong")
check("locked, wrong password: login refused", wait(lambda: "refused" in r.status()["error"], 6), r.status()["error"])
r.disconnect()
r = SecReader(); r.connect(f"127.0.0.1:{cam.port}", "jpeg", fps=5, user="Service", password="servicelevel")
check("locked, Service password: unlocks and streams", wait(lambda: r.status()["frames"] >= 3, 8) and not cam.locked, r.status())
r.disconnect(); cam.close()

# ---- RTSP path: ffmpeg decodes a stream into JPEGs (here from a local H.264 file, looped)
if shutil.which("ffmpeg"):
    r = SecReader()
    r.connect("file", "rtsp", fps=5, url=os.path.abspath("tests/data/fake_sec.mp4"))
    check("ffmpeg mode: decoded frames arrive", wait(lambda: r.status()["frames"] >= 5, 10), r.status())
    jpeg, _ = r.frame(0, 1)
    check("ffmpeg mode: frames are JPEGs", jpeg and jpeg[:2] == b"\xff\xd8" and jpeg[-2:] == b"\xff\xd9")
    p = r.proc
    r.disconnect()
    check("ffmpeg mode: disconnect ends ffmpeg", p is None or p.poll() is not None)
else:
    print("SKIP ffmpeg mode (no ffmpeg on this PC)")
r = SecReader(); r.connect("127.0.0.1:1", "jpeg", fps=5)
check("nothing listening: an error, no crash", wait(lambda: r.status()["error"] != "", 6), r.status()["error"])
r.disconnect()

# ---- bridge endpoints
from cobot.web import Handler, serve  # noqa: E402

cam = FakeSec()
httpd = serve("127.0.0.1", 0)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{httpd.server_address[1]}"


def post(path, body):
    rq = urllib.request.Request(url + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(rq, timeout=5).read())


res = post("/api/cam/connect", {"host": f"127.0.0.1:{cam.port}", "mode": "jpeg", "fps": 8})
check("POST /api/cam/connect", not res.get("errorCode") and res.get("mode") == "jpeg", res)
wait(lambda: Handler.cam.status()["frames"] >= 2)
f = urllib.request.urlopen(url + "/api/cam/frame", timeout=5)
check("GET /api/cam/frame is a JPEG", f.headers["Content-Type"] == "image/jpeg" and f.read()[:2] == b"\xff\xd8")
live = urllib.request.urlopen(url + "/api/cam/live", timeout=5)
check("GET /api/cam/live is MJPEG", live.headers["Content-Type"].startswith("multipart/x-mixed-replace"))
parts, buf = 0, b""
while parts < 3:
    buf += live.read1(65536)
    parts = buf.count(b"--frame\r\nContent-Type: image/jpeg")
live.close()
check("live stream carries several pictures", parts >= 3)
res = post("/api/cam/save", {"name": "test", "meta": {"travel": 12}})
check("POST /api/cam/save keeps it in the settings folder", res.get("file", "").startswith(os.environ["LEXIUM_COBOT_HOME"]) and os.path.isfile(res["file"]), res)
check("GET /api/cam/status", json.loads(urllib.request.urlopen(url + "/api/cam/status", timeout=5).read())["connected"] is True)
check("POST /api/cam/disconnect", post("/api/cam/disconnect", {}).get("ok") is True)
Handler.cam.disconnect(); cam.close(); httpd.shutdown()

print("\nALL PASSED" if not fails else f"\n{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
