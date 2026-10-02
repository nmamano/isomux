#!/usr/bin/env bash
# Local image check: build REVISION, run smoke.py and compose-check.py, and
# remove the image again, pass or fail.
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ $# == 1 ]] || { echo 'Usage: deploy/container/check.sh REVISION' >&2; exit 2; }
image=isomux-check:$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
remove() {
  if docker image inspect "$image" >/dev/null 2>&1; then docker image rm "$image" >/dev/null; fi
}
trap remove EXIT
trap 'exit 143' TERM
bash deploy/container/build.sh "$1" "$image"
python3 deploy/container/smoke.py "$image"
python3 deploy/container/compose-check.py "$image"
