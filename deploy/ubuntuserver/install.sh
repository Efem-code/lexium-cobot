#!/usr/bin/env bash
# Runs ON the server: installs the controller page as a systemd user service that starts at boot (no login needed)
# and restarts if it stops. The app is plain Python 3 (standard library only).
#   bash ~/lexium-cobot/deploy/ubuntuserver/install.sh [port]
set -euo pipefail
APP="$HOME/lexium-cobot"
PORT="${1:-8765}"
UNIT="$HOME/.config/systemd/user/lexium-cobot.service"

python3 -c 'import sys; assert sys.version_info >= (3, 9), sys.version' || { echo "Python 3.9 or newer is needed"; exit 1; }
if ss -ltn "( sport = :$PORT )" | grep -q LISTEN && ! systemctl --user is-active --quiet lexium-cobot; then
  echo "Port $PORT is already used by something else: run again with another port, e.g.  install.sh 8766"; exit 1
fi

mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNIT
[Unit]
Description=Lexium Cobot controller page (PIN protected on the network)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP
ExecStart=/usr/bin/python3 $APP/run.py ui --no-browser --lan --ui-port $PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable lexium-cobot >/dev/null
systemctl --user restart lexium-cobot

# keep user services running after logout and start them at boot
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"
fi

for i in $(seq 1 20); do curl -fs "http://127.0.0.1:$PORT/api/auth" >/dev/null && break; sleep 0.5; done
echo
if curl -fs "http://127.0.0.1:$PORT/api/auth" >/dev/null; then
  PIN=$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.lexium-cobot/settings.json")))["bridge"]["pin"])' 2>/dev/null || echo "?")
  echo "OK: the controller page is running on port $PORT and starts by itself at boot."
  echo "  Open:  http://$(hostname -I | awk '{print $1}'):$PORT   (demo room network)"
  command -v tailscale >/dev/null && echo "         http://$(tailscale ip -4 2>/dev/null | head -1):$PORT   (Tailscale)"
  echo "  PIN:   $PIN"
else
  echo "The service didn't answer. Its log:"; journalctl --user -u lexium-cobot -n 30 --no-pager
  exit 1
fi
if command -v ufw >/dev/null && sudo -n ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "Note: the ufw firewall is on. If other devices can't open the page: sudo ufw allow $PORT/tcp"
fi
command -v ffmpeg >/dev/null || echo "Note: ffmpeg is not installed. The SEC110 camera works in its picture (HTTP) mode; for its RTSP video: sudo apt install ffmpeg"
