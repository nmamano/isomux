#!/usr/bin/env bash
set -euo pipefail

# Everything is built into a fresh stage dir beside ui/dist and then published
# into it by scripts/publish-ui-dist.ts, which renames each file into place
# (entry files last) and prunes old chunks. The stage dir is in ui/ so the
# renames stay on one filesystem.
stage=$(mktemp -d ui/.dist-stage.XXXXXX)
trap 'rm -rf "$stage"' EXIT

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
  bun build ui/index.tsx --outdir "$stage" --production --splitting
else
  bun build ui/index.tsx --outdir "$stage" --production --splitting 2>&1 \
    | awk '!/^[[:space:]]+[^[:space:]]+\.(js|css)[[:space:]]+[0-9.]+[[:space:]]+(KB|MB|bytes)[[:space:]]+\((chunk|entry point)\)[[:space:]]*$/ && !/^[[:space:]]*$/'
fi
cp ui/index.html "$stage"/index.html
cp node_modules/@xterm/xterm/css/xterm.css "$stage"/xterm.css
cp node_modules/diff2html/bundles/css/diff2html.min.css "$stage"/diff2html.css
# Self-hosted UI fonts with their licenses (ui/fonts/fonts.css).
mkdir -p "$stage"/assets
cp -r ui/fonts "$stage"/assets/fonts
mkdir -p "$stage"/katex/fonts
cp node_modules/katex/dist/katex.min.css "$stage"/katex/katex.min.css
cp node_modules/katex/dist/fonts/* "$stage"/katex/fonts/

# PWA assets
cp ui/sw.js "$stage"/sw.js
cp ui/manifest.json "$stage"/manifest.json
mkdir -p "$stage"/icons
cp ui/icons/*.png "$stage"/icons/
cp ui/icon.svg "$stage"/icons/icon.svg

# Login-page backdrop: a static screenshot of the office UI, served pre-auth
# at /auth/login-bg.png. Same asset as the marketing screenshot so an
# unauth visitor sees the same thing as someone browsing isomux.com - no
# state from this specific deployment leaks.
cp site/screenshot.png "$stage"/login-bg.png

bun run scripts/publish-ui-dist.ts "$stage" ui/dist

# Also supplies the authenticated extension download on install and update.
bun run scripts/build-browser-extension.ts
