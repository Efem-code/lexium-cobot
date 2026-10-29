"""Run the bridge on the iPad itself (a-Shell), so no PC is needed.

In a-Shell:
    cd ~/Documents/lexium-cobot-main
    python3 ipad.py              connect to the real cobot at 10.5.5.100 (read-only until armed)
    python3 ipad.py --sim        practise against the built-in simulator instead
    python3 ipad.py --host 10.5.5.101

Then open http://127.0.0.1:8765 in Safari, side by side with a-Shell (Split View):
iPadOS pauses a-Shell when it is off screen, and the bridge stops with it.
"""
import argparse
import threading
import time

from cobot.driver import CobotDriver
from cobot.kinematics import PROFILES
from cobot.sim_server import VirtualController
from cobot.web import serve


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--host", default="10.5.5.100", help="cobot controller address")
    ap.add_argument("--sim", action="store_true", help="use the built-in simulator, not the real cobot")
    ap.add_argument("--model", default="LXMRL03", choices=list(PROFILES))
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()

    drv = CobotDriver()
    if a.sim:
        # high ports: iOS apps can't listen below 1024
        VirtualController("127.0.0.1", 1502, 11001, 11000, a.model).start()
        time.sleep(0.3)
        drv.connect("127.0.0.1", "sim", 1502, 11001, 11000, a.model)
        print(f"[sim] built-in simulator ({a.model})")
    else:
        def go():
            print(f"[cobot] connecting to {a.host} ...")
            drv.connect(a.host, "real", 502, 10001, 10000, a.model)
            time.sleep(3)
            st = drv.status()
            if st.get("joints"):
                print(f"[cobot] connected to {a.host} (read-only until you arm motion in the page)")
            else:
                print(f"[cobot] no data from {a.host} ({st.get('last_error') or 'no reply'}).")
                print("        Check the iPad is on the cobot Wi-Fi and a-Shell has Local Network")
                print("        access (Settings > a-Shell), then press Connect in the page.")
        threading.Thread(target=go, daemon=True).start()

    httpd = serve("127.0.0.1", a.port, drv)  # localhost only: nothing else on the Wi-Fi can reach it
    print(f"\n  Open in Safari:  http://127.0.0.1:{a.port}\n  Stop: Ctrl+C (or close a-Shell)\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        drv.disconnect()


if __name__ == "__main__":
    main()
