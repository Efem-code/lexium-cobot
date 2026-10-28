# Research: Lexium Cobot + EcoStruxure Cobot Expert

## The hardware
- **Lexium Cobot:** Schneider's cobot line, launched in 2023. The arms are built with or by **JAKA Robotics**, and Schneider has invested in JAKA. The hardware matches JAKA's Zu arms. Schneider developed most of the software (Cobot Expert, the Machine Expert library).
- **Models:**

  | Reference | Payload | Reach |
  |---|---|---|
  | LXMRL03C1000 | 3 kg | ~626 mm |
  | LXMRL07C1000 | 7 kg | ~819 mm |
  | LXMRL12C1000 | 12 kg | ~1327 mm |
  | LXMRL18 | 18 kg | ~1073 mm |

  Each is a 6-axis, UR/JAKA-style arm with a separate **Lexium Cobot Controller** cabinet.
- **EcoStruxure Cobot Expert:** the Windows or Android programming app (the JAKA App, rebranded and extended). It connects over LAN or WiFi to the controller. The first login is `Administrator`/`Administrator`, and you must change it. User levels are Operator, Technician and Administrator.
- **Fieldbuses on the controller:** TCP/IP, Modbus TCP, Modbus RTU, PROFINET, EtherNet/IP.
- **Control source:** Local (Cobot Expert), **Remote** (the LexiumCobotCommunication library and digital-input functions), or the teach pendant. External motion commands only work after a Technician or Administrator hands control to **Remote** in Cobot Expert.

## Interfaces you can use from a PC

| Interface | Port | Status | Use |
|---|---|---|---|
| Modbus TCP server | 502 | **Documented by Schneider** (address table, V1.7) | Live joints, TCP, speeds, currents, temperatures, voltages, F/T sensor, power/enable/e-stop/protective-stop, in-position, mode, speed %, error code, cabinet data, digital and analog I/O |
| JSON command socket | 10001 | JAKA protocol. **Schneider page not public, so verify on your unit** | power/enable, joint_move, moveL, jog, stop, set_rapidrate, I/O |
| JSON status stream | 10000 | JAKA protocol. **Verify** | High-rate state stream |
| LexiumCobotCommunication (CobCom) lib | TCP (+TLS) | **Documented by Schneider** for M262/PacDrive | PLC-side FB_CobotController: Connect/ConnectTLS, MoveL, ClearFault, GetControlSource, feedback FB |

### Modbus map highlights (FC04 input registers, FLOAT32/INT32 big-endian, 2 registers each)
- 382–392: joint positions J1–J6 (°)
- 394–404: joint speeds (°/s)
- 406–416: TCP X, Y, Z (mm) and RX, RY, RZ (°)
- 418–428: TCP speed
- 430–441: tool offset
- 442–453: user frame
- 358–368: joint currents (A)
- 316–326: temperatures (INT32, °C)
- 304–314: voltages
- 370–380: F/T sensor
- Single 16-bit flags at 454–461: protective stop, e-stop, power, enable, soft limit, in position, motion mode, reduction level
- 462: speed % (FLOAT32)
- 464: error code (INT32)
- 466–470: cabinet temperature, power and current
- 472–478: conveyor tracking
- I/O: FC02 discrete 8–135 = robot DO0–127; FC01/05/15 coils 40–167 = DI0–127; FC04 96–191 = AO; FC03/06/16 100–195 = AI

The full map is in `cobot/regmap.py`.

**The Modbus map has no motion-command registers.** You can only command motion over Modbus indirectly: a Cobot Expert program reads the I/O/registers and acts on them. Direct PC or PLC motion goes over the TCP command interface.

## LexiumCobotCommunication (Machine Expert V2.2)
- Library v1.0.1.0. It supports **TM262M05/M15/M25/M35 and TM262L01/L10/L20 at firmware V5.2.8.9 or later**, PacDrive LMC Eco/Pro2 V1.76.11 or later, and Lexium Cobot Controller **V1.7.0_51_SE or later**.
- Namespace `LCC`. It provides `FB_CobotController` (methods include Connect, ConnectTLS, MoveL, ClearFault, GetControlSource) and `FB_CobotControllerFeedback`. The feedback data includes xRobotEnabled, xProtectiveStop, etMode (Manual/Drag…), xInPosition, etProgramState, udiCommandId and stLogData.
- MoveL takes a target pose (GEM.ST_CartesianPose), speed in mm/s, acceleration in mm/s² and an arc-transition blend in mm. It needs Remote control, the arm enabled, no protective stop, no jog active and no program running. The simulator enforces the same preconditions.

## Sources
- [Lexium Cobot Modbus Address Table (Cobot Expert User Guide V1.7)](https://product-help.se.com/docs/Lexium%20Cobot/V1.7/en/ESCEUG/ESCEUG/ModbusAdressTable-714042C5.html)
- [Modbus Parameter Setting](https://product-help.schneider-electric.com/Lexium%20Cobot/V1.7/en/ESCEUG/ESCEUG/ModbusParameterSetting-784C0AC4.html)
- [Connecting the Lexium Cobot](https://product-help.se.com/docs/Lexium%20Cobot/V1.7/en/ESCEUG/ESCEUG/ConnectingTheRobot-71249165.html)
- [LexiumCobotCommunication compatibility V1.0.1.0](https://product-help.se.com/docs/Machine%20Expert/V2.2/en/CobCom/CobCom/V1.0.0.0-892DAD97.html)
- [FB_CobotController – MoveL](https://product-help.se.com/docs/Machine%20Expert/V2.2/en/CobCom/CobCom/FB_CobotController-MoveLMethod-7FE8CB4B.html)
- [LexiumCobotCommunication General Information](https://product-help.schneider-electric.com/Machine%20Expert/V2.2/en/CobCom/CobCom/GeneralInformation-1D9A0FD4.html)
- [JAKA TCP/IP protocol (ports 10000/10001)](https://www.jaka.com/docs/en/guide/V3/tcpip.html)
- [JAKA news: Schneider partnership](https://www.jaka.com/en/newsDetail/350)
- [mrk-blog: "New Cobot from Schneider Electric: made by JAKA"](https://mrk-blog.de/en/neuer-cobot-von-schneider-electric-made-by-jaka-china/)
- [Automation World: Schneider debuts new cobot line](https://www.automationworld.com/factory/robotics/article/33039447/schneider-electric-debuts-new-cobot-line)
- [Lexium Cobot catalog (PDF)](https://coevagi.com/wp-content/uploads/2024/01/Schneider-Lexium-Cobot.pdf)
