"""Photogrammetry capture planner for the Lexium Cobot.

Plans a dome of camera viewpoints around an object and works out the robot
poses that put the wrist camera (the SEC110) at each viewpoint looking at the
object. Reachability is checked with the arm's own kinematics, so this runs
with no hardware and no bridge - it is the piece we can prove before the
camera is even mounted.

The camera is modelled as the tool (TCP): its optical axis is the tool +Z, so
IK solves for the flange pose that aims the camera at the target. Set
`tool_offset` to the real camera-from-flange transform once the mount exists;
until then [0,0,0,0,0,0] treats the camera as sitting at the flange.

    python -m tools.photoscan.plan                 # sample run, prints a report
    python -m tools.photoscan.plan --json out.json # also save reachable poses
"""
from __future__ import annotations

import argparse
import json
import math
import sys

sys.path.insert(0, ".")
from cobot import kinematics as K  # noqa: E402

R2D = 180.0 / math.pi
D2R = math.pi / 180.0


# ----------------------------------------------------------------- vector math
def _sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _add(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def _scale(a, s):
    return [a[0] * s, a[1] * s, a[2] * s]


def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]]


def _norm(a):
    n = math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
    return [a[0] / n, a[1] / n, a[2] / n] if n > 1e-9 else [0.0, 0.0, 0.0]


def look_at_pose(viewpoint, target):
    """TCP pose [x,y,z,rx,ry,rz] (mm, deg) that places the camera at `viewpoint`
    with its +Z optical axis pointing at `target`."""
    z = _norm(_sub(target, viewpoint))          # optical axis: toward the object
    up = [0.0, 0.0, 1.0]
    if abs(z[0] * up[0] + z[1] * up[1] + z[2] * up[2]) > 0.99:
        up = [0.0, 1.0, 0.0]                     # looking near-vertical: pick another up
    x = _norm(_cross(up, z))
    y = _cross(z, x)
    # rotation matrix (row-major); columns are the tool axes in the base frame
    R = [[x[0], y[0], z[0]],
         [x[1], y[1], z[1]],
         [x[2], y[2], z[2]]]
    rx, ry, rz = K.R_to_rpy(R)
    return [viewpoint[0], viewpoint[1], viewpoint[2], rx * R2D, ry * R2D, rz * R2D]


# ----------------------------------------------------------------- dome of views
def dome_viewpoints(target, standoff, n_rings=3, n_az=12,
                    elev_min=20.0, elev_max=75.0):
    """Viewpoints on a partial sphere (a dome) of radius `standoff` centred on
    `target`, from `elev_min` to `elev_max` degrees above the horizon. Azimuth
    is offset ring-to-ring so the views interleave rather than stack."""
    views = []
    rings = [elev_max] if n_rings == 1 else \
        [elev_min + (elev_max - elev_min) * i / (n_rings - 1) for i in range(n_rings)]
    for ri, elev in enumerate(rings):
        ce, se = math.cos(elev * D2R), math.sin(elev * D2R)
        for k in range(n_az):
            az = (k + 0.5 * (ri % 2)) * 360.0 / n_az * D2R
            direction = [ce * math.cos(az), ce * math.sin(az), se]
            views.append(_add(target, _scale(direction, standoff)))
    return views


# ----------------------------------------------------------------- the plan
def plan_capture(model="LXMRL03", target=(350.0, 0.0, 150.0), standoff=350.0,
                 tool_offset=(0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
                 n_rings=3, n_az=12, elev_min=20.0, elev_max=75.0, floor_z=0.0):
    """Returns (reachable, skipped). Each reachable entry has the viewpoint, the
    TCP pose and the joint solution; skipped entries carry the reason."""
    arm = K.Arm(model)
    arm.tool = list(tool_offset)
    target = list(target)
    views = dome_viewpoints(target, standoff, n_rings, n_az, elev_min, elev_max)
    reach = arm.profile["a2"] + arm.profile["a3"] + arm.profile["d5"] + arm.profile["d6"]

    reachable, skipped = [], []
    seed = list(K.HOME)
    for i, vp in enumerate(views):
        if vp[2] < floor_z:
            skipped.append({"i": i, "viewpoint": vp, "reason": "below floor"})
            continue
        if math.hypot(vp[0], vp[1]) > reach or abs(vp[2] - arm.profile["d1"]) > reach:
            skipped.append({"i": i, "viewpoint": vp, "reason": "outside reach envelope"})
            continue
        pose = look_at_pose(vp, target)
        try:
            q = arm.ik(pose, seed)
        except ValueError:
            skipped.append({"i": i, "viewpoint": vp, "reason": "no IK solution"})
            continue
        if not K.within_limits(q):
            skipped.append({"i": i, "viewpoint": vp, "reason": "joint limit"})
            continue
        # confirm the solution really hits the pose (IK can converge to a near miss)
        got = arm.fk(q)
        if math.dist(got[:3], pose[:3]) > 1.0:
            skipped.append({"i": i, "viewpoint": vp, "reason": "IK off target"})
            continue
        reachable.append({"i": i, "viewpoint": vp, "pose": pose,
                          "joints": [round(a, 3) for a in q]})
        seed = q  # warm-start the next view from this one (neighbouring views)
    return reachable, skipped


def _main(argv=None):
    ap = argparse.ArgumentParser(description="Plan a photogrammetry capture dome for the Lexium Cobot.")
    ap.add_argument("--model", default="LXMRL03", choices=list(K.PROFILES))
    ap.add_argument("--target", default="350,0,150", help="object centre x,y,z in mm (base frame)")
    ap.add_argument("--standoff", type=float, default=350.0, help="camera distance to target, mm")
    ap.add_argument("--rings", type=int, default=3, help="elevation rings")
    ap.add_argument("--az", type=int, default=12, help="views per ring")
    ap.add_argument("--elev", default="20,75", help="min,max elevation degrees")
    ap.add_argument("--tool", default="0,0,0,0,0,0", help="camera offset from flange x,y,z,rx,ry,rz")
    ap.add_argument("--json", help="write reachable poses to this file")
    a = ap.parse_args(argv)
    target = [float(v) for v in a.target.split(",")]
    emin, emax = (float(v) for v in a.elev.split(","))
    tool = [float(v) for v in a.tool.split(",")]

    reachable, skipped = plan_capture(a.model, target, a.standoff, tool,
                                      a.rings, a.az, emin, emax)
    total = len(reachable) + len(skipped)
    print(f"{a.model}: object at {target} mm, standoff {a.standoff:.0f} mm, "
          f"{a.rings} rings x {a.az} views")
    print(f"  reachable: {len(reachable)}/{total}")
    reasons = {}
    for s in skipped:
        reasons[s["reason"]] = reasons.get(s["reason"], 0) + 1
    for r, n in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"  skipped ({r}): {n}")
    if reachable:
        zmax = max(r["pose"][2] for r in reachable)
        print(f"  reachable views span Z {min(r['pose'][2] for r in reachable):.0f}"
              f"..{zmax:.0f} mm")
    if a.json:
        json.dump({"model": a.model, "target": target, "standoff": a.standoff,
                   "tool_offset": tool, "poses": reachable}, open(a.json, "w"), indent=1)
        print(f"  wrote {len(reachable)} poses to {a.json}")
    return 0 if reachable else 1


if __name__ == "__main__":
    raise SystemExit(_main())
