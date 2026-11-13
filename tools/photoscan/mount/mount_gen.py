"""Parametric wrist-sensor mount for the Lexium Cobot (LXMRL03).

Rev A. The robot-side interface is to Schneider's spec (ISO 9409-1-50-4-M6,
see ../MOUNT.md). The two sensor interfaces use PLACEHOLDER dimensions flagged
CONFIRM below - replace them from the SICK TiM240 (1104981) and SEC110 (1144993)
drawings and re-run. Nothing here is final until those numbers are in.

Frame: flange face at Z=0, tool axis = +Z (toward the workpiece). The sensors
sit on a plate above the flange and look along +Z, matching plan.py's model of
the camera optical axis as the tool +Z.

    pip install trimesh manifold3d numpy    # (matplotlib only for --preview)
    python mount_gen.py --stl mount.stl --preview mount_preview.png
"""
from __future__ import annotations

import argparse
import math

import numpy as np
import trimesh

# ------------------------------------------------------------------ parameters
# Robot-side flange (LOCKED - Schneider Hardware Guide EIO0000004783)
FLANGE_BCD = 50.0        # ØQ pitch circle
BOLT_CLEAR = 6.5         # M6 clearance
CBORE_D, CBORE_H = 11.0, 6.0   # socket-head counterbore from the outer face
BOSS_D, BOSS_H = 31.3, 6.0     # locating boss into the Ø31.5 H7 bore (6.5 deep)
PIN_D = 6.2              # dowel into the Ø6 pin hole
PIN_RADIUS = 25.0        # pin sits on the pitch circle
CABLE_D = 16.0           # central cable pass-through

BASE_D, BASE_T = 72.0, 8.0     # flange disc (covers the Ø68 flange shaft)
PLATE = (170.0, 72.0, 7.0)     # sensor plate X,Y,Z  (wide enough for both sensors)
PLATE_Z = BASE_T               # plate sits on top of the base disc

# Sensor side (PLACEHOLDER - CONFIRM from SICK drawings) --------------------
# TiM240 2D LiDAR (1104981): envelope + back-face bolt pattern + optical offset.
TIM = dict(x=-48.0, env=(60.0, 60.0, 86.0), bolt_pitch=(45.0, 45.0),
           bolt_d=4.5, n_bolts=4)   # CONFIRM: pattern, thread, envelope, window height
# SEC110 5 MP camera (1144993): envelope + bolt pattern + lens(optical) offset.
SEC = dict(x=+50.0, env=(50.0, 50.0, 72.0), bolt_pitch=(30.0, 30.0),
           bolt_d=3.4, n_bolts=4)   # CONFIRM: tripod vs bolts, envelope, lens offset


# ------------------------------------------------------------------ helpers
def cyl(d, h, z0, segments=72):
    """Cylinder of diameter d, height h, bottom face at z=z0, axis +Z."""
    c = trimesh.creation.cylinder(radius=d / 2.0, height=h, sections=segments)
    c.apply_translation([0, 0, z0 + h / 2.0])
    return c


def box_at(size, center):
    b = trimesh.creation.box(extents=size)
    b.apply_translation(center)
    return b


def bolt_xy(pitch, n):
    px, py = pitch[0] / 2.0, pitch[1] / 2.0
    if n == 4:
        return [(-px, -py), (px, -py), (px, py), (-px, py)]
    return [(px * math.cos(a), py * math.sin(a))
            for a in (2 * math.pi * k / n for k in range(n))]


# ------------------------------------------------------------------ build
def build_mount():
    solids = [cyl(BASE_D, BASE_T, 0.0),                 # flange disc
              cyl(BOSS_D, BOSS_H, -BOSS_H),             # locating boss (into the bore)
              box_at(PLATE, [0, 0, PLATE_Z + PLATE[2] / 2.0])]  # sensor plate
    part = trimesh.boolean.union(solids)

    top = PLATE_Z + PLATE[2]            # outer surface the screws seat on
    bottom = -BOSS_H
    cuts = []
    # 4x M6 flange bolts, counterbored from the top
    for k in range(4):
        a = math.radians(45 + 90 * k)
        x, y = (FLANGE_BCD / 2) * math.cos(a), (FLANGE_BCD / 2) * math.sin(a)
        thru = cyl(BOLT_CLEAR, top - bottom + 2, bottom - 1)
        thru.apply_translation([x, y, 0])
        cb = cyl(CBORE_D, CBORE_H + 1, top - CBORE_H)
        cb.apply_translation([x, y, 0])
        cuts += [thru, cb]
    # dowel pin + central cable pass-through
    pin = cyl(PIN_D, top - bottom + 2, bottom - 1); pin.apply_translation([PIN_RADIUS, 0, 0])
    cuts.append(pin)
    cuts.append(cyl(CABLE_D, top - bottom + 2, bottom - 1))
    # sensor bolt patterns through the plate
    for s in (TIM, SEC):
        for (bx, by) in bolt_xy(s["bolt_pitch"], s["n_bolts"]):
            h = cyl(s["bolt_d"], PLATE[2] + 2, PLATE_Z - 1)
            h.apply_translation([s["x"] + bx, by, 0])
            cuts.append(h)
    part = trimesh.boolean.difference([part] + cuts)
    return part


def sensor_ghosts():
    """Envelope boxes for the preview only (not part of the printed STL)."""
    g = []
    for s in (TIM, SEC):
        w, d, hh = s["env"]
        g.append(box_at((w, d, hh), [s["x"], 0, PLATE_Z + PLATE[2] + hh / 2.0]))
    return g


def camera_offset():
    """SEC110 optical axis relative to the flange, for plan.py --tool (approx,
    until the lens offset is confirmed)."""
    return (SEC["x"], 0.0, PLATE_Z + PLATE[2] + SEC["env"][2])


def _preview(part, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    fig = plt.figure(figsize=(9, 6))
    ax = fig.add_subplot(111, projection="3d")
    ax.add_collection3d(Poly3DCollection(part.triangles, facecolor="#8aa0c8",
                                         edgecolor="none", alpha=1.0))
    for gh in sensor_ghosts():
        ax.add_collection3d(Poly3DCollection(gh.triangles, facecolor="#e8964a",
                                             edgecolor="#9a5a1a", alpha=0.35))
    allpts = np.vstack([part.vertices] + [g.vertices for g in sensor_ghosts()])
    lo, hi = allpts.min(0), allpts.max(0)
    ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_zlim(lo[2], hi[2])
    ax.set_box_aspect(hi - lo)   # true proportions, no axis stretch
    ax.set_xlabel("X (mm)"); ax.set_ylabel("Y (mm)"); ax.set_zlabel("Z tool axis (mm)")
    ax.view_init(elev=24, azim=-52)
    ax.set_title("Lexium Cobot wrist mount - Rev A (orange = sensor envelopes, placeholder)")
    fig.tight_layout(); fig.savefig(path, dpi=110); plt.close(fig)


def _main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stl", default="mount.stl")
    ap.add_argument("--preview")
    a = ap.parse_args()
    part = build_mount()
    part.export(a.stl)
    vol = part.volume / 1000.0  # cm^3
    print(f"mount: watertight={part.is_watertight}  volume={vol:.1f} cm^3  "
          f"~mass PLA {vol * 1.24:.0f} g / PETG {vol * 1.27:.0f} g")
    print(f"bbox (mm): {np.round(part.extents, 1).tolist()}")
    print(f"SEC110 optical offset for plan.py --tool: "
          f"{tuple(round(v, 1) for v in camera_offset())}  (x,y,z mm, CONFIRM)")
    if a.preview:
        _preview(part, a.preview)
        print(f"preview -> {a.preview}")


if __name__ == "__main__":
    _main()
