"""Lexium Cobot simulator / controller launcher (the `lexium-cobot` command, run.py, the .exe).

  lexium-cobot                  simulator + controller UI (auto-connected to the sim)
  lexium-cobot sim              virtual cobot controller only (Modbus 502, JSON 10001/10000)
  lexium-cobot sim --public     ...listening on all interfaces (so a TM262 PLC can reach it)
  lexium-cobot ui               controller UI only (connect to a sim or real cobot from the page)
  lexium-cobot --lan            ...and let phones/iPads on the same Wi-Fi use it (PIN protected)
  lexium-cobot --lan --pin 4821 set your own PIN (remembered in the settings file)

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

from . import __version__, settings
from .driver import CobotDriver
from .kinematics import PROFILES
from .sim_server import VirtualController
from .web import Handler, serve

# older checkouts kept the PIN next to run.py; picked up once and moved to the settings file
LEGACY_BRIDGE_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bridge.json")


def bridge_settings(pin_arg):
    """PIN + login token persist across restarts so the iPad stays logged in."""
    cfg = settings.load().get("bridge") or {}
    if not cfg:
        try:
            with open(LEGACY_BRIDGE_FILE) as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            cfg = {}
    if pin_arg:
        cfg["pin"] = pin_arg
    cfg.setdefault("pin", f"{secrets.randbelow(10**6):06d}")
    cfg.setdefault("token", secrets.token_hex(16))
    settings.update("bridge", cfg)
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


def main(argv=None):
    ap = argparse.ArgumentParser(prog="lexium-cobot", description=__doc__,
                                 formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("what", nargs="?", default="all", choices=["all", "sim", "ui"])
    ap.add_argument("--public", action="store_true", help="sim listens on 0.0.0.0 (for PLC/other PCs)")
    ap.add_argument("--model", default="LXMRL03", choices=list(PROFILES))
    ap.add_argument("--modbus-port", type=int, default=502)
    ap.add_argument("--cmd-port", type=int, default=10001)
    ap.add_argument("--status-port", type=int, default=10000)
    ap.add_argument("--ui-port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--lan", action="store_true", help="serve the UI to phones/tablets on the network (PIN required)")
    ap.add_argument("--pin", help="PIN for --lan (default: random, saved in the settings file)")
    ap.add_argument("--version", action="version", version=f"lexium-cobot {__version__}")
    a = ap.parse_args(argv)

    print(f"Lexium Cobot {__version__}  (settings: {settings.path()})")
    if a.what in ("all", "sim"):
        host = "0.0.0.0" if a.public else "127.0.0.1"
        try:
            VirtualController(host, a.modbus_port, a.cmd_port, a.status_port, a.model).start()
        except OSError as e:
            raise SystemExit(f"[sim] can't open the simulator ports ({e}). Is the app already running? "
                             "Close it, or start with: lexium-cobot ui")
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
        try:
            httpd = serve("0.0.0.0" if a.lan else "127.0.0.1", a.ui_port, drv, pin)
        except OSError as e:
            raise SystemExit(f"[ui] port {a.ui_port} is busy ({e}). Is the app already open? "
                             f"Use the open window, or start with --ui-port 8766")
        url = f"http://127.0.0.1:{a.ui_port}"
        print(f"[ui] controller UI at {url}")
        if a.lan:
            print("\n  Phones / iPads on the same Wi-Fi: open one of these, then Share > Add to Home Screen")
            for ip in lan_addresses():
                print(f"      http://{ip}:{a.ui_port}")
            print(f"\n  PIN: {pin}      (change with --pin NNNN)\n")
        if not a.no_browser:
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        print("  Close this window (or press Ctrl+C) to stop.")
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
