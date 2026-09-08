#!/usr/bin/env bash
# Stitch the per-layout PNGs in /tmp/lobby-preview/out/<subdir>/ into one
# composite per layout (2x2: warm-light, warm-dark / theme-light, theme-dark).
# Usage: bash scripts/lobby-gallery.sh <subdir>          # 2x2 per layout
#        bash scripts/lobby-gallery.sh <subdir> parity   # office room beside each layout
# Uses ImageMagick's montage when present; otherwise renders a 2x2 HTML page
# with headless Chrome (no ImageMagick or PIL on the box, 2026-09-05).
set -euo pipefail
SUB=${1:-slice-4}
MODE=${2:-grid}
DIR=/tmp/lobby-preview/out/$SUB

shoot_grid() { # out cols rows files...
  local out=$1 cols=$2 rows=$3; shift 3
  local html=${out%.png}.html
  {
    echo "<!doctype html><html><body style=\"margin:0;background:#888;display:grid;grid-template-columns:repeat($cols,1100px);gap:4px;padding:4px;width:$((cols*1104+4))px\">"
    for f in "$@"; do
      echo "<div style=\"position:relative\"><img src=\"file://$f\" style=\"display:block;width:1100px;height:820px\"><div style=\"position:absolute;left:8px;top:8px;font:700 22px sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:4px 10px;border-radius:6px\">$(basename "$f" .png)</div></div>"
    done
    echo '</body></html>'
  } > "$html"
  google-chrome --headless --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --window-size=$((cols*1104+8)),$((rows*824+8)) --screenshot="$out" "file://$html" >/dev/null 2>&1 || true
  rm -f "$html"
  local size
  size=$(stat -c %s "$out" 2>/dev/null || echo 0)
  [ "$size" -gt 20000 ] || { echo "FAIL $out ($size bytes)"; exit 1; }
  echo "ok   $out ($size bytes)"
}

if [ "$MODE" = parity ]; then
  office="$DIR/office-demo.png"
  [ -f "$office" ] || { echo "missing $office"; exit 1; }
  files=()
  for l in fireside lounge nook; do
    f="$DIR/$l-ghosts.png"
    [ -f "$f" ] || { echo "missing $f"; exit 1; }
    files+=("$office" "$f")
  done
  shoot_grid "$DIR/parity-gallery.png" 2 3 "${files[@]}"
  exit 0
fi

for l in fireside lounge nook; do
  out="$DIR/$l-gallery.png"
  files=("$DIR/$l-warm-light.png" "$DIR/$l-warm-dark.png" "$DIR/$l-theme-light.png" "$DIR/$l-theme-dark.png")
  for f in "${files[@]}"; do [ -f "$f" ] || { echo "missing $f"; exit 1; }; done
  if command -v montage >/dev/null 2>&1; then
    montage "${files[@]}" -tile 2x2 -geometry +4+4 -background '#888' "$out"
  else
    html="$DIR/$l-gallery.html"
    {
      echo '<!doctype html><html><body style="margin:0;background:#888;display:grid;grid-template-columns:1100px 1100px;gap:4px;padding:4px;width:2204px">'
      for f in "${files[@]}"; do
        echo "<div style=\"position:relative\"><img src=\"file://$f\" style=\"display:block;width:1100px;height:820px\"><div style=\"position:absolute;left:8px;top:8px;font:700 22px sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:4px 10px;border-radius:6px\">$(basename "$f" .png)</div></div>"
      done
      echo '</body></html>'
    } > "$html"
    google-chrome --headless --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files \
      --window-size=2212,1656 --screenshot="$out" "file://$html" >/dev/null 2>&1 || true
    rm -f "$html"
  fi
  size=$(stat -c %s "$out" 2>/dev/null || echo 0)
  [ "$size" -gt 20000 ] || { echo "FAIL $out ($size bytes)"; exit 1; }
  echo "ok   $out ($size bytes)"
done
