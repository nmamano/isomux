#!/usr/bin/env bash
set -euo pipefail

# Build main app. --splitting enables code splitting so dynamic imports (e.g.
# the mermaid renderer loaded only when a chat message contains a mermaid
# block) are pulled into separate chunks instead of being inlined into the
# main bundle.
#
# Bun's bundler lists every produced chunk by default - useful for size
# debugging, noise the rest of the time. Filter out the per-chunk lines
# (`  name.js   12.34 KB  (chunk)`) so a clean build shows just the
# "Bundled N modules" summary and the entry-point line. Anything that
# doesn't match the chunk shape (errors, warnings, blank lines) passes
# through. Set ISOMUX_BUILD_VERBOSE=1 to skip the filter when debugging.
if [[ "${ISOMUX_BUILD_VERBOSE:-}" == "1" ]]; then
  bun build ui/index.tsx --outdir ui/dist --production --splitting
else
  bun build ui/index.tsx --outdir ui/dist --production --splitting 2>&1 \
    | awk '!/^[[:space:]]+[^[:space:]]+\.(js|css)[[:space:]]+[0-9.]+[[:space:]]+(KB|MB|bytes)[[:space:]]+\((chunk|entry point)\)[[:space:]]*$/ && !/^[[:space:]]*$/'
fi
cp ui/index.html ui/dist/index.html
cp node_modules/@xterm/xterm/css/xterm.css ui/dist/xterm.css
cp node_modules/diff2html/bundles/css/diff2html.min.css ui/dist/diff2html.css

# PWA assets
cp ui/sw.js ui/dist/sw.js
cp ui/manifest.json ui/dist/manifest.json
mkdir -p ui/dist/icons
cp ui/icons/*.png ui/dist/icons/
cp ui/icon.svg ui/dist/icons/icon.svg

# Login-page backdrop: a static screenshot of the office UI, served pre-auth
# at /auth/login-bg.png. Same asset as the marketing screenshot so an
# unauth visitor sees the same thing as someone browsing isomux.com - no
# state from this specific deployment leaks.
cp site/screenshot.png ui/dist/login-bg.png
