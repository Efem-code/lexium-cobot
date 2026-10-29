# Lexium Cobot – PC Simulator & Controller

Simulate a Schneider **Lexium Cobot** on this PC, drive it with the mouse, then point the same app at the real arm, and later at a **Modicon TM262** PLC.

Python 3.10+ only, no pip installs, works offline.

```
 ┌───────────── this PC ─────────────┐
 │  Browser UI (mouse jog, 3D view)  │
 │            │ HTTP :8765           │
 │  PC controller (cobot/driver.py)  │──── same protocols ────┐
 │            │                      │                        │
 │  Virtual controller (sim) ◄───────┘  OR  real Lexium Cobot Controller
 │   Modbus TCP :502                 │         Modbus TCP :502
 │   JSON cmd   :10001               │         JSON cmd   :10001 (verify)
 │   JSON status:10000               │         JSON status:10000 (verify)
 └───────────────────────────────────┘
          ▲ later: TM262 (Machine Expert + LexiumCobotCommunication lib)
```

## Run it

```bash
python run.py
```

This starts the simulator and the controller UI, and opens http://127.0.0.1:8765. Or double-click `Start Simulator.bat`.

| Command | What it does |
|---|---|
| `python run.py` | sim + UI, auto-connected |
| `python run.py sim --public` | sim only, listening on the LAN (so a TM262 or another PC can connect) |
| `python run.py ui` | UI only; connect to a real cobot from the page |
| `python run.py --model LXMRL12` | pick the arm: `LXMRL03`, `LXMRL07`, `LXMRL12`, `LXMRL18` |
| `python -m tests.test_e2e` | 25-check end-to-end test over real sockets |

## iPad / phone

There are two ways to use the same app on an iPad or phone:

| | Demo | Live |
|---|---|---|
| Where | `https://efem-code.github.io/lexium-cobot/` (GitHub Pages) | `http://<PC-IP>:8765`, served by the bridge on the PC |
| Needs | nothing (works offline once opened) | the PC running `Start iPad Bridge.bat`, with the PC and the iPad on the cobot's Wi-Fi |
| Moves | the simulator, running on the iPad | the simulated cobot on the PC, or the real cobot |

On the iPad, open either address in Safari, then tap **Share → Add to Home Screen**. You get an app icon that opens full screen. Add both if you want both.

**Why a bridge?** Browsers can only make web requests. The cobot speaks Modbus TCP and raw TCP sockets, so something on its network has to translate, even when the iPad is on the cobot's own Wi-Fi. The bridge is `run.py`, running on a PC. Later it could run on a small always-on box such as a Raspberry Pi next to the cobot.

**iPad only, no PC:** the bridge also runs on the iPad itself in the free a-Shell app (`python3 ipad.py`), with the page opening inside a-Shell. See [docs/IPAD_ASHELL.md](docs/IPAD_ASHELL.md).

**Going live from the demo:**
1. Join the cobot's Wi-Fi on both the PC and the iPad.
2. Double-click `Start iPad Bridge.bat`. It prints the address to open and a 6-digit PIN.
3. In the demo app, go to **Setup → Go live**, type the address, enter the PIN once, and add it to the Home Screen.

The PIN and login are saved in `bridge.json` (never committed), so the iPad stays logged in between restarts. To change the PIN, run:

```bash
python run.py --lan --pin 4821
```

If the iPad can't open the address, Windows Firewall is the usual cause. Allow Python when Windows asks, and tick **Public** networks too: Windows usually labels the cobot's Wi-Fi as public.

## Using the UI

1. **Power on**, then **Enable**.
2. **Joint jog / Cartesian jog:** hold − or + to move, release to stop. The jog is hold-to-run: the page sends a keepalive every 100 ms, and the driver stops the arm 350 ms after the keepalive stops. That covers a closed tab or a dropped network.
3. **Mouse in the 3D view:**
   - Drag the green TCP ball to set a target. Shift+drag moves it up or down.
   - A blue ghost arm previews the target. Then click **Move linear** or **Move joint**.
   - Drag empty space to orbit, right-drag to pan, and use the wheel to zoom.
4. **Sliders:** set the joint targets (the ghost previews them), then click **Move to sliders**.
5. **Waypoints:** click **Teach** to store the current pose, and **Play** to run the list in order.
6. **Speed slider:** sets the speed override (`set_rapidrate`).
7. **STOP** or **Esc:** stops all motion.
8. **Simulator only:** E-stop, Fake collision (protective stop) and the Remote/Local control-source switch. Use these to test your error handling.

## Files

| File | Purpose |
|---|---|
| `cobot/kinematics.py` | FK/IK, model profiles, joint limits |
| `cobot/regmap.py` | Schneider's official Modbus address table (V1.7) |
| `cobot/modbus.py` | Modbus TCP server and client (FC 1–6, 15, 16) |
| `cobot/sim_robot.py` | virtual arm: state machine, jog, MoveJ/MoveL, limits, I/O |
| `cobot/jaka_proto.py` | JSON remote protocol, server (sim) and client (PC) |
| `cobot/sim_server.py` | virtual controller exposing all ports |
| `cobot/driver.py` | one API for sim or real, with read-only guard and jog watchdog |
| `cobot/web.py`, `cobot/static/index.html` | UI server and page |
| `docs/RESEARCH.md` | research findings and sources |
| `docs/REAL_HARDWARE.md` | step-by-step plan for connecting to your physical cobot |
| `docs/TM262_ROADMAP.md` | path to Machine Expert and the TM262 |
