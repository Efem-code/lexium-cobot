"""Capture orchestrator: drive the arm through the planned poses and grab an
image at each one, recording the pose alongside it for reconstruction.

Runs headless on ubuntuserver via cobot.sdk. The camera is pluggable:

  - StubCamera    - writes an empty placeholder; for dry runs with no hardware.
  - SEC110Camera  - pulls a still from the SICK SEC110 over its REST/RTSP API.
                    Needs the camera's address; filled in once it is on the net.

    python -m tools.photoscan.capture --host 192.168.10.94 --plan poses.json --out run1
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, ".")


# --------------------------------------------------------------- camera backends
class StubCamera:
    """No hardware: writes a 0-byte .jpg so the capture loop can be exercised."""

    def grab(self, path):
        open(path, "wb").close()
        return path


class SEC110Camera:
    """SICK SEC110 (sensingCam) still grab.

    The SEC110 is a 5 MP streaming camera: it exposes a REST API and an
    RTSP/MJPEG stream (not a file-per-shot trigger), so a 'still' is one frame
    pulled from the stream. Endpoint shape is confirmed against the camera's
    SOPAS/REST docs before first use; `snapshot_url` is left configurable.
    """

    def __init__(self, base_url, snapshot_path="/api/snapshot"):
        self.url = base_url.rstrip("/") + snapshot_path

    def grab(self, path):
        import urllib.request
        with urllib.request.urlopen(self.url, timeout=5) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)
        return path


# --------------------------------------------------------------- orchestrator
def run_capture(poses, camera, host, out_dir, settle_s=0.6, speed=0.1,
                dry_run=False):
    """Move through `poses` (from plan.py), grab an image at each, and write
    out_dir/poses.json mapping image -> robot TCP pose + joints."""
    os.makedirs(os.path.join(out_dir, "imgs"), exist_ok=True)
    records = []
    robot = None
    if not dry_run:
        from cobot.sdk import Robot  # lazy: plan-only use needs no connection
        robot = Robot.connect(host)        # direct to the real cobot (headless)
        robot.power_on(); robot.enable(); robot.arm(True)  # motion on - cell must be clear, E-stop in reach

    for n, item in enumerate(poses):
        pose = item["pose"]
        if robot is not None:
            robot.move_joint(item["joints"], speed=speed)  # joint move to the planned view
            time.sleep(settle_s)                           # let the arm settle before the shot
            actual = robot.pose()                          # record where it really is
        else:
            actual = pose
        img = os.path.join(out_dir, "imgs", f"view_{n:03d}.jpg")
        camera.grab(img)
        records.append({"image": os.path.relpath(img, out_dir), "pose": actual,
                        "joints": item["joints"]})
    if robot is not None:
        robot.close()
    json.dump({"host": host, "views": records},
              open(os.path.join(out_dir, "poses.json"), "w"), indent=1)
    return len(records)


def _main(argv=None):
    ap = argparse.ArgumentParser(description="Capture a photogrammetry sweep.")
    ap.add_argument("--plan", required=True, help="poses JSON from plan.py")
    ap.add_argument("--out", required=True, help="output run directory")
    ap.add_argument("--host", default="192.168.10.94", help="cobot IP (via the bridge/sdk)")
    ap.add_argument("--camera-url", help="SEC110 base URL, e.g. http://192.168.10.95")
    ap.add_argument("--dry-run", action="store_true", help="no arm, no camera: just exercise the loop")
    a = ap.parse_args(argv)

    poses = json.load(open(a.plan))["poses"]
    if a.dry_run:
        cam = StubCamera()
    elif a.camera_url:
        cam = SEC110Camera(a.camera_url)
    else:
        ap.error("give --camera-url (the SEC110) or use --dry-run")
    n = run_capture(poses, cam, a.host, a.out, dry_run=a.dry_run)
    print(f"captured {n} views -> {a.out}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
