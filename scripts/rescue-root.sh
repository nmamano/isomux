#!/usr/bin/env bash
# The rescue command for root installs (task cdd7883d), installed root-owned
# as /usr/local/sbin/isomux-rescue by deploy/install.sh, like isomux-update.
# It does only the root steps (the root marker, systemctl, the kills, the
# journal) and runs scripts/rescue.ts as the service user for every step that
# writes the state root (see scripts/rescue.ts): no code from the checkout
# runs as root, because the service user can edit it. It reads its settings
# from /etc/isomux/update.conf without sourcing it; ISOMUX_RESCUE_CONF,
# ISOMUX_RESCUE_ROOT_MARKER_DIR and ISOMUX_RESCUE_PROC override the paths for
# tests. Every external
# command is called by name through PATH.
#
#   isomux-rescue status | lockdown [--stop] [--reason <text>] | unlock | restart
#                 | export [dir] | rollback [release] | report [file] [--note <text>]
set -euo pipefail

CONF=${ISOMUX_RESCUE_CONF:-/etc/isomux/update.conf}
MARKER_DIR=${ISOMUX_RESCUE_ROOT_MARKER_DIR:-/etc/isomux}
MARKER=$MARKER_DIR/lockdown
PROC=${ISOMUX_RESCUE_PROC:-/proc}
STOP_TIMEOUT_S=60
READY_TIMEOUT_S=90

die() {
  echo "isomux-rescue: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: isomux-rescue <command>
  status                              the office's state; exit 0 healthy, 1 down, 2 locked
  lockdown [--stop] [--reason <text>] lock the office and revoke every sign-in and token
  unlock                              remove the lock and start the office
  restart                             restart the office and wait until it answers
  export [dir]                        write a readable copy of the office's content to dir
  rollback [release]                  go back to the release the last update replaced
  report [file] [--note <text>]       write an incident report for Isomux support
EOF
}

# KEY=VALUE lines, never sourced: a value is text, whatever it holds.
DEPLOYMENT_KIND=git SERVICE_NAME=isomux SERVICE_KIND=system SERVICE_USER=
REPO_DIR= STATE_ROOT= BUN=bun BASE_URL=http://127.0.0.1:4000
STATUS_DIR=/var/lib/isomux-update UPDATER_PATH=/usr/local/sbin/isomux-update
CONTAINER_DIR=/opt/isomux-container
CALVER_RE='^v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?$'
read_conf() {
  [[ -r $CONF ]] || die "$CONF is missing: this is not a root install. Run 'bun run rescue' as the office's user."
  local line key value
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
    case $key in
      DEPLOYMENT_KIND | SERVICE_NAME | SERVICE_KIND | SERVICE_USER | REPO_DIR | STATE_ROOT | BUN | BASE_URL | STATUS_DIR | UPDATER_PATH)
        printf -v "$key" '%s' "$value"
        ;;
    esac
  done <"$CONF"
  [[ $SERVICE_KIND == system ]] || die "SERVICE_KIND=$SERVICE_KIND: run 'bun run rescue' as the office's user."
  if [[ $DEPLOYMENT_KIND != container ]]; then
    [[ -n $SERVICE_USER && -n $REPO_DIR && -n $STATE_ROOT ]] ||
      die "$CONF is missing SERVICE_USER, REPO_DIR or STATE_ROOT"
  fi
}

# scripts/rescue.ts as the service user, in the checkout.
as_service() {
  local home
  home=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
  [[ -n $home ]] || die "no such user: $SERVICE_USER"
  (cd "$REPO_DIR" && runuser -u "$SERVICE_USER" -- env "HOME=$home" \
    "ISOMUX_HOME=$STATE_ROOT" "ISOMUX_RESCUE_CONF=$CONF" \
    "ISOMUX_RESCUE_ROOT_MARKER_DIR=$MARKER_DIR" \
    "$BUN" scripts/rescue.ts "$@")
}

# scripts/rescue.ts inside the office container, as the user and with the
# state root the entrypoint gives the office (deploy/container/entrypoint.sh).
in_container() {
  (cd /opt/isomux-container &&
    docker compose --env-file office.env exec -T -u node \
      -e HOME=/var/data/home -e ISOMUX_HOME=/var/data/home/.isomux \
      office bun scripts/rescue.ts "$@")
}

unit_state() { systemctl is-active "$SERVICE_NAME" 2>/dev/null || true; }

wait_inactive() {
  local deadline=$((SECONDS + STOP_TIMEOUT_S)) state
  while :; do
    state=$(unit_state)
    [[ $state != active && $state != deactivating ]] && return 0
    ((SECONDS >= deadline)) && return 1
    sleep 0.5
  done
}

# The /readyz body once it answers 200, or nothing after the timeout.
wait_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT_S)) body
  while :; do
    if body=$(curl -fsS --max-time 5 "$BASE_URL/readyz" 2>/dev/null); then
      printf '%s\n' "$body"
      return 0
    fi
    ((SECONDS >= deadline)) && return 1
    sleep 1
  done
}

# Refuse inside the office unit's group: stopping the unit would end us.
refuse_inside_unit() {
  if grep -qE "(^|/)${SERVICE_NAME//./\\.}\.service(/|$)" /proc/self/cgroup 2>/dev/null; then
    die "this shell runs inside the office, and stopping the office would end it. Run it from a login shell on the office's machine."
  fi
}

# The office's leftovers after its stop: processes of the service user (or the
# split agent user) whose ISOMUX_OFFICE_PID is this unit's last main pid. Never
# this process or an ancestor.
leftovers() {
  local office_pid=$1 uids=() keep=() pid ppid uid d
  uids+=("$(id -u "$SERVICE_USER")")
  local agent_uid
  agent_uid=$(grep -oE '"agentUid"[[:space:]]*:[[:space:]]*[0-9]+' "$STATE_ROOT/split.json" 2>/dev/null | grep -oE '[0-9]+$' || true)
  [[ -n $agent_uid ]] && uids+=("$agent_uid")
  pid=$$
  while [[ -n $pid && $pid -gt 0 ]]; do
    keep+=("$pid")
    ppid=$(awk '/^PPid:/{print $2}' "$PROC/$pid/status" 2>/dev/null || true)
    [[ $ppid == "$pid" ]] && break
    pid=$ppid
  done
  for d in "$PROC"/[0-9]*; do
    pid=${d##*/}
    [[ " ${keep[*]} " == *" $pid "* ]] && continue
    uid=$(awk '/^Uid:/{print $2}' "$d/status" 2>/dev/null) || continue
    [[ " ${uids[*]} " == *" $uid "* ]] || continue
    tr '\0' '\n' 2>/dev/null <"$d/environ" | grep -qx "ISOMUX_OFFICE_PID=$office_pid" || continue
    echo "$pid"
  done
}

kill_leftovers() {
  local office_pid pids
  office_pid=$(systemctl show -p ExecMainPID --value "$SERVICE_NAME" 2>/dev/null || true)
  office_pid=${office_pid#ExecMainPID=}
  [[ $office_pid =~ ^[0-9]+$ && $office_pid -gt 0 ]] || return 0
  pids=$(leftovers "$office_pid")
  [[ -n $pids ]] || return 0
  echo "Ending $(wc -w <<<"$pids") office process(es) left running."
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  sleep 2
  pids=$(leftovers "$office_pid")
  # shellcheck disable=SC2086
  [[ -z $pids ]] || kill -KILL $pids 2>/dev/null || true
}

# Written by root from update.conf alone: the checkout's code must not decide
# which office the one marker it cannot remove locks. The reason stays in the
# state marker. Same shape as lockMarkerBody (server/lockdown.ts).
write_root_marker() {
  local body tmp root
  root=${STATE_ROOT//\\/\\\\}
  root=${root//\"/\\\"}
  body=$(printf '{"since":"%s","reason":"","by":"host","stateRoot":"%s"}' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$root")
  install -d -m 755 "$MARKER_DIR"
  tmp=$(mktemp "$MARKER_DIR/.lockdown.XXXXXXXXXX")
  printf '%s\n' "$body" >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$MARKER"
}

cmd_lockdown() {
  local stop=0 reason=""
  while (($#)); do
    case $1 in
      --stop) stop=1 ;;
      --reason)
        (($# >= 2)) || die "--reason needs a text"
        reason=$2
        shift
        ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done
  if [[ $DEPLOYMENT_KIND == container ]]; then
    in_container _step state-marker --reason "$reason" --by host
    echo "Locked: the office will not start unlocked."
    if ((stop)); then
      # No exec reaches the state once the container is down.
      in_container _step audit lockdown --reason "$reason"
      systemctl disable --now "$SERVICE_NAME"
      echo "The office is stopped and stays stopped after a reboot."
    else
      systemctl stop "$SERVICE_NAME"
      wait_inactive || die "the office did not stop within ${STOP_TIMEOUT_S} s. It stays locked; run lockdown again."
      systemctl start "$SERVICE_NAME"
      wait_ready >/dev/null || die "the office did not answer within ${READY_TIMEOUT_S} s. It stays locked; see isomux-rescue status."
      # The locked office never writes office.sqlite: one writer.
      in_container _step audit lockdown --reason "$reason"
      echo "The office is up and shows only a locked page; every sign-in, API token, invite and browser extension pairing is revoked."
    fi
  else
    refuse_inside_unit
    write_root_marker
    as_service _step state-marker --reason "$reason" --by host
    echo "Locked: the office will not start unlocked."
    systemctl stop "$SERVICE_NAME"
    wait_inactive || die "the office did not stop within ${STOP_TIMEOUT_S} s. It stays locked; run lockdown again."
    as_service _step audit lockdown --reason "$reason"
    kill_leftovers
    as_service _step quarantine >/dev/null
    echo "Revoked every sign-in, API token, invite and browser extension pairing."
    if ((stop)); then
      systemctl disable "$SERVICE_NAME"
      echo "The office is stopped and stays stopped after a reboot."
    else
      systemctl start "$SERVICE_NAME"
      if wait_ready >/dev/null; then
        echo "The office is up and shows only a locked page."
      else
        echo "The office did not answer yet. It stays locked; see isomux-rescue status."
      fi
    fi
  fi
  echo "Provider keys and connection tokens are kept but unused while locked. Rotate them at the provider if they may have leaked."
  echo "To unlock: isomux-rescue unlock"
}

start_again() {
  if ! systemctl is-enabled "$SERVICE_NAME" >/dev/null 2>&1; then
    systemctl enable --now "$SERVICE_NAME"
  elif [[ $(unit_state) == active ]]; then
    systemctl restart "$SERVICE_NAME"
  else
    systemctl start "$SERVICE_NAME"
  fi
}

cmd_unlock() {
  if [[ $DEPLOYMENT_KIND == container ]]; then
    # A container stopped by lockdown --stop boots locked first, so the exec
    # can reach its state.
    if [[ $(unit_state) != active ]]; then
      systemctl enable --now "$SERVICE_NAME"
      wait_ready >/dev/null || die "the office did not answer within ${READY_TIMEOUT_S} s"
    fi
    in_container _step remove-state-marker
    in_container _step audit unlock
    systemctl restart "$SERVICE_NAME"
  else
    refuse_inside_unit
    rm -f "$MARKER"
    as_service _step remove-state-marker
    as_service _step audit unlock
    start_again
  fi
  if wait_ready >/dev/null; then
    echo "Unlocked: the office is up."
  else
    echo "Unlocked, but the office did not answer yet: see isomux-rescue status."
  fi
  echo "Every sign-in was revoked by the lock. Owners sign in again with the owner sign-in recovery (isomux.com/docs/access-and-invites)."
}

cmd_restart() {
  systemctl restart "$SERVICE_NAME"
  local body
  body=$(wait_ready) || die "the office did not answer within ${READY_TIMEOUT_S} s. See isomux-rescue status."
  if [[ $body == locked ]]; then echo "The office is up and locked."; else echo "The office is up."; fi
}

# The first line of a root-owned record, when it is a release tag.
read_release() {
  local value=""
  read -r value 2>/dev/null <"$1" || true
  [[ $value =~ $CALVER_RE ]] && printf '%s' "$value"
  return 0
}

# The release the office runs: the updater's record, or the container's.
installed_release() {
  if [[ $DEPLOYMENT_KIND == container ]]; then
    read_release "$CONTAINER_DIR/release"
  else
    read_release "$STATUS_DIR/installed-release"
  fi
}

# --release <tag> for the service user's steps: it cannot read the
# updater's folder.
release_args() {
  local release
  release=$(installed_release)
  [[ -n $release ]] && printf '%s\n' --release "$release"
  return 0
}

cmd_status() {
  local code=0
  if [[ $DEPLOYMENT_KIND == container ]]; then
    local state body release
    state=$(unit_state)
    release=$(installed_release)
    echo "Service        $SERVICE_NAME: ${state:-unknown}"
    if body=$(curl -fsS --max-time 5 "$BASE_URL/readyz" 2>/dev/null); then
      echo "Ready check    HTTP 200 \"$body\""
    else
      echo "Ready check    no answer"
    fi
    echo "Version        ${release:-unknown}"
    if [[ $body == locked ]]; then
      code=2
    elif [[ $state != active || -z $body ]]; then
      code=1
    fi
  else
    local -a extra
    mapfile -t extra < <(release_args)
    as_service status --no-journal "${extra[@]}" || code=$?
  fi
  echo
  echo "Last 50 log lines:"
  journalctl -u "$SERVICE_NAME" -n 50 --no-pager 2>/dev/null || true
  return "$code"
}

# The office's content, redacted, in a new folder (server/office-export.ts).
# The service user makes the folder and writes it: root never creates or
# chowns a path that user controls (the default is in its home), so a link
# swapped in cannot hand root's files to it. A container writes it inside
# and root copies it out.
cmd_export() {
  local out=${1:-} stamp
  stamp=$(date -u +%Y%m%d-%H%M%S)
  if [[ -z $out ]]; then
    if [[ $DEPLOYMENT_KIND == container ]]; then
      out=$PWD/isomux-export-$stamp
    else
      local name=${STATE_ROOT##*/}
      out=$(dirname "$STATE_ROOT")/${name#.}-export-$stamp
    fi
  fi
  out=$(realpath -m -- "$out")
  [[ -e $out ]] && die "$out exists: name a folder that does not exist yet"
  if [[ $DEPLOYMENT_KIND == container ]]; then
    # Nothing reaches the state while the container is down (lockdown --stop).
    [[ $(unit_state) == active ]] ||
      die "the office's container is not running, so the export cannot reach its data. Start it first: systemctl start $SERVICE_NAME (a locked office starts locked)."
    local inside=/tmp/isomux-export-$stamp code=0
    in_container _step export "$inside" || code=$?
    if ((code == 0)); then
      mkdir -m 700 -- "$out" || code=$?
    fi
    if ((code == 0)); then
      (cd /opt/isomux-container &&
        docker compose --env-file office.env cp "office:$inside/." "$out/") || code=$?
      chmod -R go-rwx -- "$out" 2>/dev/null || true
    fi
    (cd /opt/isomux-container &&
      docker compose --env-file office.env exec -T -u node office rm -rf -- "$inside") || true
    ((code == 0)) || die "the export failed"
    echo "Copied the export out of the container to $out"
  else
    local root
    root=$(realpath -m -- "$STATE_ROOT")
    [[ $out != "$root" && $out != "$root"/* ]] || die "$out is inside the office's state folder: pick a folder outside it"
    runuser -u "$SERVICE_USER" -- mkdir -m 700 -- "$out" ||
      die "$SERVICE_USER could not make $out: pick a folder that user can write"
    as_service _step export "$out"
  fi
}

# Back to the release the last update replaced, through the installed
# updater: it fetches the tag from the upstream, checks it, restores the code
# when the start fails, and refuses a release without locked mode on a locked
# office. The target: the release named, else the updater's record, else the
# newest release the trust repo fetched that is older than the installed one.
cmd_rollback() {
  local target=${1:-} current previous
  (($# <= 1)) || die "usage: isomux-rescue rollback [release]"
  current=$(installed_release)
  [[ -n $current ]] || die "no record of the installed release: name a release (isomux-rescue rollback vYYYY.M.D) from https://github.com/nmamano/isomux/releases"
  previous=$(read_release "$STATUS_DIR/previous-release")
  if [[ -n $target ]]; then
    [[ $target =~ $CALVER_RE ]] || die "not a release tag (vYYYY.M.D[.N]): $target"
  elif [[ -n $previous ]]; then
    target=$previous
  else
    target=$(git -C "$STATUS_DIR/trust.git" tag -l 'v*' 2>/dev/null | grep -E "$CALVER_RE" |
      { cat; printf '%s\n' "$current"; } | sort -uV | grep -B1 -xF "$current" | grep -vxF "$current" || true)
    [[ -n $target ]] || die "no record of an earlier release: name one (isomux-rescue rollback vYYYY.M.D) from https://github.com/nmamano/isomux/releases"
  fi
  [[ $target != "$current" ]] || die "$target is the installed release"
  if [[ $DEPLOYMENT_KIND != container ]]; then refuse_inside_unit; fi
  systemctl is-enabled "$SERVICE_NAME" >/dev/null 2>&1 ||
    die "the office's service is disabled, as lockdown --stop leaves it, and a rollback would start it. Start it first: systemctl enable --now $SERVICE_NAME (a locked office starts locked)"
  # The release rule promises that the previous release reads the data.
  if [[ -n $previous && $target != "$previous" ]] &&
    [[ $(printf '%s\n' "$target" "$previous" | sort -V | head -1) == "$target" ]]; then
    echo "Note: the office's data was written by $current, and only $previous is sure to read it. $target is older."
  fi
  echo "Rolling back from $current to $target."
  local code=0
  "$UPDATER_PATH" "$target" --allow-downgrade || code=$?
  if ((code == 0)); then
    echo "The office runs $target. Its data stays as $current left it."
    echo "To return: isomux-update $current"
  else
    echo "The rollback to $target did not complete (exit $code). See isomux-rescue status."
  fi
  return "$code"
}

# An incident report for Isomux support (server/office-report.ts). Root reads
# what the service user cannot (the journal, the updater's records) and passes
# it in; the service user redacts it with the office's secret values and
# writes the file, as with export. A container writes it to stdout, and root
# writes the file.
cmd_report() {
  local out="" note="" stamp
  while (($#)); do
    case $1 in
      --note)
        (($# >= 2)) || die "--note needs a text"
        note=$2
        shift
        ;;
      -*) die "unknown option: $1" ;;
      *)
        [[ -z $out ]] || die "usage: isomux-rescue report [file] [--note <text>]"
        out=$1
        ;;
    esac
    shift
  done
  stamp=$(date -u +%Y%m%d-%H%M%S)
  if [[ -z $out ]]; then
    if [[ $DEPLOYMENT_KIND == container ]]; then
      out=$PWD/isomux-incident-$stamp.md
    else
      local name=${STATE_ROOT##*/}
      out=$(dirname "$STATE_ROOT")/${name#.}-incident-$stamp.md
    fi
  fi
  out=$(realpath -m -- "$out")
  [[ -e $out || -L $out ]] && die "$out exists: name a file that does not exist yet"
  local -a args=(--journal-stdin --note "$note")
  local release previous result=""
  release=$(installed_release)
  previous=$(read_release "$STATUS_DIR/previous-release")
  [[ -n $release ]] && args+=(--release "$release")
  [[ -n $previous ]] && args+=(--previous "$previous")
  # write_status keeps the message free of quotes and backslashes.
  [[ -r $STATUS_DIR/status.json ]] &&
    result=$(grep -oE '"message"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_DIR/status.json" | head -1 |
      sed -E 's/^"message"[[:space:]]*:[[:space:]]*"(.*)"$/\1/' || true)
  [[ -n $result ]] && args+=(--update-result "$result")
  if [[ $DEPLOYMENT_KIND == container ]]; then
    [[ $(unit_state) == active ]] ||
      die "the office's container is not running, so the report cannot reach its data. Start it first: systemctl start $SERVICE_NAME (a locked office starts locked)."
    local tmp
    tmp=$(mktemp "$(dirname "$out")/.isomux-incident.XXXXXXXXXX") || die "could not write in $(dirname "$out")"
    if { journalctl -u "$SERVICE_NAME" -n 200 --no-pager 2>/dev/null || true; } |
      in_container _step report - "${args[@]}" >"$tmp"; then
      chmod 600 "$tmp"
      mv -T -- "$tmp" "$out" || { rm -f -- "$tmp"; die "could not write $out"; }
    else
      rm -f -- "$tmp"
      die "the report failed"
    fi
    echo "Wrote the incident report to $out"
    echo "Read it before you send it: it holds log lines from the office."
  else
    local root
    root=$(realpath -m -- "$STATE_ROOT")
    [[ $out != "$root" && $out != "$root"/* ]] || die "$out is inside the office's state folder: pick a file outside it"
    { journalctl -u "$SERVICE_NAME" -n 200 --no-pager 2>/dev/null || true; } |
      as_service _step report "$out" "${args[@]}"
  fi
}

main() {
  local cmd=${1:-}
  [[ -n $cmd ]] || {
    usage
    exit 0
  }
  shift
  [[ $(id -u) == 0 ]] || die "run this as root (sudo isomux-rescue $cmd)"
  read_conf
  case $cmd in
    status) cmd_status ;;
    lockdown) cmd_lockdown "$@" ;;
    unlock) cmd_unlock ;;
    restart) cmd_restart ;;
    export) cmd_export "$@" ;;
    rollback) cmd_rollback "$@" ;;
    report) cmd_report "$@" ;;
    help | -h | --help) usage ;;
    *)
      usage
      exit 64
      ;;
  esac
}

main "$@"
