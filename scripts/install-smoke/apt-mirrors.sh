#!/bin/bash
# apt-mirrors.sh archive|fallback: points the smoke box's apt at the Ubuntu
# archive and a fallback mirror (apt's mirror+file method), with short
# timeouts so that a host that sends nothing fails over in seconds. Smoke
# boxes only: the smoke tests the installer, not the archive's uptime.
#
#   archive   archive.ubuntu.com and security.ubuntu.com first, the fallback
#             second: what a new server gets, while the archive answers.
#   fallback  the fallback first. run.sh picks it when its probe found the
#             archive stalled: with the archive first, every file waits out
#             the timeout on each of its IPv4 addresses (apt-get update took
#             118 s on 2026-11-10).
#
# APT_ROOT (default /) is the root to write under, for tests.
set -euo pipefail
order=${1:-}
root=${APT_ROOT:-}
fallback=http://mirrors.edge.kernel.org/ubuntu/
if [[ $order != archive && $order != fallback ]]; then
  echo "usage: apt-mirrors.sh archive|fallback" >&2
  exit 2
fi

# mirror_list FILE ARCHIVE_URL
mirror_list() {
  local first=$2 second=$fallback
  [[ $order == archive ]] || {
    first=$fallback
    second=$2
  }
  printf '%s\tpriority:1\n%s\tpriority:2\n' "$first" "$second" >"$1"
}

sources=$root/etc/apt/sources.list.d/ubuntu.sources
grep -q '^URIs: http://archive.ubuntu.com/ubuntu/$' "$sources"
grep -q '^URIs: http://security.ubuntu.com/ubuntu/$' "$sources"
mkdir -p "$root/etc/apt/mirrors"
mirror_list "$root/etc/apt/mirrors/ubuntu.list" http://archive.ubuntu.com/ubuntu/
mirror_list "$root/etc/apt/mirrors/ubuntu-security.list" http://security.ubuntu.com/ubuntu/
sed -i \
  -e 's|^URIs: http://archive.ubuntu.com/ubuntu/$|URIs: mirror+file:/etc/apt/mirrors/ubuntu.list|' \
  -e 's|^URIs: http://security.ubuntu.com/ubuntu/$|URIs: mirror+file:/etc/apt/mirrors/ubuntu-security.list|' \
  "$sources"
# No retries on one host: the next mirror is the retry.
printf 'Acquire::http::Timeout "5";\nAcquire::Retries "0";\n' >"$root/etc/apt/apt.conf.d/99isomux-smoke-mirrors"
