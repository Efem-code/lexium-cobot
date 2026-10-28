# Connecting to the physical Lexium Cobot

Go in stages, and move to the next stage only when the current one works. Keep the pendant or cabinet **E-stop within reach** whenever motion is armed.

## Verified on our cobot (28 Oct 2026)
Tested over the controller's Wi-Fi, read-only. Stages 0–1 are done, and part of Stage 2.

| Item | Finding |
|---|---|
| Controller | `LXMRL03S0000`, firmware `1.7.0_60_SE_X64`, robot ID `Zu31100019`, name "GuillevinCob" |
| Wi-Fi | The SSID is the controller serial. The password is unique per unit and printed on the label inside the cabinet door. The controller is at `10.5.5.100`, and the PC gets an address in `10.5.5.x`. |
| Open ports | 22, 10000, 10001 and 10004. All except 22 use **TLS 1.3** with a self-signed `LXM_Cobot` certificate. A plain TCP connection opens, but no data comes back. |
| Modbus 502 | Closed (not enabled). Not needed: the app reads state from the 10000 stream instead. |
| JSON protocol | Works over TLS. Confirmed read-only queries: `get_robot_state`, `get_joint_pos`, `get_tcp_pos`, `get_version` and `get_dh_param`. |
| Kinematics | JAKA modified DH. `get_dh_param` returns rows `[alpha, a, d, theta-offset]`. With nominal alphas and no theta offsets, the model matches the controller's TCP to 0.3 mm or better. |
| Load | Each status-stream client receives about 230 KB/s. With several clients connected, the controller stopped accepting connections and Cobot Expert couldn't enable. Keep one app connection at most, and disconnect while using Cobot Expert. |

The driver detects TLS automatically. Not yet tested: anything that changes state (power, enable, jog, move).

## Stage 0: network
1. Find the controller IP in Cobot Expert: **Cobot connection icon → Robot IP**.
2. Put this PC on the same subnet. Use a wired LAN, not WiFi, for anything that moves the arm.
3. Check that the PC can reach it:
   ```bash
   ping <robot-ip>
   ```
4. Check the ports in PowerShell:
   ```bash
   Test-NetConnection <robot-ip> -Port 502
   ```
   Then repeat with `-Port 10001` and `-Port 10000`.

## Stage 1: read-only monitoring over Modbus (safe, no motion possible)
1. In Cobot Expert, go to **Settings → Hardware and communication → Modbus**. Enable **Modbus TCP**, then restart the controller. The arm must be disabled while you change this.
2. Start the UI only:
   ```bash
   python run.py ui
   ```
3. In the page, choose **Real cobot**, enter the IP, and click **Connect**. The header should show **Modbus** in green and **read-only**.
4. Jog the arm with the pendant or Cobot Expert, and check that the 3D model follows. Compare the joint values with Cobot Expert.
   - **Garbage values** (huge numbers or NaN): set `WORD_SWAP = True` in `cobot/regmap.py`.
   - **3D pose mismatch** (the numbers match but the drawing doesn't): send `{"cmdName": "get_dh_param"}` and copy the `a`/`d` rows into `PROFILES` in `cobot/kinematics.py` and `cobot/static/sim.js`.

At this point you have live real-time data on the PC: joints, TCP, speeds, currents, temperatures, I/O and faults.

## Stage 2: verify the command port (still no motion)
Stage 2 checks whether the Schneider firmware exposes JAKA's port 10001.

1. If **Cmd 10001** turns green after you connect, the port is open.
2. Click **Clear error**. This command is harmless. A reply means the JSON protocol works.
3. If the port is closed or the replies differ:
   - Look for a TCP/IP or "remote" setting in Cobot Expert.
   - Ask Schneider support for the *Lexium Cobot TCP/IP remote protocol* (it is the same interface the LexiumCobotCommunication library uses).
   - Adapt `cobot/jaka_proto.py`. The driver and UI won't change.

## Stage 3: mouse control
1. In Cobot Expert, a Technician or Administrator user clicks **Remote Control** to hand the control source to Remote.
2. Set speed override to **10%** in the header.
3. Tick **Arm motion on real cobot** and confirm.
4. Click **Power on**, then **Enable**.
5. Briefly hold **J6 +**. Releasing the button, losing the network, or closing the tab stops the jog within about 350 ms.
6. Only after that, try Cartesian jog, then drag-target moves.

> Safety: this is an engineering tool, not a safety function. The cobot's own safety (collision detection, safety limits configured in Cobot Expert) and the hardware E-stop are what protect people. Do a risk assessment before any unattended or high-speed use.
