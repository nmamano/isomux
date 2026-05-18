#!/usr/bin/env bash
set -euo pipefail

# Build main app. --splitting enables code splitting so dynamic imports (e.g.
# the mermaid renderer loaded only when a chat message contains a mermaid
# block) are pulled into separate chunks instead of being inlined into the
# main bundle.
bun build ui/index.tsx --outdir ui/dist --production --splitting
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
# unauth visitor sees the same thing as someone browsing isomux.com — no
# state from this specific deployment leaks.
cp site/screenshot.png ui/dist/login-bg.png
