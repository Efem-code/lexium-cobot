"""A fake SICK TiM for tests and for trying the Scan tab's "Real TiM" source without hardware.

It answers "sEN LMDscandata 1" by streaming LMDscandata at 15 Hz, 811 beams from -45° to 225° (0.3333° steps), in
CoLa A (ASCII) or CoLa B (binary) - only the one it is set to, like a real port. The fake scene: a flat floor
`floor` mm below the scanner's front (90°) and a 100 mm high, 120 mm wide block in the middle.

Run:  python -m tests.fake_tim [--port 2111] [--proto B] [--floor 330]
Then in the page: Scan → Scanner = Real TiM, host 127.0.0.1, that port.
"""
import argparse
import math
import socket
import struct
import threading
import time

from cobot.tim import B_MAGIC, ETX, STX, frame_b

START, STEP, N = -45.0, 1 / 3, 811


def profile(floor=330.0, block_h=100.0, block_w=120.0):
    """Ranges (mm) for a scanner looking down at a floor with a block centred under it; 0 = no echo."""
    out = []
    for k in range(N):
        a = math.radians(START + STEP * k)
        down, side = math.sin(a), math.cos(a)        # 90° = straight down (front), 0° / 180° = sideways
        if down <= 0.02:
            out.append(0)
            continue
        r = floor / down                             # the floor
        top = (floor - block_h) / down               # the block's top face, if the ray lands on it
        if abs(top * side) <= block_w / 2:
            r = top
        elif abs(side) > 1e-9:                       # the block's near side face
            t = block_w / 2 / abs(side)
            if floor - block_h <= t * down <= floor:
                r = t
        out.append(int(round(r)) if r < 10000 else 0)
    return out


def telegram_a(counter, dist):
    toks = ["sSN", "LMDscandata", "1", "1", "89A27F", "0", "0", f"{counter & 0xFFFF:X}", f"{counter & 0xFFFF:X}",
            "0", "0", "0", "0", "0", "0", "0", "5DC", "0", "0", "1", "DIST1", "3F800000", "00000000",
            f"{int(round(START * 10000)) & 0xFFFFFFFF:X}", f"{int(round(STEP * 10000)):X}", f"{len(dist):X}"]
    toks += [f"{d:X}" for d in dist]
    toks += ["0", "0", "0", "0", "0", "0"]
    return STX + " ".join(toks).encode() + ETX


def telegram_b(counter, dist):
    p = b"sSN LMDscandata "
    p += struct.pack(">HHI", 1, 1, 0x89A27F) + bytes([0, 0]) + struct.pack(">HH", counter & 0xFFFF, counter & 0xFFFF)
    p += struct.pack(">II", 0, 0) + bytes([0, 0, 0, 0]) + struct.pack(">H", 0)
    p += struct.pack(">II", 1500, 0) + struct.pack(">H", 0)            # 15 Hz, no encoders
    p += struct.pack(">H", 1) + b"DIST1" + struct.pack(">ffiHH", 1.0, 0.0, int(round(START * 10000)), int(round(STEP * 10000)), len(dist))
    p += struct.pack(f">{len(dist)}H", *dist)
    p += struct.pack(">H", 0) + struct.pack(">HHHH", 0, 0, 0, 0)        # no 8-bit channels, no position/name/comment
    return frame_b(p)


class FakeTim:
    def __init__(self, port=0, proto="B", floor=330.0, rate=15.0):
        self.proto, self.rate, self.dist = proto, rate, profile(floor)
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", port))
        self.srv.listen(4)
        self.port = self.srv.getsockname()[1]
        self.stopped = False
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while not self.stopped:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            threading.Thread(target=self._client, args=(c,), daemon=True).start()

    def _client(self, c):
        buf, streaming, n = b"", False, 0
        c.settimeout(1.0 / self.rate)
        try:
            while not self.stopped:
                try:
                    chunk = c.recv(4096)
                    if not chunk:
                        return
                    buf += chunk
                except socket.timeout:
                    pass
                # start/stop requests, only in this port's own framing (anything else is ignored, like a real port)
                for cmd in _commands(buf, self.proto):
                    if cmd in (b"sEN LMDscandata \x01", b"sEN LMDscandata 1"):
                        streaming = True
                    elif cmd in (b"sEN LMDscandata \x00", b"sEN LMDscandata 0"):
                        streaming = False
                    else:
                        continue
                    ans = b"sEA LMDscandata " + ((b"\x01" if streaming else b"\x00") if self.proto == "B" else (b"1" if streaming else b"0"))
                    c.sendall(frame_b(ans) if self.proto == "B" else STX + ans + ETX)
                buf = _rest(buf, self.proto)
                if streaming:
                    n += 1
                    c.sendall(telegram_b(n, self.dist) if self.proto == "B" else telegram_a(n, self.dist))
        except OSError:
            return
        finally:
            c.close()

    def close(self):
        self.stopped = True
        self.srv.close()


def _frames(buf, proto):
    """-> (complete commands, rest of buf)."""
    out = []
    while True:
        if proto == "B":
            k = buf.find(B_MAGIC)
            if k < 0 or len(buf) < k + 8:
                return out, buf
            n, = struct.unpack_from(">I", buf, k + 4)
            if len(buf) < k + 9 + n:
                return out, buf
            out.append(buf[k + 8:k + 8 + n]); buf = buf[k + 9 + n:]
        else:
            s = buf.find(STX); e = buf.find(ETX, s + 1) if s >= 0 else -1
            if s < 0 or e < 0:
                return out, buf
            out.append(buf[s + 1:e]); buf = buf[e + 1:]


def _commands(buf, proto):
    return _frames(buf, proto)[0]


def _rest(buf, proto):
    return _frames(buf, proto)[1]


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=2111)
    ap.add_argument("--proto", choices=["A", "B"], default="B")
    ap.add_argument("--floor", type=float, default=330.0, help="floor distance below the scanner, mm")
    a = ap.parse_args()
    t = FakeTim(a.port, a.proto, a.floor)
    print(f"fake TiM on 127.0.0.1:{t.port}, CoLa {a.proto}, 15 Hz. Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        t.close()
