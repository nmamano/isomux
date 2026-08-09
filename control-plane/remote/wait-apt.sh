#!/usr/bin/env bash
# Wait until the box has finished its OWN boot-time package work.
#
# A freshly built Ubuntu cloud image runs apt on boot - apt-daily,
# unattended-upgrades, the seeding of the image's own updates. Those hold
# /var/lib/dpkg/lock-frontend for the first minutes of the box's life, and an
# installer that starts in that window dies immediately:
#
#   E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process N
#
# Measured 2026-08-09: SSH answered 88s after the rebuild was requested, and apt
# was still holding the lock at T+2min. So "the box authenticates our key" is
# NOT the same claim as "the box is ready to be provisioned", and the driver has
# to make the second one before it launches anything.
#
# Detection is layered because none of the tools is guaranteed on a minimal
# image, and a check that silently cannot run would report a busy box as ready:
#   1. /proc/locks - always present, and it is the actual kernel lock table;
#   2. fuser, when psmisc is installed;
#   3. the process names, as a last resort.
# Any one of them saying "busy" means busy. Only agreement means ready.
#
# NOTE: `flock` is deliberately NOT used to test this. dpkg takes an fcntl
# (POSIX) lock, and flock(2) locks live in a different namespace on Linux, so
# `flock` would cheerfully succeed while apt holds the file - a check that
# always passes is worse than no check.
#
# Usage: wait-apt.sh [timeout-seconds] [poll-seconds]
#        wait-apt.sh once
#
# `once` performs exactly ONE check and exits, for a caller that owns its own
# scheduling - a tick may not sleep. It calls the same busy_reason() the loop
# does, so there is no second copy of the layered detection above or of its "any
# one of them saying busy means busy" rule.

set -uo pipefail

MODE=
if [ "${1:-}" = "once" ]; then
  MODE=once
  shift
fi

TIMEOUT=${1:-600}
# 5s in production; the tests pass 1 so they do not each cost a poll interval.
POLL=${2:-5}
# The lock paths are fixed on a real box. ISOMUX_APT_LOCKS exists only so
# control-plane/wait-apt.test.ts can point the detector at a temp file and hold a
# real POSIX lock on it - the same test seam wrapper.sh uses. When it is set the
# process-name fallback is skipped, because on a developer machine an unrelated
# apt run would make the test flap. The driver never sets it.
if [ -n "${ISOMUX_APT_LOCKS:-}" ]; then
  read -r -a LOCKS <<<"$ISOMUX_APT_LOCKS"
  PROCESS_CHECK=0
else
  LOCKS=(/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock)
  PROCESS_CHECK=1
fi
deadline=$(($(date +%s) + TIMEOUT))
waited=0

held_by_kernel() {
  local f=$1 ino
  [ -e "$f" ] || return 1
  ino=$(stat -c %i "$f" 2>/dev/null) || return 1
  # /proc/locks field 6 is MAJ:MIN:INODE.
  awk -v want="$ino" '{
    n = split($6, a, ":")
    if (n >= 3 && a[n] == want) { found = 1 }
  } END { exit !found }' /proc/locks
}

busy_reason() {
  local f
  for f in "${LOCKS[@]}"; do
    held_by_kernel "$f" && {
      printf 'kernel lock on %s\n' "$f"
      return 0
    }
    if command -v fuser >/dev/null 2>&1 && fuser "$f" >/dev/null 2>&1; then
      printf 'fuser reports a holder of %s\n' "$f"
      return 0
    fi
  done
  [ "$PROCESS_CHECK" -eq 1 ] || return 1
  local p
  for p in apt-get apt dpkg unattended-upgrade; do
    if pgrep -x "$p" >/dev/null 2>&1; then
      printf 'process %s is running\n' "$p"
      return 0
    fi
  done
  return 1
}

# One check, no sleeping. The reason string is the caller's evidence: when it
# changes, the box is making progress rather than being stuck.
if [ "$MODE" = once ]; then
  reason=$(busy_reason) || {
    printf 'RESULT: ready\n'
    exit 0
  }
  printf 'RESULT: busy (%s)\n' "$reason"
  exit 0
fi

while :; do
  reason=$(busy_reason) || {
    printf 'RESULT: ready (waited %ss)\n' "$waited"
    exit 0
  }
  if [ "$(date +%s)" -ge "$deadline" ]; then
    printf 'RESULT: still-busy after %ss (%s)\n' "$waited" "$reason"
    exit 1
  fi
  sleep "$POLL"
  waited=$((waited + POLL))
done
