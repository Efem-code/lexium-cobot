"""Read-only: connect straight to the real cobot and print its state once a second.
Nothing is sent that can move the arm or change a setting.

    python examples/03_read_only_monitor.py             # 10.5.5.100
    python examples/03_read_only_monitor.py 10.5.5.100
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cobot.sdk import Robot  # noqa: E402

host = sys.argv[1] if len(sys.argv) > 1 else "10.5.5.100"
with Robot.connect(host) as robot:      # read-only: robot.arm() is never called
    mass, com = robot.payload()
    print(f"payload {mass} kg at {com}, program: {robot.program_state()}")
    for _ in range(10):
        st = robot.state
        print("powered" if st["powered"] else "off", "enabled" if st["enabled"] else "-",
              "joints", [round(v, 1) for v in st["joints"]], "tcp", [round(v, 1) for v in st["tcp"][:3]])
        time.sleep(1)
