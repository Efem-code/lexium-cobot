# photoscan — robot-swept photogrammetry (prototype)

Build a fine 3D model of an object by moving a wrist-mounted **SICK SEC110**
(5 MP color camera) around it on the Lexium Cobot, grabbing an image at each
pose, and reconstructing with photogrammetry (structure-from-motion + multi-view
stereo). The known robot poses give the reconstruction absolute scale.

This is the fine-detail path. The **TiM240** 2D LiDAR stays for the coarse
shape/volume job (±30 mm range noise — too coarse for a fine model at any
distance); photogrammetry with the 5 MP camera can reach sub-mm on textured,
matte objects.

## Pipeline

1. **Locate** — the SEC110 (fixed, beside the cell, or the same wrist camera in
   a pre-pass) finds the object on the work surface and gives a rough X-Y
   centre. *(stage 3 below; not built yet)*
2. **Plan** — `plan.py` builds a dome of camera viewpoints around that centre and
   solves the robot pose for each, with the camera modelled as the tool (TCP) so
   its +Z optical axis aims at the object. **Built and working.**
3. **Capture** — drive the arm through the reachable poses; at each, pull a frame
   from the SEC110 and record the pose. `capture.py` (orchestrator skeleton).
4. **Reconstruct** — feed the images (+ poses for scale) to COLMAP → dense point
   cloud → mesh. *(documented below; not wired yet)*

## What the planner proved (no hardware needed)

`python -m tools.photoscan.plan` checks every viewpoint against the L03's own
kinematics. Key result for the **LXMRL03** (475 mm reach) at the SEC110's
**300 mm minimum working distance**:

- Object **~120–150 mm in front of the base**, 300 mm standoff → **~23 of 36**
  dome views reachable.
- Coverage is a **partial dome** — top, front and sides. The arm **cannot orbit
  the base-facing back** of a nearby object in one setup (far side would be
  >600 mm from the base, past reach).
- Standoff is pinned at 300 mm (the camera's near limit), which is good: closer =
  more pixels on the object = finer reconstruction.

**Implication:** for full 360° coverage, either put the object on a **turntable**
(rotate between sweeps) or do a **second setup** from the far side, then merge the
clouds. One sweep gives a strong partial model.

## Still needed

- **Mount** (workstream A): the camera-from-flange offset becomes `--tool
  x,y,z,rx,ry,rz` so the poses aim the *camera*, not the flange. Until the mount
  is designed, the planner treats the camera as sitting at the flange.
- **SEC110 on the network**: IP + REST/RTSP endpoint, for `capture.py`.
- **Hand-eye calibration**: refine the camera-from-flange transform from a
  calibration-board capture (the printed `--tool` is the nominal starting point).
- **COLMAP** on `ubuntuserver` for reconstruction (stage 4).

## Deploy target

The whole pipeline is meant to run headless on **`ubuntuserver`** (demo room,
always on, on Tailscale) via `cobot.sdk` — so the laptop isn't needed. `plan.py`
needs nothing but the repo; `capture.py` needs the bridge/cobot and the camera.

## Reconstruction (stage 4, reference)

With images in `imgs/` and `poses.json` from the capture:

```bash
colmap feature_extractor   --database_path db.db --image_path imgs
colmap exhaustive_matcher  --database_path db.db
colmap mapper              --database_path db.db --image_path imgs --output_path sparse
colmap image_undistorter   --image_path imgs --input_path sparse/0 --output_path dense
colmap patch_match_stereo  --workspace_path dense
colmap stereo_fusion       --workspace_path dense --output_path dense/fused.ply
```

Then scale/align `fused.ply` to the robot frame using the recorded poses, and
mesh (e.g. Open3D Poisson). Robot poses resolve photogrammetry's scale ambiguity
and seed camera extrinsics, which makes the solve faster and metric.
