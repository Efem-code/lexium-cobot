"""Your first cobot program, on the built-in simulator (no hardware needed).

    python examples/01_hello_simulator.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # run from a git checkout
from cobot.sdk import Robot  # noqa: E402

with Robot.simulator(powered=True) as robot:
    robot.speed(100)
    robot.home()
    print("at home, TCP:", [round(v, 1) for v in robot.pose])

    # draw a 100 mm square in the air, keeping the tool orientation
    x, y, z = robot.pose[:3]
    for dx, dy in ((100, 0), (100, 100), (0, 100), (0, 0)):
        robot.move_linear(x=x + dx, y=y + dy, z=z - 50, speed=200)
        print("corner", [round(v, 1) for v in robot.pose[:3]])

    robot.home()
    print("done")
