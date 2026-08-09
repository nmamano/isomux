#!/usr/bin/env bash
# isomux-cp-run - the box side of the install driver.
#
# Marker polling alone cannot tell a slow step from a dead process, and a blind
# retry can run two installers over each other. So the remote side is this
# wrapper, not a bare `curl | bash`. Its invariants matter more than its text:
#
#   EVERY RUN HAS ITS OWN GENERATION. Status lives in
#   /var/lib/isomux-cp/runs/<runId>/{pid,started,exit,log}, absolute paths only.
#   A retry allocates a new runId, so a previous run's `exit` can never be read
#   as this run's verdict.
#
#   THE SUPERVISOR PUBLISHES, THE LAUNCHER ONLY OBSERVES. The detached
#   supervisor writes its own pid and start-ticks into a COMPLETE generation and
#   only then swaps `current` by atomic rename, while still holding the lock.
#   The launcher never publishes anything and never reports success it has not
#   seen. Its outcome is three-valued: CONFIRMED, FAILED (the supervisor died
#   before publication), or UNCONFIRMED (timeout) - and UNCONFIRMED is resolved
#   by the next tick, never by launching again. Relaunching an unconfirmed run
#   is the same error as replaying an ambiguous create.
#
#   THE INSTALLER NEVER SEES THE LOCK FD. The supervisor owns fd 9 and runs the
#   installer with `9>&-`, so nothing the installer forks can inherit the lock
#   and hold single-flight shut after the installer itself has exited.
#
#   THE EXIT STATUS IS CAPTURED WHEN THE TRAP FIRES, not when it is installed.
#   The trap body is SINGLE-quoted; double quotes would expand $? at
#   installation time and record whatever ran before it.
#
#   THE LOG IS APPENDED AND NEVER TRUNCATED, so a failed install can be read by
#   a human afterwards.
#
# Usage (as root):
#   isomux-cp-run launch <runId> <command> [args...]
#   isomux-cp-run tick
#   isomux-cp-run _supervise <runId> <command> [args...]   (internal)

set -Eeuo pipefail

# The run root is /var/lib/isomux-cp on a real box. It is overridable only so
# control-plane/wrapper.test.ts can point the protocol at a temp tree and
# exercise it for real - the same seam deploy/install.sh uses for its own tests.
# The driver never sets it.
ROOT=${ISOMUX_CP_ROOT:-/var/lib/isomux-cp}
RUNS=$ROOT/runs
LOCK=$ROOT/lock
CURRENT=$ROOT/current
PUBLISH_TIMEOUT_S=${PUBLISH_TIMEOUT_S:-20}

# Field 22 of /proc/<pid>/stat is the process start time in clock ticks since
# boot. Together with the pid it identifies a specific process: a pid on its own
# can be reused, and a reused pid would make a dead generation look alive.
# `comm` (field 2) is parenthesised and may contain spaces, so the fields are
# counted from after the last ')' rather than by naive whitespace splitting.
start_ticks() {
  local stat rest
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  rest=${stat##*') '}
  printf '%s\n' "$rest" | awk '{print $20}'
}

launch() {
  local run_id=$1
  shift
  [[ -n $run_id ]] || {
    echo "usage: isomux-cp-run launch <runId> <command>..." >&2
    exit 2
  }
  mkdir -p "$RUNS"

  # Single-flight. The launcher holds the lock while it waits, so nothing else
  # can start in the window before the supervisor has published.
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "LOCKED another run holds the lock"
    exit 3
  fi

  local rundir=$RUNS/$run_id
  if [[ -e $rundir ]]; then
    echo "FAILED generation $run_id already exists"
    exit 4
  fi

  # The supervisor inherits fd 9 and owns the lock for the run's whole life.
  # `bash "$0"` rather than "$0": the interpreter is named explicitly so this
  # works whether or not the file carries its executable bit, and a supervisor
  # that cannot even start is a launch failure rather than a silent timeout.
  if ! setsid --fork bash "$0" _supervise "$run_id" "$@" </dev/null >/dev/null 2>&1; then
    echo "FAILED could not start the supervisor"
    exit 4
  fi

  local deadline=$(($(date +%s) + PUBLISH_TIMEOUT_S))
  while :; do
    if [[ -L $CURRENT && $(readlink "$CURRENT") == "$rundir" && -s $rundir/pid && -s $rundir/started ]]; then
      echo "CONFIRMED $run_id"
      exit 0
    fi
    # The supervisor writes its pid first, so a pid we can read whose process is
    # gone, with `current` still not pointing here, is a death before
    # publication - a genuine launch failure, and the lock is free for a retry.
    if [[ -s $rundir/pid ]]; then
      local sup
      sup=$(cat "$rundir/pid")
      if ! kill -0 "$sup" 2>/dev/null; then
        if [[ -L $CURRENT && $(readlink "$CURRENT") == "$rundir" ]]; then
          continue
        fi
        echo "FAILED supervisor died before publication"
        exit 4
      fi
    fi
    if (($(date +%s) >= deadline)); then
      # Not a failure: the run may be about to publish. The next tick settles
      # it. Launching again here would be the duplicate-run bug.
      echo "UNCONFIRMED publication timed out; resolve with tick, do not relaunch"
      exit 5
    fi
    sleep 0.2
  done
}

_supervise() {
  local run_id=$1
  shift
  RUN_DIR=$RUNS/$run_id
  mkdir -p "$RUN_DIR"

  # pid first: it is what lets the launcher tell "died before publishing" from
  # "has not got there yet".
  printf '%s\n' "$$" >"$RUN_DIR/pid"
  printf 'epoch=%s\nstartticks=%s\n' "$(date +%s)" "$(start_ticks $$)" >"$RUN_DIR/started"
  touch "$RUN_DIR/log"

  # Publish only now that the generation is complete, by atomic rename, still
  # holding the lock on fd 9.
  ln -sfn "$RUN_DIR" "$ROOT/.current.$$"
  mv -T "$ROOT/.current.$$" "$CURRENT"

  # Single-quoted on purpose. See the header.
  trap 'printf %s "$?" >"$RUN_DIR/exit"' EXIT

  local rc=0
  # 9>&- keeps the lock fd away from the installer and everything it forks.
  "$@" >>"$RUN_DIR/log" 2>&1 9>&- || rc=$?
  exit "$rc"
}

tick() {
  if [[ ! -L $CURRENT ]]; then
    echo "state=none"
    return 0
  fi
  local rundir run_id
  rundir=$(readlink "$CURRENT")
  run_id=$(basename "$rundir")

  # 1. The exit file. Present means finished, and its value is the verdict.
  if [[ -f $rundir/exit ]]; then
    printf 'state=finished runId=%s exit=%s step=%s\n' \
      "$run_id" "$(cat "$rundir/exit")" "$(last_step "$rundir")"
    return 0
  fi

  # 2. Is the recorded process still the one we started? A live pid whose start
  # ticks differ is a reused pid, not our run.
  local pid alive=0 recorded current_ticks
  pid=$(cat "$rundir/pid" 2>/dev/null || echo "")
  recorded=$(sed -n 's/^startticks=//p' "$rundir/started" 2>/dev/null || echo "")
  if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
    current_ticks=$(start_ticks "$pid" || echo "")
    if [[ -n $recorded && -n $current_ticks && $recorded == "$current_ticks" ]]; then
      alive=1
    fi
  fi

  if ((alive)); then
    printf 'state=running runId=%s pid=%s step=%s\n' \
      "$run_id" "$pid" "$(last_step "$rundir")"
    return 0
  fi

  # 3. RE-READ the exit file before calling it a crash. The process may have
  # exited between step 1 and step 2, and a finished run is not a crashed one.
  if [[ -f $rundir/exit ]]; then
    printf 'state=finished runId=%s exit=%s step=%s\n' \
      "$run_id" "$(cat "$rundir/exit")" "$(last_step "$rundir")"
    return 0
  fi

  printf 'state=crashed runId=%s step=%s\n' "$run_id" "$(last_step "$rundir")"
}

last_step() {
  grep -a -- '--- step: ' "$1/log" 2>/dev/null | tail -1 |
    sed 's/.*--- step: //' || true
}

case "${1:-}" in
  launch)
    shift
    launch "$@"
    ;;
  _supervise)
    shift
    _supervise "$@"
    ;;
  tick)
    tick
    ;;
  *)
    echo "usage: isomux-cp-run {launch <runId> <command>... | tick}" >&2
    exit 2
    ;;
esac
