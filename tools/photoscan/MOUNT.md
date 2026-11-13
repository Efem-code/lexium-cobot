# Wrist sensor mount — interface spec

Printable bracket on the cobot tool flange carrying the **SEC110** camera (fine
photogrammetry) and the **TiM240** 2D LiDAR (coarse volume). Mass + CoM of the
finished assembly go into the app's Payload field (the L03 is a 3 kg arm).

## Robot side — LXMRL03 tool flange (locked)

Standard **ISO 9409-1-50-4-M6**. From Schneider *Lexium Cobot Hardware Guide*
EIO0000004783.00 (06/2023), Technical Data / Tool Flange Details.

| Feature | Symbol | Value |
|---|---|---|
| Pitch (bolt) circle | ØQ | **Ø50 mm** |
| Mounting holes | N | **4 × M6**, 7 mm deep, torque 11 Nm |
| Centering bore (recessed) | ØZ | **Ø31.5 H7** (+0.025/0), 6.5 mm deep |
| Locating pin hole | ØP | **Ø6** (+0.012/0), 10 mm deep |
| Flange shaft OD | ØT2 | Ø68 mm (29 mm deep) |
| External centering | ØT1 | Ø63 (0/−0.030), 5.5 mm deep |
| Tool I/O connector | — | **M8** on the side of joint 6, near the flange |

Mount robot-side face therefore needs: a **Ø31.5 locating boss** (into the bore),
a **Ø6 dowel** (orientation/anti-rotation), **4 × M6 clearance** holes on the
Ø50 circle, and **clearance for the side M8 connector + cable**.

(Reference only — base mounting is a different Ø110 BCD, not this flange.)

## Sensor side — STILL NEEDED

Auto-fetch of the SICK datasheets failed (the links returned stubs; the real
drawings/CAD are on the SICK product pages). From **sick.com/1104981** (TiM240)
and **sick.com/1144993** (SEC110), the STEP files are ideal; otherwise the
dimensional drawing gives these few numbers each:

**TiM240 (1104981):**
- mounting hole pattern (positions + thread, e.g. 4 × M4) on which face
- overall W × H × D and weight
- height of the scan-plane / optical window above the mounting face, and the
  fan direction (must stay unobstructed)
- connector side (M12 ×2)

**SEC110 (1144993):**
- mounting thread/holes (tripod 1/4"? M-thread? bolt pattern)
- overall size and weight
- lens optical-axis position relative to the mounting face
- connector side

## Open design choices
- Relative aim: cameras parallel, or both toed-in at the work point ~300 mm out?
- Cable exit direction.
- Printer build volume + material (sets wall thickness / whether to split).
