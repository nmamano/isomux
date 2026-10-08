#!/usr/bin/env bash
# Runs the CI gate (`bun run ci`) for one commit on a remote Linux machine, so
# a busy dev box does not run it. Exit 0 is green; any other code is red.
#
#   bun run ci:remote [<rev>]       one commit (default HEAD)
#   scripts/ci-remote.sh --pre-push  what .githooks/pre-push runs
#
# The target is the clone's git config key isomux.ciRemote (user@host), set
# with `git config isomux.ciRemote user@host`: never committed, and shared by
# every worktree of the clone. Unset, both entry points run `bun run ci` here,
# in place, as the hook always did.
#
# Set, the commit goes to the remote by `git push` over ssh, and this file is
# piped to the remote shell to run it there (--remote below). The remote half
# exits 0 for a green run and 1 for a red one. Any other code, ssh's own 255
# included, means the remote could not run the suite, and the run happens here
# instead. A red from the remote never falls back.
#
# The remote needs git, curl, unzip, flock, jq, a working `docker compose`
# and a user systemd manager; it needs no sudo. It keeps
# ~/.cache/isomux-ci-remote: a bare repo, the pinned node, bun and Postgres,
# and the bun package cache. A run's checkout, HOME, TMPDIR and database live
# in runs/<id> there and are deleted when the run ends. The container stage
# removes its image but leaves Docker build cache in the daemon, which
# BuildKit's garbage collection bounds.
set -uo pipefail

NODE_VERSION=v24.19.0
NODE_SHA256=f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4
BUN_VERSION=1.3.14
BUN_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
PG_VERSION=18.4.0-beta.17
# The control-plane suite's Postgres port, a constant in control-plane/testing/pg.ts.
PG_PORT=5433
RUN_LIMIT=30m
REMOTE_ROOT=.cache/isomux-ci-remote
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

# --- local half ------------------------------------------------------------

run_here() {
  local log=$1 status
  echo "→ bun run ci (the exact GitHub gate)"
  echo "  full output: $log"
  bun run ci 2>&1 | tee -a "$log"
  status=${PIPESTATUS[0]}
  if [[ $status -ne 0 ]]; then
    echo "✗ bun run ci failed (exit $status). Full output: $log"
  fi
  return "$status"
}

# Returns the remote half's exit code: 0 green, 1 red, anything else no verdict.
run_remote() {
  local sha=$1 log=$2 id=$3 host=$TARGET status
  echo "→ bun run ci on $host at $sha"
  echo "  full output: $log"
  # --no-verify: this push is the transport, and the pre-push hook is what
  # called us.
  if ! ssh "${SSH_OPTS[@]}" "$host" "git init -q --bare $REMOTE_ROOT/repo.git" >>"$log" 2>&1 ||
    ! GIT_SSH_COMMAND="ssh ${SSH_OPTS[*]}" git push -q --no-verify \
      "$host:$REMOTE_ROOT/repo.git" "$sha:refs/ci/$id" >>"$log" 2>&1; then
    return 255
  fi
  ssh "${SSH_OPTS[@]}" "$host" bash -s -- --remote "$sha" "$id" <"${BASH_SOURCE[0]}" 2>&1 | tee -a "$log"
  status=${PIPESTATUS[0]}
  # The remote half deletes its ref; this covers a run that never started.
  ssh "${SSH_OPTS[@]}" "$host" "git -C $REMOTE_ROOT/repo.git update-ref -d refs/ci/$id" >/dev/null 2>&1
  return "$status"
}

one_commit() {
  local rev=$1 sha id log status
  sha=$(git rev-parse --verify --quiet "$rev^{commit}") || {
    echo "✗ not a commit: $rev" >&2
    return 2
  }
  id=$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')
  log="${TMPDIR:-/tmp}/isomux-ci-$id.log"
  run_remote "$sha" "$log" "$id"
  status=$?
  case $status in
    0) echo "✓ CI passed on $TARGET. Full output: $log" ;;
    1) echo "✗ CI failed on $TARGET. Full output: $log" ;;
    *)
      echo "→ $TARGET could not run CI (exit $status); running it here"
      run_here "$log"
      status=$?
      ;;
  esac
  return "$status"
}

local_main() {
  # git exports GIT_DIR to hooks; from a linked worktree it is an absolute path
  # into the shared repo. CI must not inherit it: a test that runs `git init` in
  # a temp dir would otherwise write into the shared repo config and refs.
  # shellcheck disable=SC2046
  unset $(git rev-parse --local-env-vars)

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
# Exit 0: `bun run ci` passed. Exit 1: it ran and failed. Exit 3: the suite
# could not run here. Nothing else, so ssh's 255 stays unambiguous.

say() { printf '%s\n' "$*"; }

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
  setup_failed() {
    say "✗ $(hostname) could not run CI: $1"
    exit 3
  }
  # Stops every process of a run and deletes its directory. Touches only the
  # directory and the scope this script named after the run id.
  clear_run() {
    local dir=$1 id=${1##*/} tries=0
    local scope=isomux-ci-$id.scope
    systemctl --user kill --signal=SIGKILL "$scope" >/dev/null 2>&1
    while systemctl --user is-active --quiet "$scope"; do
      ((tries++ < 50)) || {
        say "✗ run ${dir##*/} still has processes; left $dir in place" >&2
        return 1
      }
      sleep 0.2
    done
    rm -rf "$dir" "/tmp/icr-${id##*-}"
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

  # Toolchain, pinned and checksummed. The system node and ~/.bun are not used.
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
  if [[ ! -x $pg_bin/pg_ctl ]]; then
    say "  installing Postgres $PG_VERSION"
    { mkdir -p "$tools/pg-$PG_VERSION" &&
      printf '{"dependencies":{"@embedded-postgres/linux-x64":"%s"},"trustedDependencies":["@embedded-postgres/linux-x64"]}\n' \
        "$PG_VERSION" >"$tools/pg-$PG_VERSION/package.json" &&
      "${sandbox[@]}" bun install --cwd "$tools/pg-$PG_VERSION" >/dev/null; } || setup_failed "Postgres $PG_VERSION install"
  fi

  # The Docker test returns early when no docker is on PATH, so a missing or
  # stopped Docker would pass it without running it.
  "${sandbox[@]}" docker version >/dev/null 2>&1 || setup_failed "Docker is not running"
  "${sandbox[@]}" docker compose version >/dev/null 2>&1 || setup_failed "docker compose is missing"
  "${sandbox[@]}" jq --version >/dev/null 2>&1 || setup_failed "jq is missing"
  if (exec 3<>"/dev/tcp/127.0.0.1/$PG_PORT") 2>/dev/null; then
    setup_failed "port $PG_PORT is in use"
  fi

  say "  checking out $sha"
  { git clone -q --shared --no-checkout "$root/repo.git" "$run/src" &&
    git -C "$run/src" checkout -q --detach "$sha" &&
    [[ $(git -C "$run/src" rev-parse HEAD) == "$sha" ]]; } || setup_failed "checkout of $sha"
  # The run ref goes; one base ref stays so the next push sends only new objects.
  git -C "$root/repo.git" update-ref refs/ci-base "$sha"
  git -C "$root/repo.git" update-ref -d "refs/ci/$id"
  local pinned
  pinned=$(jq -r .packageManager "$run/src/package.json")
  [[ $pinned == "bun@$("${sandbox[@]}" bun --version)" ]] ||
    setup_failed "the commit pins $pinned and this script pins bun@$BUN_VERSION"

  say "  installing dependencies"
  (cd "$run/src" && "${sandbox[@]}" bun install --frozen-lockfile &&
    "${sandbox[@]}" bun install --cwd control-plane/web --frozen-lockfile) >"$run/install.log" 2>&1 || {
    cat "$run/install.log"
    setup_failed "bun install"
  }

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

if [[ ${1:-} == --remote ]]; then
  shift
  remote_main "$@" </dev/null
else
  local_main "$@"
fi
