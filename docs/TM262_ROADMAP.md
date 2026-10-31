# Roadmap: Machine Expert + Modicon TM262

The goal is for the TM262 to become the motion master, while this PC app becomes the HMI, monitor and simulator.

## Check first
- **LexiumCobotCommunication v1.0.1.0** needs Machine Expert **V2.2**, TM262 firmware **V5.2.8.9 or later**, and Lexium Cobot Controller **V1.7.0_51_SE or later**. Check all three on your hardware before buying or upgrading anything.
- The library works with all TM262 models: Motion M05, M15, M25, M35 and Logic L01, L10, L20.

## Found on this PC (2026-10-31)
- Machine Expert **V2.2** and **V2.3** are installed, with **LexiumCobotCommunication 1.0.3.0** (V2.2) and **1.1.0.0** (V2.3).
- `LCC.FB_CobotController` has the methods `Connect` / `ConnectTLS`, `PowerOn`, `EnableRobot`, `ClearFault`, `MoveJ`, `MoveL`, `MoveC`, `MoveTCP`, `JogStart`/`JogStop`, `SetDigitalOutput`, `SetSpeedOverride`, `StopRobotMovement`, `LoadProgram`/`StartProgram`, plus kinematics and trajectory recording. `LCC.FB_CobotControllerFeedback` reads the status stream.
- Schneider's help says commands use port **10001** and feedback port **10000**: the same JAKA JSON ports this app and its simulator use. So a TM262 can be pointed at the PC simulator (`lexium-cobot sim --public`, plain `Connect`) and later at the real cobot (`ConnectTLS`, since the real controller only speaks TLS).
- Caution: the real controller ignored `set_rapidrate` from this app, so `SetSpeedOverride` may also do nothing. Give each `MoveL`/`MoveJ` its own slow speed until that's tested.

## Drawing with the TM262 (G-code)
The page's **Draw** tab plans the drawing, and **Export for TM262** writes it as Structured Text: a `ST_DrawPoint` DUT and a `GVL_Drawing` list with every point in the base frame, the pen orientation, the speeds, and the start and finish joints. The PLC program then only has to run: `MoveJ` start, then `MoveL` through `aPoints[1..DRAW_POINTS]`, then `MoveJ` finish, waiting for each command to be acknowledged and in position. That program will be written against the method inputs as shown in Machine Expert, then tested against the simulator before the real arm.

## Phase A: PLC talks to the simulator (no robot needed)
1. On the PC:
   ```bash
   python run.py sim --public
   ```
   Allow Python through Windows Firewall on ports 502, 10001 and 10000.
2. **Modbus first** (works today, uses only standard Machine Expert pieces):
   1. In Machine Expert, add a **Modbus TCP IOScanner** (Generic Modbus TCP slave) on the TM262 Ethernet port. Target is the PC IP, unit ID 1.
   2. Add a channel: **FC04, read input registers, start 300, length 180, cyclic 50 ms**. Map it to an `ARRAY[0..179] OF WORD`.
   3. Decode the FLOAT32 pairs. For example, J1 = words 82–83 (register 382). Use `SEL`/`MEMCPY` into a `REAL` with high word first.
   4. Optional: FC15 write coils 40+ to drive robot DI, and FC02 read 8+ for robot DO.

   Result: the PLC sees the simulated arm live, exactly as it will see the real one.
3. **CobCom library against the sim:** add `LexiumCobotCommunication` and instantiate `LCC.FB_CobotController` plus the feedback FB. Point `Connect` at the PC IP. If the library speaks the JAKA JSON protocol (expected), the sim answers it. If it uses a different wire format, capture it with Wireshark and add the messages to `cobot/jaka_proto.py`. The sim is built to grow this way.

## Phase B: PLC talks to the real robot
Change only the IP address in the PLC project. Run the Stage 1–3 checks from `REAL_HARDWARE.md`, now with the PLC as master.

## Phase C: PC as HMI for the PLC
Pick one:
- **Simple:** keep this app reading the robot's Modbus directly (the robot accepts several Modbus clients) for monitoring. Motion commands go only through the PLC.
- **Clean:** expose a small handshake block in the TM262 (Modbus TCP server, or OPC UA, which the M262 has built in): request jog axis/direction, move target, command ID, acknowledge and error. Add a `PlcDriver` next to `CobotDriver` in `cobot/driver.py` with the same methods (`jog_start`, `command`, `status`). The UI won't change. Jog keepalive becomes a PLC heartbeat word that the PLC watchdogs.

Only one master should own motion at a time. JAKA's port 10001 accepts one client, and the newest connection kicks the old one. Once the PLC owns motion, the PC goes read-only or sends its requests through the PLC.
