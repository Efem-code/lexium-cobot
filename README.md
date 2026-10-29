# Lexium Cobot – Simulator, Web Controller & Python SDK

Simulate a Schneider **Lexium Cobot**, drive it from a browser (PC, iPad or phone), script it in Python or JavaScript, then point the same tools at the real arm. Built and tested against a real **LXMRL03** (firmware 1.7.0_60_SE). Standard-library Python only, works offline.

Try it now, nothing to install: **https://efem-code.github.io/lexium-cobot/** (demo: a simulator running in your browser).

```
 browser page (3D view, jog, setup, programs, scripts)        Python scripts (cobot.sdk)
        │ HTTP :8765                                                │
        ▼                                                           ▼
 bridge = this app (PC .exe, run.py, or ipad.py in a-Shell)  ──or── Robot.connect(...)
   speed limit · floor/joint/reach limits · read-only until armed · jog dead-man
        │ JSON over TLS :10001 (commands) + :10000 (status)
        ▼
 real Lexium Cobot controller  ──or──  built-in simulator (same protocol)
```

## Install

| You want | Do this |
|---|---|
| **Windows, no Python** | Download `LexiumCobot.exe` from [Releases](https://github.com/Efem-code/lexium-cobot/releases) and double-click it. Windows may warn about an unknown publisher (the exe isn't code-signed): *More info → Run anyway*. |
| **Any OS with Python 3.9+** | `pip install git+https://github.com/Efem-code/lexium-cobot` then run `lexium-cobot` |
| **The source** | `git clone https://github.com/Efem-code/lexium-cobot` then `python run.py` (or double-click `Start Simulator.bat`) |
| **iPad, no PC** | free a-Shell app + `python3 ipad.py`: see [docs/IPAD_ASHELL.md](docs/IPAD_ASHELL.md) |

All of them start the simulator and open the controller page at http://127.0.0.1:8765.

| Command | What it does |
|---|---|
| `lexium-cobot` (or `python run.py`) | simulator + page, auto-connected |
| `lexium-cobot ui` | page only: connect to the real cobot from **Setup** |
| `lexium-cobot --lan` | also serve the page to phones/iPads on the same Wi-Fi (PIN protected) |
| `lexium-cobot sim --public` | simulator only, on the LAN (for a TM262 or another PC) |
| `lexium-cobot --model LXMRL12` | arm model: `LXMRL03` (default), `LXMRL07`, `LXMRL12`, `LXMRL18` |

Settings (bridge limits, iPad PIN) are saved per user in `%APPDATA%\LexiumCobot\settings.json` (Windows) or `~/.lexium-cobot/settings.json`.

## Connect to the real cobot

1. Join the cobot's Wi-Fi (SSID = controller serial, password on the label in the cabinet door). The controller is `10.5.5.100`.
2. Close Cobot Expert (or leave it on **Local**): the page doesn't need it, and too many connections overload the controller.
3. **Setup → Real cobot → Connect.** The page is **read-only** until you tick **Arm motion on real cobot**. The speed limit starts at **10 %** on every connect.

Details and everything verified on the real controller: [docs/REAL_HARDWARE.md](docs/REAL_HARDWARE.md).

## The page

| Tab / card | What you can do |
|---|---|
| **3D view** | live arm (matches the real one to < 0.3 mm). Drag the orange TCP ball to set a target (Shift+drag = up/down), preview it, then *Move linear* or *Move joint*. Drag = orbit, right-drag = pan, wheel = zoom. |
| **Jog** | hold-to-run joint and Cartesian (base/tool) jog. Release, a closed tab or a dropped network stops the arm within 350 ms. Joint sliders + *Move to sliders*. |
| **Robot** | power on/off, enable/disable, clear error, go home (asks first on the real cobot), status lights. |
| **Points** | teach waypoints (J = joint move, L = straight line per point), add **gripper open/close steps** (one digital output, or two for a double-acting valve, with a wait time; the simulator draws a SCHUNK Co-act EGP-C 40 whose jaws follow those outputs), reorder steps, play once or **loop continuously** with a pause, export/import as files, turn them into a script. **Programs on the cobot**: load a program saved on the controller by name, run / pause / resume / stop, with live state and line. |
| **Script** | write and run JavaScript with the same commands as the Python SDK; examples, save/open files, live log, Stop. |
| **Data** | joint speeds/currents/temperatures, digital I/O (tap a DO to switch it), controller log, **record to CSV**. |
| **Setup** | connect (simulator or real cobot); **payload**; **tool (TCP) slots**, active tool and **4-point tool calibration**; **user frames**; **bridge limits** (floor height, max joint and linear speed); collision sensitivity (view only). Every setting change is read back from the cobot to confirm it took. |

**STOP** (header) or **Esc** stops all motion and any running program.

## Program it

### Python

```python
from cobot.sdk import Robot

robot = Robot.simulator(powered=True)       # practise with no hardware
# robot = Robot.bridge()                    # through the running app: watch it in the 3D view
# robot = Robot.connect("10.5.5.100")       # straight to the real cobot (call robot.arm() to allow motion)

robot.speed(30)                              # percent
robot.home()
robot.move_linear(z=200)                     # straight line, keep x/y/orientation
robot.move_joint([0, 0, 0, 0, 0, 45], relative=True)
robot.set_do(0, True)
robot.wait_di(1, True, timeout=10)
```

Moves wait until the arm stops and raise `CobotError` on a refused command, a bridge limit, an E-stop, a protective stop or a controller error. Full API: [docs/SCRIPTING.md](docs/SCRIPTING.md). Examples: [examples/](examples/).

### In the browser

The **Script** tab runs the same commands in JavaScript (`await robot.move_linear({z: 200})`), in the demo or live, with no install. **Points → → Script** turns taught waypoints into a script you can edit.

## Safety model

This is an engineering tool, **not a safety function**. The cobot's own safety configuration (set in Cobot Expert), its collision detection and the hardware E-stop protect people. On top of that the bridge adds:

- **read-only until armed** on the real cobot (moves, I/O and setting changes all need *Arm motion*);
- a **speed limit** applied by the bridge itself (the controller ignores the speed-override command), 10 % on every connect;
- **floor / joint / reach limits** checked before every move (whole path), and a jog heading down stops at the floor;
- **hold-to-run jog** with a 350 ms dead-man;
- **safety settings are never sent** (collision sensitivity, limits, zones): change those in Cobot Expert.

Programs stored on the controller run at their own saved speeds: the bridge limits don't apply to them.

## What still needs Cobot Expert

Safety configuration, creating/editing programs stored on the controller, user accounts, network settings and firmware updates. See [docs/COBOT_EXPERT_PARITY.md](docs/COBOT_EXPERT_PARITY.md) for the full comparison.

## Develop

```bash
python -m tests.test_e2e     # driver + simulator over real sockets
python -m tests.test_sdk     # the Python SDK, scripted like a user would
```

Releases: `git tag v1.0.1 && git push origin v1.0.1` builds `LexiumCobot.exe` and publishes it (`.github/workflows/release.yml`). Every push to `main` redeploys the demo.

| File | Purpose |
|---|---|
| `cobot/sdk.py` | Python SDK (`Robot`) |
| `cobot/driver.py` | one API for sim or real: read-only guard, speed limit, bridge limits, jog watchdog |
| `cobot/jaka_proto.py` | JAKA JSON protocol: client (TLS) and simulator server |
| `cobot/sim_robot.py`, `cobot/sim_server.py` | the simulated controller |
| `cobot/kinematics.py` | FK/IK with the DH parameters read from the real controller |
| `cobot/web.py`, `cobot/static/` | the page (also runs standalone as the demo) |
| `cobot/cli.py` | the launcher (`lexium-cobot`, `run.py`, the .exe) |
| `ipad.py` | the bridge for a-Shell on iPad |
| `docs/` | real-hardware notes, iPad guide, scripting guide, research, TM262 roadmap |
