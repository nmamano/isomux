#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ $# == 2 ]] || { echo 'Usage: deploy/container/build.sh REVISION LOCAL_IMAGE_TAG' >&2; exit 2; }
context_dir=$(mktemp -d)
trap 'rm -rf "$context_dir"' EXIT
# Build natively for this machine; release images are built on one runner per
# architecture.
case $(uname -m) in
  x86_64) platform=linux/amd64 ;;
  aarch64) platform=linux/arm64 ;;
  *) echo "Unsupported build architecture: $(uname -m)" >&2; exit 1 ;;
esac
revision=$(python3 deploy/container/context.py "$1" "$context_dir/source.tar")
sha256sum "$context_dir/source.tar"
docker build --platform "$platform" --build-arg "ISOMUX_REVISION=$revision" \
  -f deploy/container/Dockerfile -t "$2" - < "$context_dir/source.tar"
docker image inspect "$2" --format '{{.Id}} {{.Os}}/{{.Architecture}}'
