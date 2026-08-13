#!/usr/bin/env bash
# Update an installed isomux to a pinned release tag, rolling back on failure.
# (Release-channel slice C1, internal-docs/release-design.md.)
#
# Usage:  isomux-update vYYYY.M.D[.N] [--allow-downgrade]
#
# CONTRACT
# - Run the INSTALLED copy (deploy/install.sh puts one at
#   /usr/local/sbin/isomux-update), not scripts/update.sh inside the repo:
#   the checkout step replaces the script under a running in-repo shell,
#   which reads it incrementally and can splice old and new updater logic.
#   Defense-in-depth: an in-repo invocation re-execs a temp copy of itself.
#   On success the installed copy is refreshed from the new checkout, so
#   each release ships updater fixes that take effect on the NEXT update.
# - Configuration comes only from the root-of-trust config file the
#   installer wrote (default /etc/isomux/update.conf; ISOMUX_UPDATE_CONF
#   overrides it for sandbox testing) - never from the caller beyond the
#   target tag and flags. The file is parsed as literal key=value lines,
#   never sourced: a hostile value is data, not code.
# - TRUST BOUNDARY (system deployments): the service checkout ($REPO_DIR)
#   and everything in it are writable by the unprivileged service user, and
#   isomux agents intentionally run shell as that user. Nothing root
#   executes or installs may come from there. Tag resolution and the
#   installed-updater refresh therefore go through $STATUS_DIR/trust.git, a
#   root-owned bare repo that fetches refs/tags/<target> straight from the
#   configured REPO_URL: the remote is the only tag authority (a local tag
#   in the service checkout is never consulted), the non-forced tag fetch
#   refuses a moved tag (release tags are immutable), and the service
#   checkout is then pinned to the trust-resolved commit hash.
# - The target must be an exact CalVer tag. A downgrade (target is an
#   ancestor of the current checkout) needs --allow-downgrade.
# - A flock on $STATUS_DIR/lock makes concurrent invocations fail fast.
#
# SEQUENCE and per-phase recovery (the design doc has the rationale):
#   fetch/validate     -> nothing to undo
#   deps               -> nothing of isomux's to undo; installed system
#                         packages stay (see sync_system_deps)
#   checkout+install+build     [fail: check out the old commit, reinstall its
#                               deps, rebuild its UI - node_modules and the
#                               live-served ui/dist are already dirty]
#   stop service, wait inactive
#   snapshot state root, verify tarball
#                              [fail: old code (reinstall+rebuild) + start]
#   start, poll /readyz        [fail: stop; move the broken state root
#                               aside; restore the snapshot; old code
#                               (reinstall+rebuild); start]
#
# Progress and the final result are written to $STATUS_DIR/status.json,
# which lives OUTSIDE the state root because rollback replaces the state
# root wholesale.
#
# update.conf keys (all required unless noted):
#   REPO_DIR       the isomux git checkout the service runs from
#   REPO_URL       upstream repo the trust fetches pull from (the tag
#                  authority; never the service checkout's own remote config)
#   SERVICE_NAME   systemd unit name (isomux)
#   SERVICE_KIND   system | user - which systemctl manages the unit
#   SERVICE_USER   system kind only: run git/bun as this user
#   STATE_ROOT     the office state dir the service reads (~/.isomux shape)
#   SNAPSHOT_DIR   where pre-update state tarballs go (outside STATE_ROOT)
#   STATUS_DIR     lock + status.json (outside STATE_ROOT)
#   BUN            bun binary the service uses
#   BASE_URL       loopback base for the readiness poll
#   UPDATER_PATH   (optional) installed copy to refresh on success
#   READY_TIMEOUT_S (optional, default 90)

set -Eeuo pipefail

log() { printf '[isomux-update] %s\n' "$*"; }

CONF="${ISOMUX_UPDATE_CONF:-/etc/isomux/update.conf}"
PHASE=init
TARGET_TAG=""
ALLOW_DOWNGRADE=""
OLD_COMMIT=""
OLD_DESC=""
SNAPSHOT=""
CALVER_RE='^v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?$'
SNAPSHOT_KEEP=3
BROKEN_KEEP=1
DEPS_WARNING=""

# --- Status file ------------------------------------------------------------

# JSON without jq: every value is either a fixed identifier or sanitized to a
# quote/backslash/control-free string, so plain printf cannot produce broken
# JSON.
json_sanitize() { printf '%s' "$1" | tr -d '"\\' | tr '\n\t' '  '; }

write_status() {
  local result=$1 message=$2
  [[ -d ${STATUS_DIR:-} ]] || return 0
  printf '{"phase":"%s","result":"%s","target":"%s","from":"%s","message":"%s","at":"%s"}\n' \
    "$PHASE" "$result" "$(json_sanitize "$TARGET_TAG")" \
    "$(json_sanitize "$OLD_DESC")" "$(json_sanitize "$message")" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STATUS_DIR/status.json.tmp" &&
    mv -f "$STATUS_DIR/status.json.tmp" "$STATUS_DIR/status.json"
}

phase() {
  PHASE=$1
  log "--- $1"
  write_status running ""
}

die() {
  trap - ERR
  log "ERROR: $*"
  write_status failed "$*"
  exit 1
}

# --- Config -----------------------------------------------------------------

load_config() {
  [[ -r $CONF ]] || die "config not readable: $CONF (is isomux installed with the updater?)"
  # Literal key=value parser - the file is NEVER sourced. In system mode this
  # runs as root and the config carries installer-parameter-derived values
  # (REPO_URL), so a value must stay data under all circumstances: shell
  # metacharacters are inert here, an embedded newline turns into an
  # unknown-key refusal, and unknown keys fail closed.
  local line key value
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line == *=* ]] || die "malformed line in $CONF: $line"
    key=${line%%=*}
    value=${line#*=}
    case $key in
      REPO_DIR | REPO_URL | SERVICE_NAME | SERVICE_KIND | SERVICE_USER | STATE_ROOT | SNAPSHOT_DIR | STATUS_DIR | BUN | BASE_URL | UPDATER_PATH | READY_TIMEOUT_S)
        printf -v "$key" '%s' "$value"
        ;;
      *) die "unknown key in $CONF: $key" ;;
    esac
  done <"$CONF"
  local k
  for k in REPO_DIR REPO_URL SERVICE_NAME SERVICE_KIND STATE_ROOT SNAPSHOT_DIR STATUS_DIR BUN BASE_URL; do
    [[ -n ${!k:-} ]] || die "config is missing $k: $CONF"
  done
  # Defense in depth on the one externally-influenced value: a git URL or
  # path from this conservative charset can be passed to git safely and
  # cannot smuggle options (no leading dash) or shell syntax.
  [[ $REPO_URL =~ ^[A-Za-z0-9@:/._+~][A-Za-z0-9@:/._+~-]*$ ]] ||
    die "REPO_URL is not a plain git URL/path: $REPO_URL"
  case $SERVICE_KIND in
    system)
      [[ $EUID -eq 0 ]] || die "SERVICE_KIND=system needs root (systemctl + runuser)"
      [[ -n ${SERVICE_USER:-} ]] || die "config is missing SERVICE_USER"
      SERVICE_USER_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
      [[ -n $SERVICE_USER_HOME ]] || die "no such user: $SERVICE_USER"
      ;;
    user) ;;
    *) die "SERVICE_KIND must be system or user: $SERVICE_KIND" ;;
  esac
  READY_TIMEOUT_S=${READY_TIMEOUT_S:-90}
  UPDATER_PATH=${UPDATER_PATH:-}
  TRUST_REPO=$STATUS_DIR/trust.git
}

# git/bun act on the checkout as the service user in system mode (the repo is
# owned by it), directly otherwise. Same HOME pinning as the installer.
as_repo_user() {
  if [[ $SERVICE_KIND == system ]]; then
    runuser -u "$SERVICE_USER" -- env "HOME=$SERVICE_USER_HOME" "$@"
  else
    "$@"
  fi
}

svc() {
  if [[ $SERVICE_KIND == system ]]; then
    systemctl "$@"
  else
    systemctl --user "$@"
  fi
}

# systemctl stop already blocks, but "inactive before touching state" is the
# safety property rollback rests on, so verify it rather than trust it.
wait_inactive() {
  local deadline=$((SECONDS + 60)) state
  while :; do
    state=$(svc is-active "$SERVICE_NAME" 2>/dev/null) || true
    [[ $state != active && $state != deactivating ]] && return 0
    ((SECONDS < deadline)) || die "service did not stop within 60s (state: $state)"
    sleep 1
  done
}

# Install the system dependencies the TARGET release needs (apt packages,
# Node.js, the headless browser) by running THAT release's own installer in its
# deps-only mode. The release's installer is the single declaration of what the
# release requires, so nothing here keeps a second copy of the list. Without
# this the updater only ever moves the checkout, and a box installed before a
# new dependency landed stays broken through every update.
#
# Trust: the bytes come from the ROOT-OWNED trust repo at the resolved commit,
# exactly like the installed-updater refresh - never from $REPO_DIR, which the
# service user (the one agents run shell as) can write.
#
# Runs BEFORE the checkout, so a failure leaves nothing of isomux's to undo:
# the service is still up on the old code, and node_modules and ui/dist are
# untouched. (Host packages are a different matter - a failed apt run can leave
# them partly changed, and that is not rolled back.) It also means the
# dependencies node-gyp needs are in place before `bun install`.
#
# Skipped with a note where the box cannot or should not do this: a user-kind
# (dev) box has no root, a box without apt manages its own packages, and a
# target release from before this mode existed has no deps-only entry point.
#
# Dependencies are NOT undone by a later rollback. They are additive, and the
# old version runs fine with newer packages installed.
sync_system_deps() {
  local target=$1
  if [[ $SERVICE_KIND != system ]]; then
    log "SERVICE_KIND=$SERVICE_KIND: skipping the system-dependency sync (it needs root)"
    return 0
  fi
  if ! command -v apt-get >/dev/null; then
    # A system-kind box is expected to have apt (the installer requires it), so
    # this skip can leave the office degraded in ways /readyz cannot see. The
    # update still succeeds, but the success is qualified: the warning is
    # carried into the final status.json so it stays visible, not a log line
    # that scrolls away.
    DEPS_WARNING="system dependencies were not synced (no apt-get on this box); if $TARGET_TAG needs new system packages, install them yourself"
    log "warning: $DEPS_WARNING"
    return 0
  fi
  local installer rc=0
  installer=$(mktemp /tmp/isomux-deps.XXXXXXXXXX)
  chmod 700 "$installer"
  if ! git -C "$TRUST_REPO" cat-file -p "$target:deploy/install.sh" >"$installer" 2>/dev/null; then
    rm -f "$installer"
    log "note: $TARGET_TAG carries no deploy/install.sh; skipping the system-dependency sync"
    return 0
  fi
  # Capability probe. The exact protocol assignment, anchored - not a mention
  # of the flag: header docs mention it, and running an installer that only
  # TALKS about the mode would run a FULL install, as root, on a live box.
  if ! grep -qx 'ISOMUX_INSTALL_DEPS_MODE_VERSION=1' "$installer"; then
    rm -f "$installer"
    log "note: $TARGET_TAG's installer has no deps-only mode; skipping the system-dependency sync"
    return 0
  fi
  log "installing $TARGET_TAG's system dependencies"
  # Fixed environment, deliberately: this script's contract is that
  # configuration comes from the root-of-trust conf and nothing else, and the
  # installer reads env vars that would quietly change what it does - an
  # inherited DRY_RUN would turn the sync into a no-op that reports success,
  # and an inherited INSTALL_CALLBACK_URL would post about an install nobody
  # ran. Constants rather than "$PATH"/"$HOME": this runs as root, so nothing
  # caller-controlled should reach it at all.
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/root ISOMUX_DEPS_ONLY=1 /bin/bash "$installer" || rc=$?
  rm -f "$installer"
  return "$rc"
}

ready_poll() {
  local timeout=$1 deadline=$((SECONDS + $1))
  until curl -fsS -o /dev/null --max-time 5 "$BASE_URL/readyz" 2>/dev/null; do
    ((SECONDS < deadline)) || return 1
    sleep 2
  done
}

# --- Recovery ladders -------------------------------------------------------

# Re-point the checkout at the old commit and rebuild its world. Used by every
# recovery path; node_modules and ui/dist are dirty from the moment the target
# install/build started, so recovery must redo both for the OLD commit.
restore_old_code() {
  as_repo_user git -C "$REPO_DIR" checkout --detach "$OLD_COMMIT" &&
    as_repo_user bash -c "cd '$REPO_DIR' && '$BUN' install --frozen-lockfile" &&
    as_repo_user bash -c "cd '$REPO_DIR' && '$BUN' run build:ui"
}

fail_build() {
  trap - ERR
  log "install/build of $TARGET_TAG failed; restoring $OLD_DESC (service was never touched)"
  if restore_old_code; then
    die "update to $TARGET_TAG failed during install/build; old version restored, service untouched"
  else
    PHASE=recovery-failed
    die "update to $TARGET_TAG failed during install/build AND restoring $OLD_DESC failed; the checkout at $REPO_DIR needs manual attention"
  fi
}

fail_snapshot() {
  trap - ERR
  log "state snapshot failed; restoring $OLD_DESC and starting it (state untouched)"
  if restore_old_code && svc start "$SERVICE_NAME" && ready_poll "$READY_TIMEOUT_S"; then
    die "update to $TARGET_TAG failed at the state snapshot; old version restored and running"
  else
    PHASE=recovery-failed
    die "update to $TARGET_TAG failed at the state snapshot AND restoring the old version failed; the service needs manual attention"
  fi
}

fail_ready() {
  trap - ERR
  log "$TARGET_TAG did not become ready; rolling back code AND state"
  svc stop "$SERVICE_NAME" || true
  local state deadline=$((SECONDS + 60))
  while :; do
    state=$(svc is-active "$SERVICE_NAME" 2>/dev/null) || true
    [[ $state != active && $state != deactivating ]] && break
    if ((SECONDS >= deadline)); then
      PHASE=recovery-failed
      die "rollback: service would not stop; NOT touching the state root under a live process. Manual attention required."
    fi
    sleep 1
  done
  local parent broken
  parent=$(dirname "$STATE_ROOT")
  if [[ -d $STATE_ROOT ]]; then
    broken="$SNAPSHOT_DIR/broken-$(date +%Y%m%d-%H%M%S)"
    mv "$STATE_ROOT" "$broken" || {
      PHASE=recovery-failed
      die "rollback: could not move the broken state root aside; manual attention required"
    }
    prune_glob "$SNAPSHOT_DIR" 'broken-*' "$BROKEN_KEEP"
  fi
  if [[ -n $SNAPSHOT ]]; then
    tar -xzf "$SNAPSHOT" -C "$parent" || {
      PHASE=recovery-failed
      die "rollback: restoring the state snapshot failed: $SNAPSHOT; manual attention required"
    }
  fi
  if restore_old_code && svc start "$SERVICE_NAME" && ready_poll "$READY_TIMEOUT_S"; then
    die "update to $TARGET_TAG failed readiness; rolled back to $OLD_DESC (code and state) and it is running"
  else
    PHASE=recovery-failed
    die "update to $TARGET_TAG failed readiness AND the rollback did not come up; manual attention required"
  fi
}

# Keep the newest $3 entries matching $2 (a glob) in dir $1, delete the rest.
prune_glob() {
  local dir=$1 pattern=$2 keep=$3
  (
    cd "$dir" 2>/dev/null || exit 0
    # shellcheck disable=SC2012
    ls -1dt -- $pattern 2>/dev/null | tail -n +$((keep + 1)) | while IFS= read -r f; do
      rm -rf -- "$f"
    done
  )
}

on_error() {
  local failed_phase=$PHASE
  trap - ERR
  case $failed_phase in
    deps) die "could not install $TARGET_TAG's system dependencies; the checkout, its dependencies, the built UI and the office state are unchanged and the service is still running $OLD_DESC, but system package changes may be partial" ;;
    checkout | install | build) fail_build ;;
    snapshot) fail_snapshot ;;
    start | readiness) fail_ready ;;
    *) die "unexpected failure during $failed_phase" ;;
  esac
}

# --- Main -------------------------------------------------------------------

main() {
  local arg
  for arg in "$@"; do
    case $arg in
      --allow-downgrade) ALLOW_DOWNGRADE=1 ;;
      -*) die "unknown flag: $arg" ;;
      *)
        [[ -z $TARGET_TAG ]] || die "exactly one target tag expected"
        TARGET_TAG=$arg
        ;;
    esac
  done
  [[ -n $TARGET_TAG ]] || die "usage: isomux-update vYYYY.M.D[.N] [--allow-downgrade]"
  [[ $TARGET_TAG =~ $CALVER_RE ]] || die "not a CalVer release tag (vYYYY.M.D[.N]): $TARGET_TAG"

  load_config

  # Never run the copy inside the repo the update is about to rewrite.
  local self
  self=$(readlink -f "$0")
  if [[ $self == "$REPO_DIR"/* && -z ${ISOMUX_UPDATE_REEXEC:-} ]]; then
    local tmp
    tmp=$(mktemp /tmp/isomux-update.XXXXXXXXXX)
    cat "$self" >"$tmp"
    chmod 700 "$tmp"
    log "running from inside $REPO_DIR; re-executing a temp copy"
    ISOMUX_UPDATE_REEXEC=1 exec bash "$tmp" "$@"
  fi
  # The re-exec temp copy deletes itself when done (bash holds it open).
  [[ -n ${ISOMUX_UPDATE_REEXEC:-} && $self == /tmp/* ]] && trap 'rm -f "$self"' EXIT

  install -d -m 700 "$STATUS_DIR" "$SNAPSHOT_DIR"
  exec 9>"$STATUS_DIR/lock"
  flock -n 9 || die "another update is already running (lock: $STATUS_DIR/lock)"

  trap on_error ERR

  phase validate
  [[ -d $REPO_DIR/.git ]] || die "not a git checkout: $REPO_DIR"
  [[ -z $(as_repo_user git -C "$REPO_DIR" status --porcelain) ]] ||
    die "checkout is dirty: $REPO_DIR - refusing to update over local changes"
  OLD_COMMIT=$(as_repo_user git -C "$REPO_DIR" rev-parse HEAD)
  OLD_DESC=$(as_repo_user git -C "$REPO_DIR" describe --tags --always --match 'v*')

  phase fetch
  # Resolve the tag in root-owned space, against the configured upstream
  # only. The non-forced refspec makes a moved tag an error, not an update.
  [[ -d $TRUST_REPO ]] || git init -q --bare "$TRUST_REPO"
  git -C "$TRUST_REPO" fetch -q --depth 1 "$REPO_URL" "refs/tags/$TARGET_TAG:refs/tags/$TARGET_TAG" ||
    die "release tag $TARGET_TAG not found at $REPO_URL (or the tag moved upstream - release tags are immutable)"
  local target_commit
  target_commit=$(git -C "$TRUST_REPO" rev-parse -q --verify "refs/tags/$TARGET_TAG^{commit}") ||
    die "could not resolve $TARGET_TAG to a commit in the trust repo"
  # Bun-pin heads-up BEFORE any mutation, read from the trusted objects.
  local pinned have
  pinned=$(git -C "$TRUST_REPO" cat-file -p "$target_commit:package.json" 2>/dev/null |
    sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' | head -1)
  have=$("$BUN" --version 2>/dev/null || true)
  if [[ -n $pinned && $pinned != "$have" ]]; then
    log "warning: $TARGET_TAG pins bun@$pinned but $BUN is $have; if the new version fails to start, that mismatch is the first suspect (rollback will still work)"
  fi
  # Bring the objects into the service checkout from the same upstream
  # (bypassing its tamperable remote config) and hold it to the
  # trust-resolved commit.
  as_repo_user git -C "$REPO_DIR" fetch -q "$REPO_URL" "refs/tags/$TARGET_TAG"
  local fetched
  fetched=$(as_repo_user git -C "$REPO_DIR" rev-parse -q --verify 'FETCH_HEAD^{commit}') || fetched=""
  [[ $fetched == "$target_commit" ]] ||
    die "the service checkout fetched a different commit for $TARGET_TAG ($fetched) than the trusted upstream resolution ($target_commit)"
  # Record the tag in the checkout too. A bare `git fetch <url> refs/tags/<tag>`
  # only moves FETCH_HEAD, and server/version.ts identifies the running release
  # with `git tag --points-at HEAD` - so without this the box reports a bare
  # sha with release: null after every update, and the release banner keeps
  # offering the release it is already running. Written from the TRUST-resolved
  # commit verified just above, never from whatever the fetch left behind. Ahead
  # of the already-on-target exit on purpose: re-running the updater with the
  # tag a box is already on then repairs a checkout updated before this fix.
  local had_tag
  had_tag=$(as_repo_user git -C "$REPO_DIR" rev-parse -q --verify "refs/tags/$TARGET_TAG^{commit}") || had_tag=""
  as_repo_user git -C "$REPO_DIR" update-ref "refs/tags/$TARGET_TAG" "$target_commit"

  if [[ $target_commit == "$OLD_COMMIT" ]]; then
    if [[ $had_tag == "$target_commit" ]]; then
      log "already on $TARGET_TAG; nothing to do"
      write_status ok "already on $TARGET_TAG"
      exit 0
    fi
    # The line above just repaired a checkout that was running this release
    # without recording it. This is also the upgrade shape left by updaters
    # from before target dependency sync existed: their first update refreshes
    # the installed updater, but cannot deliver this release's system
    # dependencies. Run the target's narrow deps-only installer now so the
    # second invocation converges that box. A tagged no-op stays a true no-op.
    # update-ref ran before this branch so the running server can identify the
    # release after its restart. Until every repair step succeeds, however,
    # that ref is provisional: leaving it behind on one transient failure
    # would make the retry take the tagged no-op arm and skip the repair
    # forever.
    restore_repair_tag() {
      if [[ -n $had_tag ]]; then
        as_repo_user git -C "$REPO_DIR" update-ref \
          "refs/tags/$TARGET_TAG" "$had_tag" "$target_commit"
      else
        as_repo_user git -C "$REPO_DIR" update-ref -d \
          "refs/tags/$TARGET_TAG" "$target_commit"
      fi
    }
    repair_error() {
      local failed_phase=$PHASE
      trap - ERR
      if ! restore_repair_tag; then
        PHASE=recovery-failed
        die "the $TARGET_TAG repair failed during $failed_phase AND its provisional tag could not be restored; the checkout at $REPO_DIR needs manual attention"
      fi
      PHASE=$failed_phase
      case $failed_phase in
        deps) on_error ;;
        restart) die "recorded the release tag for $TARGET_TAG, but $SERVICE_NAME could not be restarted; the tag repair was rolled back and the code is unchanged from before this run" ;;
        readiness) die "recorded the release tag for $TARGET_TAG and restarted $SERVICE_NAME, but it did not answer within ${READY_TIMEOUT_S}s; the tag repair was rolled back and the code is unchanged from before this run, so look at the service log" ;;
        finalize) die "repaired $TARGET_TAG, but could not record the successful result; the tag repair was rolled back so a retry can finish it" ;;
        *) die "the $TARGET_TAG repair failed during $failed_phase; the tag repair was rolled back so a retry can finish it" ;;
      esac
    }
    trap repair_error ERR
    phase deps
    sync_system_deps "$target_commit"
    # Nothing was built and nothing can be rolled back, so the ordinary code
    # recovery ladder does not apply. server/version.ts reads the tag once per
    # process, and configure_user_manager's drop-in also takes effect on the
    # restart below.
    log "already on $TARGET_TAG, which the checkout was not recording; restarting so the office reports it"
    phase restart
    svc stop "$SERVICE_NAME"
    wait_inactive
    svc start "$SERVICE_NAME"
    phase readiness
    ready_poll "$READY_TIMEOUT_S"
    phase finalize
    write_status ok "recorded the release tag for $TARGET_TAG"
    trap - ERR
    log "recorded the release tag for $TARGET_TAG"
    exit 0
  fi
  if as_repo_user git -C "$REPO_DIR" merge-base --is-ancestor "$target_commit" "$OLD_COMMIT"; then
    [[ -n $ALLOW_DOWNGRADE ]] ||
      die "$TARGET_TAG is older than the current $OLD_DESC; pass --allow-downgrade to do this anyway"
    log "downgrading $OLD_DESC -> $TARGET_TAG (--allow-downgrade)"
  fi

  phase deps
  sync_system_deps "$target_commit"

  phase checkout
  as_repo_user git -C "$REPO_DIR" checkout --detach "$target_commit"

  phase install
  as_repo_user bash -c "cd '$REPO_DIR' && '$BUN' install --frozen-lockfile"

  phase build
  as_repo_user bash -c "cd '$REPO_DIR' && '$BUN' run build:ui"

  phase stop
  svc stop "$SERVICE_NAME"
  wait_inactive

  phase snapshot
  if [[ -d $STATE_ROOT ]]; then
    SNAPSHOT="$SNAPSHOT_DIR/pre-update-$(json_sanitize "$OLD_DESC")-to-$TARGET_TAG-$(date +%Y%m%d-%H%M%S).tar.gz"
    tar -C "$(dirname "$STATE_ROOT")" -czf "$SNAPSHOT" "$(basename "$STATE_ROOT")"
    tar -tzf "$SNAPSHOT" >/dev/null
    prune_glob "$SNAPSHOT_DIR" 'pre-update-*.tar.gz' "$SNAPSHOT_KEEP"
    log "state snapshot: $SNAPSHOT"
  else
    log "no state root at $STATE_ROOT yet; skipping the snapshot (a rollback removes whatever the new version creates)"
  fi

  phase start
  svc start "$SERVICE_NAME"

  phase readiness
  ready_poll "$READY_TIMEOUT_S" || fail_ready

  phase finalize
  trap - ERR
  # Refresh the installed updater from the ROOT-OWNED trust objects. The
  # service checkout must never be the source: the service user (which
  # agents run as) could have replaced scripts/update.sh there while the
  # new server was already running.
  if [[ -n $UPDATER_PATH ]]; then
    local newupd
    newupd=$(mktemp /tmp/isomux-update-new.XXXXXXXXXX)
    if git -C "$TRUST_REPO" cat-file -p "$target_commit:scripts/update.sh" >"$newupd" 2>/dev/null; then
      install -m 755 "$newupd" "$UPDATER_PATH" 2>/dev/null ||
        log "warning: could not refresh the installed updater at $UPDATER_PATH"
    else
      log "note: $TARGET_TAG carries no scripts/update.sh; leaving the installed updater as is"
    fi
    rm -f "$newupd"
  fi
  if [[ -n $DEPS_WARNING ]]; then
    write_status ok "updated $OLD_DESC -> $TARGET_TAG; warning: $DEPS_WARNING"
  else
    write_status ok "updated $OLD_DESC -> $TARGET_TAG"
  fi
  log "updated $OLD_DESC -> $TARGET_TAG"
}

main "$@"
