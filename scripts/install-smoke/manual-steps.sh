#!/usr/bin/env bash
# The published manual install (docs/hosting/blocks/install.md), step by step,
# as a normal user with sudo on a fresh Ubuntu machine. run.sh runs each step
# in its own `bash -i`, the way the guide has the reader open a new terminal.
#
#   manual-steps.sh node|packages|bun|runtimes|clone|install REPO
set -euo pipefail
case $1 in
  node)
    # nodejs.org's Linux instructions for Node.js 24 LTS.
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    . "$HOME/.nvm/nvm.sh"
    nvm install 24
    ;;
  packages)
    sudo apt update
    sudo apt install -y git curl unzip python3 build-essential
    ;;
  bun)
    curl -fsSL https://bun.sh/install | bash
    ;;
  runtimes)
    node --version
    bun --version
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 24 && minor >= 15 ? 0 : 1)'
    ;;
  clone)
    git clone "$2" isomux
    ;;
  install)
    cd isomux
    bun install
    ;;
  *)
    echo "unknown step: $1" >&2
    exit 2
    ;;
esac
