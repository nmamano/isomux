#!/usr/bin/env bash
# Runs the CI gate (`bun run ci`) for one commit on a remote Linux machine, so
# a busy dev box does not run it. Exit 0 is green; any other code is red.
#
#   bun run ci:remote [<rev>]       one commit (default HEAD)
#   scripts/ci-remote.sh --pre-push  what .githooks/pre-push runs
#   bash scripts/ci-remote.sh --gate [<path>...]  a lane's tsc and scoped tests
#
# The target is the clone's git config key isomux.ciRemote (user@host), set
# with `git config isomux.ciRemote user@host`: never committed, and shared by
# every worktree of the clone. Unset, both CI entry points run `bun run ci`
# here, in place, as the hook always did.
#
# Set, the commit goes to the remote by `git push` over ssh, and this file is
# piped to the remote shell to run it there (--remote below). The remote half
# exits 0 for a green run and 1 for a red one. Any other code, ssh's own 255
# included, means the remote could not run the suite: the script says why and
# tries again every CI_RETRY_EVERY seconds, for CI_RETRY_FOR seconds from that
# first failure, and then runs the suite here. A red from the remote is never
# retried and never falls back. A push that fails gets one repair of the
# remote's cache (--repair below) and one more try.
#
# Each run tees its output to a log under ${TMPDIR:-/tmp} and prints the path
# first. A green run deletes its log; a red run keeps it.
#
# --gate runs `bun x tsc --noEmit` and, when paths are given, `bun run
# build:ui` and `bun test` on those paths, for the committed HEAD of this
# checkout, on the same remote. It writes no file here: the caller redirects
# its output. The first line is the commit's sha and the last is exit=<n>:
# 0 green, 1 red, 2 refused (nothing was sent), 3 no verdict. It never runs
# here: with no target, or when the remote cannot run it, it exits 3. Each path
# must be tracked at HEAD and contain nothing under control-plane/, whose tests
# need the Postgres that a CI run holds on the remote.
#
# The remote needs git, curl, unzip, flock, jq, a working `docker compose`
# and a user systemd manager; it needs no sudo. It keeps
# ~/.cache/isomux-ci-remote: a bare repo, the pinned node, bun and Postgres,
# and the bun package cache. A run's checkout, HOME, TMPDIR and database live
# in runs/<id> there and are deleted when the run ends. The container stage
# removes its image but leaves Docker build cache in the daemon, which
# BuildKit's garbage collection bounds.
set -uo pipefail

NODE_VERSION=v24.22.1
NODE_SHA256=eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c
BUN_VERSION=1.4.4
BUN_SHA256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
PG_VERSION=18.4.0-beta.17
# The control-plane suite's Postgres port, a constant in control-plane/testing/pg.ts.
PG_PORT=5433
RUN_LIMIT=30m
# Seconds to keep trying the remote after its first no-verdict, and the pause
# between tries: long enough for a remote that crashed to come back (the WSL
# remote used here restarts within one 5-minute keepalive cycle plus its boot,
# 2026-10-23).
CI_RETRY_FOR=360
CI_RETRY_EVERY=30
REMOTE_ROOT=.cache/isomux-ci-remote
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
# Gate runs at once on the remote. Each takes about 2.5 GiB (tsc peaked at
# 2.2 GiB, 2026-10-23), and the remote's memory must still hold a CI run
# beside them (task b3056d6c).
GATE_SLOTS=2
# Seconds a gate run waits for a slot and for a CI run to end, together.
GATE_WAIT=600
GATE_RUN_LIMIT=20m
NULL_SHA=0000000000000000000000000000000000000000

# --- local half ------------------------------------------------------------

run_here() {
  local log=$1 status
  echo "→ bun run ci (the exact GitHub gate)"
  echo "  full output: $log"
  bun run ci 2>&1 | tee -a "$log"
  status=${PIPESTATUS[0]}
  if [[ $status -eq 0 ]]; then
    rm -f -- "$log"
  else
    echo "✗ bun run ci failed (exit $status). Full output: $log"
  fi
  return "$status"
}

# Sends one commit to the remote's bare repo as <ref>. Transport output goes
# to stdout. A failed push gets one repair of the remote's cache and one more
# try: a crash of the remote can leave empty object files and refs to them,
# and every later push then fails. Returns 0, or 255 when the commit is not
# there. When the second push fails, PUSH_ERROR holds git's first error line.
push_commit() {
  local sha=$1 ref=$2 out
  local push=(git push -q --no-verify "$TARGET:$REMOTE_ROOT/repo.git" "$sha:$ref")
  PUSH_ERROR=""
  # --no-verify: this push is the transport, and the pre-push hook may be
  # what called us.
  ssh "${SSH_OPTS[@]}" "$TARGET" "git init -q --bare $REMOTE_ROOT/repo.git" 2>&1 || return 255
  GIT_SSH_COMMAND="ssh ${SSH_OPTS[*]}" "${push[@]}" 2>&1 && return 0
  echo "→ the push to $TARGET failed; repairing its cache"
  ssh "${SSH_OPTS[@]}" "$TARGET" bash -s -- --repair <"${BASH_SOURCE[0]}" 2>&1 || return 255
  out=$(GIT_SSH_COMMAND="ssh ${SSH_OPTS[*]}" "${push[@]}" 2>&1) && return 0
  [[ -z $out ]] || printf '%s\n' "$out"
  # git's last line only says that some refs failed.
  PUSH_ERROR=$(grep -m1 -E 'fatal:|error:' <<<"$out" || last_line "$out")
  PUSH_ERROR=${PUSH_ERROR:-no output}
  return 255
}

# The last non-empty line of its argument.
last_line() {
  grep -v '^[[:space:]]*$' <<<"$1" | tail -n1 | tr -d '\r'
}

new_id() {
  echo "$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
}

# Returns the remote half's exit code: 0 green, 1 red, anything else no verdict.
run_remote() {
  local sha=$1 log=$2 id=$3 host=$TARGET status
  echo "→ bun run ci on $host at $sha"
  echo "  full output: $log"
  push_commit "$sha" "refs/ci/$id" >>"$log" || return 255
  ssh "${SSH_OPTS[@]}" "$host" bash -s -- --remote "$sha" "$id" <"${BASH_SOURCE[0]}" 2>&1 | tee -a "$log"
  status=${PIPESTATUS[0]}
  # The remote half deletes its ref; this covers a run that never started.
  ssh "${SSH_OPTS[@]}" "$host" "git -C $REMOTE_ROOT/repo.git update-ref -d refs/ci/$id" >/dev/null 2>&1
  return "$status"
}

# Why an attempt gave no verdict, from its exit code and its output.
attempt_cause() {
  local status=$1 out=$2 line
  if [[ -n $PUSH_ERROR ]]; then
    echo "the push failed: $PUSH_ERROR"
    return
  fi
  case $status in
    255)
      # ssh prints its own error last, also when a running connection drops.
      line=$(last_line "$out")
      echo "ssh exit 255${line:+: $line}"
      ;;
    3)
      # The remote half's setup_failed line.
      line=$(grep -o 'could not run CI: .*' <<<"$out" | tail -n1 | tr -d '\r')
      line=${line#could not run CI: }
      echo "${line:-exit 3}"
      ;;
    *) echo "exit $status" ;;
  esac
}

one_commit() {
  local rev=$1 sha id log status start cause deadline=""
  sha=$(git rev-parse --verify --quiet "$rev^{commit}") || {
    echo "✗ not a commit: $rev" >&2
    return 2
  }
  id=$(new_id)
  log="${TMPDIR:-/tmp}/isomux-ci-$id.log"
  while :; do
    start=$(wc -c 2>/dev/null <"$log" || echo 0)
    run_remote "$sha" "$log" "$id"
    status=$?
    case $status in
      0)
        rm -f -- "$log"
        echo "✓ CI passed on $TARGET."
        return 0
        ;;
      1)
        echo "✗ CI failed on $TARGET. Full output: $log"
        return 1
        ;;
    esac
    cause=$(attempt_cause "$status" "$(tail -c +$((start + 1)) "$log" 2>/dev/null)")
    # The window counts from the first failure, which can come late in a run.
    [[ -n $deadline ]] || deadline=$((SECONDS + CI_RETRY_FOR))
    ((SECONDS + CI_RETRY_EVERY <= deadline)) || break
    echo "→ $TARGET could not run CI: $cause; trying again in ${CI_RETRY_EVERY}s" | tee -a "$log"
    sleep "$CI_RETRY_EVERY"
    id=$(new_id)
  done
  echo "→ $TARGET could not run CI: $cause; running it here" | tee -a "$log"
  run_here "$log"
}

# The gate's local half. Every outcome prints the sha first and exit=<n> last.
gate_main() {
  local sha status
  sha=$(git rev-parse --verify --quiet "HEAD^{commit}") || sha=$NULL_SHA
  echo "$sha"
  gate_run "$sha" "$@"
  status=$?
  echo "exit=$status"
  return "$status"
}

gate_run() {
  local sha=$1 top arg path files id status
  shift
  if [[ $sha == "$NULL_SHA" ]]; then
    echo "✗ not in a git checkout with a commit"
    return 2
  fi
  top=$(git rev-parse --show-toplevel) || return 2
  local dirty
  dirty=$(git -C "$top" status --porcelain --untracked-files=no)
  if [[ -n $dirty ]]; then
    echo "✗ the working tree differs from HEAD, and the gate tests commits only:"
    echo "$dirty"
    return 2
  fi
  # bun test reads a bare argument as a name filter, so each one must be a
  # tracked path; the remote hands it to bun as ./<path>.
  local paths=() cp
  for arg in "$@"; do
    if [[ $arg == -* ]]; then
      echo "✗ $arg: give paths only, no bun test options"
      return 2
    fi
    path=${arg#./}
    path=${path%/}
    files=""
    [[ -z $path ]] || files=$(git -C "$top" ls-tree -r --name-only "$sha" -- "$path" 2>/dev/null)
    if [[ -z $files ]]; then
      echo "✗ $arg: not a path tracked at $sha (paths are relative to the repo root)"
      return 2
    fi
    cp=$(grep -m1 '^control-plane/' <<<"$files")
    if [[ -n $cp ]]; then
      echo "✗ $arg: holds $cp; run control-plane tests here (they need Postgres on $PG_PORT)"
      return 2
    fi
    paths+=("$(printf '%q' "$path")")
  done
  TARGET=$(git config --get isomux.ciRemote)
  if [[ -z $TARGET ]]; then
    echo "✗ git config isomux.ciRemote is not set; run the gates here"
    return 3
  fi
  id=$(new_id)
  echo "→ tsc${paths[*]:+ and bun test} on $TARGET"
  push_commit "$sha" "refs/gate/$id" || {
    echo "✗ $TARGET could not take the commit; run the gates here"
    return 3
  }
  ssh "${SSH_OPTS[@]}" "$TARGET" bash -s -- --remote-gate "$sha" "$id" -- "${paths[@]}" <"${BASH_SOURCE[0]}" 2>&1
  status=$?
  ssh "${SSH_OPTS[@]}" "$TARGET" "git -C $REMOTE_ROOT/repo.git update-ref -d refs/gate/$id" >/dev/null 2>&1
  case $status in
    0 | 1) return "$status" ;;
    3) ;;
    *) echo "✗ $TARGET could not run the gates (exit $status)" ;;
  esac
  echo "  no verdict: run the gates here"
  return 3
}

local_main() {
  # git exports GIT_DIR to hooks; from a linked worktree it is an absolute path
  # into the shared repo. CI must not inherit it: a test that runs `git init` in
  # a temp dir would otherwise write into the shared repo config and refs.
  # shellcheck disable=SC2046
  unset $(git rev-parse --local-env-vars)

  if [[ ${1:-} == --gate ]]; then
    shift
    gate_main "$@"
    return
  fi
  TARGET=$(git config --get isomux.ciRemote)
  if [[ -z $TARGET ]]; then
    run_here "${TMPDIR:-/tmp}/isomux-pre-push-$(date +%Y%m%dT%H%M%S).log"
    return
  fi
  if [[ ${1:-} != --pre-push ]]; then
    one_commit "${1:-HEAD}"
    return
  fi
  # Hook input: one "<local ref> <local sha> <remote ref> <remote sha>" line per
  # pushed ref. An all-zero local sha is a deletion and has nothing to test.
  local _ sha="" seen=" " status
  while read -r _ sha _ _ || [[ -n $sha ]]; do
    [[ $sha =~ ^0+$ || $seen == *" $sha "* ]] && continue
    seen+="$sha "
  done
  for sha in $seen; do
    one_commit "$sha" </dev/null
    status=$?
    [[ $status -eq 0 ]] || return "$status"
  done
}

# --- remote half -------------------------------------------------------------
# Exit 0: the run passed. Exit 1: it ran and failed. Exit 3: it could not run
# here. Nothing else, so ssh's 255 stays unambiguous.

say() { printf '%s\n' "$*"; }

# The pinned toolchain, checksummed. The system node and ~/.bun are not used.
# CI and gate runs share it, so installs take a lock.
install_toolchain() {
  local root=$1 tmp=$2 with_pg=$3 tools pg_dir
  tools=$root/toolchain
  pg_dir=$tools/pg-$PG_VERSION
  exec 7>"$root/toolchain.lock"
  flock 7
  if [[ ! -x $tools/node-$NODE_VERSION-linux-x64/bin/node ]]; then
    say "  installing node $NODE_VERSION"
    { curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.gz" -o "$tmp/node.tgz" &&
      echo "$NODE_SHA256  $tmp/node.tgz" | sha256sum -c --quiet &&
      tar -xzf "$tmp/node.tgz" -C "$tools"; } || setup_failed "node $NODE_VERSION download"
  fi
  if [[ ! -x $tools/bun-$BUN_VERSION/bun ]]; then
    say "  installing bun $BUN_VERSION"
    { curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64.zip" -o "$tmp/bun.zip" &&
      echo "$BUN_SHA256  $tmp/bun.zip" | sha256sum -c --quiet &&
      unzip -q "$tmp/bun.zip" -d "$tmp" &&
      mkdir -p "$tools/bun-$BUN_VERSION" &&
      mv "$tmp/bun-linux-x64/bun" "$tools/bun-$BUN_VERSION/bun"; } || setup_failed "bun $BUN_VERSION download"
  fi
  if [[ $with_pg == pg && ! -x $pg_dir/node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl ]]; then
    say "  installing Postgres $PG_VERSION"
    { mkdir -p "$pg_dir" &&
      printf '{"dependencies":{"@embedded-postgres/linux-x64":"%s"},"trustedDependencies":["@embedded-postgres/linux-x64"]}\n' \
        "$PG_VERSION" >"$pg_dir/package.json" &&
      "${sandbox[@]}" bun install --cwd "$pg_dir" >/dev/null; } || setup_failed "Postgres $PG_VERSION install"
  fi
  exec 7>&-
}

# Checks out <sha> from the bare repo into <dir>/src. --shared is CI's: its
# clone borrows the bare repo's objects. A gate clone hardlinks them, so a
# repair cannot break it.
check_out() {
  local root=$1 sha=$2 dir=$3 clone_opt=$4
  say "  checking out $sha"
  # shellcheck disable=SC2086 # an empty option is no option
  { git clone -q $clone_opt --no-checkout "$root/repo.git" "$dir/src" &&
    git -C "$dir/src" checkout -q --detach "$sha" &&
    [[ $(git -C "$dir/src" rev-parse HEAD) == "$sha" ]]; } || setup_failed "checkout of $sha"
}

# Checks the commit's bun pin and installs its dependencies.
install_deps() {
  local dir=$1 pinned
  pinned=$(jq -r .packageManager "$dir/src/package.json")
  [[ $pinned == "bun@$("${sandbox[@]}" bun --version)" ]] ||
    setup_failed "the commit pins $pinned and this script pins bun@$BUN_VERSION"
  say "  installing dependencies"
  (cd "$dir/src" && "${sandbox[@]}" bun install --frozen-lockfile &&
    "${sandbox[@]}" bun install --cwd control-plane/web --frozen-lockfile) >"$dir/install.log" 2>&1 || {
    cat "$dir/install.log"
    setup_failed "bun install"
  }
}

# What the remote half runs, for its messages.
RUN_NAME=CI
setup_failed() {
  say "✗ $(hostname) could not run $RUN_NAME: $1"
  exit 3
}

# Stops every process of a run's scope and deletes its directories. Touches
# only what this script named after the run.
clear_dir() {
  local scope=$1 tries=0
  shift
  systemctl --user kill --signal=SIGKILL "$scope" >/dev/null 2>&1
  while systemctl --user is-active --quiet "$scope"; do
    ((tries++ < 50)) || {
      say "✗ $scope still has processes; left $1 in place" >&2
      return 1
    }
    sleep 0.2
  done
  rm -rf "$@"
}

remote_main() {
  local sha=$1 id=$2
  local root=$HOME/$REMOTE_ROOT
  local run=$root/runs/$id
  # TMPDIR stays short and under /tmp as on a dev box: a long one pushes the
  # suite's unix socket paths over the kernel's 108-byte limit, and a test
  # checks that its temp files sit in world-traversable directories.
  local tmp=/tmp/icr-${id##*-}
  local tools=$root/toolchain
  local pg_bin=$tools/pg-$PG_VERSION/node_modules/@embedded-postgres/linux-x64/native/bin

  # A closed ssh connection must not kill this shell before cleanup. Children
  # get the default disposition back through `env --default-signal`.
  trap '' PIPE

  # Every command below runs in this scrubbed environment, so no install,
  # build or test writes outside $run or $root/cache.
  local sandbox=(env -i --default-signal=PIPE
    PATH="$tools/node-$NODE_VERSION-linux-x64/bin:$tools/bun-$BUN_VERSION:/usr/local/bin:/usr/bin:/bin"
    HOME="$run/home" TMPDIR="$tmp" BUN_INSTALL_CACHE_DIR="$root/cache/bun"
    NEXT_TELEMETRY_DISABLED=1 LANG=C.UTF-8 USER="$USER" LOGNAME="$USER" SHELL=/bin/bash)
  clear_run() {
    local dir=$1 id=${1##*/}
    clear_dir "isomux-ci-$id.scope" "$dir" "/tmp/icr-${id##*-}"
  }

  mkdir -p "$root/runs" "$root/cache" "$tools" || setup_failed "cannot create $root"
  exec 9>"$root/lock"
  if ! flock -n 9; then
    say "  waiting for another CI run on $(hostname)"
    flock 9
  fi

  # A run killed before its own cleanup leaves its directory behind.
  local stale
  for stale in "$root"/runs/*; do
    [[ ! -d $stale ]] || clear_run "$stale" || setup_failed "a previous run still has processes"
  done
  # The temp directory comes first: a run directory exists only with its own.
  mkdir "$tmp" || setup_failed "cannot create $tmp"
  # A failed cleanup is reported but does not change the verdict: the exit
  # code is about the commit, and the next run refuses while the processes
  # live.
  trap 'clear_run "$run"; git -C "$root/repo.git" update-ref -d "refs/ci/$id" 2>/dev/null' EXIT
  trap 'exit 3' HUP INT TERM
  mkdir -p "$run/home" || setup_failed "cannot create $run"

  install_toolchain "$root" "$tmp" pg

  # The Docker test returns early when no docker is on PATH, so a missing or
  # stopped Docker would pass it without running it.
  "${sandbox[@]}" docker version >/dev/null 2>&1 || setup_failed "Docker is not running"
  "${sandbox[@]}" docker compose version >/dev/null 2>&1 || setup_failed "docker compose is missing"
  "${sandbox[@]}" jq --version >/dev/null 2>&1 || setup_failed "jq is missing"
  if (exec 3<>"/dev/tcp/127.0.0.1/$PG_PORT") 2>/dev/null; then
    setup_failed "port $PG_PORT is in use"
  fi

  check_out "$root" "$sha" "$run" --shared
  # The run ref goes; one base ref stays so the next push sends only new objects.
  git -C "$root/repo.git" update-ref refs/ci-base "$sha"
  git -C "$root/repo.git" update-ref -d "refs/ci/$id"
  install_deps "$run"

  # Postgres and CI run in one scope, so killing the scope stops every
  # process of the run, detached CI stages included. The started file marks
  # that the setup inside the scope passed and `bun run ci` began.
  say "  running bun run ci"
  : >"$run/ci.log"
  (cd "$run/src" && exec systemd-run --user --scope --collect --quiet --unit="isomux-ci-$id" -- \
    "${sandbox[@]}" bash -c '
      "$1/initdb" -D "$2/pg" -U isomux --auth=trust >"$2/pg-setup.log" 2>&1 &&
        echo "CREATE DATABASE control_plane_test;" | "$1/postgres" --single -D "$2/pg" postgres >>"$2/pg-setup.log" 2>&1 &&
        "$1/pg_ctl" -D "$2/pg" -o "-p $3 -h 127.0.0.1 -k $TMPDIR" -l "$2/pg.log" -w start >>"$2/pg-setup.log" 2>&1 ||
        exit 3
      : >"$2/started"
      nice -n 10 timeout -k 30s "$4" bun run ci >"$2/ci.log" 2>&1
    ' _ "$pg_bin" "$run" "$PG_PORT" "$RUN_LIMIT" 9>&-) &
  local ci_pid=$!
  tail -n +1 -f --pid="$ci_pid" "$run/ci.log" 2>/dev/null
  wait "$ci_pid"
  local ci_status=$?
  if [[ ! -e $run/started ]]; then
    cat "$run/pg-setup.log" 2>/dev/null
    setup_failed "Postgres did not start"
  fi
  [[ $ci_status -eq 124 ]] && say "✗ bun run ci passed the $RUN_LIMIT limit"
  [[ $ci_status -eq 0 ]] && exit 0
  exit 1
}

# Takes a free gate slot, after any CI run ends: sets GATE_SLOT and keeps the
# slot's lock on fd 8. Returns 1 when the wait passes GATE_WAIT seconds.
take_gate_slot() {
  local root=$1 deadline n said_ci="" said_slot=""
  deadline=$(($(date +%s) + GATE_WAIT))
  while :; do
    # CI keeps priority: no gate run starts while a CI run holds its lock.
    if ! flock -n "$root/lock" true; then
      [[ -n $said_ci ]] || say "  waiting for a CI run on $(hostname) to end"
      said_ci=1
    else
      for ((n = 1; n <= GATE_SLOTS; n++)); do
        exec 8>"$root/gate-slot-$n"
        if flock -n 8; then
          GATE_SLOT=$n
          return 0
        fi
        exec 8>&-
      done
      [[ -n $said_slot ]] || say "  waiting for one of $GATE_SLOTS gate slots on $(hostname)"
      said_slot=1
    fi
    if (($(date +%s) >= deadline)); then
      say "✗ waited ${GATE_WAIT}s for ${said_slot:+a gate slot}${said_slot:+${said_ci:+ and }}${said_ci:+a CI run to end}"
      return 1
    fi
    sleep 2
  done
}

remote_gate_main() {
  local sha=$1 id=$2
  shift 2
  [[ ${1:-} == -- ]] && shift
  # ./ makes bun test read a path, not a name filter.
  local paths=() arg
  for arg in "$@"; do paths+=("./$arg"); done
  local root=$HOME/$REMOTE_ROOT
  local tools=$root/toolchain
  local slot run tmp scope stale_tmp
  RUN_NAME="the gates"
  trap '' PIPE
  mkdir -p "$root/gate-runs" "$root/cache" "$tools" || setup_failed "cannot create $root"
  take_gate_slot "$root" || exit 3
  slot=$GATE_SLOT
  run=$root/gate-runs/slot-$slot
  # Short, under /tmp, for the same reasons as CI's. The run directory notes
  # it, so the slot's next holder can delete it after a kill.
  tmp=/tmp/igr-${id##*-}
  scope=isomux-gate-slot-$slot.scope
  local sandbox=(env -i --default-signal=PIPE
    PATH="$tools/node-$NODE_VERSION-linux-x64/bin:$tools/bun-$BUN_VERSION:/usr/local/bin:/usr/bin:/bin"
    HOME="$run/home" TMPDIR="$tmp" BUN_INSTALL_CACHE_DIR="$root/cache/bun"
    NEXT_TELEMETRY_DISABLED=1 LANG=C.UTF-8 USER="$USER" LOGNAME="$USER" SHELL=/bin/bash)

  # What an earlier holder of this slot left when it was killed.
  stale_tmp=$(cat "$run/tmpdir" 2>/dev/null)
  [[ $stale_tmp =~ ^/tmp/igr-[0-9a-f]+$ ]] || stale_tmp=""
  clear_dir "$scope" "$run" $stale_tmp || setup_failed "gate slot $slot still has processes"
  # The run directory comes first: it names its temp directory.
  mkdir -p "$run/home" && echo "$tmp" >"$run/tmpdir" || setup_failed "cannot create $run"
  trap 'clear_dir "$scope" "$tmp" "$run"; git -C "$root/repo.git" update-ref -d "refs/gate/$id" 2>/dev/null' EXIT
  trap 'exit 3' HUP INT TERM
  mkdir "$tmp" || setup_failed "cannot create $tmp"

  install_toolchain "$root" "$tmp" no-pg
  "${sandbox[@]}" jq --version >/dev/null 2>&1 || setup_failed "jq is missing"
  check_out "$root" "$sha" "$run" ""
  git -C "$root/repo.git" update-ref refs/gate-base "$sha"
  git -C "$root/repo.git" update-ref -d "refs/gate/$id"
  install_deps "$run"

  # tsc always; build:ui and bun test only for paths. A red build:ui is red:
  # it is the commit's. The started file marks that the scope ran.
  (cd "$run/src" && exec systemd-run --user --scope --collect --quiet --unit="${scope%.scope}" -- \
    "${sandbox[@]}" nice -n 19 timeout -k 30s "$GATE_RUN_LIMIT" bash -c '
      : >"$1/started"
      shift
      status=0
      echo "→ tsc"
      NODE_OPTIONS=--max-old-space-size=2048 bun x tsc --noEmit || status=1
      if (($# > 0)); then
        echo "→ build:ui"
        if bun run build:ui >"$TMPDIR/build-ui.log" 2>&1; then
          echo "→ bun test $*"
          bun test "$@" || status=1
        else
          cat "$TMPDIR/build-ui.log"
          echo "✗ build:ui failed"
          status=1
        fi
      fi
      exit $status
    ' _ "$run" "${paths[@]}" 8>&-)
  local status=$?
  [[ -e $run/started ]] || setup_failed "the gate scope did not start"
  [[ $status -eq 124 ]] && say "✗ the gates passed the $GATE_RUN_LIMIT limit"
  [[ $status -eq 0 ]] && exit 0
  exit 1
}

# Deletes what a crash can leave in the bare repo that makes every push fail:
# empty loose objects and refs whose history is not all there. Only a file at a
# final object name counts: git renames a whole object into place, so an empty
# one there is never valid. Temp files (tmp_obj_*, packs in progress, a push's
# incoming-* quarantine) can be empty while another push writes them.
repair_main() {
  # Relative, as the push's own `git init`: ssh starts in the remote's home.
  local repo=$REMOTE_ROOT/repo.git ref file
  [[ -d $repo ]] || exit 0
  while IFS= read -r file; do
    rm -f -- "$file" && say "  deleted empty object file ${file#"$repo"/}"
  done < <(find "$repo/objects" -mindepth 2 -maxdepth 2 -type f -empty \
    -regextype posix-extended -regex '.*/objects/[0-9a-f]{2}/[0-9a-f]{38}')
  while IFS= read -r ref; do
    git -C "$repo" rev-list --quiet --objects "$ref" >/dev/null 2>&1 && continue
    git -C "$repo" update-ref --no-deref -d "$ref" 2>/dev/null ||
      rm -f -- "$repo/$ref"
    say "  deleted ref $ref"
  done < <(git -C "$repo" for-each-ref --format='%(refname)' 2>/dev/null)
  exit 0
}

case ${1:-} in
  --remote)
    shift
    remote_main "$@" </dev/null
    ;;
  --remote-gate)
    shift
    remote_gate_main "$@" </dev/null
    ;;
  --repair) repair_main </dev/null ;;
  *) local_main "$@" ;;
esac
