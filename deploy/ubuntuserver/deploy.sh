#!/usr/bin/env bash
# Runs on THIS PC: copies the app (the committed version of this checkout) to the server and (re)installs the
# service there. One SSH connection is reused, so the password is asked once.
#   deploy/ubuntuserver/deploy.sh [user@host] [port]       default: temp@ubuntuserver 8765
set -euo pipefail
TARGET="${1:-temp@ubuntuserver}"
PORT="${2:-8765}"
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
SOCK="$(mktemp -u /tmp/lexium-deploy-XXXXXX)"
SSH=(ssh -o ControlMaster=auto -o ControlPath="$SOCK" -o ControlPersist=120)
trap '"${SSH[@]}" -O exit "$TARGET" 2>/dev/null || true' EXIT

echo "Copying $(git rev-parse --short HEAD) ($(git branch --show-current)) to $TARGET:~/lexium-cobot ..."
"${SSH[@]}" "$TARGET" 'mkdir -p ~/lexium-cobot'
git archive --format=tar HEAD | "${SSH[@]}" "$TARGET" 'tar -x -C ~/lexium-cobot'
echo "Installing the service ..."
"${SSH[@]}" -t "$TARGET" "bash ~/lexium-cobot/deploy/ubuntuserver/install.sh $PORT"
