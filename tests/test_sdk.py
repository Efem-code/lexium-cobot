"""SDK test: drive the built-in simulator the way a user script would.

Run:  python -m tests.test_sdk     (from the lexium-cobot folder)
"""
import math
import os
import sys
import tempfile
import threading
import time

sys.path.insert(0, ".")
os.environ["LEXIUM_COBOT_HOME"] = tempfile.mkdtemp(prefix="cobot-test-")
from cobot import kinematics as K  # noqa: E402
from cobot.sdk import CobotError, Robot  # noqa: E402

fails = []


def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""))
    if not cond:
        fails.append(name)


def raises(fn):
    try:
        fn()
        return False
    except CobotError:
        return True


with Robot.simulator() as robot:
    check("state arrives", len(robot.joints) == 6 and len(robot.pose) == 6)
    check("move refused while unpowered", raises(lambda: robot.home()))
    robot.power_on()
    robot.enable()
    robot.speed(100)

    tgt = [20, 100, -95, 85, 90, 30]
    robot.move_joint(tgt, speed=120)
    check("move_joint waits until there", max(abs(a - b) for a, b in zip(robot.joints, tgt)) < 0.05)

    p0 = robot.pose
    robot.move_linear(z=p0[2] - 40, speed=300)
    p1 = robot.pose
    check("move_linear(z=...) keeps x/y", abs(p1[2] - (p0[2] - 40)) < 0.5 and math.dist(p0[:2], p1[:2]) < 0.5)
    robot.move_linear([30, 0, 0, 0, 0, 0], relative=True, speed=300)
    check("relative move_linear", abs(robot.pose[0] - (p1[0] + 30)) < 0.5)

    check("fk matches the controller", math.dist(robot.fk(robot.joints)[:3], robot.pose[:3]) < 0.5)
    pose = robot.pose
    pose[1] += 40
    robot.move_pose(pose, speed=120)
    check("move_pose reaches the pose", math.dist(robot.pose[:3], pose[:3]) < 0.5)

    robot.set_do(4, True)
    time.sleep(0.1)
    check("set_do / do", robot.do(4))
    threading.Timer(0.3, lambda: robot.command("sim_set_din", index=6, value=1)).start()
    t = time.time()
    robot.wait_di(6, True, timeout=3)
    check("wait_di returns when the input changes", 0.2 < time.time() - t < 2)
    check("wait_di times out", raises(lambda: robot.wait_di(7, True, timeout=0.3)))

    robot.limits(z_min=robot.pose[2] + 100)
    check("bridge limit raises CobotError", raises(lambda: robot.move_linear(z=robot.pose[2] - 10)))
    robot.limits(z_min=0)

    robot.set_payload(0.8, (0, 0, 40))
    check("payload", robot.payload()[0] == 0.8)
    robot.set_tool(1, [0, 0, 120, 0, 0, 0])
    robot.use_tool(1)
    time.sleep(0.1)
    check("tool changes the reported TCP", abs(math.dist(robot.pose[:3], robot.fk(robot.joints)[:3])) < 0.5,
          "fk uses the active tool too")
    robot.use_tool(0)

    robot.run_program("demo")
    check("run_program starts", robot.program_state() == "running")
    robot.stop()
    check("stop ends it", robot.program_state() == "idle")

    # a fault during a move raises instead of hanging
    robot.home(speed=20)
    robot.move_joint([0, 90, -90, 90, 90, 90], speed=10, wait=False)
    threading.Timer(0.5, lambda: robot.command("sim_estop", on=True)).start()
    check("E-stop during a move raises", raises(robot.wait_until_stopped))
    robot.command("sim_estop", on=False)

print()
print("ALL PASSED" if not fails else f"{len(fails)} FAILED: {fails}")
sys.exit(1 if fails else 0)
