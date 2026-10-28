"""End-to-end test: virtual controller <-> driver over real sockets.

Run:  python -m tests.test_e2e     (from the lexium-cobot folder)
Uses non-default ports so it can run while the app is up.
"""
import math
import sys
import time

sys.path.insert(0, ".")
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

# real-mode read-only guard
d2 = CobotDriver()
d2.connect("127.0.0.1", "real", MB, CMD, ST)
try:
    d2.command("joint_move", relFlag=0, jointPosition=K.HOME, speed=10, accel=10)
    check("real mode is read-only until armed", False)
except PermissionError:
    check("real mode is read-only until armed", True)
d2.disconnect()

print()
print("ALL PASSED" if not fails else f"{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
