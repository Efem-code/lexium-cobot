"""SICK TiM reader: CoLa A and CoLa B parsing, auto-detection, and the bridge's /api/tim endpoints, against a fake TiM.

Run:  python -m tests.test_tim     (from the lexium-cobot folder)
"""
import json
import os
import sys
import tempfile
import threading
import time
import urllib.request

sys.path.insert(0, ".")
os.environ["LEXIUM_COBOT_HOME"] = tempfile.mkdtemp(prefix="cobot-test-")
from cobot.tim import TimReader, parse_cola_a, parse_cola_b  # noqa: E402
from tests.fake_tim import FakeTim, N, START, STEP, profile, telegram_a, telegram_b  # noqa: E402

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


dist = profile(330)
# ---- parsers on single telegrams
a = parse_cola_a(telegram_a(7, dist)[1:-1].decode())
check("CoLa A: parsed", a is not None)
check("CoLa A: 811 beams from -45° in 0.3333° steps", a and len(a["dist"]) == N and abs(a["start"] + 45) < 1e-6 and abs(a["step"] - 0.3333) < 1e-4,
      a and (len(a["dist"]), a["start"], a["step"]))
check("CoLa A: ranges, frequency, counter", a and a["dist"] == [float(d) for d in dist] and a["freq"] == 15 and a["counter"] == 7)
fb = telegram_b(9, dist)
b = parse_cola_b(fb[8:-1])
check("CoLa B: parsed", b is not None)
check("CoLa B: same scan as CoLa A", b and b["dist"] == a["dist"] and b["start"] == a["start"] and b["step"] == a["step"] and b["counter"] == 9)
check("CoLa B: checksum byte is the XOR of the payload", fb[-1] == __import__("functools").reduce(lambda x, y: x ^ y, fb[8:-1], 0))
check("not scan data: None", parse_cola_a("sRA DeviceIdent 0 0") is None and parse_cola_b(b"sRA DeviceIdent \x00") is None)
# straight down (90°) is the floor distance; the block (100 mm high) is nearer
mid = round((90 - START) / STEP)
check("fake scene: floor 330 mm, block top 230 mm straight down", abs(a["dist"][mid] - 230) <= 1, a["dist"][mid])

# ---- the reader against fake scanners, both protocols, auto-detect
for proto in ("B", "A"):
    fake = FakeTim(proto=proto)
    r = TimReader()
    r.connect("127.0.0.1", fake.port, "auto")
    ok = wait(lambda: r.status()["scans"] >= 5)
    st = r.status()
    check(f"auto-detect finds CoLa {proto} and streams", ok and st["proto"] == proto and st["connected"], st)
    check(f"CoLa {proto}: about 15 scans/s", 10 <= st["rate"] <= 20, st["rate"])
    sc = r.wait_scan(0, 1)
    check(f"CoLa {proto}: scan content", sc and len(sc["dist"]) == N and sc["dist"][mid] == a["dist"][mid])
    r.disconnect()
    n = r.status()["scans"]; time.sleep(0.4)
    check(f"CoLa {proto}: disconnect stops the stream", r.status()["scans"] == n and not r.status()["connected"])
    fake.close()

# wrong fixed protocol: no data, an error instead of a hang
fake = FakeTim(proto="A")
r = TimReader(); r.connect("127.0.0.1", fake.port, "B")
check("wrong protocol: says so", wait(lambda: r.status()["error"] != "", 6), r.status()["error"])
r.disconnect(); fake.close()

# nothing listening
r = TimReader(); r.connect("127.0.0.1", 1, "auto")
check("nothing listening: error, no crash", wait(lambda: "Error" in r.status()["error"] or "refused" in r.status()["error"].lower(), 5), r.status()["error"])
r.disconnect()

# ---- bridge endpoints
from cobot.web import Handler, serve  # noqa: E402

fake = FakeTim(proto="B")
httpd = serve("127.0.0.1", 0)
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{port}"


def post(path, body):
    rq = urllib.request.Request(url + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(rq, timeout=5).read())


res = post("/api/tim/connect", {"host": "127.0.0.1", "port": fake.port, "proto": "auto"})
check("POST /api/tim/connect", not res.get("errorCode") and not res.get("error") and res.get("port") == fake.port, res)
stream = urllib.request.urlopen(url + "/api/tim/stream", timeout=5)
msgs = []
while len(msgs) < 3:
    line = stream.readline().decode()
    if line.startswith("data: "):
        m = json.loads(line[6:])
        if m["scan"]:
            msgs.append(m)
stream.close()
check("GET /api/tim/stream sends scans with state", all(len(m["scan"]["dist"]) == N and m["state"]["connected"] for m in msgs))
check("stream: each scan once, in order", [m["scan"]["seq"] for m in msgs] == sorted({m["scan"]["seq"] for m in msgs}))
check("POST /api/tim/disconnect", post("/api/tim/disconnect", {}).get("ok") is True)
Handler.tim.disconnect(); fake.close(); httpd.shutdown()

print("\nALL PASSED" if not fails else f"\n{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
