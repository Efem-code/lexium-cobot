"""Entry point for the Windows .exe (PyInstaller)."""
import sys

from cobot.cli import main

if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code not in (0, None):
            print(e.code if isinstance(e.code, str) else f"exit {e.code}")
            input("\nPress Enter to close...")   # keep the console open so the message can be read
        raise
    except Exception as e:  # show crashes instead of a window that flashes and closes
        print(f"Error: {e}")
        input("\nPress Enter to close...")
        sys.exit(1)
