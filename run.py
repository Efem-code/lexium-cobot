"""Lexium Cobot launcher for a git checkout (same as the installed `lexium-cobot` command).

  python run.py                 simulator + controller UI
  python run.py ui              controller UI only (connect to a sim or real cobot from the page)
  python run.py --lan           ...and let phones/iPads on the same Wi-Fi use it (PIN protected)
  python run.py --help          all options
"""
from cobot.cli import main

if __name__ == "__main__":
    main()
