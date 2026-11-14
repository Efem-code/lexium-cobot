# TiM + SEC110 tool mount for the Lexium Cobot

This is a 3D-printable mount for the LXMRL03 tool flange (JAKA Zu 3: 4 × M6 on Ø50, Ø6 pin). It carries:
- a **SICK TiM5xx/7xx** 2D LiDAR (TiM561/571/781 all use the same housing)
- a **SICK sensingCam SEC110** camera

The design is one parametric OpenSCAD file, [tim_sec_mount.scad](tim_sec_mount.scad). The printable STLs are in [stl/](stl/).

![assembly](img/assembly.png)

**How the TiM sits:**
- It lies **on its side**: hood axis along the flange's X axis (the direction of travel), front face down at the belt, connectors up towards the arm.
- A TiM scans in the plane at right angles to its hood axis, so this makes the 270° fan stand **across the belt**, through the flange axis.
- Its 90° blind sector (around the connectors) faces the arm, so the fan never sees the robot.
- The scan origin is **X 0, Y 0, Z 62.5 mm** from the flange face. The app's Scan tab uses the same value for tool slot 1.

**The camera** hangs under the other end of the plate, looking down and tilted 15° back towards the scan line.

## Parts

| STL | Print | Time (estimate, not sliced) |
|---|---|---|
| `fit_test.stl` | flat, no supports | about 20 min. **Print this first.** |
| `bracket.stl` | flange face on the bed, no supports | about 4–5 h |
| `camera_bracket.stl` | on its side (as exported), no supports | about 1 h |

- **Material:** PETG or ASA. PLA creeps when it's warm, and the sensors and the arm get warm.
- **Settings:** 0.2 mm layers, 4 walls, 40 % gyroid infill.
- **Holes:** they are drawn to size. If your printer prints holes small, ream the Ø6 pin hole and drill out the M6 holes.

## Hardware

| Qty | Part | Where |
|---|---|---|
| 4 | M6 × 12 socket head + washers | bracket to the flange (counterbored, 6 mm in the plastic). About 4 Nm, not the 11 Nm rated for metal tools. |
| 1 | Ø6 × 16 dowel pin | in the pin hole: 7 mm in the plate, 9 mm in the flange. It sets the rotation. |
| 8 | M3 heat-set inserts (Ø4.0 hole) | cradle side walls, 4 per side |
| 8 | M3 × 8 nylon-tipped set screws | pinch the TiM in the cradle: snug, not tight (the TiM's housing is plastic too) |
| 2 | M4 heat-set inserts (Ø5.6 hole) | plate, for the camera bracket |
| 2 | M4 × 16 socket head | camera bracket to the plate |
| 2 | M4 × 8 socket head + washers | SEC110 to its bracket (about 4 mm into the camera: check its thread depth) |
| 2 | **right-angle** M12 cables | SEC110: Ethernet (4-pin D-coded) and power/I/O (4-pin A-coded). There is 34 mm above the camera. |
| 2 | M12 cables | TiM: they leave through the window in the cradle's end wall |

## Assembly

1. Press the heat-set inserts in: eight M3 in the cradle walls, two M4 from the top of the plate.
2. Fit the dowel and bolt the bracket to the flange. The bolt heads are only reachable before the TiM goes in.
3. Slide the TiM into the cradle base-first along −X, with its front face on the lip and its connectors through the end-wall window. Snug the eight set screws evenly.
4. Screw the SEC110 to the camera bracket, then bolt the bracket under the plate. Plug in the right-angle cables.
5. In the app: Scan tab → **scanner on the flange**. In the simulator that sets tool slot 1 (Z 62.5) and the 0.5 kg payload. On the real cobot, enter them in Setup → Tool and Payload.

## Check before trusting it

- **Fan direction:** the bolt pattern is symmetric, so it doesn't say which way the robot's own tool X points. After mounting, jog in Tool X and check the arm moves along the TiM's hood axis. If not, add the difference to the pass **Direction**, or turn the tool frame.
- **TiM grip:** the cradle holds the first 36 mm of the TiM's body, with windows over its M3 mounting recesses. Check that it's stiff enough at the speeds you use. `cradle_len` changes the length; it must stay below about 48 mm, where the TiM's hood begins.
- **TiM side faces:** the datasheet drawing shows a 0.7 mm step on the lower housing. The set screws take up the difference, but if the TiM rocks in the cradle, check the clearance (`clr`).
- **Camera focus:** the SEC110's working distance starts at **0.3 m**. Its lens sits about 14 mm lower than the TiM's scan origin, so the Scan tab's default pass height of 330 mm keeps the belt just over 0.3 m away. Don't scan lower than about 320 mm if you need the camera image. The L03 reaches a 330 mm pass at X 250–340 mm.
- **Not confirmed:** the SEC110 M4 thread depth, and where the arm's M8 tool connector sits around the flange (it's on the side of joint 6, and the plate stays within 36 mm of the axis at Y).

## Collision checks

The .scad file has check parts that intersect two things that must never touch. Each must come out empty (OpenSCAD then says *Current top level object is empty*):

| Check | What must not touch |
|---|---|
| `check_tim` | the bracket and the TiM (body, hood, connector unit and straight M12 plugs) |
| `check_cam_body`, `check_cam_plugs` | the brackets and the camera body, or its right-angle M12 plugs |
| `check_cam_tim` | the camera and the TiM |
| `check_brackets` | the bracket and the camera bracket |
| `check_fan` | anything printed, or the camera, inside the TiM's 270° fan |

All six were empty for the files in `stl/` (14 Nov 2026). Run them again after any change:

```bash
for p in check_tim check_cam_body check_cam_plugs check_cam_tim check_brackets check_fan; do openscad --backend=manifold -D "part=\"$p\"" -o /tmp/$p.stl tim_sec_mount.scad 2>&1 | grep -q -i empty && echo "$p ok" || echo "$p COLLISION"; done
```

## Change it

Open the .scad in OpenSCAD and edit the values at the top: clearances, `gap`, `cradle_len`, `cam_x`, `cam_drop`, `cam_tilt`. To export one part:

```bash
openscad --backend=manifold -D 'part="bracket"' -o stl/bracket.stl tim_sec_mount.scad
```

Sources: Schneider Hardware Guide EIO0000004783 (pp. 41–42), SICK datasheets TiM571-2050101 and TiM781-2174101 (p. 5), SEC110-5C9D1SFZZZZ (p. 5).
