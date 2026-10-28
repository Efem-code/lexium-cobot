"""Generate the app icons (PNG) with the stdlib only: a simple cobot arm on green.

    python tools/make_icons.py
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "cobot", "static", "icons")

BG = (23, 28, 35)
GREEN = (61, 205, 88)
WHITE = (236, 240, 244)
DARK = (40, 48, 58)

# shapes in a 0..1 square: capsules (x1, y1, x2, y2, radius, colour), circles (x, y, r, colour)
CAPS = [
    (0.30, 0.82, 0.30, 0.62, 0.075, WHITE),   # base column
    (0.30, 0.62, 0.62, 0.36, 0.065, WHITE),   # upper arm
    (0.62, 0.36, 0.74, 0.58, 0.055, WHITE),   # forearm
    (0.74, 0.58, 0.74, 0.70, 0.040, WHITE),   # wrist
]
CIRCLES = [
    (0.30, 0.62, 0.06, GREEN), (0.62, 0.36, 0.05, GREEN), (0.74, 0.58, 0.042, GREEN),
]
BASE = (0.18, 0.80, 0.42, 0.86, DARK)  # rounded base plate (x1, y1, x2, y2)


def seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy or 1)))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def render(size, rounded):
    rows = []
    aa = 1.5 / size
    rad = 0.22  # corner radius for non-maskable icons
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            x, y = (i + 0.5) / size, (j + 0.5) / size
            col = BG
            # base plate
            bx1, by1, bx2, by2, bc = BASE
            d = seg_dist(x, y, bx1, (by1 + by2) / 2, bx2, (by1 + by2) / 2) - (by2 - by1) / 2
            if d < aa:
                col = mix(col, bc, clamp(0.5 - d / aa))
            for x1, y1, x2, y2, r, c in CAPS:
                d = seg_dist(x, y, x1, y1, x2, y2) - r
                if d < aa:
                    col = mix(col, c, clamp(0.5 - d / aa))
            for cx, cy, r, c in CIRCLES:
                d = math.hypot(x - cx, y - cy) - r
                if d < aa:
                    col = mix(col, c, clamp(0.5 - d / aa))
            alpha = 255
            if rounded:
                qx, qy = max(abs(x - 0.5) - (0.5 - rad), 0), max(abs(y - 0.5) - (0.5 - rad), 0)
                d = math.hypot(qx, qy) - rad
                alpha = int(255 * clamp(0.5 - d / aa))
            row += bytes(col) + bytes([alpha])
        rows.append(bytes(row))
    return rows


def clamp(v):
    return max(0.0, min(1.0, v))


def mix(a, b, t):
    return tuple(int(a[k] + (b[k] - a[k]) * t) for k in range(3))


def write_png(path, size, rows):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    # iOS draws its own rounded corners, so the touch icon is square and opaque
    for name, size, rounded in [("icon-192.png", 192, False), ("icon-512.png", 512, False),
                                ("apple-touch-icon.png", 180, False)]:
        write_png(os.path.join(OUT, name), size, render(size, rounded))
        print("wrote", name)
