#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC="$ROOT/services/com.minilab.mistralrs-serve.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.minilab.mistralrs-serve.plist"

if [[ "$(hostname)" != "lab-512" ]]; then
  echo "Refusing: this installer is for LAB 512, current hostname is $(hostname)" >&2
  exit 1
fi

/usr/bin/env node "$ROOT/scripts/preflight.js" lab512

mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DST"

launchctl bootout "gui/$(id -u)" "$PLIST_DST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/com.minilab.mistralrs-serve"
launchctl kickstart -k "gui/$(id -u)/com.minilab.mistralrs-serve"

echo "Installed LAB 512 inference service: com.minilab.mistralrs-serve"
