#!/usr/bin/env bash
# The published manual install (docs/hosting/blocks/install.md), step by step,
# as a normal user with sudo on a fresh Ubuntu machine. run.sh runs each step
# in its own `bash -i`, the way the guide has the reader open a new terminal.
#
#   manual-steps.sh packages|bun|runtimes|clone|install REPO
set -euo pipefail
case $1 in
  packages)
    sudo apt update
    sudo apt install -y git curl unzip
    ;;
  bun)
    curl -fsSL https://bun.sh/install | bash
    ;;
  runtimes)
    bun --version
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
