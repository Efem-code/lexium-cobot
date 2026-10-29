# Connecting to the physical Lexium Cobot

Go in stages, and move to the next stage only when the current one works. Keep the pendant or cabinet **E-stop within reach** whenever motion is armed.

## Verified on our cobot (28 Oct 2026)
Tested over the controller's Wi-Fi, read-only. Stages 0–1 are done, and part of Stage 2.

| Item | Finding |
|---|---|
| Controller | `LXMRL03S0000`, firmware `1.7.0_60_SE_X64`, robot ID `Zu31100019`, name "GuillevinCob" |
| Wi-Fi | The SSID is the controller serial. The password is unique per unit and printed on the label inside the cabinet door. The controller is at `10.5.5.100`, and the PC gets an address in `10.5.5.x`. |
| Open ports | 22, 10000, 10001, 10004, 50051 and 50052. All except 22 use **TLS 1.3** with a self-signed `LXM_Cobot` certificate. A plain TCP connection opens, but no data comes back. Port scans are rate-limited by the controller: probe ports one at a time. |
| Cobot Expert | Talks to the controller over **gRPC on 50051/50052** (login, user levels, Local/Remote control). The gRPC service refuses everything, including reflection, before login ("Access denied"), and its message formats are private, so the app does not use it. |
| Modbus 502 | Closed (not enabled). Not needed: the app reads state from the 10000 stream instead. |
| JSON protocol | Works over TLS. Confirmed read-only queries: `get_robot_state`, `get_joint_pos`, `get_tcp_pos`, `get_version` and `get_dh_param`. |
| Kinematics | JAKA modified DH. `get_dh_param` returns rows `[alpha, a, d, theta-offset]`. With nominal alphas and no theta offsets, the model matches the controller's TCP to 0.3 mm or better. |
| Load | Each status-stream client receives about 230 KB/s. With several clients connected, the controller stopped accepting connections and Cobot Expert couldn't enable. Keep one app connection at most, and disconnect while using Cobot Expert. |

| Jog (29 Oct 2026) | Verified from the page: joint jog (J1 moved only the base) and Cartesian jog (Z+ straight up), **with Cobot Expert left on Local**. No Remote hand-over or login is needed for the JSON command port. JAKA format: `jog_mode` 1 = continuous, 2 = fixed step (needs `poscmd`), 0 = stop; `jnum` is 0-based; a stop must carry the same `coord_map` + `jnum`. |
| Speed override (29 Oct 2026) | The controller does **not** answer `set_rapidrate`; its own override stays at 100% (`speed_rate` 1.0 in the stream). A "Go home" at a 40 deg/s setting ran at full speed. The bridge now scales every move/jog speed and acceleration itself in real mode, and starts at **10%** on every connect. |
| Setup + programs (29 Oct 2026) | Queries that work: `get_payload` (1.0 kg, CoM [0,0,90]), `get_tool_offsets` (11 slots, 0 = flange), `get_user_offsets`, `get_clsn_sensitivity` (level 3), `get_program_state`, `get_loaded_program`, `get_current_line`, `get_digital_input_status`, `get_extio_status`, `get_funcdi_status`, `kine_forward`, `kine_inverse`; `get_data` carries `current_tool_id` / `current_user_id`. Not supported: `get_program_list`, `get_tool_id`, `get_user_id`, drag-mode queries, safety config, joint/soft limits, analog/DO status. The page's Setup and Programs panels use these; their **writes** (`set_payload`, `set_tool_offsets`, `set_tool_id`, `set_user_offsets`, `set_user_id`, `load_program`, `play_program`, `pause_program`, `resume_program`) follow JAKA's documented format and are **not yet confirmed on this firmware**. The page reads every value back after a write and says whether it took. Safety commands are blocked by the bridge. |

The driver always uses TLS in real mode (probing could time out on a busy controller and fall back to plain TCP). Not yet tested on the real arm: power on/enable from the page, `joint_move` / `moveL`, waypoint playback.

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
1. Close Cobot Expert, or leave it on **Local**. (Verified: the JSON command port does not need the Remote hand-over.)
2. Set speed override to **10%** in the header.
3. Tick **Arm motion on real cobot** and confirm.
4. Click **Power on**, then **Enable**.
5. Briefly hold **J6 +**. Releasing the button, losing the network, or closing the tab stops the jog within about 350 ms.
6. Only after that, try Cartesian jog, then drag-target moves.

> Safety: this is an engineering tool, not a safety function. The cobot's own safety (collision detection, safety limits configured in Cobot Expert) and the hardware E-stop are what protect people. Do a risk assessment before any unattended or high-speed use.
