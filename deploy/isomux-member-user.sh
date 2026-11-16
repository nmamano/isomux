#!/usr/bin/env bash
# isomux-member-user - run one member's agents as their own OS user
# (internal-docs/member-os-user-design.md, section 2). Installed root-owned
# as /usr/local/sbin/isomux-member-user by deploy/install.sh. Root acts only
# on the account and on new places it makes; the office does the rest over
# admin.sock (server/member-user-admin.ts). It reads its settings from
# /etc/isomux/update.conf without sourcing it. In the container image it
# reads /etc/isomux/member-user-container.conf (DEPLOYMENT_KIND=inside-container)
# and leaves every change under /var/data/members to
# deploy/container/member-users.py. Every external command is called by name
# through PATH. ISOMUX_MEMBER_USER_CONF, ISOMUX_MEMBER_USER_SHARE_ROOT,
# ISOMUX_MEMBER_USER_ETC, ISOMUX_MEMBER_USER_SYSTEMD_DIR,
# ISOMUX_MEMBER_USER_HELPER and ISOMUX_MEMBER_USER_USERADD_DEFAULTS override
# the paths for tests.
#
#   isomux-member-user enable <member> [--user <osuser>]
#   isomux-member-user disable <member> [--delete-user] [--keep-files]
set -euo pipefail

# Only the image has the container conf. Its update.conf (the host's
# client-update.conf, mounted) says DEPLOYMENT_KIND=container, as the host's
# own does, so it cannot tell the two apart.
CONF=${ISOMUX_MEMBER_USER_CONF:-}
if [[ -z $CONF ]]; then
  CONF=/etc/isomux/update.conf
  [[ ! -e /etc/isomux/member-user-container.conf ]] ||
    CONF=/etc/isomux/member-user-container.conf
fi
SHARE_ROOT=${ISOMUX_MEMBER_USER_SHARE_ROOT:-/var/lib/isomux-share}
ETC_DIR=${ISOMUX_MEMBER_USER_ETC:-/etc/isomux/member-runner}
SYSTEMD_DIR=${ISOMUX_MEMBER_USER_SYSTEMD_DIR:-/run/systemd/system}
HELPER=${ISOMUX_MEMBER_USER_HELPER:-/opt/isomux/deploy/container/member-users.py}
# useradd's defaults: HOME= is the base of the homes it makes.
USERADD_DEFAULTS=${ISOMUX_MEMBER_USER_USERADD_DEFAULTS:-/etc/default/useradd}
# Homes in the container: on the data volume (member-users.py, ROOT).
CONTAINER_HOMES=/var/data/members/home
UNIT=isomux-member-runner
NAME_RE='^[a-z_][a-z0-9_-]{0,31}$'
PRIVILEGED_GROUPS=(sudo wheel admin adm docker)

die() {
  echo "isomux-member-user: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: isomux-member-user <command>
  enable <member> [--user <osuser>]   run the member's agents as a new OS user
  disable <member> [--delete-user] [--keep-files]
                                      run them as the office's user again
      --keep-files: when the member's runner cannot run, leave their files
      in their home and do not move them back to the office
EOF
  exit 2
}

# KEY=VALUE lines, never sourced: a value is text, whatever it holds.
SERVICE_USER= STATE_ROOT= SERVICE_KIND=system DEPLOYMENT_KIND=git
read_conf() {
  [[ -r $CONF ]] || die "$CONF is missing: this is not a root install."
  local line key value
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
    case $key in
      SERVICE_USER | STATE_ROOT | SERVICE_KIND | DEPLOYMENT_KIND)
        printf -v "$key" '%s' "$value"
        ;;
    esac
  done <"$CONF"
  [[ $SERVICE_KIND == system ]] || die "SERVICE_KIND=$SERVICE_KIND: member OS users need a system install."
  [[ $DEPLOYMENT_KIND != container ]] || die "in the container, run this command inside it (docker exec -u 0)."
  [[ -n $SERVICE_USER && -n $STATE_ROOT ]] || die "$CONF is missing SERVICE_USER or STATE_ROOT"
  IN_CONTAINER=
  [[ $DEPLOYMENT_KIND != inside-container ]] || IN_CONTAINER=1
  ADMIN_SOCK=$STATE_ROOT/admin.sock
  OFFICE_UID=$(id -u "$SERVICE_USER") || die "no such user: $SERVICE_USER"
}

# POST one verb to the office: the answer in ADMIN_BODY and its HTTP status
# in ADMIN_STATUS (globals: a command substitution would lose them). Dies
# when the office does not answer.
ADMIN_STATUS= ADMIN_BODY=
# go-on and disable move the member's files, so they wait for the office's
# worst path (server/member-move.ts): the connect (30 s), MOVE_IN_TIMEOUT_MS
# (3600 s), then MOVE_STEP_TIMEOUT_MS twice (place 1800 s, undo 1800 s) =
# 7230 s, plus a margin.
MOVE_VERB_LIMIT_S=10800
admin() {
  admin_call "$@" || die "the office did not answer $1"
}
# As admin, but returns 1 when the office does not answer.
admin_call() {
  local verb=$1 body=$2 out limit=120
  [[ $verb != go-on && $verb != disable ]] || limit=$MOVE_VERB_LIMIT_S
  [[ -S $ADMIN_SOCK ]] || die "$ADMIN_SOCK is missing; is the office running?"
  out=$(curl -sS --max-time "$limit" --unix-socket "$ADMIN_SOCK" -X POST \
    -H 'Content-Type: application/json' --data "$body" \
    -w '\n%{http_code}' "http://localhost/admin/member-user/$verb") ||
    return 1
  ADMIN_STATUS=${out##*$'\n'}
  ADMIN_BODY=${out%$'\n'*}
}

# The field of a JSON answer, or "" (jq -r prints null as "null").
field() { jq -r "$1 // empty" <<<"$2"; }

# The container's helper, for every change under /var/data/members.
helper() { python3 -I "$HELPER" "$@"; }

# The steps done so far, undone in reverse on a failure.
UNDO=()
undo_all() {
  local i
  for ((i = ${#UNDO[@]} - 1; i >= 0; i--)); do
    eval "${UNDO[i]}" || echo "isomux-member-user: undo failed: ${UNDO[i]}" >&2
  done
  UNDO=()
}
fail() {
  echo "isomux-member-user: $*" >&2
  exit 1
}
# Every exit with steps left to undo (fail, die, a set -e failure, a
# signal) undoes them, except while go-on is out: the office may have
# recorded the user, so the user stays and a rerun of enable finishes.
GO_ON_OUT=
on_exit() {
  local status=$?
  # A second stop signal (a restart sends TERM to sudo and to this command,
  # and sudo relays it; or a second Ctrl-C) must not cut the undo short.
  # systemd's SIGKILL after TimeoutStopSec still bounds it.
  trap '' INT TERM
  if [[ -n $GO_ON_OUT ]]; then
    echo "isomux-member-user: the office may have taken the OS user; it stays. Run the same enable command again when the office runs." >&2
  elif ((${#UNDO[@]})); then
    undo_all
    echo "isomux-member-user: nothing was changed" >&2
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A folder only root can change: owned by root, no group or other write,
# not a link.
root_only_dir() {
  local path=$1 owner mode
  [[ -d $path && ! -L $path ]] || return 1
  read -r owner mode < <(stat -c '%u %a' "$path")
  [[ $owner == 0 ]] || return 1
  (((8#$mode & 8#022) == 0))
}

# The user cannot become root: in no privileged group, and sudo lists
# nothing for it.
cannot_become_root() {
  local user=$1 group out
  local privileged
  for group in $(id -Gn "$user"); do
    for privileged in "${PRIVILEGED_GROUPS[@]}"; do
      [[ $group == "$privileged" ]] && return 1
    done
  done
  if command -v sudo >/dev/null; then
    out=$(LC_ALL=C sudo -n -l -U "$user" 2>&1 || true)
    grep -q "is not allowed to run sudo" <<<"$out" || return 1
  fi
  return 0
}

# The base of the homes useradd makes: HOME= of its defaults, else /home.
useradd_home_base() {
  local line base=/home
  if [[ -r $USERADD_DEFAULTS ]]; then
    while IFS= read -r line || [[ -n $line ]]; do
      [[ $line =~ ^[[:space:]]*HOME=(/[^[:space:]]*)[[:space:]]*$ ]] && base=${BASH_REMATCH[1]}
    done <"$USERADD_DEFAULTS"
  fi
  [[ $base == / ]] || base=${base%/}
  printf '%s\n' "$base"
}

enable() {
  local member=$1 os_user=$2 info role user_id slug current current_uid moved_in home
  [[ -n $IN_CONTAINER || -d $SYSTEMD_DIR ]] || die "this box does not run systemd."
  admin info "$(jq -n --arg m "$member" '{member: $m}')"
  info=$ADMIN_BODY
  [[ $ADMIN_STATUS == 200 ]] || die "$(field .message "$info")"
  role=$(field .role "$info")
  user_id=$(field .userId "$info")
  slug=$(field .slug "$info")
  current=$(field .osUser.name "$info")
  current_uid=$(field .osUser.uid "$info")
  # A member who came with an office move: the record names her user and
  # the old machine's uid, and this machine has no such user yet.
  moved_in=$(field .movedIn "$info")
  [[ $role != owner ]] || die "$member is an owner; an owner cannot have their own OS user."
  if [[ -n $current ]]; then
    [[ -z $os_user || $os_user == "$current" ]] || die "$member already runs as $current."
    os_user=$current
  fi
  [[ -n $os_user ]] || os_user=isomux-$slug
  [[ $os_user =~ $NAME_RE ]] || die "$os_user is not a user name."
  # A user that this command made for this member, from an enable that did
  # not finish (the office stopped during go-on): finish it.
  if getent passwd "$os_user" >/dev/null && made_by_command "$os_user" "$user_id"; then
    # The uid of a moved-in record is the old machine's until go-on
    # records the new one.
    [[ $moved_in != true ]] || current_uid=
    resume "$user_id" "$os_user" "$current_uid"
    echo "$member runs as $os_user."
    return
  fi
  if [[ -n $current && $moved_in == true ]]; then
    getent passwd "$current" >/dev/null &&
      die "the OS user $current exists here; $member came with an office move and needs a new user of that name."
    # The home must be new: the move places her old home over it.
    if [[ -n $IN_CONTAINER ]]; then
      home=$CONTAINER_HOMES/$os_user
    else
      home=$(useradd_home_base)/$os_user
    fi
    [[ ! -e $home && ! -L $home ]] ||
      die "$home exists here; move it away, then run enable again."
  elif [[ -n $current ]]; then
    getent passwd "$current" >/dev/null ||
      die "$member is recorded as $current, which is no OS user here: run disable $member --keep-files, then enable again."
    die "$member already runs as $current, and this command did not make that user."
  fi
  # Only a user that this command makes: disable --delete-user removes it.
  ! getent passwd "$os_user" >/dev/null || die "the OS user $os_user exists; choose another with --user."

  if [[ -n $IN_CONTAINER ]]; then
    enable_container "$user_id" "$os_user"
  else
    enable_systemd "$user_id" "$os_user"
  fi
  cannot_become_root "$os_user" || fail "$os_user can become root (a privileged group or a sudo rule)"
  go_on "$user_id" "$os_user"
  UNDO=()
  echo "$member runs as $os_user."
}

# The second run of an enable that did not finish: the user, its home and
# its share are there. Nothing here is undone: the office may hold the
# record. Start the runner again and send go-on.
resume() {
  local user_id=$1 os_user=$2 recorded_uid=$3 uid
  uid=$(id -u "$os_user") || fail "cannot look up $os_user"
  [[ -z $recorded_uid || $recorded_uid == "$uid" ]] ||
    fail "the office records uid $recorded_uid for $os_user, which has uid $uid"
  prepare "$user_id" "$os_user" "$uid"
  if [[ -n $IN_CONTAINER ]]; then
    helper start "$os_user" || fail "cannot start the runner of $os_user"
  else
    [[ -e $ETC_DIR/$os_user.env ]] || {
      printf 'ISOMUX_OFFICE_UID=%s\n' "$OFFICE_UID" >"$ETC_DIR/$os_user.env" &&
        chmod 644 "$ETC_DIR/$os_user.env"
    } || fail "cannot write $ETC_DIR/$os_user.env"
    loginctl enable-linger "$os_user" || fail "cannot enable the linger of $os_user"
    systemctl enable --now "$UNIT@$os_user.service" || fail "cannot start $UNIT@$os_user"
  fi
  MEMBER_UID=$uid
  cannot_become_root "$os_user" || fail "$os_user can become root (a privileged group or a sudo rule)"
  go_on "$user_id" "$os_user"
}

# The office installs the runtime in the share; root writes no code.
prepare() {
  local user_id=$1 os_user=$2 uid=$3
  admin prepare "$(jq -n --arg m "$user_id" --arg u "$os_user" \
    --argjson uid "$uid" '{member: $m, osUser: $u, uid: $uid}')"
  [[ $ADMIN_STATUS == 200 ]] || fail "the office could not prepare the share: $(field .message "$ADMIN_BODY")"
}

# The uid of the user that enable made (set by enable_container or
# enable_systemd).
MEMBER_UID=
go_on() {
  local user_id=$1 os_user=$2
  GO_ON_OUT=1
  while :; do
    admin_call go-on "$(jq -n --arg m "$user_id" --arg u "$os_user" \
      --argjson uid "$MEMBER_UID" '{member: $m, osUser: $u, uid: $uid}')" ||
      die "the office did not answer go-on"
    [[ $ADMIN_STATUS == 200 && $(field .ready "$ADMIN_BODY") == true ]] && {
      GO_ON_OUT=
      jq -r '.warnings[]? | "isomux-member-user: \(.)"' <<<"$ADMIN_BODY" >&2
      return 0
    }
    # A home that came with an office move is placed as a job: ask again
    # until it ends.
    [[ $ADMIN_STATUS == 200 && $(field .running "$ADMIN_BODY") == true ]] || break
    echo "Placing the home of $os_user: $(field .placed "$ADMIN_BODY") of $(field .total "$ADMIN_BODY") entries."
    sleep 5
  done
  # kept: the office still records the user, so it stays (GO_ON_OUT) and
  # the same enable finishes. Else the refusal removed what this call
  # recorded, and the steps are undone.
  [[ $ADMIN_STATUS == 200 && $(field .kept "$ADMIN_BODY") == true ]] ||
    GO_ON_OUT=
  fail "the office did not take the OS user: $(field .reason "$ADMIN_BODY")$(field .message "$ADMIN_BODY")"
}

# In the container: ids above every recorded one, the home and the share on
# the data volume through the helper, and the member's restart loop in place
# of the unit.
enable_container() {
  local user_id=$1 os_user=$2 id
  id=$(helper next-id) || fail "cannot choose a uid for $os_user"
  [[ $id =~ ^[0-9]+$ ]] || fail "cannot choose a uid for $os_user"
  groupadd -g "$id" "$os_user" || fail "could not make the group $os_user"
  UNDO+=("groupdel $(printf '%q' "$os_user") 2>/dev/null || true")
  useradd -M -u "$id" -g "$id" -d "$CONTAINER_HOMES/$os_user" -s /bin/bash "$os_user" ||
    fail "could not make the OS user $os_user"
  UNDO+=("userdel $(printf '%q' "$os_user")")
  helper add "$os_user" "$id" "$id" "$user_id" || fail "cannot record $os_user"
  UNDO+=("helper delete $(printf '%q' "$os_user") $(printf '%q' "$user_id")")
  prepare "$user_id" "$os_user" "$id"
  UNDO+=("helper stop $(printf '%q' "$os_user")")
  helper start "$os_user" || fail "cannot start the runner of $os_user"
  MEMBER_UID=$id
}

enable_systemd() {
  local user_id=$1 os_user=$2
  useradd --create-home --user-group --shell /bin/bash "$os_user" ||
    fail "could not make the OS user $os_user"
  UNDO+=("userdel --remove $(printf '%q' "$os_user")")
  local uid gid home
  uid=$(id -u "$os_user") && gid=$(id -g "$os_user") ||
    fail "cannot look up $os_user"
  home=$(getent passwd "$os_user" | cut -d: -f6)
  chmod 700 "$home" || fail "cannot close $home"
  install -d -m 755 "$ETC_DIR" || fail "cannot make $ETC_DIR"
  # The mark that this command made the user (disable --delete-user).
  printf '%s\n' "$user_id" >"$ETC_DIR/$os_user.made" &&
    chmod 600 "$ETC_DIR/$os_user.made" || fail "cannot write $ETC_DIR/$os_user.made"
  UNDO+=("rm -f $(printf '%q' "$ETC_DIR/$os_user.made")")

  # The share: under a root-only parent, the office's, the member's group.
  if [[ ! -e $SHARE_ROOT ]]; then
    install -d -o root -g root -m 755 "$SHARE_ROOT" || fail "cannot make $SHARE_ROOT"
  fi
  root_only_dir "$SHARE_ROOT" ||
    fail "$SHARE_ROOT must be a folder that only root can change"
  local share=$SHARE_ROOT/$os_user
  [[ ! -e $share && ! -L $share ]] || fail "$share exists"
  install -d -o "$SERVICE_USER" -g "$gid" -m 2750 "$share" || fail "cannot make $share"
  UNDO+=("rm -rf --one-file-system $(printf '%q' "$share")")

  prepare "$user_id" "$os_user" "$uid"

  printf 'ISOMUX_OFFICE_UID=%s\n' "$OFFICE_UID" >"$ETC_DIR/$os_user.env" &&
    chmod 644 "$ETC_DIR/$os_user.env" || fail "cannot write $ETC_DIR/$os_user.env"
  UNDO+=("rm -f $(printf '%q' "$ETC_DIR/$os_user.env")")
  loginctl enable-linger "$os_user" || fail "cannot enable the linger of $os_user"
  UNDO+=("loginctl disable-linger $(printf '%q' "$os_user")")
  # Undone in reverse: the unit stops first (Restart=always), then what is
  # left of the user's processes, then userdel.
  UNDO+=("pkill -KILL -u $(printf '%q' "$os_user") || true")
  # enable links the unit before it starts it: a failed start leaves a link.
  UNDO+=("systemctl disable --now $(printf '%q' "$UNIT@$os_user.service")")
  systemctl enable --now "$UNIT@$os_user.service" || fail "cannot start $UNIT@$os_user"
  MEMBER_UID=$uid
}

disable() {
  local member=$1 delete_user=$2 keep_files=$3 info user_id os_user answer
  admin info "$(jq -n --arg m "$member" '{member: $m}')"
  info=$ADMIN_BODY
  [[ $ADMIN_STATUS == 200 ]] || die "$(field .message "$info")"
  user_id=$(field .userId "$info")
  os_user=$(field .osUser.name "$info")
  [[ -n $os_user ]] || die "$member has no OS user of their own."
  [[ $os_user =~ $NAME_RE ]] || die "$os_user is not a user name."
  if [[ -n $delete_user ]]; then
    made_by_command "$os_user" "$user_id" ||
      die "this command did not make $os_user, so it does not delete it; run disable without --delete-user."
  fi
  # The office moves the member's files back and stops using their host
  # first. With --keep-files it only stops using the host.
  admin disable "$(jq -n --arg m "$user_id" --arg k "$keep_files" \
    '{member: $m} + (if $k == "1" then {keepFiles: true} else {} end)')"
  answer=$ADMIN_BODY
  [[ $ADMIN_STATUS == 200 ]] || die "the office refused: $(field .message "$answer")"
  [[ $(field .ok "$answer") == true ]] ||
    die "the office could not move the files back: $(field .reason "$answer")"
  if [[ $(field .movedHomeRemoved "$answer") == true ]]; then
    echo "The home of $member that came with the office move is deleted."
    getent passwd "$os_user" >/dev/null || {
      echo "$member runs as the office's user again."
      return 0
    }
  elif [[ -n $keep_files ]]; then
    echo "The files of $member stay in the home of $os_user: copy what you need as root before --delete-user deletes them."
  fi
  if [[ -n $IN_CONTAINER ]]; then
    disable_container "$member" "$user_id" "$os_user" "$delete_user"
  else
    disable_systemd "$member" "$os_user" "$delete_user"
  fi
}

made_by_command() {
  local os_user=$1 user_id=$2
  if [[ -n $IN_CONTAINER ]]; then
    helper check-made "$os_user" "$user_id"
  else
    [[ $(cat "$ETC_DIR/$os_user.made" 2>/dev/null) == "$user_id" ]]
  fi
}

# In the container the record stays, locked, unless the user is deleted: a
# uid that owns files on the volume never goes to another member.
disable_container() {
  local member=$1 user_id=$2 os_user=$3 delete_user=$4
  helper stop "$os_user" || echo "isomux-member-user: some processes of $os_user are still running" >&2
  if command -v crontab >/dev/null; then crontab -r -u "$os_user" 2>/dev/null || true; fi
  if [[ -n $delete_user ]]; then
    helper delete "$os_user" "$user_id" || die "cannot delete the home and the share of $os_user"
    userdel "$os_user"
    groupdel "$os_user" 2>/dev/null || true
    echo "$member runs as the office's user again; $os_user is deleted."
  else
    helper lock "$os_user" || die "cannot lock the record of $os_user"
    usermod --lock --expiredate 1 "$os_user"
    echo "$member runs as the office's user again; $os_user is locked."
  fi
}

disable_systemd() {
  local member=$1 os_user=$2 delete_user=$3
  systemctl disable --now "$UNIT@$os_user.service" 2>/dev/null || true
  loginctl terminate-user "$os_user" 2>/dev/null || true
  loginctl disable-linger "$os_user" 2>/dev/null || true
  local tries=0
  while pgrep -u "$os_user" >/dev/null && ((tries++ < 20)); do
    pkill -KILL -u "$os_user" || true
    sleep 0.25
  done
  ! pgrep -u "$os_user" >/dev/null || echo "isomux-member-user: some processes of $os_user are still running" >&2
  crontab -r -u "$os_user" 2>/dev/null || true
  if command -v atq >/dev/null; then
    local job
    for job in $(atq 2>/dev/null | awk -v u="$os_user" '$NF == u {print $1}'); do
      atrm "$job" || true
    done
  fi
  rm -rf --one-file-system "${SHARE_ROOT:?}/$os_user"
  rm -f "$ETC_DIR/$os_user.env"
  if [[ -n $delete_user ]]; then
    userdel --remove "$os_user"
    rm -f "$ETC_DIR/$os_user.made"
    echo "$member runs as the office's user again; $os_user is deleted."
  else
    usermod --lock --expiredate 1 "$os_user"
    echo "$member runs as the office's user again; $os_user is locked."
  fi
}

main() {
  [[ $# -ge 2 ]] || usage
  [[ $(id -u) == 0 ]] || die "run this as root."
  local command=$1 member=$2 os_user= delete_user= keep_files=
  shift 2
  while [[ $# -gt 0 ]]; do
    case $command:$1 in
      enable:--user)
        [[ $# -ge 2 ]] || usage
        os_user=$2
        shift 2
        ;;
      disable:--delete-user)
        delete_user=1
        shift
        ;;
      disable:--keep-files)
        keep_files=1
        shift
        ;;
      *) usage ;;
    esac
  done
  read_conf
  case $command in
    enable) enable "$member" "$os_user" ;;
    disable) disable "$member" "$delete_user" "$keep_files" ;;
    *) usage ;;
  esac
}

main "$@"
