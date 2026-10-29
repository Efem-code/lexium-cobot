# This app vs EcoStruxure Cobot Expert

What you can do without opening Cobot Expert, as of v1.0.0 (29 Oct 2026, LXMRL03, firmware 1.7.0_60_SE).
"Verified" = tested on the real cobot; "built" = works in the simulator, format follows JAKA's protocol, not yet tried on the real cobot.

| Cobot Expert feature | This app | Status |
|---|---|---|
| Live status, joints, TCP, faults | 3D view, status lights, Data tab | verified |
| Joint jog | Jog tab (hold-to-run) | verified |
| Cartesian jog (base / tool) | Jog tab | verified |
| Jog in a user frame | – | not available over the command port |
| Move to point / go home | Points *Go*, *Go home*, *Move to sliders*, drag target | verified (joint moves) |
| Straight-line moves | drag target *Move linear*, L waypoints, scripts | built |
| Speed override | speed slider (applied by the bridge) | verified |
| Power on / enable / clear error | Robot tab | built (so far done from Cobot Expert / pendant) |
| Teach points + play | Points tab, loop, pause, J/L per point, files | built (single moves verified) |
| Programs: run / pause / resume / stop | Points → Programs on the cobot | built |
| Programs: create / edit (block editor) | **Script tab and Python SDK instead** | programs live in the app, not on the controller |
| Program list on the controller | – | not available (type the name) |
| Digital outputs / inputs | Data tab, scripts | DI verified (read); DO built |
| Payload | Setup → Payload | **verified** (write + read back) |
| Tool (TCP) offsets + active tool | Setup → Tool | built (read verified) |
| TCP calibration | Setup → Tool → 4-point calibration | built |
| User frames | Setup → User frame | built (read verified) |
| Collision sensitivity | Setup → Safety | view only (by design) |
| Safety limits, zones, reduced mode, safety I/O | – | Cobot Expert only (by design) |
| Free-drive / hand guiding | – | pendant or the button on the arm |
| Data logging | Data → Record → CSV | built |
| Simulation | built-in simulator, browser demo | built |
| Login / user levels / Remote hand-over | not needed for the command port | verified (motion works with Cobot Expert on Local) |
| Network, accounts, firmware, add-ons | – | Cobot Expert only |

## Things the app adds

- Python SDK and in-browser scripting, with the same commands.
- Bridge limits: floor height, joint limits and reach checked along the whole path before every move.
- iPad/phone control, including the iPad running the bridge itself (no PC).
- A public demo that runs entirely in the browser.

## Still to verify on the real cobot

Power on / enable from the page, straight-line moves, waypoint loops, writing tool offsets and user frames, digital outputs, and running a stored program. Each takes a minute with the arm parked and the E-stop in reach; the page reports whether each one took.
