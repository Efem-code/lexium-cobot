"""Pick-and-place loop through the running app, so you watch it in the 3D view.

Start the app first (Start Simulator.bat, or connect it to the real cobot), then:
    python examples/02_pick_and_place.py            # 3 cycles
    python examples/02_pick_and_place.py 10         # 10 cycles

On the real cobot: tick "Arm motion" in the page first, start at 10 % speed, and keep
the E-stop in reach. The bridge's floor and speed limits apply to every move.
DO0 = gripper close, DI0 = part present (change to match your wiring).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cobot.sdk import Robot  # noqa: E402

GRIPPER, PART_SENSOR = 0, 0
PICK = [400, -150, 150, 180, 0, 0]    # x, y, z, rx, ry, rz (mm, deg) -- teach yours
PLACE = [400, 150, 150, 180, 0, 0]
APPROACH = 80                          # mm above pick/place
SIMULATED_SENSOR = True                # the simulator has no real part sensor


def above(p, dz=APPROACH):
    return [p[0], p[1], p[2] + dz] + p[3:]


cycles = int(sys.argv[1]) if len(sys.argv) > 1 else 3
robot = Robot.bridge()
st = robot.state
if st.get("mode") == "real" and not st.get("motion_armed"):
    sys.exit('The app is connected to the REAL cobot but read-only: tick "Arm motion" first.')

robot.move_pose(above(PICK))
for n in range(1, cycles + 1):
    if not SIMULATED_SENSOR:
        robot.wait_di(PART_SENSOR, True, timeout=30)
    robot.set_do(GRIPPER, False)              # open
    robot.move_linear(PICK, speed=80)
    robot.set_do(GRIPPER, True)               # close
    robot.sleep(0.3)
    robot.move_linear(above(PICK), speed=150)
    robot.move_pose(above(PLACE))
    robot.move_linear(PLACE, speed=80)
    robot.set_do(GRIPPER, False)              # release
    robot.sleep(0.3)
    robot.move_linear(above(PLACE), speed=150)
    robot.move_pose(above(PICK))
    print(f"cycle {n}/{cycles} done")
robot.home()
