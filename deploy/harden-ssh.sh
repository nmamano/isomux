#!/usr/bin/env bash
# isomux-harden-ssh — SSH hardening for an isomux box, and the check that says
# whether it holds.
#
# Two jobs:
#   apply — key-only SSH auth. Skipped, loudly, on a box that has no SSH key
#           yet: turning off password logins there would lock the operator out.
#   check — can the isomux service account log in as root on this box? Answered
#           by TRYING, as that account, and reading the authentication
#           transcript. Also checks passwordless sudo.
#
# deploy/install.sh installs this at /usr/local/sbin/isomux-harden-ssh and runs
# both jobs during an install. Re-run it by hand after adding an SSH key, or
# any time you want the check again. It also runs straight from a checkout:
#
#   sudo bash deploy/harden-ssh.sh
#
# NOTE FOR MAINTAINERS: this file is embedded verbatim in deploy/install.sh,
# which is fetched on its own by curl | bash and so cannot read repo files. The
# two copies are pinned equal by deploy/install-sh.test.ts — edit here, then
# paste into the heredoc there.
#
# Usage (as root):
#   isomux-harden-ssh            apply, then check
#   isomux-harden-ssh --apply    apply only
#   isomux-harden-ssh --check    check only, change nothing
#   isomux-harden-ssh --help
#
# Exit status:
#    0  passed: the isomux account could not log in as root, and cannot sudo
#    1  failed: it could
#    2  could not tell
#    3  usage or environment error
#   10  --apply only: hardening skipped because the box has no SSH key yet

set -Eeuo pipefail

SERVICE_USER=isomux
SERVICE_HOME=/home/isomux
DROPIN=/etc/ssh/sshd_config.d/90-isomux-hardening.conf
TAG=isomux-harden-ssh

log() { printf '[%s] %s\n' "$TAG" "$*"; }
die() {
  log "ERROR: $*"
  exit 3
}

usage() {
  cat <<EOF
Usage: isomux-harden-ssh [--apply | --check]

  (no option)  apply key-only SSH auth, then check that the $SERVICE_USER
               account cannot log in as root
  --apply      apply only
  --check      check only, change nothing

Exit status: 0 passed, 1 failed, 2 could not tell, 3 usage error.
EOF
}

# Run a command as the service account with a bare environment. env -i is what
# drops SSH_AUTH_SOCK: a forwarded ssh-agent in the caller's environment would
# lend the probe keys the service account does not actually have, and turn a
# real answer into a false alarm.
# LC_ALL=C because the answers below are read out of English message text:
# transcripts, sudo's refusals, bash's own connection errors.
as_service_user() {
  runuser -u "$SERVICE_USER" -- env -i \
    "HOME=$SERVICE_HOME" "USER=$SERVICE_USER" "LOGNAME=$SERVICE_USER" \
    "PATH=/usr/local/bin:/usr/bin:/bin" "TERM=dumb" "LC_ALL=C" "$@"
}

# One effective sshd setting, read from sshd's own resolved config.
sshd_setting() {
  sshd -T 2>/dev/null | awk -v k="$1" '$1 == k { $1 = ""; sub(/^ /, ""); print; exit }' || true
}

# --- apply ------------------------------------------------------------------

apply_hardening() {
  if ! command -v sshd >/dev/null; then
    log "no SSH server is installed on this box; nothing to harden"
    return 0
  fi
  # Refuse to turn off password logins when no key can get back in. Assumption:
  # any non-empty authorized_keys under /root or /home belongs to an account
  # the operator can log in with — true on a freshly provisioned VPS, where
  # those are the provider-created login accounts.
  local f has_keys=""
  for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
    [[ -s $f ]] && has_keys=1
  done
  if [[ -z $has_keys ]]; then
    log "SSH HARDENING SKIPPED - this box has no SSH key on it yet, and turning"
    log "off password logins now would lock you out. Password logins stay on."
    log ""
    log "Add your key (ssh-copy-id from the machine you connect with, or paste"
    log "it into ~/.ssh/authorized_keys), then run:"
    log ""
    log "    sudo isomux-harden-ssh"
    log ""
    return 10
  fi
  install -d -m 755 "$(dirname "$DROPIN")"
  install -m 644 /dev/null "$DROPIN"
  cat >"$DROPIN" <<'EOF'
# Installed by the isomux VPS installer: key-only SSH auth.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  # The drop-in composes with whatever sshd config the box already has;
  # validate the aggregate before it can take effect, and back out our file if
  # the result is broken.
  if ! sshd -t 2>/dev/null; then
    rm -f "$DROPIN"
    die "sshd rejected the configuration with the hardening drop-in; removed it again. Run sshd -t to inspect the preexisting config."
  fi
  # Ubuntu 24.04 socket-activates ssh; reload only applies if it's running.
  if systemctl is-active -q ssh; then
    systemctl reload ssh
  fi
  log "key-only SSH auth is in place ($DROPIN)"
  return 0
}

# --- check ------------------------------------------------------------------

SSH_STATE=UNKNOWN
SSH_DETAIL=""
SUDO_STATE=UNKNOWN
SUDO_DETAIL=""
PROBE_STATE=""
PROBE_TAIL=""
# Endpoints SSH answers on, and the subset actually tried: one "addr port" per
# line. TRIED is the proof of what the verdict covers.
ENDPOINTS=""
TRIED=""
# Listening ports that neither greeted as SSH within the deadline nor are owned
# by a process named like an SSH server. Reported, not assumed innocent.
UNIDENTIFIED=""
# Set when the endpoint list cannot be trusted to be complete; a partial answer
# is not an answer.
COVERAGE_GAP=""
# A key file the service account can read whose public half root accepts. A
# positive finding on its own, independent of whether the login attempt got in.
KEY_HIT=""
# Readable key files locked with a passphrase: whether root accepts them cannot
# be established here, and "could not check" is not "safe".
KEY_UNPROVEN=""

# Every address a login could arrive on. Two sources, because on Ubuntu 24.04
# ssh is socket-activated and the port then lives in the SOCKET unit, not in
# sshd_config: sshd's own resolved config, and systemd's ssh.socket. A wildcard
# bind expands to the loopback address plus every global address of the box,
# because a Match LocalAddress rule can hand out a different root policy per
# address - which is also why each one is tried separately instead of trusting
# a single global reading of the config.
local_addresses() {
  command -v ip >/dev/null || return 1
  ip "$1" -o addr show scope global 2>/dev/null |
    awk '{ sub(/\/.*/, "", $4); print $4 }' | sort -u
}

emit_endpoints() {
  local addr=$1 port=$2 a
  case $addr in
    0.0.0.0 | '*')
      printf '127.0.0.1 %s\n' "$port"
      while read -r a; do printf '%s %s\n' "$a" "$port"; done < <(local_addresses -4)
      ;;
    ::)
      printf '::1 %s\n' "$port"
      while read -r a; do printf '%s %s\n' "$a" "$port"; done < <(local_addresses -6)
      ;;
    *) printf '%s %s\n' "$addr" "$port" ;;
  esac
}

# Whether this bash can open network connections at all, told apart from a
# refused connection by the error text: without it the banner sniff below would
# quietly find nothing and report a clean box.
dev_tcp_supported() {
  local out
  out=$(as_service_user timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/1' 2>&1) || true
  [[ $out != *"No such file or directory"* ]]
}

# Does something answer here with an SSH banner?
speaks_ssh() {
  local addr=$1 port=$2 out
  # The protocol allows a server to send other lines BEFORE its SSH-2.0-...
  # identification string, so this reads lines until one starts with SSH-
  # rather than judging the first four bytes. Bounded by lines and by time; a
  # port that stays quiet costs the deadline, which is why the port is also
  # judged by who owns it.
  out=$(as_service_user timeout 6 bash -c '
    exec 3<>/dev/tcp/"$1"/"$2" || exit 1
    n=0
    while IFS= read -r -t 5 line <&3; do
      case $line in
        SSH-*)
          printf SSH
          exit 0
          ;;
      esac
      n=$((n + 1))
      [[ $n -ge 20 ]] && exit 1
    done
    exit 1' _ "$addr" "$port" 2>/dev/null) || true
  [[ $out == SSH ]]
}

# Every port on this box that is serving SSH, whoever is serving it. sshd's own
# configuration only describes OpenSSH: a second SSH daemon (dropbear is the
# usual one) alongside a masked sshd would otherwise never be probed at all -
# and "nothing was reachable" is only a safe pass when the list of endpoints is
# complete.
#
# Two independent signals, because neither alone is sound. The banner says what
# a port IS regardless of who serves it, but a server that takes longer than
# the deadline to greet looks the same as a silent non-SSH service. The owning
# process name catches those, but only for daemons named something we
# recognise. Ports that answer to neither are listed in UNIDENTIFIED and said
# out loud in the result: not enough to block an install (an ordinary box has
# several services that never speak first), but not silently dropped either.
add_sniffed_endpoints() {
  if ! command -v ss >/dev/null; then
    COVERAGE_GAP="the list of listening ports could not be read (no ss command), so a second SSH server on this box would not have been noticed"
    return 0
  fi
  if ! dev_tcp_supported; then
    COVERAGE_GAP="this bash cannot open network connections, so a second SSH server on this box would not have been noticed"
    return 0
  fi
  local line sock addr port tmp i=0 idx
  local -a socks=() eps=() owners=()
  while read -r line; do socks+=("$line"); done < <(ss -Hltnp 2>/dev/null | sort -u)
  [[ ${#socks[@]} -gt 0 ]] || return 0
  tmp=$(mktemp -d /tmp/isomux-ssh-sniff.XXXXXXXXXX) || {
    COVERAGE_GAP="the listening ports could not be checked (no writable temporary directory), so a second SSH server on this box would not have been noticed"
    return 0
  }
  # Concurrently, in bounded batches: a port that stays quiet costs the whole
  # deadline, and an ordinary box has a dozen of them. Serially that is minutes
  # of install time for a check that should take seconds.
  for line in "${socks[@]}"; do
    sock=$(awk '{ print $4 }' <<<"$line")
    if [[ $sock =~ ^\[(.+)\]:([0-9]+)$ ]]; then
      addr=${BASH_REMATCH[1]}
      port=${BASH_REMATCH[2]}
    elif [[ $sock =~ ^([^][]+):([0-9]+)$ ]]; then
      addr=${BASH_REMATCH[1]}
      port=${BASH_REMATCH[2]}
    else
      continue
    fi
    # A wildcard bind answers on the loopback address too, and an interface
    # scope (127.0.0.53%lo) is not something to dial.
    case $addr in
      0.0.0.0 | '*') addr=127.0.0.1 ;;
      ::) addr=::1 ;;
    esac
    addr=${addr%%%*}
    eps[i]="$addr $port"
    owners[i]=$line
    (speaks_ssh "$addr" "$port" && : >"$tmp/$i") &
    i=$((i + 1))
    ((i % 16 != 0)) || wait || true
  done
  wait || true
  for idx in "${!eps[@]}"; do
    if [[ -e $tmp/$idx ]]; then
      ENDPOINTS+="${eps[idx]}"$'\n'
    elif [[ ${owners[idx]} =~ \"(sshd|sshd-session|dropbear|tinysshd|opensshd)\" ]]; then
      # Greeted too slowly to be recognised, but owned by a daemon that is one.
      ENDPOINTS+="${eps[idx]}"$'\n'
    else
      UNIDENTIFIED+="${eps[idx]}"$'\n'
    fi
  done
  rm -rf "$tmp"
}

# Fills ENDPOINTS (and COVERAGE_GAP), rather than printing: a pipeline would
# put those assignments in a subshell and lose them.
build_endpoints() {
  local raw line addr port wildcard=""
  raw=$(
    sshd -T 2>/dev/null | awk '$1 == "listenaddress" { print $2 }'
    # Socket units, not just ssh.socket: on Ubuntu 24.04 ssh is socket-activated
    # and the port lives in the SOCKET unit rather than sshd_config, and a
    # second daemon brings its own unit.
    systemctl list-unit-files --type=socket --no-legend 2>/dev/null |
      awk '{ print $1 }' | grep -iE 'ssh|dropbear' |
      while read -r unit; do
        systemctl show "$unit" -p Listen --value 2>/dev/null |
          awk '$2 == "(Stream)" { print $1 }'
      done
    # || true, not || raw="": one empty source must not discard the other's
    # output, which is the whole endpoint list on a normal box.
  ) || true
  ENDPOINTS=""
  while read -r line; do
    if [[ $line =~ ^\[(.+)\]:([0-9]+)$ ]]; then
      addr=${BASH_REMATCH[1]}
      port=${BASH_REMATCH[2]}
    elif [[ $line =~ ^([0-9.]+):([0-9]+)$ ]]; then
      addr=${BASH_REMATCH[1]}
      port=${BASH_REMATCH[2]}
    elif [[ $line =~ ^[0-9]+$ ]]; then
      # A bare port in a socket unit means every address, both families.
      wildcard=1
      ENDPOINTS+=$(emit_endpoints 0.0.0.0 "$line")$'\n'
      ENDPOINTS+=$(emit_endpoints :: "$line")$'\n'
      continue
    else
      continue
    fi
    case $addr in
      0.0.0.0 | '*' | ::) wildcard=1 ;;
    esac
    ENDPOINTS+=$(emit_endpoints "$addr" "$port")$'\n'
  done <<<"$raw"
  add_sniffed_endpoints
  ENDPOINTS=$(printf '%s' "$ENDPOINTS" | grep -v '^[[:space:]]*$' | sort -u) || ENDPOINTS=""
  # A wildcard bind covers addresses this script could not enumerate, so an
  # answer would only be about whichever ones it happened to try.
  if [[ -n $wildcard ]] && ! command -v ip >/dev/null; then
    COVERAGE_GAP="SSH is bound to every address on this box, and the list of those addresses could not be read (no ip command)"
  fi
}

# Try to log in as root from the service account, at one endpoint. THE ANSWER
# COMES FROM THE AUTHENTICATION TRANSCRIPT, NEVER FROM ssh's EXIT STATUS: a
# forced command in root's authorized_keys exits non-zero on a perfectly
# successful login, and a client-side config error exits non-zero before
# authentication is even attempted. Reading the exit status would call both of
# those "kept out".
#
# -F /dev/null: the service account's own ~/.ssh/config must not be able to
# decide this. A HostName or ProxyCommand line there could send the probe
# somewhere else entirely and manufacture a refusal. Key files that a config
# would have pointed at are covered separately, by scan_key_files.
#
# Answers in PROBE_STATE and PROBE_TAIL rather than on stdout: a command
# substitution would run this in a subshell and lose the transcript tail that
# makes an inconclusive result diagnosable.
probe_root_ssh() {
  local addr=$1 port=$2 out
  out=$(as_service_user timeout 30 ssh -v -n -T \
    -F /dev/null \
    -o BatchMode=yes \
    -o ConnectTimeout=5 \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -p "$port" "root@$addr" true 2>&1) || true
  PROBE_TAIL=$(printf '%s\n' "$out" | grep -v '^debug' | tail -2 | tr '\n' ' ')
  # Anchored, and success checked first: a server banner is arbitrary text that
  # arrives before authentication finishes, so an unanchored search for
  # "Permission denied" anywhere in the transcript could be fed by the banner.
  if printf '%s\n' "$out" | grep -qE '^(Authenticated to |debug1: Authentication succeeded)'; then
    PROBE_STATE=IN
  elif printf '%s\n' "$out" | grep -qE '^root@[^ ]+: Permission denied[ ,(]'; then
    PROBE_STATE=OUT
  elif printf '%s\n' "$out" | grep -qE '^ssh: connect to host .*: (Connection refused|Connection timed out|No route to host|Network is unreachable)'; then
    # The probe runs as the account under test, from this box: if it cannot
    # open a connection here and now, that account cannot use this endpoint.
    PROBE_STATE=NOREACH
  else
    PROBE_STATE=UNSURE
  fi
}

# Work out where a login could arrive before anything else needs the answer:
# the key scan asks ssh to resolve the account's configuration per endpoint.
# Returns non-zero when there is nothing to probe, having said why.
prepare_endpoints() {
  if ! command -v ssh >/dev/null; then
    SSH_STATE=UNKNOWN
    SSH_DETAIL="the ssh client is not installed, so no login could be attempted (apt-get install openssh-client)"
    return 1
  fi
  if ! command -v sshd >/dev/null; then
    # Not the same as "there is no SSH server": dropbear and friends exist. An
    # absent OpenSSH binary means this check cannot see the configuration, not
    # that there is nothing to log in to.
    SSH_STATE=UNKNOWN
    SSH_DETAIL="no OpenSSH server is installed, so its configuration could not be read; another SSH server on this box would not be ruled out"
    return 1
  fi
  build_endpoints
  if [[ -z $ENDPOINTS ]]; then
    SSH_STATE=UNKNOWN
    SSH_DETAIL="could not work out where SSH listens on this box (sshd -T, ssh.socket and the listening ports all came back empty)"
    return 1
  fi
  return 0
}

check_ssh_root_login() {
  local addr port unsure="" reached=""
  while read -r addr port; do
    [[ -n $addr ]] || continue
    TRIED+="$addr $port"$'\n'
    probe_root_ssh "$addr" "$port"
    case $PROBE_STATE in
      IN)
        SSH_STATE=FAIL
        SSH_DETAIL="the $SERVICE_USER account logged in as root over SSH at $addr port $port"
        return 0
        ;;
      OUT) reached=1 ;;
      NOREACH) ;;
      *)
        unsure=1
        SSH_DETAIL="the login attempt at $addr port $port neither succeeded nor was refused: $PROBE_TAIL"
        ;;
    esac
  done <<<"$ENDPOINTS"
  if [[ -n $unsure ]]; then
    SSH_STATE=UNKNOWN
    return 0
  fi
  if [[ -n $COVERAGE_GAP ]]; then
    SSH_STATE=UNKNOWN
    SSH_DETAIL="$COVERAGE_GAP"
    return 0
  fi
  SSH_STATE=PASS
  if [[ -z $reached ]]; then
    SSH_DETAIL="nothing was accepting SSH connections on this box at the time of the check"
  else
    SSH_DETAIL=""
  fi
}

# The other door to root. `sudo -n true` alone is not enough: a rule such as
# "isomux ALL=(root) NOPASSWD: /bin/bash" refuses `true` and still hands over a
# root shell. So ask sudo what this account may actually run - asked AS ROOT,
# which needs no password to get an answer - and treat any NOPASSWD entry as a
# way in. The outcome is classified rather than reduced to an exit status:
# "could not ask" must never read as "cannot sudo".
check_sudo() {
  if ! command -v sudo >/dev/null; then
    SUDO_STATE=PASS
    SUDO_DETAIL="sudo is not installed on this box"
    return 0
  fi
  local out rc=0
  out=$(LC_ALL=C timeout 15 sudo -n -l -U "$SERVICE_USER" 2>&1) || rc=$?
  if printf '%s\n' "$out" | grep -q 'NOPASSWD'; then
    SUDO_STATE=FAIL
    SUDO_DETAIL="the $SERVICE_USER account can run commands as root with sudo and no password: $(printf '%s\n' "$out" | grep NOPASSWD | tr -s '[:space:]' ' ')"
    return 0
  fi
  # Cross-check by doing it, in case the listed policy and the enforced one
  # disagree.
  if as_service_user timeout 15 sudo -n true >/dev/null 2>&1; then
    SUDO_STATE=FAIL
    SUDO_DETAIL="the $SERVICE_USER account can run commands as root with sudo, without being asked for a password"
    return 0
  fi
  if [[ $rc -eq 0 ]]; then
    # Entries exist, all of them behind a password. Within the promise; the
    # entries themselves are printed as evidence.
    SUDO_STATE=PASS
    SUDO_DETAIL="sudo entries exist for $SERVICE_USER but every one of them asks for a password"
    return 0
  fi
  if printf '%s\n' "$out" | grep -qE 'not allowed to run sudo|may not run sudo|not in the sudoers file|a password is required'; then
    SUDO_STATE=PASS
    SUDO_DETAIL=""
    return 0
  fi
  SUDO_STATE=UNKNOWN
  SUDO_DETAIL="could not establish what $SERVICE_USER may do with sudo: $(printf '%s' "$out" | tail -1)"
}

# --- key files --------------------------------------------------------------
#
# A second, independent way in: a key file the service account can read whose
# public half root accepts. This does not depend on the login attempt getting
# through - a restriction in authorized_keys, or a server that stopped
# accepting new attempts, could hide the same key from the probe - so a match
# here fails the check on its own.

# The files sshd reads root's accepted keys from, with its own placeholders
# resolved (%h is the home directory, %u the user name; a relative path is
# relative to the home directory).
root_authorized_key_files() {
  local raw pattern
  raw=$(sshd_setting authorizedkeysfile)
  [[ -n $raw ]] || raw=".ssh/authorized_keys .ssh/authorized_keys2"
  for pattern in $raw; do
    [[ $pattern != none ]] || continue
    pattern=${pattern//%h//root}
    pattern=${pattern//%u/root}
    [[ $pattern == /* ]] || pattern=/root/$pattern
    printf '%s\n' "$pattern"
  done
}

# Line by line rather than a search through the whole file: a commented-out key
# is not a key root accepts, and since this decides the verdict, matching one
# would block an install over nothing.
root_accepts_key() {
  local blob=$1 file line
  [[ -n $blob ]] || return 1
  while IFS= read -r file; do
    [[ -r $file ]] || continue
    while IFS= read -r line; do
      [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
      [[ $line == *"$blob"* ]] && return 0
    done <"$file"
  done < <(root_authorized_key_files)
  return 1
}

# Key files the service account's own ssh configuration would offer, resolved
# by ssh itself: -G applies Host, Match and Include exactly as a real
# connection would, so there is no second implementation of those rules here.
# The login probe deliberately ignores that configuration (it could otherwise
# manufacture a refusal), which is precisely why the files it names still have
# to be looked at - they can live anywhere, under any name.
#
# Fills CONFIG_IDENTITY_FILES rather than printing, and checks ssh's exit
# status: a malformed config, an unreadable Include or a Match exec that hangs
# would otherwise come back as "this account has no key files" - the same
# false pass this lookup exists to close.
CONFIG_IDENTITY_FILES=""

collect_config_identity_files() {
  local addr port out rc path
  CONFIG_IDENTITY_FILES=""
  [[ -n $ENDPOINTS ]] || return 0
  while read -r addr port; do
    [[ -n $addr ]] || continue
    rc=0
    out=$(as_service_user timeout 10 ssh -G -p "$port" "root@$addr" 2>/dev/null) || rc=$?
    if [[ $rc -ne 0 ]]; then
      COVERAGE_GAP="the $SERVICE_USER account's ssh configuration could not be read (ssh -G exited $rc for $addr port $port), so key files it points at may not have been checked"
      continue
    fi
    while read -r path; do
      [[ -n $path ]] || continue
      [[ $path == '~'* ]] && path="$SERVICE_HOME${path#\~}"
      CONFIG_IDENTITY_FILES+="$path"$'\n'
    done < <(printf '%s\n' "$out" |
      awk '$1 == "identityfile" { $1 = ""; sub(/^ /, ""); print }')
  done <<<"$ENDPOINTS"
  return 0
}

# Key files anywhere the service account might reach: everything in the home
# directories' .ssh folders, plus whatever its ssh configuration points at.
# Candidates are recognised by looking INSIDE the file, because a key can be
# called anything and an id_* pattern misses renamed ones.
candidate_key_files() {
  local dir f
  {
    for dir in /root/.ssh /home/*/.ssh "$SERVICE_HOME/.ssh"; do
      [[ -d $dir ]] || continue
      for f in "$dir"/*; do printf '%s\n' "$f"; done
    done
    printf '%s' "$CONFIG_IDENTITY_FILES"
  } | sort -u | while IFS= read -r f; do
    [[ -f $f ]] || continue
    if head -c 128 "$f" 2>/dev/null | grep -q -- "-----BEGIN .*PRIVATE KEY-----"; then
      printf '%s\n' "$f"
    fi
  done
  return 0
}

KEY_REPORT=""

scan_key_files() {
  local file pub blob
  collect_config_identity_files
  while IFS= read -r file; do
    [[ -n $file ]] || continue
    if ! as_service_user test -r "$file"; then
      KEY_REPORT+="  $file - not readable by $SERVICE_USER"$'\n'
      continue
    fi
    # As the service account, with no terminal and no way to wait for a
    # passphrase: exactly what it could do by itself.
    pub=$(as_service_user timeout 15 ssh-keygen -y -P "" -f "$file" 2>/dev/null </dev/null) || pub=""
    if [[ -z $pub ]]; then
      KEY_UNPROVEN+="  $file"$'\n'
      KEY_REPORT+="  $file - readable by $SERVICE_USER; locked with a passphrase, so whether root accepts it could not be tested"$'\n'
      continue
    fi
    blob=$(printf '%s\n' "$pub" | awk '{print $2}')
    if root_accepts_key "$blob"; then
      KEY_HIT+="  $file"$'\n'
      KEY_REPORT+="  $file - READABLE BY $SERVICE_USER AND ACCEPTED BY ROOT  <== this is the one"$'\n'
    else
      KEY_REPORT+="  $file - readable by $SERVICE_USER, not accepted by root"$'\n'
    fi
  done < <(candidate_key_files)
}

# --- evidence ---------------------------------------------------------------

report_evidence() {
  log ""
  log "What is on this box:"
  local akcmd
  akcmd=$(sshd_setting authorizedkeyscommand)
  if [[ -n $akcmd && $akcmd != none ]]; then
    log "  The keys root accepts can also come from a program ($akcmd), so the"
    log "  list below may be incomplete."
  fi
  local file count
  while IFS= read -r file; do
    if [[ -r $file ]]; then
      count=$(grep -cvE '^[[:space:]]*(#|$)' "$file" 2>/dev/null || true)
      log "  Root accepts the keys listed in $file (${count:-0})"
    else
      log "  Root's key list $file is not present"
    fi
  done < <(root_authorized_key_files)
  if [[ -n $KEY_REPORT ]]; then
    printf '%s' "$KEY_REPORT" | while IFS= read -r file; do log "$file"; done
  else
    log "  No key files found in the home directories on this box"
  fi
  [[ -z $SUDO_DETAIL ]] || log "  sudo: $SUDO_DETAIL"
  report_coverage
  # Recorded because they are useful context, not because they answer the
  # question: an account can be out of the sudo group and still reach root.
  local groups pw
  groups=$(id -nG "$SERVICE_USER" 2>/dev/null | tr ' ' ',') || groups=unknown
  pw=$(passwd -S "$SERVICE_USER" 2>/dev/null | awk '{print $2}') || pw=""
  case $pw in
    L) pw="locked" ;;
    NP) pw="none set" ;;
    P) pw="set" ;;
    *) pw="unknown" ;;
  esac
  log "  The $SERVICE_USER account: groups $groups, password $pw"
}

report_coverage() {
  local list
  if [[ -n $TRIED ]]; then
    list=$(printf '%s' "$TRIED" | awk '{ printf "%s%s port %s", sep, $1, $2; sep = ", " }')
    log "  Login attempted at: $list"
  fi
  if [[ -n $UNIDENTIFIED ]]; then
    list=$(printf '%s' "$UNIDENTIFIED" | sort -u | awk '{ printf "%s%s port %s", sep, $1, $2; sep = ", " }')
    log "  Listening but silent, so not identified: $list"
    log "  (if one of those is an SSH server, it was not tested)"
  fi
}

report_fail() {
  log ""
  log "FAILED - the $SERVICE_USER account can reach root on this box."
  [[ $SSH_STATE != FAIL || -z $SSH_DETAIL ]] || log "  $SSH_DETAIL"
  [[ $SUDO_STATE != FAIL || -z $SUDO_DETAIL ]] || log "  $SUDO_DETAIL"
  log ""
  log "Isomux agents run as the $SERVICE_USER account, so whatever that account"
  log "can do, an agent can do - including turning off every guardrail isomux"
  log "puts in front of them."
  report_evidence
  log ""
  log "How to fix it:"
  if [[ $SSH_STATE == FAIL ]]; then
    log "  Root accepts a key whose file is stored on this box, where the"
    log "  $SERVICE_USER account can read it. That file is what proves you are"
    log "  allowed in, so it belongs on the computer you connect FROM, not on"
    log "  the server."
    log "  1. Back up root's key list:"
    log "       cp /root/.ssh/authorized_keys /root/.ssh/authorized_keys.bak"
    if [[ -n $KEY_HIT ]]; then
      log "  2. Delete the line for the key marked above, keeping the line for"
      log "     the computer you connect from."
    else
      log "  2. Delete the lines for keys whose files live on this box, keeping"
      log "     the line for the computer you connect from."
    fi
    log "  3. Before closing this session, open a second one to confirm you can"
    log "     still get in."
  fi
  if [[ $SUDO_STATE == FAIL ]]; then
    log "  Take the $SERVICE_USER account out of the sudo group"
    log "  (deluser $SERVICE_USER sudo) and remove any rule in /etc/sudoers.d"
    log "  that lets it run commands as root without a password."
  fi
  log "  Then run: sudo isomux-harden-ssh"
}

report_unknown() {
  log ""
  log "COULD NOT TELL whether the $SERVICE_USER account can reach root."
  [[ $SSH_STATE != UNKNOWN || -z $SSH_DETAIL ]] || log "  $SSH_DETAIL"
  [[ $SUDO_STATE != UNKNOWN || -z $SUDO_DETAIL ]] || log "  $SUDO_DETAIL"
  report_evidence
  log ""
  log "This is treated as a failure: a box is not hardened just because the"
  log "check could not run. Fix the reason above and run:"
  log "  sudo isomux-harden-ssh --check"
  log "To see it by hand, from this box:"
  log "  runuser -u $SERVICE_USER -- env -i PATH=/usr/bin ssh -v root@localhost true"
}

report_pass() {
  if [[ -z $KEY_UNPROVEN && -z $UNIDENTIFIED ]]; then
    log "PASSED - the isomux service account cannot log in as root over SSH"
    log "on this box, and cannot sudo."
  else
    # Softened deliberately. With a key this check could not open, or a port
    # that never identified itself, "cannot log in" would contradict the caveat
    # printed right below it.
    log "PASSED - no way in was found: the isomux service account could not"
    log "log in as root over SSH on this box, and cannot sudo."
  fi
  [[ -z $SSH_DETAIL ]] || log "  ($SSH_DETAIL)"
  report_coverage
  if [[ -n $KEY_UNPROVEN ]]; then
    log ""
    log "One limit worth knowing: the $SERVICE_USER account can read these key"
    log "files, but they are locked with a password, so the check could not"
    log "try them against root:"
    printf '%s' "$KEY_UNPROVEN" | while IFS= read -r file; do log "$file"; done
    log "A locked key only stays harmless while its password is nowhere on"
    log "this box (not in a script, a note, or shell history). If it is, or"
    log "if you are unsure, move the key file off the box."
  fi
  log "Checked now, on this box. Adding a key later can undo it - re-run this"
  log "command whenever root's key list changes."
}

run_check() {
  log "Checking that the $SERVICE_USER account - the one agents run as - cannot"
  log "take admin (root) control of this box. It is not supposed to."
  log ""
  # Every probe below runs THROUGH runuser as the service account. If that
  # plumbing is broken, each one comes back "kept out" for the wrong reason and
  # the box passes without having been tested. Prove it works first.
  local want uid
  want=$(id -u "$SERVICE_USER" 2>/dev/null) || want=""
  uid=$(as_service_user id -u 2>/dev/null) || uid=""
  if [[ -z $want || $uid != "$want" ]]; then
    SSH_STATE=UNKNOWN
    SUDO_STATE=UNKNOWN
    SSH_DETAIL="could not run a command as the $SERVICE_USER account, so nothing was actually tested"
    SUDO_DETAIL=""
    report_unknown
    return 2
  fi
  local can_probe=1
  prepare_endpoints || can_probe=""
  scan_key_files
  [[ -z $can_probe ]] || check_ssh_root_login
  check_sudo
  if [[ -n $KEY_HIT && $SSH_STATE != FAIL ]]; then
    # The login attempt did not get in, but root accepts a key this account can
    # read. Restrictions in authorized_keys or a server that stopped taking new
    # attempts can hide that from a login attempt; the key itself cannot be
    # explained away.
    SSH_STATE=FAIL
    SSH_DETAIL="root accepts a key whose file the $SERVICE_USER account can read"
  fi
  if [[ $SSH_STATE == FAIL || $SUDO_STATE == FAIL ]]; then
    report_fail
    return 1
  fi
  if [[ $SSH_STATE == UNKNOWN || $SUDO_STATE == UNKNOWN ]]; then
    report_unknown
    return 2
  fi
  report_pass
  return 0
}

# --- main -------------------------------------------------------------------

main() {
  local mode=both
  case ${1:-} in
    "") mode=both ;;
    --apply) mode=apply ;;
    --check) mode=check ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 3
      ;;
  esac
  [[ $EUID -eq 0 ]] || die "must run as root (try: sudo isomux-harden-ssh)"
  local rc=0
  if [[ $mode != check ]]; then
    apply_hardening || rc=$?
    [[ $rc -eq 0 || $rc -eq 10 ]] || exit "$rc"
    [[ $mode != apply ]] || exit "$rc"
  fi
  id -u "$SERVICE_USER" >/dev/null 2>&1 || {
    log "the $SERVICE_USER account does not exist on this box yet, so there is nothing to check"
    exit 2
  }
  SERVICE_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
  rc=0
  run_check || rc=$?
  exit "$rc"
}

main "$@"
