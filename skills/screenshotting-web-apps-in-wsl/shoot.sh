#!/usr/bin/env bash
# Screenshot a locally-running web app from WSL using headless Windows Chrome.
# Chrome writes the PNG itself (no CDP / no network round-trip), so this works
# even though WSL has no Linux browser and Playwright's Chromium won't install.
#
# Usage:   shoot.sh <url> <name>
# Example: shoot.sh 'http://localhost:3001/#/dashboard' dashboard
# Output:  /mnt/c/claude/temp/<name>.png   (== C:\claude\temp\<name>.png)
#          The Linux path is printed on success — Read it directly.
set -euo pipefail

url="${1:?usage: shoot.sh <url> <name> [width] [height]}"
name="${2:?usage: shoot.sh <url> <name> [width] [height]}"
width="${3:-1440}"
height="${4:-900}"

chrome="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
[ -x "$chrome" ] || chrome="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
[ -x "$chrome" ] || { echo "no Windows Chrome/Edge found under /mnt/c" >&2; exit 1; }

mkdir -p /mnt/c/claude/temp
win_out="C:\\claude\\temp\\${name}.png"
lin_out="/mnt/c/claude/temp/${name}.png"

# --virtual-time-budget gives the SPA time to mount + fetch before the snapshot.
# --hide-scrollbars keeps the capture clean. --headless=new is the modern path.
"$chrome" --headless=new --disable-gpu --hide-scrollbars \
  --window-size="${width},${height}" \
  --virtual-time-budget=8000 \
  --screenshot="$win_out" \
  "$url" >/dev/null 2>&1

[ -s "$lin_out" ] || { echo "screenshot not written: $lin_out" >&2; exit 1; }
echo "$lin_out"
