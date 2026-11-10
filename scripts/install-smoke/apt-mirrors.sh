#!/bin/bash
# apt-mirrors.sh archive|fallback|update: points the smoke box's apt at the
# Ubuntu archive and a fallback mirror (apt's mirror+file method), with short
# timeouts so that a host that sends nothing fails over in seconds. Smoke
# boxes only: the smoke tests the installer, not the archive's uptime.
#
#   archive   archive.ubuntu.com and security.ubuntu.com first, the fallback
#             second: what a new server gets, while the archive answers.
#   fallback  the fallback first. run.sh picks it when its probe found the
#             archive stalled: with the archive first, every file waits out
#             the timeout on each of its IPv4 addresses (apt-get update took
#             118 s on 2026-11-10).
#   update    apt-get update for the smoke's own apt steps. apt-get update
#             exits 0 when it ignores an index that no mirror sent ("Ign:"),
#             and the install then finds no packages (2026-11-10: "Ign:3 ...
#             noble InRelease", then exit 100 on jq, python3, tmux). So any
#             index that fails is an error here; then the other mirror goes
#             first and apt-get update runs once more, after a pause.
#
# APT_ROOT (default /) is the root to write under, for tests.
set -euo pipefail
cmd=${1:-}
root=${APT_ROOT:-}
fallback=http://mirrors.edge.kernel.org/ubuntu/
lists=$root/etc/apt/mirrors
# Before the second apt-get update: a mirror that failed for a moment can
# answer again.
retry_pause=10

# mirror_list ORDER FILE ARCHIVE_URL
mirror_list() {
  local first=$3 second=$fallback
  [[ $1 == archive ]] || {
    first=$fallback
    second=$3
  }
  printf '%s\tpriority:1\n%s\tpriority:2\n' "$first" "$second" >"$2"
}

# write_lists ORDER
write_lists() {
  mkdir -p "$lists"
  mirror_list "$1" "$lists/ubuntu.list" http://archive.ubuntu.com/ubuntu/
  mirror_list "$1" "$lists/ubuntu-security.list" http://security.ubuntu.com/ubuntu/
}

configure() {
  local sources=$root/etc/apt/sources.list.d/ubuntu.sources
  grep -q '^URIs: http://archive.ubuntu.com/ubuntu/$' "$sources"
  grep -q '^URIs: http://security.ubuntu.com/ubuntu/$' "$sources"
  write_lists "$1"
  sed -i \
    -e 's|^URIs: http://archive.ubuntu.com/ubuntu/$|URIs: mirror+file:/etc/apt/mirrors/ubuntu.list|' \
    -e 's|^URIs: http://security.ubuntu.com/ubuntu/$|URIs: mirror+file:/etc/apt/mirrors/ubuntu-security.list|' \
    "$sources"
  # No retries on one host: the next mirror is the retry.
  printf 'Acquire::http::Timeout "5";\nAcquire::Retries "0";\n' >"$root/etc/apt/apt.conf.d/99isomux-smoke-mirrors"
}

update() {
  apt-get update --error-on=any && return 0
  local other=fallback
  if [[ $(head -n 1 "$lists/ubuntu.list") == "$fallback"* ]]; then
    other=archive
  fi
  echo "apt-mirrors: apt-get update did not get every index (above); trying again in ${retry_pause}s with the $other mirror first" >&2
  write_lists "$other"
  sleep "$retry_pause"
  apt-get update --error-on=any && return 0
  echo "apt-mirrors: apt-get update did not get every index with either mirror first (archive.ubuntu.com and security.ubuntu.com, $fallback). This is outside isomux." >&2
  return 1
}

case $cmd in
  archive | fallback) configure "$cmd" ;;
  update) update ;;
  *)
    echo "usage: apt-mirrors.sh archive|fallback|update" >&2
    exit 2
    ;;
esac
