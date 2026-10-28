"""Lexium Cobot PC simulator / controller launcher.

  python run.py                 simulator + controller UI (auto-connected to the sim)
  python run.py sim             virtual cobot controller only (Modbus 502, JSON 10001/10000)
  python run.py sim --public    ...listening on all interfaces (so a TM262 PLC can reach it)
  python run.py ui              controller UI only (connect to a sim or real cobot from the page)
  python run.py --lan           ...and let phones/iPads on the same Wi-Fi use it (PIN protected)
  python run.py --lan --pin 4821   set your own PIN (remembered in bridge.json)

Then open http://127.0.0.1:8765
"""
import argparse
import json
import os
import secrets
import socket
import threading
import time
import webbrowser

from cobot.driver import CobotDriver
from cobot.kinematics import PROFILES
from cobot.sim_server import VirtualController
from cobot.web import Handler, serve

BRIDGE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge.json")


def bridge_settings(pin_arg):
    """PIN + login token persist across restarts so the iPad stays logged in."""
    try:
        with open(BRIDGE_FILE) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    if pin_arg:
        cfg["pin"] = pin_arg
    cfg.setdefault("pin", f"{secrets.randbelow(10**6):06d}")
    cfg.setdefault("token", secrets.token_hex(16))
    with open(BRIDGE_FILE, "w") as f:
        json.dump(cfg, f, indent=2)
    return cfg


def lan_addresses():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:  # the address used for the default route
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("what", nargs="?", default="all", choices=["all", "sim", "ui"])
    ap.add_argument("--public", action="store_true", help="sim listens on 0.0.0.0 (for PLC/other PCs)")
    ap.add_argument("--model", default="LXMRL03", choices=list(PROFILES))
    ap.add_argument("--modbus-port", type=int, default=502)
    ap.add_argument("--cmd-port", type=int, default=10001)
    ap.add_argument("--status-port", type=int, default=10000)
    ap.add_argument("--ui-port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--lan", action="store_true", help="serve the UI to phones/tablets on the network (PIN required)")
    ap.add_argument("--pin", help="PIN for --lan (default: random, saved in bridge.json)")
    a = ap.parse_args()

    if a.what in ("all", "sim"):
        host = "0.0.0.0" if a.public else "127.0.0.1"
        VirtualController(host, a.modbus_port, a.cmd_port, a.status_port, a.model).start()
        print(f"[sim] virtual Lexium Cobot ({a.model}) on {host}: Modbus TCP {a.modbus_port}, "
              f"JSON cmd {a.cmd_port}, status {a.status_port}")

    if a.what in ("all", "ui"):
        drv = CobotDriver()
        if a.what == "all":
            time.sleep(0.3)
            drv.connect("127.0.0.1", "sim", a.modbus_port, a.cmd_port, a.status_port, a.model)
        pin = ""
        if a.lan:
            cfg = bridge_settings(a.pin)
            pin, Handler.token = cfg["pin"], cfg["token"]
        httpd = serve("0.0.0.0" if a.lan else "127.0.0.1", a.ui_port, drv, pin)
        url = f"http://127.0.0.1:{a.ui_port}"
        print(f"[ui] controller UI at {url}")
        if a.lan:
            print("\n  Phones / iPads on the same Wi-Fi: open one of these, then Share > Add to Home Screen")
            for ip in lan_addresses():
                print(f"      http://{ip}:{a.ui_port}")
            print(f"\n  PIN: {pin}      (change with --pin NNNN)\n")
        if not a.no_browser:
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    else:
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
