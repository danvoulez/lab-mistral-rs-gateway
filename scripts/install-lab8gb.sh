#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$HOME/lab-mistral-rs-gateway"

if [[ "$(hostname)" != "lab-8gb" ]]; then
  echo "Refusing: this installer is for LAB 8GB, current hostname is $(hostname)" >&2
  exit 1
fi

mkdir -p "$TARGET"
if [[ "$ROOT" != "$TARGET" ]]; then
  rsync -az --delete \
    --exclude node_modules \
    --exclude logs \
    --exclude runtime \
    "$ROOT/" "$TARGET/"
fi

cd "$TARGET"
/opt/homebrew/bin/npm install

mkdir -p "$HOME/Library/LaunchAgents" "$TARGET/logs" "$TARGET/runtime"
if [[ ! -s "$TARGET/runtime/gateway-token" ]]; then
  umask 077
  /usr/bin/openssl rand -base64 36 > "$TARGET/runtime/gateway-token"
fi
/bin/chmod 600 "$TARGET/runtime/gateway-token"

/opt/homebrew/bin/node scripts/preflight.js lab8gb
cp services/lab-mistral-gateway.plist "$HOME/Library/LaunchAgents/local.lab-mistral-gateway.plist"
cp services/lab-bridge-watchdog.plist "$HOME/Library/LaunchAgents/local.lab-bridge-watchdog.plist"

for label in local.lab-mistral-gateway local.lab-bridge-watchdog; do
  launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist"
  launchctl enable "gui/$(id -u)/$label"
  launchctl kickstart -k "gui/$(id -u)/$label"
done

echo "Installed LAB 8GB gateway and watchdog."
