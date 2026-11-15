#!/usr/bin/env bash
# isomux-member-user - run one member's agents as their own OS user
# (internal-docs/member-os-user-design.md, section 2). Installed root-owned
# as /usr/local/sbin/isomux-member-user by deploy/install.sh. Root acts only
# on the account and on new places it makes; the office does the rest over
# admin.sock (server/member-user-admin.ts). It reads its settings from
# /etc/isomux/update.conf without sourcing it. Every external command is
# called by name through PATH. ISOMUX_MEMBER_USER_CONF,
# ISOMUX_MEMBER_USER_SHARE_ROOT, ISOMUX_MEMBER_USER_ETC and
# ISOMUX_MEMBER_USER_SYSTEMD_DIR override the paths for tests.
#
#   isomux-member-user enable <member> [--user <osuser>]
#   isomux-member-user disable <member> [--delete-user]
set -euo pipefail

CONF=${ISOMUX_MEMBER_USER_CONF:-/etc/isomux/update.conf}
SHARE_ROOT=${ISOMUX_MEMBER_USER_SHARE_ROOT:-/var/lib/isomux-share}
ETC_DIR=${ISOMUX_MEMBER_USER_ETC:-/etc/isomux/member-runner}
SYSTEMD_DIR=${ISOMUX_MEMBER_USER_SYSTEMD_DIR:-/run/systemd/system}
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
  disable <member> [--delete-user]    run them as the office's user again
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
  ADMIN_SOCK=$STATE_ROOT/admin.sock
  OFFICE_UID=$(id -u "$SERVICE_USER") || die "no such user: $SERVICE_USER"
}

# POST one verb to the office: the answer in ADMIN_BODY and its HTTP status
# in ADMIN_STATUS (globals: a command substitution would lose them). Dies
# when the office does not answer.
ADMIN_STATUS= ADMIN_BODY=
admin() {
  local verb=$1 body=$2 out
  [[ -S $ADMIN_SOCK ]] || die "$ADMIN_SOCK is missing; is the office running?"
  out=$(curl -sS --max-time 120 --unix-socket "$ADMIN_SOCK" -X POST \
    -H 'Content-Type: application/json' --data "$body" \
    -w '\n%{http_code}' "http://localhost/admin/member-user/$verb") ||
    die "the office did not answer $verb"
  ADMIN_STATUS=${out##*$'\n'}
  ADMIN_BODY=${out%$'\n'*}
}

# The field of a JSON answer, or "" (jq -r prints null as "null").
field() { jq -r "$1 // empty" <<<"$2"; }

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
# signal) undoes them.
on_exit() {
  local status=$?
  if ((${#UNDO[@]})); then
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

enable() {
  local member=$1 os_user=$2 info role user_id slug current answer
  [[ -d $SYSTEMD_DIR ]] || die "this box does not run systemd."
  admin info "$(jq -n --arg m "$member" '{member: $m}')"
  info=$ADMIN_BODY
  [[ $ADMIN_STATUS == 200 ]] || die "$(field .message "$info")"
  role=$(field .role "$info")
  user_id=$(field .userId "$info")
  slug=$(field .slug "$info")
  current=$(field .osUser.name "$info")
  [[ $role != owner ]] || die "$member is an owner; an owner cannot have their own OS user."
  [[ -z $current ]] || die "$member already runs as $current."
  [[ -n $os_user ]] || os_user=isomux-$slug
  [[ $os_user =~ $NAME_RE ]] || die "$os_user is not a user name."
  # Only a user that this command makes: disable --delete-user removes it.
  ! getent passwd "$os_user" >/dev/null || die "the OS user $os_user exists; choose another with --user."

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

  # The office installs the runtime in the share; root writes no code.
  admin prepare "$(jq -n --arg m "$user_id" --arg u "$os_user" \
    --argjson uid "$uid" '{member: $m, osUser: $u, uid: $uid}')"
  answer=$ADMIN_BODY
  [[ $ADMIN_STATUS == 200 ]] || fail "the office could not prepare the share: $(field .message "$answer")"

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

  cannot_become_root "$os_user" || fail "$os_user can become root (a privileged group or a sudo rule)"

  admin go-on "$(jq -n --arg m "$user_id" --arg u "$os_user" \
    --argjson uid "$uid" '{member: $m, osUser: $u, uid: $uid}')"
  answer=$ADMIN_BODY
  if [[ $ADMIN_STATUS != 200 || $(field .ready "$answer") != true ]]; then
    fail "the office did not take the OS user: $(field .reason "$answer")$(field .message "$answer")"
  fi
  UNDO=()
  echo "$member runs as $os_user."
}

disable() {
  local member=$1 delete_user=$2 info user_id os_user answer
  admin info "$(jq -n --arg m "$member" '{member: $m}')"
  info=$ADMIN_BODY
  [[ $ADMIN_STATUS == 200 ]] || die "$(field .message "$info")"
  user_id=$(field .userId "$info")
  os_user=$(field .osUser.name "$info")
  [[ -n $os_user ]] || die "$member has no OS user of their own."
  [[ $os_user =~ $NAME_RE ]] || die "$os_user is not a user name."
  if [[ -n $delete_user ]]; then
    [[ $(cat "$ETC_DIR/$os_user.made" 2>/dev/null) == "$user_id" ]] ||
      die "this command did not make $os_user, so it does not delete it; run disable without --delete-user."
  fi
  # The office stops using the member's host first.
  admin disable "$(jq -n --arg m "$user_id" '{member: $m}')"
  answer=$ADMIN_BODY
  [[ $ADMIN_STATUS == 200 ]] || die "the office refused: $(field .message "$answer")"
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
  local command=$1 member=$2 os_user= delete_user=
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
      *) usage ;;
    esac
  done
  read_conf
  case $command in
    enable) enable "$member" "$os_user" ;;
    disable) disable "$member" "$delete_user" ;;
    *) usage ;;
  esac
}

main "$@"
