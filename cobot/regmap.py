"""Lexium Cobot Modbus TCP address map.

Source: Schneider Electric, EcoStruxure Cobot Expert User Guide (Lexium Cobot
V1.7, EIO0000004780.03) -> Appendices -> Modbus Address Table.

All 32-bit values are big-endian with the HIGH word in the lower register
(standard Modbus). Addresses are protocol (0-based) addresses as printed in
the Schneider table. If a value on the real cobot reads as garbage, try the
WORD_SWAP option -- that is the first thing to check on a new controller.
"""
import struct

WORD_SWAP = False  # flip if the real controller turns out to be low-word-first

# --- bit areas
DISCRETE_DO_BASE = 8     # FC02, robot digital outputs DO0..DO127  (read-only)
COIL_DI_BASE = 40        # FC01/05/15, robot digital inputs DI0..DI127 (writable)
IO_COUNT = 128

# --- register areas
IREG_AO_BASE = 96        # FC04 robot analog outputs (AO00-15 UINT16, 16-31 INT16, 32-63 FLOAT32)
HREG_AI_BASE = 100       # FC03/06/16 robot analog inputs (AI00-15 UINT16, 16-31 INT16, 32-63 FLOAT32)

# --- FC04 input registers: robot data  (name, address, type)
ROBOT_DATA = [
    ("servo_version", 300, "i32"),
    ("serial_no", 302, "i32"),
]
for _i in range(6):
    ROBOT_DATA.append((f"j{_i+1}_voltage", 304 + 2 * _i, "i32"))
for _i in range(6):
    ROBOT_DATA.append((f"j{_i+1}_temperature", 316 + 2 * _i, "i32"))
for _i in range(6):
    ROBOT_DATA.append((f"j{_i+1}_servo_error", 328 + 2 * _i, "i32"))
for _i in range(6):
    ROBOT_DATA.append((f"j{_i+1}_error_state", 340 + _i, "u16"))
for _i in range(6):
    ROBOT_DATA.append((f"j{_i+1}_enabled", 346 + _i, "u16"))
for _i in range(6):
    ROBOT_DATA.append((f"j{_i+1}_collision", 352 + _i, "u16"))
for _i in range(6):
    ROBOT_DATA.append((f"j{_i+1}_current", 358 + 2 * _i, "f32"))
for _i, _n in enumerate(["fx", "fy", "fz", "tx", "ty", "tz"]):
    ROBOT_DATA.append((f"sensor_{_n}", 370 + 2 * _i, "f32"))
for _i in range(6):
    ROBOT_DATA.append((f"j{_i+1}_position", 382 + 2 * _i, "f32"))
for _i in range(6):
    ROBOT_DATA.append((f"j{_i+1}_speed", 394 + 2 * _i, "f32"))
for _i, _n in enumerate(["x", "y", "z", "rx", "ry", "rz"]):
    ROBOT_DATA.append((f"tcp_{_n}", 406 + 2 * _i, "f32"))
for _i, _n in enumerate(["x", "y", "z", "rx", "ry", "rz"]):
    ROBOT_DATA.append((f"tcp_speed_{_n}", 418 + 2 * _i, "f32"))
for _i, _n in enumerate(["x", "y", "z", "rx", "ry", "rz"]):
    ROBOT_DATA.append((f"tcp_offset_{_n}", 430 + 2 * _i, "f32"))
for _i, _n in enumerate(["x", "y", "z", "rx", "ry", "rz"]):
    ROBOT_DATA.append((f"base_offset_{_n}", 442 + 2 * _i, "f32"))
ROBOT_DATA += [
    ("protective_stop", 454, "u16"),
    ("emergency_stop", 455, "u16"),
    ("power_on", 456, "u16"),
    ("robot_enable", 457, "u16"),
    ("on_soft_limit", 458, "u16"),
    ("inpos", 459, "u16"),
    ("motion_mode", 460, "u16"),      # 4 servo pos, 2 admittance, 1 hand-guide, 0 other/jog
    ("reduction_level", 461, "u16"),  # 1 first-level, 2 second-level, 3 protective stop
    ("speed_ratio", 462, "f32"),
    ("motion_errcode", 464, "i32"),
    ("cab_temperature", 466, "f32"),
    ("cab_avg_power", 468, "f32"),
    ("cab_avg_current", 470, "f32"),
    ("conveyor_pulses", 472, "f32"),
    ("conveyor_speed", 474, "f32"),
    ("conveyor_dir", 476, "u16"),
    ("conveyor_origin_pulses", 477, "i32"),
]
ROBOT_DATA_START = 300
ROBOT_DATA_END = 480  # exclusive (479 reserved)

MOTION_MODES = {4: "servo position", 2: "admittance", 1: "hand-guide", 0: "jog/other"}


def _words(fmt, value):
    hi, lo = struct.unpack(">HH", struct.pack(fmt, value))
    return [lo, hi] if WORD_SWAP else [hi, lo]


def encode(typ, value):
    if typ == "u16":
        return [int(value) & 0xFFFF]
    if typ == "i16":
        return [struct.unpack(">H", struct.pack(">h", int(value)))[0]]
    if typ == "i32":
        return _words(">i", int(value))
    if typ == "f32":
        return _words(">f", float(value))
    raise ValueError(typ)


def decode(typ, words):
    if typ == "u16":
        return words[0]
    if typ == "i16":
        return struct.unpack(">h", struct.pack(">H", words[0]))[0]
    w = [words[1], words[0]] if WORD_SWAP else words[:2]
    raw = struct.pack(">HH", *w)
    if typ == "i32":
        return struct.unpack(">i", raw)[0]
    if typ == "f32":
        return struct.unpack(">f", raw)[0]
    raise ValueError(typ)


def build_block(values):
    """values: dict name->value. Returns list of words for 300..479."""
    words = [0] * (ROBOT_DATA_END - ROBOT_DATA_START)
    for name, addr, typ in ROBOT_DATA:
        w = encode(typ, values.get(name, 0))
        words[addr - ROBOT_DATA_START: addr - ROBOT_DATA_START + len(w)] = w
    return words


def parse_block(words, start=ROBOT_DATA_START):
    out = {}
    for name, addr, typ in ROBOT_DATA:
        i = addr - start
        n = 1 if typ in ("u16", "i16") else 2
        if 0 <= i and i + n <= len(words):
            out[name] = decode(typ, words[i:i + n])
    return out
