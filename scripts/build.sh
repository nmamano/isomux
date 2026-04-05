#!/usr/bin/env bash
set -euo pipefail

# Build main app
bun build ui/index.tsx --outdir ui/dist --production
cp ui/index.html ui/dist/index.html
cp node_modules/@xterm/xterm/css/xterm.css ui/dist/xterm.css

# PWA assets
cp ui/sw.js ui/dist/sw.js
cp ui/manifest.json ui/dist/manifest.json
bun run scripts/generate-icons.ts
