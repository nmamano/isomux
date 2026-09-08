#!/usr/bin/env bash
# Build the demo bundle, serve a copy on port 9878, shoot the lobby with the
# receptionist and its chat.
#   bash scripts/receptionist-shots.sh slice-3   -> /tmp/recep-shots/slice-3/*.png
set -euo pipefail
sub="${1:?out subdir}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
bun run build:demo
rm -rf /tmp/recep-demo
mkdir -p /tmp/recep-demo/demo
cp -r site/demo/. /tmp/recep-demo/demo/
python3 -m http.server 9878 --directory /tmp/recep-demo --bind 127.0.0.1 >/tmp/recep-demo-server.log 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT
sleep 1
bun scripts/receptionist-shots.mjs "http://127.0.0.1:9878/demo/" "/tmp/recep-shots/$sub"
ls -la "/tmp/recep-shots/$sub"
