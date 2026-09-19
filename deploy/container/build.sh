#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ $# == 2 ]] || { echo 'Usage: deploy/container/build.sh REVISION LOCAL_IMAGE_TAG' >&2; exit 2; }
context_dir=$(mktemp -d)
trap 'rm -rf "$context_dir"' EXIT
revision=$(python3 deploy/container/context.py "$1" "$context_dir/source.tar")
sha256sum "$context_dir/source.tar"
docker build --platform linux/amd64 --build-arg "ISOMUX_REVISION=$revision" \
  -f deploy/container/Dockerfile -t "$2" - < "$context_dir/source.tar"
docker image inspect "$2" --format '{{.Id}} {{.Os}}/{{.Architecture}}'
