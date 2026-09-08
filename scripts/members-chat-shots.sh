#!/usr/bin/env bash
# Build the demo bundle, serve a copy on port 9878, shoot the Lobby tab.
#   bash scripts/members-chat-shots.sh slice-4   -> /tmp/mchat-shots/slice-4/*.png
set -euo pipefail
sub="${1:?out subdir}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
bun run build:demo
rm -rf /tmp/mchat-demo
mkdir -p /tmp/mchat-demo/demo
cp -r site/demo/. /tmp/mchat-demo/demo/
python3 -m http.server 9878 --directory /tmp/mchat-demo --bind 127.0.0.1 >/tmp/mchat-demo-server.log 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT
sleep 1
bun scripts/members-chat-shots.mjs "http://127.0.0.1:9878/demo/" "/tmp/mchat-shots/$sub"
ls -la "/tmp/mchat-shots/$sub"
