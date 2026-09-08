#!/usr/bin/env bash
# Build the standalone lobby preview, serve it over HTTP on port 9877, and
# screenshot every listed URL with headless Chrome. Usage:
#   bash scripts/lobby-preview.sh <out-subdir> [name=query ...]
# With no name=query pairs it shoots the default set. PNGs land in
# /tmp/lobby-preview/out/<out-subdir>/<name>.png. Offline, no keys, no quota.
# A name ending in "-sheet" is shot in a tall window (contact sheets); set
# LOBBY_WIN=WxH to override the window for every shot.
set -euo pipefail
cd "$(dirname "$0")/.."

SUB=${1:-adhoc}
shift || true
OUT=/tmp/lobby-preview
PORT=9877
mkdir -p "$OUT/out/$SUB"

bun build ui/office/lobby/preview-entry.tsx --outdir "$OUT" --production >/dev/null
cat > "$OUT/preview.html" <<HTML
<!doctype html>
<html><head><meta charset="utf-8"><title>Lobby preview</title></head>
<body><div id="root"></div><script type="module" src="/preview-entry.js"></script></body></html>
HTML

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$OUT" >/dev/null 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/preview.html" >/dev/null && break
  sleep 0.1
done

if [ $# -eq 0 ]; then
  set -- \
    empty-dark="mode=dark" \
    empty-light="mode=light"
fi

fail=0
for pair in "$@"; do
  name=${pair%%=*}
  query=${pair#*=}
  png="$OUT/out/$SUB/$name.png"
  win=${LOBBY_WIN:-1100,820}
  case "$name" in *-sheet) win=${LOBBY_WIN:-1100,1400} ;; esac
  google-chrome --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --window-size="$win" --virtual-time-budget=6000 \
    --screenshot="$png" "http://127.0.0.1:$PORT/preview.html?$query" >/dev/null 2>&1 || true
  size=$(stat -c %s "$png" 2>/dev/null || echo 0)
  if [ "$size" -lt 5000 ]; then
    echo "FAIL $name ($size bytes)"
    fail=1
  else
    echo "ok   $name ($size bytes) -> $png"
  fi
done
exit $fail
