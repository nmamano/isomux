#!/usr/bin/env bash
# Update an installed isomux to a pinned release tag.
# Git installs roll the code back on failure; containers replace the image on
# the existing mount.
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
#                         packages stay (see sync_system_deps). Finalize
#                         records the synced commit in $STATUS_DIR/deps-synced;
#                         an already-on-target run without that record syncs
#                         and restarts instead of exiting as a no-op.
#   checkout+install+build     [fail: check out the old commit, reinstall its
#                               deps, rebuild its UI - node_modules and the
#                               live-served ui/dist are already dirty]
#   stop service, wait inactive
#   start, poll /readyz        [fail: stop; old code (reinstall+rebuild);
#                               start]
#
# The office is down only between the stop and the readiness poll. There is
# no state snapshot: a rollback restores the code and leaves the state root
# as the new version left it. Releases keep state readable by older versions,
# migrations copy the files they touch, and the daily backup covers the rest.
#
# Progress and the final result are written to $STATUS_DIR/status.json. The
# lock holder also publishes a safe-fields-only copy (attempt, phase, result,
# and the updater's process identity) for the office server to read: see
# publish_progress.
#
# update.conf keys (Git deployment keys below; container keys follow):
#   DEPLOYMENT_KIND (optional, default git): git | container
#   REPO_DIR       the isomux git checkout the service runs from
#   REPO_URL       upstream repo the trust fetches pull from (the tag
#                  authority; never the service checkout's own remote config)
#   SERVICE_NAME   systemd unit name (isomux)
#   SERVICE_KIND   system | user - which systemctl manages the unit
#   SERVICE_USER   system kind only: run git/bun as this user
#   STATE_ROOT     (accepted, unused) the office state dir; older updaters
#                  snapshot it and require it
#   SNAPSHOT_DIR   (accepted, unused) where older updaters put pre-update
#                  state tarballs; they require it
#   STATUS_DIR     lock, status.json, deps-synced (outside STATE_ROOT)
#   BUN            bun binary the service uses
#   BASE_URL       loopback base for the readiness poll
#   UPDATER_PATH   (optional) installed copy to refresh on success
#   READY_TIMEOUT_S (optional, default 90)
# Container mode requires REPO_URL, SERVICE_KIND=system,
# SERVICE_NAME=isomux-container, STATUS_DIR and BASE_URL. It uses the fixed
# /opt/isomux-container installation and official image repository.

set -Eeuo pipefail

log() { printf '[isomux-update] %s\n' "$*"; }

CONF="${ISOMUX_UPDATE_CONF:-/etc/isomux/update.conf}"
PHASE=init
TARGET_TAG=""
ALLOW_DOWNGRADE=""
OLD_COMMIT=""
OLD_DESC=""
CALVER_RE='^v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?$'
DEPS_WARNING=""
# System kind: the office service user can read this directory but not write
# it. install.sh publishes outcome.json in the same directory.
PROGRESS_PUBLIC_DIR=/var/lib/isomux-update-public
PROGRESS_FILE=""
ATTEMPT=""
PROC_START=""
BOOT_ID=""

add_deps_warning() {
  local warning=$1
  if [[ -n $DEPS_WARNING ]]; then
    DEPS_WARNING+="; $warning"
  else
    DEPS_WARNING=$warning
  fi
}

# --- Status file ------------------------------------------------------------

# JSON without jq: every value is either a fixed identifier or sanitized to a
# quote/backslash/control-free string, so plain printf cannot produce broken
# JSON.
json_sanitize() { printf '%s' "$1" | tr -d '"\\' | tr '\n\t' '  '; }

write_status() {
  local result=$1 message=$2
  publish_progress "$result"
  [[ -d ${STATUS_DIR:-} ]] || return 0
  printf '{"phase":"%s","result":"%s","target":"%s","from":"%s","message":"%s","at":"%s"}\n' \
    "$PHASE" "$result" "$(json_sanitize "$TARGET_TAG")" \
    "$(json_sanitize "$OLD_DESC")" "$(json_sanitize "$message")" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STATUS_DIR/status.json.tmp" &&
    mv -f "$STATUS_DIR/status.json.tmp" "$STATUS_DIR/status.json"
}

# The progress file the office server reads (server/update-progress.ts) to
# show every open tab what the update is doing. Only the lock holder writes
# it, so a second invocation that loses the flock cannot overwrite the live
# attempt. Every field is generated here: the attempt id, a phase name from
# this script, the result, and pid + start ticks + boot id so the server can
# tell a dead updater from a running one. Publication is best effort: it runs
# in a subshell with no ERR trap, so no failure in it changes the update.
progress_path() {
  if [[ $SERVICE_KIND == system ]]; then
    printf '%s/progress.json' "$PROGRESS_PUBLIC_DIR"
  else
    printf '%s/progress.json' "$STATUS_DIR"
  fi
}

init_progress() {
  local line uuid
  read -r uuid </proc/sys/kernel/random/uuid || return 0
  read -r BOOT_ID </proc/sys/kernel/random/boot_id || return 0
  # Field 22 (start time in clock ticks). The command name in field 2 can
  # hold spaces, so split after its closing parenthesis.
  read -r line </proc/$$/stat || return 0
  line=${line##*) }
  local -a fields
  read -r -a fields <<<"$line"
  PROC_START=${fields[19]:-}
  ATTEMPT=${uuid//-/}
  [[ $ATTEMPT =~ ^[a-f0-9]{32}$ && $PROC_START =~ ^[0-9]+$ && $BOOT_ID =~ ^[a-f0-9-]{36}$ ]] || return 0
  PROGRESS_FILE=$(progress_path)
}

publish_progress() {
  local result=$1
  [[ -n $PROGRESS_FILE ]] || return 0
  (
    trap - ERR
    set +e
    dir=${PROGRESS_FILE%/*}
    if [[ $SERVICE_KIND == system ]]; then
      install -d -m 755 "$dir" || exit 0
      # Publish only into a root-owned directory nobody else can write.
      [[ -d $dir && ! -L $dir && $(stat -c %u "$dir") == 0 ]] || exit 0
      (((8#$(stat -c %a "$dir") & 8#022) == 0)) || exit 0
    fi
    tmp=$(mktemp "$dir/.progress.XXXXXXXXXX") || exit 0
    if printf '{"attempt":"%s","phase":"%s","result":"%s","pid":%s,"pidStart":"%s","boot":"%s"}\n' \
      "$ATTEMPT" "$PHASE" "$result" "$$" "$PROC_START" "$BOOT_ID" >"$tmp" &&
      chmod 644 "$tmp" && mv -f "$tmp" "$PROGRESS_FILE"; then
      exit 0
    fi
    rm -f "$tmp"
  ) 2>/dev/null || true
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
      DEPLOYMENT_KIND | REPO_DIR | REPO_URL | SERVICE_NAME | SERVICE_KIND | SERVICE_USER | STATE_ROOT | SNAPSHOT_DIR | STATUS_DIR | BUN | BASE_URL | UPDATER_PATH | READY_TIMEOUT_S)
        printf -v "$key" '%s' "$value"
        ;;
      *) die "unknown key in $CONF: $key" ;;
    esac
  done <"$CONF"
  local k
  DEPLOYMENT_KIND=${DEPLOYMENT_KIND:-git}
  local required="REPO_URL SERVICE_NAME SERVICE_KIND STATUS_DIR BASE_URL"
  case $DEPLOYMENT_KIND in
    git) required+=" REPO_DIR BUN" ;;
    container) [[ $EUID -eq 0 && ${SERVICE_KIND:-} == system && ${SERVICE_NAME:-} == isomux-container ]] || die "container updates need the root container service" ;;
    *) die "unknown DEPLOYMENT_KIND" ;;
  esac
  for k in $required; do
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
      if [[ $DEPLOYMENT_KIND == git ]]; then
      [[ -n ${SERVICE_USER:-} ]] || die "config is missing SERVICE_USER"
      SERVICE_USER_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
      [[ -n $SERVICE_USER_HOME ]] || die "no such user: $SERVICE_USER"
      fi
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
    if ((SECONDS >= deadline)); then
      log "ERROR: service did not stop within 60s (state: $state)"
      return 1
    fi
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
    add_deps_warning "system dependencies were not synced (no apt-get on this box); if $TARGET_TAG needs new system packages, install them yourself"
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
  local output warning
  output=$(mktemp /tmp/isomux-deps-output.XXXXXXXXXX)
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/root ISOMUX_DEPS_ONLY=1 /bin/bash "$installer" >"$output" 2>&1 || rc=$?
  grep -v 'ISOMUX_UPDATE_WARNING=' "$output" || true
  while IFS= read -r warning; do
    warning=${warning#*ISOMUX_UPDATE_WARNING=}
    add_deps_warning "$warning"
  done < <(grep 'ISOMUX_UPDATE_WARNING=' "$output" || true)
  rm -f "$output"
  rm -f "$installer"
  return "$rc"
}

# $STATUS_DIR/deps-synced holds the commit of the last update that synced its
# system dependencies and then completed. The already-on-target arm reads it:
# a box can run the target code with the tag recorded and still never have had
# that release's dependencies (an older updater moved its checkout). A box with
# no record syncs once. Written only at finalize, so a failed run syncs again
# on its retry.
deps_synced_for() {
  local recorded=""
  read -r recorded 2>/dev/null <"$STATUS_DIR/deps-synced" || true
  [[ $recorded == "$1" ]]
}

record_deps_synced() {
  { printf '%s\n' "$1" >"$STATUS_DIR/deps-synced.tmp" &&
    mv -f "$STATUS_DIR/deps-synced.tmp" "$STATUS_DIR/deps-synced"; } 2>/dev/null ||
    log "warning: could not record the dependency sync for $TARGET_TAG; the next update to it syncs again"
}

ready_poll() {
  local timeout=$1 deadline=$((SECONDS + $1))
  until curl -fsS -o /dev/null --max-time 5 "$BASE_URL/readyz" 2>/dev/null; do
    ((SECONDS < deadline)) || return 1
    sleep 2
  done
}

check_public_front_door() {
  [[ $SERVICE_KIND == system ]] || return 0
  systemctl cat caddy >/dev/null 2>&1 || return 0
  if ! systemctl is-active --quiet caddy; then
    local warning="Caddy is down; the office's public URL may be down. Check: systemctl status caddy"
    log "warning: $warning"
    add_deps_warning "$warning"
  fi
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

fail_ready() {
  trap - ERR
  log "$TARGET_TAG did not become ready; rolling back the code"
  svc stop "$SERVICE_NAME" || true
  if ! wait_inactive; then
    PHASE=recovery-failed
    die "rollback: service would not stop; NOT rebuilding the old version under a live process. Manual attention required."
  fi
  if restore_old_code && svc start "$SERVICE_NAME" && ready_poll "$READY_TIMEOUT_S"; then
    die "update to $TARGET_TAG failed readiness; rolled the code back to $OLD_DESC and it is running"
  else
    PHASE=recovery-failed
    die "update to $TARGET_TAG failed readiness AND the rollback did not come up; manual attention required"
  fi
}

# A stopped updater says so instead of leaving a running attempt behind.
on_signal() {
  trap - ERR TERM INT HUP
  die "the updater was stopped during $PHASE"
}

on_error() {
  local failed_phase=$PHASE
  trap - ERR
  if [[ $DEPLOYMENT_KIND == container ]]; then
    die "container update failed during $failed_phase; check the updater and container service logs"
  fi
  case $failed_phase in
    deps) die "could not install $TARGET_TAG's system dependencies; the checkout, its dependencies, the built UI and the office state are unchanged and the service is still running $OLD_DESC, but system package changes may be partial" ;;
    checkout | install | build) fail_build ;;
    start | readiness) fail_ready ;;
    *) die "unexpected failure during $failed_phase" ;;
  esac
}

git_validate() {
  [[ -d $REPO_DIR/.git ]] || die "not a git checkout: $REPO_DIR"
  [[ -z $(as_repo_user git -C "$REPO_DIR" status --porcelain) ]] ||
    die "checkout is dirty: $REPO_DIR - refusing to update over local changes"
  OLD_COMMIT=$(as_repo_user git -C "$REPO_DIR" rev-parse HEAD)
  OLD_DESC=$(as_repo_user git -C "$REPO_DIR" describe --tags --always --match 'v*')

 }

git_prepare() {
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
    local need_deps=""
    deps_synced_for "$target_commit" || need_deps=1
    if [[ $had_tag == "$target_commit" && -z $need_deps ]]; then
      log "already on $TARGET_TAG; nothing to do"
      write_status ok "already on $TARGET_TAG"
      exit 0
    fi
    # The box runs this release, but the checkout was not recording its tag,
    # or no completed update recorded syncing its system dependencies (or
    # both). Updaters from before target dependency sync leave that shape:
    # their first update refreshes the installed updater, but cannot deliver
    # this release's system dependencies. Run the target's narrow deps-only
    # installer now so the next invocation converges that box. A tagged,
    # synced no-op stays a true no-op.
    # update-ref ran before this branch so the running server can identify the
    # release after its restart. Until every repair step succeeds, however,
    # that ref is provisional: leaving it behind on one transient failure
    # would make the retry take the tagged no-op arm and skip the repair
    # forever. The dependency record is provisional the same way: it is
    # written only at finalize.
    local repaired="recorded the release tag for $TARGET_TAG"
    local undone="the tag repair was rolled back and the code is unchanged from before this run"
    local retry="the tag repair was rolled back so a retry can finish it"
    local unrecorded=" but is still not recording the release"
    if [[ $had_tag == "$target_commit" ]]; then
      repaired="synced $TARGET_TAG's system dependencies"
      undone="the code is unchanged from before this run"
      retry="a retry can finish it"
      unrecorded=""
    fi
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
        restart)
          # Restore the tag before starting. server/version.ts reads it once at
          # process start, so the running process must see the same state as the
          # checkout. Every command is guarded because the ERR trap is gone but
          # `set -e` is still active, and the final message must always be told.
          log "the restart did not take; trying once to bring $SERVICE_NAME back up"
          svc stop "$SERVICE_NAME" || true
          if svc start "$SERVICE_NAME" && ready_poll "$READY_TIMEOUT_S"; then
            die "$repaired, but $SERVICE_NAME did not come back up on the first attempt; $undone; a second start brought $SERVICE_NAME back up, so the office is serving$unrecorded - re-run the update to finish the repair"
          else
            die "$repaired, but $SERVICE_NAME could not be restarted; $undone, but the office is still down and needs manual attention"
          fi
          ;;
        readiness) die "$repaired and restarted $SERVICE_NAME, but it did not answer within ${READY_TIMEOUT_S}s; $undone, so look at the service log" ;;
        finalize) die "repaired $TARGET_TAG, but could not record the successful result; $retry" ;;
        *) die "the $TARGET_TAG repair failed during $failed_phase; $retry" ;;
      esac
    }
    trap repair_error ERR
    if [[ -n $need_deps ]]; then
      phase deps
      sync_system_deps "$target_commit"
    fi
    # Nothing was built and nothing can be rolled back, so the ordinary code
    # recovery ladder does not apply. server/version.ts reads the tag once per
    # process, and configure_user_manager's drop-in also takes effect on the
    # restart below.
    if [[ $had_tag == "$target_commit" ]]; then
      log "already on $TARGET_TAG, but its system dependencies were never recorded as synced; restarting so the office runs with them"
    else
      log "already on $TARGET_TAG, which the checkout was not recording; restarting so the office reports it"
    fi
    phase restart
    svc stop "$SERVICE_NAME"
    wait_inactive
    svc start "$SERVICE_NAME"
    phase readiness
    ready_poll "$READY_TIMEOUT_S"
    check_public_front_door
    phase finalize
    record_deps_synced "$target_commit"
    if [[ -n $DEPS_WARNING ]]; then
      write_status ok "$repaired; warning: $DEPS_WARNING"
    else
      write_status ok "$repaired"
    fi
    trap - ERR
    log "$repaired"
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

 }

# Git installs keep the state root in place: nothing to do while stopped.
git_state() { :; }

git_ready() {
  ready_poll "$READY_TIMEOUT_S" || fail_ready
}

git_finalize() {
  record_deps_synced "$target_commit"
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
 }

# Container operations use only installer-owned paths and trusted release files.
CONTAINER_DIR=/opt/isomux-container
CONTAINER_IMAGE=ghcr.io/nmamano/isomux

container_compose() {
  (cd "$CONTAINER_DIR" && env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    docker compose --env-file office.env -f compose.yaml "$@")
}

container_validate() {
  [[ -d $CONTAINER_DIR && ! -L $CONTAINER_DIR ]] || die "container installation is absent"
  OLD_DESC=$(cat "$CONTAINER_DIR/release")
  OLD_COMMIT=$(cat "$CONTAINER_DIR/revision")
  [[ $OLD_DESC =~ $CALVER_RE && $OLD_COMMIT =~ ^[a-f0-9]{40}$ ]] || die "invalid container installation record"
  "$CONTAINER_DIR/mount-check.sh"
}

container_prepare() {
  if [[ $TARGET_TAG == "$OLD_DESC" && $target_commit == "$OLD_COMMIT" ]]; then
    write_status ok "already on $TARGET_TAG"
    exit 0
  fi
  if [[ $(printf '%s\n' "$TARGET_TAG" "$OLD_DESC" | sort -V | head -1) == "$TARGET_TAG" && -z $ALLOW_DOWNGRADE ]]; then
    die "$TARGET_TAG is older than $OLD_DESC; pass --allow-downgrade to continue"
  fi
  phase image
  docker pull "$CONTAINER_IMAGE:$TARGET_TAG"
  local revision
  CONTAINER_DIGEST=$(docker image inspect "$CONTAINER_IMAGE:$TARGET_TAG" --format '{{json .RepoDigests}}' |
    jq -er --arg prefix "$CONTAINER_IMAGE@sha256:" '[.[] | select(startswith($prefix))] | if length == 1 then .[0] else error("ambiguous digest") end')
  [[ $CONTAINER_DIGEST == "$CONTAINER_IMAGE@sha256:"* && ${CONTAINER_DIGEST##*@sha256:} =~ ^[a-f0-9]{64}$ ]] || die "invalid image digest"
  docker pull "$CONTAINER_DIGEST"
  revision=$(docker image inspect "$CONTAINER_DIGEST" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  [[ $revision == "$target_commit" ]] || die "image source revision does not match the release"
  phase assets
  CONTAINER_STAGE=$(mktemp -d "$STATUS_DIR/release.XXXXXXXX")
  trap 'rm -rf -- "$CONTAINER_STAGE"' EXIT
  mkdir "$CONTAINER_STAGE/seccomp"
  local name
  for name in compose.yaml isomux-container.service mount-check.sh seccomp/chromium.json seccomp/LICENSE update-helper.py isomux-container-update.socket isomux-container-update@.service install-update-support.sh; do
    git -C "$TRUST_REPO" cat-file -p "$target_commit:deploy/container/$name" > "$CONTAINER_STAGE/$name"
  done
  git -C "$TRUST_REPO" cat-file -p "$target_commit:scripts/update.sh" > "$CONTAINER_STAGE/update.sh"
  git -C "$TRUST_REPO" cat-file -p "$target_commit:deploy/install.sh" | sha256sum | cut -d ' ' -f 1 > "$CONTAINER_STAGE/installer.sha256"
  # Keep the existing root-owned settings; replace only the image assignment.
  sed "s|^ISOMUX_IMAGE=.*$|ISOMUX_IMAGE=$CONTAINER_DIGEST|" "$CONTAINER_DIR/office.env" > "$CONTAINER_STAGE/office.env"
  grep -qx "ISOMUX_IMAGE=$CONTAINER_DIGEST" "$CONTAINER_STAGE/office.env" || die "image setting is absent"
  chmod 600 "$CONTAINER_STAGE/office.env"
  cp "$CONTAINER_DIR/client-update.conf" "$CONTAINER_STAGE/client-update.conf"
  (cd "$CONTAINER_STAGE" && env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    docker compose --env-file office.env -f compose.yaml config --quiet)
}

container_state() {
  phase publish
  local name
  for name in compose.yaml isomux-container.service seccomp/chromium.json seccomp/LICENSE office.env update.sh update-helper.py isomux-container-update.socket isomux-container-update@.service install-update-support.sh; do
    install -m 600 "$CONTAINER_STAGE/$name" "$CONTAINER_DIR/$name"
  done
  install -m 755 "$CONTAINER_STAGE/mount-check.sh" "$CONTAINER_DIR/mount-check.sh"
  install -m 644 "$CONTAINER_STAGE/isomux-container.service" /etc/systemd/system/isomux-container.service
  bash "$CONTAINER_STAGE/install-update-support.sh" "$CONTAINER_STAGE"
}

container_ready() {
  ready_poll "$READY_TIMEOUT_S" || die "container did not become ready"
  local identity
  identity=$(container_compose exec -T office bun -e 'import {getVersionInfo} from "./server/version.ts"; console.log(JSON.stringify(getVersionInfo()))')
  jq -e --arg commit "$target_commit" --arg release "$TARGET_TAG" '.commit == $commit and .release == $release' <<<"$identity" >/dev/null || die "running container version does not match the release"
}

container_finalize() {
  local release image
  release=$(cat "$CONTAINER_DIR/release")
  image=$(cat "$CONTAINER_DIR/image")
  printf '%s\n' "$TARGET_TAG" > "$CONTAINER_DIR/release"
  printf '%s\n' "$target_commit" > "$CONTAINER_DIR/revision"
  printf '%s\n' "$CONTAINER_DIGEST" > "$CONTAINER_DIR/image"
  install -m 600 "$CONTAINER_STAGE/installer.sha256" "$CONTAINER_DIR/installer.sha256"
  container_remove_previous "$CONTAINER_IMAGE:$release" "$image"
}

# Remove the two references the installer or the last update pulled for the
# replaced release, so the host does not keep one image per release. Docker
# keeps the image while a container or another reference still uses it.
container_remove_previous() {
  local current ref id
  current=$(docker image inspect --format '{{.Id}}' "$CONTAINER_DIGEST") ||
    { log "warning: could not inspect $CONTAINER_DIGEST; the previous image stays"; return 0; }
  for ref in "$@"; do
    [[ $ref == "$CONTAINER_IMAGE"[:@]* ]] || continue
    # An absent reference was already removed; never remove the new image.
    id=$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null) || continue
    [[ $id != "$current" ]] || continue
    docker image rm "$ref" >/dev/null || log "warning: could not remove the previous image $ref"
  done
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
  if [[ $DEPLOYMENT_KIND == git && $self == "${REPO_DIR:-}"/* && -z ${ISOMUX_UPDATE_REEXEC:-} ]]; then
    local tmp
    tmp=$(mktemp /tmp/isomux-update.XXXXXXXXXX)
    cat "$self" >"$tmp"
    chmod 700 "$tmp"
    log "running from inside $REPO_DIR; re-executing a temp copy"
    ISOMUX_UPDATE_REEXEC=1 exec bash "$tmp" "$@"
  fi
  # The re-exec temp copy deletes itself when done (bash holds it open).
  [[ -n ${ISOMUX_UPDATE_REEXEC:-} && $self == /tmp/* ]] && trap 'rm -f "$self"' EXIT

  install -d -m 700 "$STATUS_DIR"
  exec 9>"$STATUS_DIR/lock"
  flock -n 9 || die "another update is already running (lock: $STATUS_DIR/lock)"
  init_progress || true
  trap 'on_signal' TERM INT HUP

  trap on_error ERR

  phase validate
  "${DEPLOYMENT_KIND}_validate"

  phase fetch
  # Resolve the tag in root-owned space, against the configured upstream
  # only. The non-forced refspec makes a moved tag an error, not an update.
  [[ -d $TRUST_REPO ]] || git init -q --bare "$TRUST_REPO"
  git -C "$TRUST_REPO" fetch -q --depth 1 "$REPO_URL" "refs/tags/$TARGET_TAG:refs/tags/$TARGET_TAG" ||
    die "release tag $TARGET_TAG not found at $REPO_URL (or the tag moved upstream - release tags are immutable)"
  local target_commit
  target_commit=$(git -C "$TRUST_REPO" rev-parse -q --verify "refs/tags/$TARGET_TAG^{commit}") ||
    die "could not resolve $TARGET_TAG to a commit in the trust repo"
  "${DEPLOYMENT_KIND}_prepare"

  phase stop
  svc stop "$SERVICE_NAME"
  wait_inactive

  "${DEPLOYMENT_KIND}_state"

  phase start
  svc start "$SERVICE_NAME"

  phase readiness
  "${DEPLOYMENT_KIND}_ready"
  check_public_front_door

  phase finalize
  trap - ERR
  "${DEPLOYMENT_KIND}_finalize"
  if [[ -n $DEPS_WARNING ]]; then
    write_status ok "updated $OLD_DESC -> $TARGET_TAG; warning: $DEPS_WARNING"
  else
    write_status ok "updated $OLD_DESC -> $TARGET_TAG"
  fi
  log "updated $OLD_DESC -> $TARGET_TAG"
}

main "$@"
