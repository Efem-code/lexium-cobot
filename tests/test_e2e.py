"""End-to-end test: virtual controller <-> driver over real sockets.

Run:  python -m tests.test_e2e     (from the lexium-cobot folder)
Uses non-default ports so it can run while the app is up.
"""
import math
import os
import sys
import tempfile
import time

sys.path.insert(0, ".")
os.environ["LEXIUM_COBOT_HOME"] = tempfile.mkdtemp(prefix="cobot-test-")  # never touch real settings
from cobot import kinematics as K  # noqa: E402
from cobot import regmap as RM  # noqa: E402
from cobot.driver import CobotDriver  # noqa: E402
from cobot.modbus import ModbusClient  # noqa: E402
from cobot.sim_server import VirtualController  # noqa: E402

MB, CMD, ST = 15020, 15001, 15000
fails = []


def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))
    if not cond:
        fails.append(name)


def wait(pred, timeout=10.0):
    t = time.time()
    while time.time() - t < timeout:
        if pred():
            return True
        time.sleep(0.05)
    return False


def ok(r):
    return r.get("errorCode") in ("0", 0)


# kinematics round trip
arm = K.Arm("LXMRL03")
for q in ([10, 80, -70, 100, -80, 30], [-45, 120, -100, 60, -90, 90]):
    pose = arm.fk(q)
    q2 = arm.ik(pose, K.HOME)
    err = math.dist(arm.fk(q2)[:3], pose[:3])
    check(f"IK round trip {q}", err < 0.1, f"{err:.4f} mm")

# regmap round trip
words = RM.build_block({"j1_position": 12.5, "motion_errcode": -7, "power_on": 1})
vals = RM.parse_block(words)
check("regmap float/int round trip",
      abs(vals["j1_position"] - 12.5) < 1e-6 and vals["motion_errcode"] == -7 and vals["power_on"] == 1)

vc = VirtualController("127.0.0.1", MB, CMD, ST).start()
time.sleep(0.3)
d = CobotDriver()
d.connect("127.0.0.1", "sim", MB, CMD, ST, "LXMRL03")
check("modbus state arrives", wait(lambda: d.status().get("joints") is not None))
check("status stream arrives", wait(lambda: d.status().get("control_source") is not None))
s = d.status()
check("modbus joints == sim joints",
      max(abs(a - b) for a, b in zip(s["joints"], vc.robot.q)) < 0.5)

r = d.command("joint_move", relFlag=0, jointPosition=[0, 90, -90, 90, -90, 30], speed=50, accel=100)
check("motion refused while unpowered", not ok(r), r.get("errorMsg"))

check("power_on", ok(d.command("power_on")))
check("enable_robot", ok(d.command("enable_robot")))
check("modbus shows enabled", wait(lambda: d.status().get("enabled") is True))

tgt = [20, 100, -95, 85, -90, 30]
r = d.command("joint_move", relFlag=0, jointPosition=tgt, speed=90, accel=300)
check("joint_move accepted", ok(r), r.get("errorMsg"))
check("joint_move reaches target",
      wait(lambda: d.status()["inpos"] and max(abs(a - b) for a, b in zip(d.status()["joints"], tgt)) < 0.05))

start = d.status()["tcp"]
goal = list(start)
goal[0] += 60
goal[2] -= 40
r = d.command("moveL", relFlag=0, cartPosition=goal, speed=200, accel=1000)
check("moveL accepted", ok(r), r.get("errorMsg"))
check("moveL reaches target", wait(lambda: d.status()["inpos"] and math.dist(d.status()["tcp"][:3], goal[:3]) < 0.5),
      str([round(v, 1) for v in d.status()["tcp"][:3]]))

# joint jog with keepalive, then let watchdog stop it
j0 = d.status()["joints"][0]
check("jog start", ok(d.jog_start("joint", 0, +1, 30)))
for _ in range(6):
    time.sleep(0.1)
    d.jog_keepalive()
time.sleep(0.15)
moved = d.status()["joints"][0] - j0
check("jog moved J1 while held", moved > 10, f"{moved:.1f} deg")
time.sleep(0.8)  # no keepalive -> watchdog must stop it
a = d.status()["joints"][0]
time.sleep(0.4)
b = d.status()["joints"][0]
check("dead-man watchdog stopped jog", abs(b - a) < 0.01, f"drift {b-a:.3f}")

# cartesian jog base +Z
z0 = d.status()["tcp"][2]
check("cart jog start", ok(d.jog_start("base", 2, +1, 50)))
for _ in range(5):
    time.sleep(0.1)
    d.jog_keepalive()
d.jog_stop()
time.sleep(0.2)
tcp = d.status()["tcp"]
# direction check; distance varies 10-25 mm with machine load
check("cart jog moved +Z", tcp[2] - z0 > 3, f"dz {tcp[2]-z0:.1f}")

# bridge limits (checked before anything is sent)
from cobot.driver import LimitError  # noqa: E402
d.jog_stop()
time.sleep(0.2)


def refused(name, **f):
    try:
        d.command(name, **f)
        return False
    except LimitError:
        return True


check("joint target outside limits refused", refused("joint_move", relFlag=0, jointPosition=[0, 300, -90, 90, 90, 0], speed=20, accel=100))
d.set_limits(z_min=d.status()["tcp"][2] + 50)
check("move below the floor limit refused", refused("joint_move", relFlag=0, jointPosition=K.HOME, speed=20, accel=100))
d.set_limits(z_min=-1000)
check("unreachable moveL refused", refused("moveL", relFlag=0, cartPosition=[3000, 0, 300, 180, 0, 0], speed=50, accel=500))
d.set_limits(joint_speed_max=5)
check("speed capped to the joint limit", d._check_motion("joint_move", dict(relFlag=0, jointPosition=list(d.status()["joints"]), speed=90))["speed"] == 5)
d.set_limits(joint_speed_max=120, z_min=0)
# floor stop while jogging down
r = d.command("joint_move", relFlag=0, jointPosition=[0, 90, -90, 90, 90, 0], speed=90, accel=300)
wait(lambda: d.status()["inpos"] and abs(d.status()["joints"][2] + 90) < 0.1)
zf = d.status()["tcp"][2]
d.set_limits(z_min=zf - 15)
d.jog_start("base", 2, -1, 40)
for _ in range(15):
    time.sleep(0.1)
    d.jog_keepalive()
time.sleep(0.2)
zs = d.status()["tcp"][2]
check("jog down stops at the floor limit", zf - 30 < zs < zf - 10 and not d.status()["jogging"], f"z {zs:.1f} vs limit {zf - 15:.1f}")
d.set_limits(z_min=-1000)
check("limits saved to the settings file", __import__("cobot.settings", fromlist=["load"]).load()["limits"]["z_min"] == -1000)
d.set_limits(z_min=0)

# IO through Modbus
d.command("set_digital_output", type=0, index=3, value=1)
check("DO3 visible on Modbus discrete input 11", wait(lambda: d.status()["dout"][3] == 1))
mb = ModbusClient("127.0.0.1", MB)
mb.write_coil(RM.COIL_DI_BASE + 5, True)
check("Modbus coil 45 sets robot DI5", wait(lambda: vc.robot.din[5] == 1))

# safety
d.command("sim_estop", on=True)
check("e-stop drops enable", wait(lambda: d.status()["estop"] and not d.status()["enabled"]))
r = d.command("enable_robot")
check("enable refused during e-stop", not ok(r))
d.command("sim_estop", on=False)

# control source
d.command("power_on")
d.command("enable_robot")
d.command("sim_control_source", source="local")
r = d.command("joint_move", relFlag=0, jointPosition=K.HOME, speed=50, accel=100)
check("motion refused when control source is Local", not ok(r), r.get("errorMsg"))
d.command("sim_control_source", source="remote")

# controller configuration (what Cobot Expert's setup pages edit)
check("set_payload", ok(d.command("set_payload", mass=1.5, centroid=[0, 0, 60]))
      and d.command("get_payload")["mass"] == 1.5)
check("payload above rated load refused", not ok(d.command("set_payload", mass=99, centroid=[0, 0, 0])))
tcp0 = d.command("get_tcp_pos")["tcp_pos"]
d.command("set_tool_offsets", id=2, tooloffset=[0, 0, 100, 0, 0, 0], name="tool2")
check("tool slot 2 stored", d.command("get_tool_offsets")["tool_offsets"][2][2] == 100)
d.command("set_tool_id", tool_id=2)
time.sleep(0.1)  # the sim recomputes the TCP on its next tick
tcp1 = d.command("get_tcp_pos")["tcp_pos"]
check("active tool 2 moves the TCP 100 mm", d.command("get_data")["current_tool_id"] == 2
      and abs(math.dist(tcp0[:3], tcp1[:3]) - 100) < 0.01)
check("bridge model uses the active tool", d.status()["tool"][2] == 100 and d.status()["tool_id"] == 2)
d.command("set_tool_id", tool_id=0)
d.command("set_user_offsets", id=1, userffset=[10, 0, 0, 0, 0, 0], name="user1")
d.command("set_user_id", user_frame_id=1)
check("user frame 1 stored + active", d.command("get_user_offsets")["user_offsets"][1][0] == 10
      and d.command("get_data")["current_user_id"] == 1)
check("collision sensitivity readable", d.command("get_clsn_sensitivity")["sensitivityLevel"] == 3)

# programs stored on the controller
check("load_program", ok(d.command("load_program", programName="demo"))
      and d.command("get_loaded_program")["programName"] == "demo")
check("play_program", ok(d.command("play_program"))
      and d.command("get_program_state")["programState"] == "running")
check("program advances", wait(lambda: d.command("get_current_line")["current_line"] >= 2, 4))
d.command("pause_program")
l1 = d.command("get_current_line")["current_line"]
time.sleep(1.2)
check("pause holds the line", d.command("get_program_state")["programState"] == "paused"
      and d.command("get_current_line")["current_line"] == l1)
check("resume_program", ok(d.command("resume_program"))
      and d.command("get_program_state")["programState"] == "running")
d.stop_all()
check("STOP ends the program", d.command("get_program_state")["programState"] == "idle")

# real-mode read-only guard
d2 = CobotDriver()
d2.connect("127.0.0.1", "real", MB, CMD, ST)
try:
    d2.command("joint_move", relFlag=0, jointPosition=K.HOME, speed=10, accel=10)
    check("real mode is read-only until armed", False)
except PermissionError:
    check("real mode is read-only until armed", True)
for name, fields in (("set_payload", dict(mass=1, centroid=[0, 0, 0])), ("load_program", dict(programName="x"))):
    try:
        d2.command(name, **fields)
        check(f"{name} needs arming on real", False)
    except PermissionError:
        check(f"{name} needs arming on real", True)
d2.motion_armed = True
try:
    d2.command("set_clsn_sensitivity", sensitivityLevel=1)
    check("safety settings blocked on real even when armed", False)
except PermissionError:
    check("safety settings blocked on real even when armed", True)
d2.motion_armed = False
# real mode: the bridge scales speeds itself (controller ignores set_rapidrate)
check("real mode starts at 10% speed", abs(d2.speed - 0.10) < 1e-9 and d2.status()["speed_override"] == 10)
d2.motion_armed = True
r = d2.command("set_rapidrate", rapid_rate=0.25)
check("set_rapidrate handled by the bridge", ok(r) and abs(d2.speed - 0.25) < 1e-9)
sc = d2._scaled("joint_move", {"speed": 40, "accel": 100, "jointPosition": [0] * 6})
check("move speed + accel scaled", sc["speed"] == 10 and sc["accel"] == 25 and sc["jointPosition"] == [0] * 6)
check("jog velocity scaled", d2._scaled("jog", {"jogvel": -20})["jogvel"] == -5)
d2.disconnect()

print()
print("ALL PASSED" if not fails else f"{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
