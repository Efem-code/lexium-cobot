"""SICK TiM 2D LiDAR reader for the bridge (TiM5xx / TiM7xx; also LMS1xx/5xx, which use the same telegrams).

The scanner streams LMDscandata telegrams after "sEN LMDscandata 1". Two framings exist on its TCP ports:
  CoLa A  ASCII: <STX> tokens separated by spaces <ETX>; numbers are hex unless signed (+/-).
  CoLa B  binary: 02 02 02 02, payload length (uint32, big-endian), payload, XOR checksum of the payload.
Field order per SICK "Telegram Listing" (LMDscandata): version, device number, serial, 2 status bytes, telegram
counter, scan counter, time since start-up, time of transmission, 2 input bytes, 2 output bytes, reserved,
scan frequency (1/100 Hz), measurement frequency, encoders, then 16-bit channels (DIST1, RSSI1...): name, scale
(float32), offset (float32), start angle (int32, 1/10000°), step (uint16, 1/10000°), count, values.

The CoLa A parser follows bulkscan-volume/cola.py. TiM angles: 90° points out of the front face, the 270° field
runs from -45° to 225°, and the blind sector is around the connectors.
"""
import socket
import struct
import threading
import time

STX, ETX = b"\x02", b"\x03"
B_MAGIC = b"\x02\x02\x02\x02"


# ------------------------------------------------------------------ CoLa A (ASCII)
def _num(tok):
    return int(tok, 10) if tok[:1] in ("+", "-") else int(tok, 16)


def _int32(tok):
    v = _num(tok)
    return v - 0x100000000 if v >= 0x80000000 else v


def _float32(tok):
    return struct.unpack(">f", struct.pack(">I", _num(tok) & 0xFFFFFFFF))[0]


def parse_cola_a(msg):
    """One 'sRA/sSN LMDscandata ...' telegram (text between STX and ETX) -> scan dict, or None."""
    t = msg.split()
    if len(t) < 20 or t[0] not in ("sRA", "sSN") or t[1] != "LMDscandata":
        return None
    i = 2 + 3                                   # version, device number, serial number
    status = (_num(t[i]), _num(t[i + 1])); i += 2
    i += 1                                      # telegram counter
    scan_counter = _num(t[i]); i += 1
    i += 2 + 4 + 1                              # two times, inputs (2), outputs (2), reserved
    freq = _num(t[i]) / 100.0; i += 2           # scan frequency, measurement frequency
    n_enc = _num(t[i]); i += 1 + 2 * n_enc
    n16 = _num(t[i]); i += 1
    for _ in range(n16):
        name, scale, offset = t[i], _float32(t[i + 1]), _float32(t[i + 2])
        start, step, n = _int32(t[i + 3]) / 10000.0, _num(t[i + 4]) / 10000.0, _num(t[i + 5])
        i += 6
        raw = t[i:i + n]; i += n
        if name == "DIST1":
            return _scan(scan_counter, status, freq, start, step, [_num(v) * scale + offset for v in raw])
    return None


# ------------------------------------------------------------------ CoLa B (binary)
def frame_b(cmd: bytes) -> bytes:
    cs = 0
    for b in cmd:
        cs ^= b
    return B_MAGIC + struct.pack(">I", len(cmd)) + cmd + bytes([cs])


def parse_cola_b(payload: bytes):
    """One CoLa B payload (between the length and the checksum) -> scan dict, or None."""
    head = b"sSN LMDscandata "
    if payload.startswith(b"sRA LMDscandata "):
        head = b"sRA LMDscandata "
    if not payload.startswith(head):
        return None
    p = payload[len(head):]
    try:
        o = 0
        o += 2 + 2 + 4                                      # version, device number, serial number
        status = (p[o], p[o + 1]); o += 2
        o += 2                                              # telegram counter
        scan_counter, = struct.unpack_from(">H", p, o); o += 2
        o += 4 + 4 + 2 + 2 + 2                              # two times, inputs, outputs, reserved
        freq = struct.unpack_from(">I", p, o)[0] / 100.0; o += 4 + 4
        n_enc, = struct.unpack_from(">H", p, o); o += 2 + 6 * n_enc
        n16, = struct.unpack_from(">H", p, o); o += 2
        for _ in range(n16):
            name = p[o:o + 5].decode("ascii", "replace"); o += 5
            scale, offset, start = struct.unpack_from(">ffi", p, o); o += 12
            step, n = struct.unpack_from(">HH", p, o); o += 4
            vals = struct.unpack_from(f">{n}H", p, o); o += 2 * n
            if name == "DIST1":
                return _scan(scan_counter, status, freq, start / 10000.0, step / 10000.0, [v * scale + offset for v in vals])
    except (struct.error, IndexError):
        return None
    return None


def _scan(counter, status, freq, start, step, dist):
    return {"counter": counter, "error": tuple(status) != (0, 0), "freq": freq,
            "start": start, "step": step, "dist": [round(d, 1) for d in dist]}   # mm, 0 = no echo


# ------------------------------------------------------------------ reader thread
class TimReader:
    """Keeps one connection to the scanner and the latest scan. proto: "auto", "A" or "B"."""

    def __init__(self):
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.host, self.port, self.proto = None, 2111, "auto"
        self.used = None
        self.sock = None
        self.thread = None
        self.stop_ev = threading.Event()
        self.scan = None          # latest scan dict + "t" (time.time() when received) + "seq"
        self.seq = 0
        self.error = ""
        self.connected = False
        self.rate = 0.0
        self._times = []

    # -- control
    def connect(self, host, port=2111, proto="auto"):
        self.disconnect()
        self.host, self.port, self.proto = str(host), int(port), (proto or "auto")
        self.stop_ev = threading.Event()
        self.error, self.used = "", None
        self.thread = threading.Thread(target=self._run, args=(self.stop_ev,), daemon=True, name="tim")
        self.thread.start()
        return self.status()

    def disconnect(self):
        self.stop_ev.set()
        s = self.sock
        if s:
            try:
                s.close()
            except OSError:
                pass
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=2)
        self.thread = self.sock = None
        with self.lock:
            self.connected = False
            self.rate = 0.0
        return {"ok": True}

    def status(self):
        with self.lock:
            age = time.time() - self.scan["t"] if self.scan else None
            return {"host": self.host, "port": self.port, "proto": self.used or self.proto, "connected": self.connected,
                    "running": bool(self.thread and self.thread.is_alive()), "error": self.error,
                    "rate": round(self.rate, 1), "scans": self.seq, "age": None if age is None else round(age, 2)}

    def wait_scan(self, after_seq, timeout=1.0):
        """Block until a scan newer than after_seq arrives (or timeout); returns it or None."""
        with self.cond:
            self.cond.wait_for(lambda: self.seq > after_seq or self.stop_ev.is_set(), timeout)
            return dict(self.scan) if self.scan and self.seq > after_seq else None

    # -- worker
    def _run(self, stop):
        while not stop.is_set():
            try:
                for proto in (["B", "A"] if self.proto == "auto" else [self.proto]):
                    if stop.is_set():
                        break
                    if self._session(proto, stop, probe=self.proto == "auto"):
                        break
                else:
                    if not stop.is_set() and not self.error:
                        self.error = "no scan data from the scanner on either protocol (CoLa A or B)"
            except OSError as e:
                if not stop.is_set():
                    self.error = f"{type(e).__name__}: {e}"
            with self.lock:
                self.connected = False
            stop.wait(2.0)   # retry

    def _session(self, proto, stop, probe):
        """Connect, start the stream and read scans until stopped. False = no answer in this protocol (probe)."""
        s = socket.create_connection((self.host, self.port), timeout=3)
        s.settimeout(1.5 if probe else 5)
        self.sock = s
        buf = b""
        try:
            s.sendall(frame_b(b"sEN LMDscandata \x01") if proto == "B" else STX + b"sEN LMDscandata 1" + ETX)
            got_any = False
            while not stop.is_set():
                try:
                    chunk = s.recv(65536)
                except socket.timeout:
                    if not got_any:
                        return False if probe else self._fail("no answer from the scanner")
                    raise
                if not chunk:
                    raise ConnectionError("scanner closed the connection")
                buf += chunk
                if len(buf) > 2_000_000:
                    buf = b""
                buf, scans, framed = self._split(buf, proto)
                if framed and not got_any:
                    got_any = True
                    with self.lock:
                        self.connected, self.used, self.error = True, proto, ""
                    s.settimeout(5)
                for sc in scans:
                    self._store(sc)
            return True
        finally:
            try:
                s.close()
            except OSError:
                pass

    def _fail(self, msg):
        self.error = msg
        return True

    @staticmethod
    def _split(buf, proto):
        """Take complete telegrams off the front of buf -> (rest, [scan dicts], any telegram seen)."""
        scans, framed = [], False
        if proto == "B":
            while True:
                k = buf.find(B_MAGIC)
                if k < 0:
                    return buf[-3:], scans, framed
                if len(buf) < k + 8:
                    return buf[k:], scans, framed
                n, = struct.unpack_from(">I", buf, k + 4)
                if n > 1_000_000:          # not a real frame: skip this magic
                    buf = buf[k + 1:]
                    continue
                if len(buf) < k + 8 + n + 1:
                    return buf[k:], scans, framed
                payload = buf[k + 8:k + 8 + n]
                buf = buf[k + 9 + n:]
                framed = True
                sc = parse_cola_b(payload)
                if sc:
                    scans.append(sc)
        while True:
            s = buf.find(STX)
            if s < 0:
                return b"", scans, framed
            e = buf.find(ETX, s)
            if e < 0:
                return buf[s:], scans, framed
            msg = buf[s + 1:e].decode("ascii", "replace")
            buf = buf[e + 1:]
            framed = True
            sc = parse_cola_a(msg)
            if sc:
                scans.append(sc)

    def _store(self, sc):
        now = time.time()
        with self.cond:
            self.seq += 1
            sc["t"], sc["seq"] = now, self.seq
            self.scan = sc
            self._times = [t for t in self._times if now - t < 2] + [now]
            self.rate = (len(self._times) - 1) / max(1e-6, self._times[-1] - self._times[0]) if len(self._times) > 1 else 0.0
            self.cond.notify_all()
