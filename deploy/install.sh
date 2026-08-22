#!/usr/bin/env bash
# Unattended isomux VPS installer.
#
# Turns a fresh Ubuntu 24.04 server into an HTTPS-served isomux instance:
# bun + isomux (systemd service) + Caddy with automatic Let's Encrypt +
# a headless browser for the agents' page-preview cards +
# a working bubblewrap sandbox for codex agents +
# firewall/SSH hardening + out-of-memory protection + unattended security
# updates (a standard Ubuntu feature - it patches system packages, never
# isomux itself). Ends by claiming the office owner, minting a single-use
# owner invite link, saving it to /var/lib/isomux-install/invite-url,
# printing it if a terminal is watching (naming that file instead if not),
# and optionally POSTing it to a callback URL.
#
# Two checks can stop the install outright. Both ask the same question - can
# the isomux service account become root on this box? - and both answer it by
# trying, as that account. An install that cannot answer it stops too: a box
# is not hardened just because the check could not run. See harden_ssh below
# and deploy/harden-ssh.sh.
#
# Usage (as root):
#
#   DOMAIN=office.example.com bash install.sh
#
# or as cloud-init user-data:
#
#   #!/bin/bash
#   set -e
#   installer=$(mktemp)
#   trap 'rm -f "$installer"' EXIT
#   curl -fsSL https://raw.githubusercontent.com/nmamano/isomux/main/deploy/install.sh -o "$installer"
#   DOMAIN=office.example.com bash "$installer"
#
# Parameters (environment variables):
#   DOMAIN        (required) public domain for the office; its A record must
#                 point at this server for the HTTPS certificate to issue.
#   OWNER_NAME    display name of the office owner (default "Owner";
#                 changeable later in User Settings).
#   ISOMUX_REF    git branch, tag, or commit to install. Default: the latest
#                 GitHub release of the official repo; main when none exists
#                 or the repo is a fork.
#   ISOMUX_REPO   git repo to install from (default the official GitHub repo).
#   SSH_PORT      SSH port to allow through the firewall (default 22; set to
#                 "none" to keep SSH closed).
#   INSTALL_CALLBACK_URL  if set, the installer POSTs JSON
#                 {inviteUrl, status[, step]} here on success and on failure.
#   DRY_RUN       set to 1 to print state-changing commands instead of
#                 running them.
#   ISOMUX_DEPS_ONLY  set to 1 to install only the system dependencies (apt
#                 packages, Node.js, the headless browser, the codex
#                 sandbox's bubblewrap) and exit, leaving
#                 the office, the service and the box's configuration alone.
#                 DOMAIN is not needed. scripts/update.sh runs the TARGET
#                 release's installer this way, so an update can deliver
#                 system dependencies the release newly requires (see
#                 deps_only below).
#
# Re-running after a failure is safe: every step is idempotent, and the
# owner-claim step recovers its session from disk or from the isomux admin
# socket. A re-run restarts the isomux service, which interrupts any
# running agents.

set -Eeuo pipefail

# --- Parameters -------------------------------------------------------------

DOMAIN="${DOMAIN:-}"
OWNER_NAME="${OWNER_NAME:-Owner}"
ISOMUX_REF="${ISOMUX_REF:-}"
ISOMUX_REPO="${ISOMUX_REPO:-https://github.com/nmamano/isomux.git}"
SSH_PORT="${SSH_PORT:-22}"
INSTALL_CALLBACK_URL="${INSTALL_CALLBACK_URL:-}"
DRY_RUN="${DRY_RUN:-}"
ISOMUX_DEPS_ONLY="${ISOMUX_DEPS_ONLY:-}"

# Protocol marker for scripts/update.sh: the exact assignment below is what the
# updater greps for before it runs this file as root with ISOMUX_DEPS_ONLY=1.
# A release that lacks it gets its dependency sync skipped, which is the safe
# outcome - running an older installer that ignores the flag would run a FULL
# install on a live box. Bump only if the mode's contract changes.
# shellcheck disable=SC2034 # declared for scripts/update.sh to find, not used here
ISOMUX_INSTALL_DEPS_MODE_VERSION=1

# --- Constants --------------------------------------------------------------

INSTALL_DIR=/opt/isomux
SERVICE_USER=isomux
SERVICE_HOME=/home/isomux
STATE_DIR=/var/lib/isomux-install
UPDATER_PATH=/usr/local/sbin/isomux-update
HARDEN_TOOL=/usr/local/sbin/isomux-harden-ssh
OOM_TOOL=/usr/local/sbin/isomux-oom-protect
UPDATE_CONF=/etc/isomux/update.conf
UPDATE_STATE_DIR=/var/lib/isomux-update
COOKIE_JAR=$STATE_DIR/session.cookies
INVITE_FILE=$STATE_DIR/invite-url
CHROME_PATH=/usr/bin/google-chrome
CHROME_DEB_URL=https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
# The AppArmor profile that lets codex's bubblewrap sandbox start on a box
# where unprivileged user namespaces are restricted (see configure_codex_sandbox).
BWRAP_PROFILE_NAME=bwrap-userns-restrict
BWRAP_PROFILE=/etc/apparmor.d/$BWRAP_PROFILE_NAME
BWRAP_PROFILE_DISABLED=/etc/apparmor.d/disable/$BWRAP_PROFILE_NAME
BWRAP_PROFILE_PACKAGED=/usr/share/apparmor/extra-profiles/$BWRAP_PROFILE_NAME
USERNS_RESTRICT_SYSCTL=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
BASE_URL=http://127.0.0.1:4000
ADMIN_SOCK=$SERVICE_HOME/.isomux/admin.sock
HEALTH_TIMEOUT_S=180
# Where the isomux service is told how to reach the service account's systemd
# user manager - the transport the app supervisor runs agents' apps on. A
# drop-in rather than lines in the unit itself; see configure_user_manager.
USER_MANAGER_DROPIN=/etc/systemd/system/isomux.service.d/10-user-manager.conf
USER_MANAGER_TIMEOUT_S=15
CADDY_MARKER="# Managed by the isomux installer"
# Where dpkg keeps package config files. A constant because apt_install scans
# it to report the operator's files it kept, and the tests point that scan at a
# temp tree instead.
CONFFILE_ROOT=/etc

CURRENT_STEP=preflight
INVITE_URL=""
# Set while caddy is temporarily masked around the package operation, so the
# failure path can guarantee the unmask and a re-run starts clean.
CADDY_MASKED=""
# Display name of the owner the minted invite signs in as. Set from the live
# session in mint_invite; OWNER_NAME is only the name used at claim time.
RESOLVED_OWNER_NAME=""
# Set when harden_ssh had to leave password logins on because the box had no
# SSH key yet, so the final report can say so again.
SSH_HARDENING_SKIPPED=""

# --- Helpers ----------------------------------------------------------------

log() { printf '[isomux-install] %s\n' "$*"; }

# True when stdout is a terminal - the closest this script can get to asking
# whether anyone is reading the run as it goes, rather than a file, a pipe or
# an agent's transcript collecting it. The owner invite is a credential, so the
# final report prints the link itself only then and names the file it was saved
# to otherwise: cloud-init, `| tee install.log` and an agent running this over
# ssh all end up with the output on disk, where a live invite has no business
# being.
output_is_watched() { [[ -t 1 ]]; }

step() {
  CURRENT_STEP=$1
  log "--- step: $1"
}

# One-shot failure reporting. The sentinel is a file rather than a variable
# because a failure inside a $(...) substitution fires the inherited ERR trap
# in the subshell first and the parent's ERR trap right after; a variable set
# in the subshell would not stop the parent from reporting twice. mktemp
# (atomic, random name, caller-owned) rather than a predictable path: /tmp is
# world-writable, and truncating a guessable pathname as root would follow a
# planted symlink. Created before the trap is installed so subshells inherit
# the path; "reported" content, not existence, is the marker (mktemp creates
# the file empty). If mktemp fails the guard degrades to possible duplicate
# reports, never to an unset-variable error. jq-free on purpose: this can
# fire at preflight, before jq is installed (step names are fixed
# identifiers, safe to interpolate into JSON).
FAILURE_SENTINEL=$(mktemp /tmp/isomux-install-failure.XXXXXXXXXX) || FAILURE_SENTINEL=""

# Caddy's active/enabled state as deps_only found it, and the restore that puts
# it back. THE INVARIANT: a dependency sync leaves the proxy exactly as it found
# it. Both halves of that matter, and in both directions:
#   - install_packages stops, disables and masks caddy whenever it cannot verify
#     a claimed office, and only a FULL install has a configure_caddy afterwards
#     to bring it back. Without a restore here, an update could take a live
#     office off its public URL for good.
#   - on a box where the claim check passes, install_packages leaves caddy alone
#     and apt is free to install or upgrade it; a maintainer script may then
#     start or enable a proxy the operator had deliberately turned off. So the
#     restore has to stop/disable as readily as it starts/enables.
# Restoring exactly what was there can only leave the box as exposed as it
# already was, so it cannot reopen the unclaimed-office window the masking
# closes. Callers own the message: this returns nonzero and says nothing.
CADDY_PRIOR_UNIT=""
CADDY_PRIOR_ACTIVE=""
CADDY_PRIOR_ENABLED=""
CADDY_SNAPSHOT_ARMED=""

caddy_unit_present() { systemctl cat caddy >/dev/null 2>&1; }

# Unit presence is part of the snapshot, not a reason to skip it: the
# dependency step INSTALLS caddy, so a box whose package was purged (while the
# managed Caddyfile and a claimed office remain, which is what keeps
# install_packages from masking) would otherwise come out of a sync with a
# started, enabled proxy it did not have before.
snapshot_caddy_state() {
  CADDY_PRIOR_UNIT=""
  CADDY_PRIOR_ACTIVE=""
  CADDY_PRIOR_ENABLED=""
  CADDY_SNAPSHOT_ARMED=""
  [[ -z $DRY_RUN ]] || return 0
  if caddy_unit_present; then
    CADDY_PRIOR_UNIT=1
    if systemctl is-active -q caddy 2>/dev/null; then CADDY_PRIOR_ACTIVE=1; fi
    if systemctl is-enabled -q caddy 2>/dev/null; then CADDY_PRIOR_ENABLED=1; fi
  fi
  CADDY_SNAPSHOT_ARMED=1
}

restore_caddy_state() {
  [[ -n $CADDY_SNAPSHOT_ARMED ]] || return 0
  local rc=0
  if ! caddy_unit_present; then
    # No unit before and none now: nothing to put back. A unit that WAS there
    # and is gone cannot be restored, and the caller has to hear about it.
    [[ -z $CADDY_PRIOR_UNIT ]] || return 1
    CADDY_SNAPSHOT_ARMED=""
    return 0
  fi
  # A unit that only exists because this step installed it falls through to the
  # transitions below with both booleans false, so it ends up stopped and
  # disabled. The package stays: it is a declared dependency of the release.
  if [[ -n $CADDY_PRIOR_ENABLED ]]; then
    systemctl enable caddy >/dev/null 2>&1 || rc=1
  else
    systemctl disable caddy >/dev/null 2>&1 || rc=1
  fi
  if [[ -n $CADDY_PRIOR_ACTIVE ]]; then
    systemctl start caddy >/dev/null 2>&1 || rc=1
  else
    systemctl stop caddy >/dev/null 2>&1 || rc=1
  fi
  # Disarm only on success, so the failure path gets one more attempt.
  ((rc == 0)) && CADDY_SNAPSHOT_ARMED=""
  return "$rc"
}

report_failure() {
  if [[ -n $FAILURE_SENTINEL ]]; then
    [[ -s $FAILURE_SENTINEL ]] && return 0
    printf 'reported\n' >"$FAILURE_SENTINEL" 2>/dev/null || true
  fi
  trap - ERR
  log "INSTALL FAILED at step: $CURRENT_STEP"
  log "Re-running the installer with the same parameters is safe; it skips what is already done."
  # Never leave caddy masked behind: a lingering mask would make a later
  # re-run's configure_caddy silently unable to start the proxy.
  if [[ -n $CADDY_MASKED && -z $DRY_RUN ]]; then
    systemctl unmask caddy >/dev/null 2>&1 || true
  fi
  # A full install continues into configure_caddy on the next run, which puts
  # the proxy back. A dependency sync has no such step, so it restores the
  # proxy itself - on this path too, or a failed apt would take an office off
  # its public URL. Best effort here: this path is already reporting a failure.
  restore_caddy_state ||
    log "warning: caddy could not be restored to its previous state; the office's public URL may be down. Check: systemctl status caddy"
  if [[ -n $INSTALL_CALLBACK_URL && -z $DRY_RUN ]]; then
    printf '{"inviteUrl": null, "status": "failed", "step": "%s"}' "$CURRENT_STEP" |
      curl -fsS -X POST "$INSTALL_CALLBACK_URL" -H 'Content-Type: application/json' --data @- \
        >/dev/null 2>&1 || log "warning: failure callback to INSTALL_CALLBACK_URL did not go through"
  fi
}

die() {
  log "ERROR: $*"
  report_failure
  exit 1
}

trap report_failure ERR

# Run a state-changing command, or print it in dry-run mode.
run() {
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: $*"
  else
    "$@"
  fi
}

# apt-get install, with any package config file the operator has edited by hand
# left exactly as they left it.
#
# DEBIAN_FRONTEND=noninteractive does NOT cover this. When a package ships a new
# version of a config file that has local edits, dpkg still stops to ask which
# version to keep; with nothing on stdin the run dies with "end of file on stdin
# at conffile prompt" and takes the install with it. Reproduced on a live box
# with a hand-edited /etc/caddy/Caddyfile: it failed the updater's dependency
# phase, which is the worst place for it, since that is where an operator who
# has been tuning the box for months finally meets the behavior.
#
# --force-confold answers the prompt the only way an unattended run safely can:
# keep what is on the box. The cost is that the kept file can now lag the
# package's default, so kept files are named in the output rather than kept
# quietly. Reconciling them is the operator's call; nothing here will do it.
apt_install() {
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: apt-get install -y -o Dpkg::Options::=--force-confold $*"
    return 0
  fi
  local before rc=0
  before=$(mktemp /tmp/isomux-conffile.XXXXXXXXXX) || before=""
  [[ -z $before ]] || conffile_markers >"$before"
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    -o Dpkg::Options::=--force-confold "$@" || rc=$?
  if [[ -n $before ]]; then
    report_kept_conffiles "$before"
    rm -f "$before"
  fi
  return "$rc"
}

# Every .dpkg-dist marker under $root, with the identity fields that change when
# dpkg writes a fresh one: inode, mtime, size. dpkg's marker is its own record
# of the decision - when it keeps the operator's file it parks the package's
# version next to it as <file>.dpkg-dist - which makes this independent of apt's
# wording and of the locale it prints in.
#
# What it deliberately does NOT do is ask whether a marker is newer than the
# start of this run. dpkg unpacks the packaged conffile with the timestamp it
# carries inside the .deb and then renames that file into place, so a marker
# written seconds ago routinely holds a date from years ago: verified against
# real dpkg, a 2020 archive member produced a 2020-dated .dpkg-dist while the
# run itself was in 2026. A "newer than when we started" test would miss every
# real package.
conffile_markers() {
  find "${1:-$CONFFILE_ROOT}" -name '*.dpkg-dist' \
    -printf '%p\t%i\t%T@\t%s\n' 2>/dev/null | LC_ALL=C sort
}

# Name the config files dpkg kept during the apt run, by what changed against
# the marker snapshot $before. A marker this run wrote is a different file from
# the one that was there (dpkg renames a freshly unpacked file into place, so
# the inode is new), which also catches a package overwriting a marker an
# earlier run had left behind - path existence alone could not tell those apart.
report_kept_conffiles() {
  local before=$1 root=${2:-$CONFFILE_ROOT} line path
  local -a kept=()
  while IFS= read -r line; do
    path=${line%%$'\t'*}
    kept+=("${path%.dpkg-dist}")
  done < <(comm -13 "$before" <(conffile_markers "$root"))
  ((${#kept[@]} > 0)) || return 0
  log "apt shipped a new version of ${#kept[@]} package config file(s) you had edited; your version was kept, so it may now lag the package's default. The packaged version sits next to each one as <file>.dpkg-dist; reconciling them is up to you:"
  for dist in "${kept[@]}"; do log "  $dist"; done
}

# Run a command as the service user. runuser without --login preserves the
# caller's environment, so HOME must be pinned or git/bun would try to use
# /root.
as_service_user() {
  runuser -u "$SERVICE_USER" -- env "HOME=$SERVICE_HOME" "$@"
}

run_as_service_user() {
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN (as $SERVICE_USER): $*"
  else
    as_service_user "$@"
  fi
}

# Write stdin to a file with the given mode, or print intent in dry-run mode.
write_file() {
  local path=$1 mode=$2
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would write $path (mode $mode) with:"
    sed 's/^/    /'
  else
    install -m "$mode" /dev/null "$path"
    cat >"$path"
  fi
}

api_curl() {
  curl -fsS --max-time 15 -b "$COOKIE_JAR" "$@"
}

# Bare DNS hostname: 2+ dot-separated labels of [a-z0-9-], each 1-63 chars,
# not starting/ending with "-", 253 chars total, non-numeric TLD (rejects
# IP addresses). Lowercase-only by design (preflight lowercases first).
valid_domain() {
  local domain=$1 label
  [[ ${#domain} -le 253 ]] || return 1
  [[ $domain == *.* ]] || return 1
  # read -a drops a trailing empty field, so bare-dot edges need their own
  # check.
  [[ $domain != .* && $domain != *. ]] || return 1
  local -a labels
  IFS=. read -ra labels <<<"$domain"
  for label in "${labels[@]}"; do
    [[ ${#label} -ge 1 && ${#label} -le 63 ]] || return 1
    [[ $label =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
  [[ ! ${labels[-1]} =~ ^[0-9]+$ ]] || return 1
}

# The callback carries the invite credential, so plain http is allowed only
# to genuinely local hosts. The host must be exactly "localhost" or a valid
# 127/8 address (first octet exactly 127, the rest 0-255) and end at an
# authority boundary (port, path, query, fragment, or end of string) - a
# prefix match would accept http://localhost.evil.example. Userinfo forms
# (http://x@localhost/) fail the anchored host match.
callback_is_local_http() {
  local url=$1 host port
  [[ $url =~ ^http://(localhost|127(\.[0-9]{1,3}){3})(:([0-9]{1,5}))?([/?#].*)?$ ]] || return 1
  host=${BASH_REMATCH[1]}
  port=${BASH_REMATCH[4]:-80}
  ((10#$port >= 1 && 10#$port <= 65535)) || return 1
  if [[ $host != localhost ]]; then
    local -a octets
    IFS=. read -ra octets <<<"$host"
    local o
    for o in "${octets[@]:1}"; do
      ((10#$o <= 255)) || return 1
    done
  fi
}

# --- Steps ------------------------------------------------------------------

preflight() {
  step preflight
  [[ $EUID -eq 0 ]] || die "this installer must run as root"
  [[ -n $DOMAIN ]] || die "DOMAIN is required (e.g. DOMAIN=office.example.com)"
  DOMAIN=${DOMAIN,,}
  valid_domain "$DOMAIN" || die "DOMAIN does not look like a DNS hostname: $DOMAIN"
  if [[ $SSH_PORT != none ]]; then
    if ! [[ $SSH_PORT =~ ^[0-9]+$ ]] || ((10#$SSH_PORT < 1 || 10#$SSH_PORT > 65535)); then
      die "SSH_PORT must be a port (1-65535) or \"none\": $SSH_PORT"
    fi
  fi
  if [[ -n $INSTALL_CALLBACK_URL && ! $INSTALL_CALLBACK_URL =~ ^https:// ]] && ! callback_is_local_http "$INSTALL_CALLBACK_URL"; then
    die "INSTALL_CALLBACK_URL must be https:// (plain http is allowed only for localhost testing)"
  fi
  # ISOMUX_REPO lands in /etc/isomux/update.conf, which the updater parses
  # as literal key=value (never sourced) - but keep the value to a plain
  # git-URL charset anyway so it can never smuggle options or shell syntax
  # into anything that consumes it.
  [[ $ISOMUX_REPO =~ ^[A-Za-z0-9@:/._+~][A-Za-z0-9@:/._+~-]*$ ]] ||
    die "ISOMUX_REPO is not a plain git URL/path: $ISOMUX_REPO"
  command -v apt-get >/dev/null || die "apt-get not found; this installer supports Ubuntu (24.04)"
  local os_id="" os_ver=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    os_id=$(. /etc/os-release && echo "${ID:-}")
    # shellcheck disable=SC1091
    os_ver=$(. /etc/os-release && echo "${VERSION_ID:-}")
  fi
  if [[ $os_id != ubuntu || $os_ver != 24.04 ]]; then
    log "warning: tested on Ubuntu 24.04, detected ${os_id:-unknown} ${os_ver:-unknown}; continuing"
  fi
  run install -d -m 700 "$STATE_DIR"
}

install_packages() {
  step install-packages
  export DEBIAN_FRONTEND=noninteractive
  # Caddy safety is decided BEFORE any package mutation: apt can start (fresh
  # install) or restart (upgrade) the caddy service, and on a box whose
  # office is not claimed, a leftover reverse proxy would expose the
  # loopback-only claim endpoint to the internet. Only a box that is both
  # configured by this installer AND claimed keeps its proxy running across
  # the re-run; everything else gets caddy stopped AND masked before apt
  # runs - the mask is what closes the window, because the package postinst
  # respects it and cannot start the service mid-install. Unmasked (but
  # still stopped + disabled) right after, and on any failure in between by
  # report_failure; caddy stays down until configure_caddy.
  local caddy_safe=""
  caddy_serving_claimed_office && caddy_safe=1
  if [[ -z $caddy_safe ]]; then
    run systemctl stop caddy 2>/dev/null || true
    run systemctl disable caddy 2>/dev/null || true
    run systemctl mask caddy
    CADDY_MASKED=1
  fi
  run apt-get update -y
  # polkitd: authorizes the in-UI update trigger (see install_updater); present
  # on most Ubuntu images but not guaranteed on minimal ones.
  # build-essential + python3: node-gyp compiles native modules (node-pty)
  # during bun install; fresh server images ship without a toolchain.
  # openssh-client: the root-reachability check logs in to this box to find out
  # whether the service account can; server images ship sshd without the client.
  # ffmpeg: a broadly useful utility for agent workloads, not an isomux runtime
  # dependency.
  apt_install curl ca-certificates gnupg git jq unzip ufw unattended-upgrades polkitd build-essential python3 openssh-client ffmpeg
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would add the Caddy and NodeSource apt repositories and install caddy + nodejs"
  else
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
      gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      >/etc/apt/sources.list.d/caddy-stable.list
    # Node.js from NodeSource: the terminal panel's PTY sidecar needs real
    # Node (node-pty's bindings don't run under bun's node-compat), at
    # /usr/bin/node where the server probes for it. A current version, not
    # Ubuntu 24.04's apt nodejs (v18): once a real node is on PATH, bun's
    # node-pty rebuild runs node-gyp under it, and node-gyp@latest crashes
    # on v18 (observed on the first re-run of the real VPS test box).
    curl -fsSL 'https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key' |
      gpg --batch --yes --dearmor -o /usr/share/keyrings/nodesource.gpg
    echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
      >/etc/apt/sources.list.d/nodesource.list
    apt-get update -y
    apt_install caddy nodejs
  fi
  if [[ -z $caddy_safe ]]; then
    run systemctl unmask caddy
    CADDY_MASKED=""
    run systemctl stop caddy
    run systemctl disable caddy
  fi
}

# True when our Caddyfile is in place and the office has an owner. Only then
# is it safe to leave caddy running during a re-run: with the office still
# unclaimed (e.g. wiped state but leftover Caddyfile), a public proxy to the
# loopback claim endpoint would make ownership claimable from the internet.
caddy_serving_claimed_office() {
  grep -qs "$CADDY_MARKER" /etc/caddy/Caddyfile || return 1
  command -v jq >/dev/null || return 1
  [[ -r $SERVICE_HOME/.isomux/users.json ]] || return 1
  jq -e '[.[] | select(.role == "owner")] | length > 0' \
    "$SERVICE_HOME/.isomux/users.json" >/dev/null 2>&1
}

configure_firewall() {
  step configure-firewall
  run ufw default deny incoming
  run ufw default allow outgoing
  run ufw allow 80/tcp
  run ufw allow 443/tcp
  if [[ $SSH_PORT != none ]]; then
    run ufw allow "$SSH_PORT/tcp"
  else
    log "SSH_PORT=none: not opening an SSH port"
  fi
  run ufw --force enable
  # The deny-default firewall must really be active before the later restart
  # binds isomux on 0.0.0.0:4000, so verify instead of trusting the exit code.
  if [[ -z $DRY_RUN ]]; then
    LC_ALL=C ufw status | grep -q '^Status: active' || die "ufw did not report active after enable"
  fi
}

# The SSH hardening and the check that says whether it holds both live in
# deploy/harden-ssh.sh, installed here as a command the operator can re-run.
# One implementation, three callers: this step, the two gates below, and the
# operator afterwards - the last one is the point. Hardening is skipped on a
# box with no SSH key yet (see the script), and the person who then adds a key
# is not going to remember to re-run a whole installer.
#
# Embedded rather than fetched: this script is downloaded and run on its own,
# so it cannot read repo files, and SSH hardening must not wait
# on a network round trip. deploy/install-sh.test.ts pins the copy equal to
# deploy/harden-ssh.sh.
harden_ssh() {
  step harden-ssh
  write_file "$HARDEN_TOOL" 755 <<'ISOMUX_HARDEN_SSH_SH'
#!/usr/bin/env bash
# isomux-harden-ssh - SSH hardening for an isomux box, and the check that says
# whether it holds.
#
# Two jobs:
#   apply - key-only SSH auth. Skipped, loudly, on a box that has no SSH key
#           yet: turning off password logins there would lock the operator out.
#   check - can the isomux service account log in as root on this box? Answered
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
# which is downloaded and run on its own and so cannot read repo files. The two
# copies are pinned equal by deploy/install-sh.test.ts - edit here, then run
# `bun run scripts/embed-deploy-scripts.ts` to update the copy there.
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
SSHD_CONFIG_D=/etc/ssh/sshd_config.d
# sshd keeps the FIRST value it reads for a keyword and reads the drop-in
# directory in name order, so the hardening file has to sort ahead of whatever
# the provider image shipped. Contabo's cloud-init writes a 50-cloud-init.conf
# that turns password logins back on, and a 90- file loses to it in silence.
DROPIN=$SSHD_CONFIG_D/00-isomux-hardening.conf
# Where the hardening used to live. Removed once the new file is in place and
# proven effective, so a box installed before this converges on a re-run.
LEGACY_DROPIN=$SSHD_CONFIG_D/90-isomux-hardening.conf
# The keys an operator could still get back in with; see apply_hardening.
AUTHORIZED_KEYS_FILES=(/root/.ssh/authorized_keys /home/*/.ssh/authorized_keys)
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

# What the hardening is supposed to achieve, checked against what sshd actually
# resolves. Writing the drop-in proves nothing on its own: an earlier file can
# already have decided the keyword, and that is exactly how the hardening used
# to fail silently. Read from a single sshd -T snapshot, and a value that is
# missing or unreadable counts as a failure, never as a pass.
HARDENING_SHORTFALL=""
hardening_is_effective() {
  local resolved key accepted value entry
  HARDENING_SHORTFALL=""
  if ! resolved=$(sshd -T 2>/dev/null) || [[ -z $resolved ]]; then
    HARDENING_SHORTFALL="sshd would not report its resolved configuration"
    return 1
  fi
  # sshd renders PermitRootLogin prohibit-password as the older
  # without-password on some versions, so both spellings are the same answer.
  for entry in \
    "passwordauthentication no" \
    "kbdinteractiveauthentication no" \
    "permitrootlogin prohibit-password|without-password"; do
    key=${entry%% *}
    accepted=${entry#* }
    value=$(printf '%s\n' "$resolved" |
      awk -v k="$key" '$1 == k { print $2; exit }')
    if [[ -z $value ]]; then
      HARDENING_SHORTFALL+="; sshd does not report $key at all"
    elif [[ "|$accepted|" != *"|$value|"* ]]; then
      HARDENING_SHORTFALL+="; $key is $value, not ${accepted%%|*}"
    fi
  done
  HARDENING_SHORTFALL=${HARDENING_SHORTFALL#; }
  [[ -z $HARDENING_SHORTFALL ]]
}

# Where a previous run's files are held while the candidate is validated. The
# stash lives in $SSHD_CONFIG_D so every move is a rename inside one directory,
# and mktemp's names carry no .conf suffix, so sshd's Include never reads them.
BACKUP_DROPIN=""
BACKUP_LEGACY=""
# Set once the candidate may exist on disk, so a rollback that runs before then
# cannot delete a file this run never replaced.
CANDIDATE_WRITTEN=""

# Move $2 aside, recording where it went in the variable named by $1. Assigns
# in the CURRENT shell on purpose: through a command substitution this would
# run in a subshell, where bash drops errexit, and a failed mv would report a
# stash that does not hold the file. Fails without moving anything if it
# cannot.
stash_existing() {
  local var=$1 file=$2 backup
  printf -v "$var" '%s' ""
  [[ -f $file ]] || return 0
  backup=$(mktemp "$SSHD_CONFIG_D/isomux-hardening-prior.XXXXXXXX") || return 1
  if ! mv "$file" "$backup"; then
    rm -f "$backup"
    return 1
  fi
  printf -v "$var" '%s' "$backup"
}

# Undo a failed apply: the candidate goes, and every file a previous run left
# comes back as it was. A failed attempt must not leave the box less hardened
# than it found it - which includes the case where what it found was this
# script's own working drop-in. Idempotent: each file is forgotten as it is
# restored, so a second call is a no-op.
revert_hardening() {
  [[ -z $CANDIDATE_WRITTEN ]] || rm -f "$DROPIN"
  CANDIDATE_WRITTEN=""
  if [[ -n $BACKUP_DROPIN ]] && mv "$BACKUP_DROPIN" "$DROPIN"; then
    BACKUP_DROPIN=""
  fi
  if [[ -n $BACKUP_LEGACY ]] && mv "$BACKUP_LEGACY" "$LEGACY_DROPIN"; then
    BACKUP_LEGACY=""
  fi
}

apply_hardening() {
  if ! command -v sshd >/dev/null; then
    log "no SSH server is installed on this box; nothing to harden"
    return 0
  fi
  # Refuse to turn off password logins when no key can get back in. Assumption:
  # any non-empty authorized_keys under /root or /home belongs to an account
  # the operator can log in with - true on a freshly provisioned VPS, where
  # those are the provider-created login accounts.
  local f has_keys=""
  for f in "${AUTHORIZED_KEYS_FILES[@]}"; do
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
  install -d -m 755 "$SSHD_CONFIG_D"
  # Both files a previous run could have left go aside BEFORE the candidate is
  # written, and what gets validated below is therefore the exact set of files
  # the box is left with. Writing first would truncate a working drop-in that a
  # failure then has to put back.
  stash_existing BACKUP_DROPIN "$DROPIN" ||
    die "could not move the existing $DROPIN aside, so the hardening was not touched; nothing here changed."
  # Armed the moment the box is without its own hardening file: from here an
  # unexpected command failure has to put the stash back instead of exiting
  # over it. Command failures only - an ERR trap does not run on a signal, and
  # this makes no atomicity promise about one; what a kill leaves behind is a
  # stash file next to the drop-in it came from. The failure paths below revert
  # explicitly and then die, which exits without running this.
  trap 'revert_hardening; die "applying the hardening failed partway; put back what was here and changed nothing else."' ERR
  stash_existing BACKUP_LEGACY "$LEGACY_DROPIN" || {
    revert_hardening
    die "could not move $LEGACY_DROPIN aside; put back what was here and changed nothing else."
  }
  CANDIDATE_WRITTEN=1
  install -m 644 /dev/null "$DROPIN"
  cat >"$DROPIN" <<'EOF'
# Installed by the isomux VPS installer: key-only SSH auth. Named to sort
# first, because sshd keeps the first value it reads for a keyword.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  # The drop-in composes with whatever sshd config the box already has;
  # validate the aggregate before it can take effect, and back out our file if
  # the result is broken.
  if ! sshd -t 2>/dev/null; then
    revert_hardening
    die "sshd rejected the configuration with the hardening drop-in; removed it again. Run sshd -t to inspect the preexisting config."
  fi
  if ! hardening_is_effective; then
    revert_hardening
    die "the hardening did not take effect: $HARDENING_SHORTFALL. Something this box already had sets it first, and sshd keeps the first value it reads - look in /etc/ssh/sshd_config and $SSHD_CONFIG_D. Removed our file again; nothing here changed."
  fi
  trap - ERR
  [[ -z $BACKUP_DROPIN ]] || rm -f "$BACKUP_DROPIN"
  [[ -z $BACKUP_LEGACY ]] || rm -f "$BACKUP_LEGACY"
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
    log "Found key files that the $SERVICE_USER account can read but are"
    log "locked with a password:"
    printf '%s' "$KEY_UNPROVEN" | while IFS= read -r file; do log "$file"; done
    log "If root accepts one of these keys AND an agent gets the password"
    log "somehow, it'll have a way in. The safest option is to move these key"
    log "files off the box."
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
ISOMUX_HARDEN_SSH_SH
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would run $HARDEN_TOOL --apply (key-only SSH auth)"
    return 0
  fi
  local rc=0
  "$HARDEN_TOOL" --apply || rc=$?
  case $rc in
    0) ;;
    10) SSH_HARDENING_SKIPPED=1 ;;
    *) die "SSH hardening failed (see above)" ;;
  esac
}

# First gate, as early as the service account exists: if agents on this box
# could become root, nothing further is worth building. Placed before the long
# fetch/build so the operator finds out in seconds rather than minutes.
check_root_reachability() {
  step check-root-reachability
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would check whether the $SERVICE_USER account can log in as root on this box"
    return 0
  fi
  local rc=0
  "$HARDEN_TOOL" --check || rc=$?
  case $rc in
    0) ;;
    1) die "this box is not safe to run agents on yet (see above); fix it and re-run the installer" ;;
    *) die "could not verify that the $SERVICE_USER account cannot reach root (see above); the install stops rather than claim a box is hardened without having checked" ;;
  esac
}

# Second gate, on the finished box: everything since the first one - package
# installs, the service, the update trigger - could in principle have opened
# the door again. Deliberately BEFORE the owner is claimed, so a box that fails
# here has no owner, no invite link and no success callback: nothing usable
# leaves an install that did not pass.
assert_hardening() {
  step assert-hardening
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would re-check that the $SERVICE_USER account cannot reach root"
    return 0
  fi
  local rc=0
  "$HARDEN_TOOL" --check || rc=$?
  case $rc in
    0) ;;
    1) die "the $SERVICE_USER account can reach root on the finished box (see above); no owner was claimed and no invite was minted" ;;
    *) die "could not verify the finished box (see above); no owner was claimed and no invite was minted" ;;
  esac
}

# Memory-pressure protection: earlyoom, a tiered kill order, and deliberate
# swap settings. Embedded for the same reason as the hardening script, and
# installed as a command so it can be re-run or previewed with --dry-run.
# Non-fatal: an office that survives an OOM spike better is a resilience
# improvement, not a security boundary, and a hiccup here must not abandon an
# otherwise good install.
configure_oom_protection() {
  step configure-oom-protection
  write_file "$OOM_TOOL" 755 <<'ISOMUX_OOM_PROTECT_SH'
#!/usr/bin/env bash
# isomux-oom-protect - keep a memory spike from taking the whole box down.
#
# When an isomux box runs out of memory, the kernel's own last-resort killer
# arrives too late: by then the machine is already swapping so hard that
# nothing responds, including the SSH and VPN daemons you would need to fix it.
# The box looks dead and only a console reboot brings it back.
#
# This sets up the cheap version of the fix:
#   - earlyoom kills ONE process while there is still memory left to act with,
#   - the kill order is tiered so the things that keep the box reachable and
#     usable go last and agent processes go first,
#   - swap is sized not to run out mid-spike, and the kernel is told to prefer
#     dropping file caches over swapping live memory.
#
# Losing one agent is a papercut; losing the box is an outage.
#
# deploy/install.sh installs this at /usr/local/sbin/isomux-oom-protect and
# runs it during an install. It is re-runnable, and runs straight from a
# checkout on a box that was set up before it existed:
#
#   sudo bash deploy/oom-protect.sh --dry-run   # show what would change
#   sudo bash deploy/oom-protect.sh
#
# Nothing here restarts a service other than earlyoom, and the only unit it
# starts is a small re-stamp timer of its own: the new kill order is written to
# the already-running processes directly, so applying it does not interrupt SSH,
# the VPN, or the office.
#
# NOTE FOR MAINTAINERS: this file is embedded verbatim in deploy/install.sh,
# which is downloaded and run on its own and so cannot read repo files. The
# two copies are pinned equal by deploy/install-sh.test.ts - edit here, then
# run `bun run scripts/embed-deploy-scripts.ts` to update the copy there.
#
# Usage (as root):
#   isomux-oom-protect             apply
#   isomux-oom-protect --dry-run   print what it would do, change nothing
#   isomux-oom-protect --restamp   re-apply a user-level office's kill order
#   isomux-oom-protect --help

set -Eeuo pipefail

TAG=isomux-oom-protect
DRY_RUN=""
RESTAMP=""
SWAPFILE=/swapfile
SWAP_SIZE_MIB=8192
SYSCTL_CONF=/etc/sysctl.d/60-isomux-memory.conf
OFFICE_MEMORY_DROPIN=/etc/systemd/system/isomux.service.d/20-memory.conf
MEMINFO_PATH=/proc/meminfo
CGROUP_ROOT=/sys/fs/cgroup
OFFICE_MEMORY_MIN_MIB=4096
OFFICE_MEMORY_RESERVE_MIB=1024
OFFICE_SWAP_MAX_MIB=6144
# Where deploy/install.sh puts this tool, and what the re-stamp timer runs.
OOM_TOOL_PATH=/usr/local/sbin/isomux-oom-protect
RESTAMP_UNIT=isomux-oom-restamp
# How long a restarted office can go unprotected. Short, because the window is
# the whole point of the timer; the run itself is a scan of /proc.
RESTAMP_INTERVAL=1min
# What the office server is tiered at, on either install shape.
OFFICE_SCORE=-500
# How long a unit this tool protects waits before restarting. Paired with the
# StartLimitIntervalSec=0 in the same drop-in: with the rate limit gone, a unit
# that cannot start at all would otherwise retry as fast as the machine allows.
RESTART_BACKOFF=5s
# Where to read and write process state. A seam for deploy/oom-protect.test.ts,
# which points it at a fake tree so the kill-order logic can be tested without
# real pids to race against. Never changed in production.
PROC_ROOT=/proc

log() { printf '[%s] %s\n' "$TAG" "$*"; }
warn() { log "warning: $*"; }

run() {
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: $*"
  else
    "$@"
  fi
}

write_file() {
  local path=$1 mode=$2
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would write $path (mode $mode) with:"
    sed 's/^/    /'
  else
    install -d -m 755 "$(dirname "$path")"
    install -m "$mode" /dev/null "$path"
    cat >"$path"
  fi
}

usage() {
  cat <<EOF
Usage: isomux-oom-protect [--dry-run] [--restamp]

  (no option)  install and configure earlyoom, tier the OOM kill order, set
               swap and swappiness
  --restamp    only re-apply the kill order to a running user-level office,
               and stay quiet when it is already right. This is what the
               $RESTAMP_UNIT timer runs every $RESTAMP_INTERVAL.
  --dry-run    print what would change, change nothing
EOF
}

# --- earlyoom ---------------------------------------------------------------

install_earlyoom() {
  if command -v earlyoom >/dev/null; then
    log "earlyoom already installed"
    return 0
  fi
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would apt-get install -y -o Dpkg::Options::=--force-confold earlyoom"
    return 0
  fi
  # --force-confold for the same reason as the installer's apt_install: a
  # noninteractive frontend does not answer dpkg's conffile prompt, and a run
  # with nothing on stdin dies at it. Keep whatever the operator has; this
  # script drives earlyoom through a drop-in and never reads
  # /etc/default/earlyoom anyway.
  DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::=--force-confold earlyoom >/dev/null 2>&1 || {
    warn "could not install earlyoom (it lives in Ubuntu's universe component). The kill order and swap settings below still apply, but nothing will step in early under memory pressure. Install it later with: apt-get install earlyoom"
    return 1
  }
  log "installed earlyoom"
}

# Thresholds and preferences, as a drop-in rather than /etc/default/earlyoom:
# the packaged command line is replaced outright, so there is exactly one place
# that decides how the daemon runs.
#
# -m 10,5      warn-kill at 10% memory left, force-kill at 5%
# -s 100,100   ignore swap entirely. The default only kills once BOTH memory
#              and swap are nearly full, which on a box with a large swap file
#              means the kill never arrives: the machine spends the whole
#              descent thrashing instead.
# --avoid      the daemons that keep the box reachable and the office alive
# --prefer     agent processes: the memory hogs, and the cheapest to lose
#
# Both lists match a process NAME, which is why the office server is shielded as
# `isomux` and not as `bun`. It runs under bun, so its name used to be `bun` - 
# and so is every `bun install` and `bun run build` an agent starts. Shielding
# that name shielded the multi-GB build spike this whole setup exists to kill,
# while the server gained nothing its own workload did not also get. The server
# now names itself `isomux` at startup (server/process-name.ts) so the two can
# be told apart. A build keeps the name `bun` and is a candidate again.
#
# An office older than that rename is still called `bun` and so is not matched
# here. What it falls back on is the OOMScoreAdjust tier, the stronger of the
# two shields - either the one its system unit already carries, or the one this
# tool stamps onto it below. Note that an old USER-level office that this tool
# has never been run against has neither, since its configured tier is the
# ineffective one. Keeping `bun` in the list to cover that case is what caused
# the bug, so it stays out.
configure_earlyoom() {
  write_file /etc/systemd/system/earlyoom.service.d/isomux.conf 644 <<'EOF'
# Written by isomux-oom-protect. Replaces the packaged command line, so
# /etc/default/earlyoom is not consulted.
[Service]
ExecStart=
ExecStart=/usr/bin/earlyoom -m 10,5 -s 100,100 -r 3600 --avoid '^(systemd|systemd-.+|sshd|tailscaled|caddy|earlyoom|isomux)$' --prefer '^(claude|codex|node|chrome)$'
# The process that decides who dies must never be a candidate itself.
OOMScoreAdjust=-1000
Nice=-20
EOF
  run systemctl daemon-reload
  run systemctl enable earlyoom
  run systemctl restart earlyoom
}

# --- office memory bounds --------------------------------------------------

# Keep a hosted office inside the box instead of letting its build and agent
# processes consume the operator's last login shell. The 1 GiB reserve is a
# provisional entry-tier value, pending the release-shaped acceptance run. It
# is not sensible on a small self-hosted box: below 4 GiB it would remove too
# much of the RAM that made the office usable before this tool ran, so those
# boxes keep their existing uncapped behavior.
#
# MemorySwapMax stays at 6 GiB even when the box has less swap. In that case the
# global swap supply binds first, so scaling this cgroup value down would only
# make the measured exhaustion cliff arrive sooner.
#
# This is the system-unit shape installed by deploy/install.sh. A user-level
# office needs its own user-manager drop-in and reload; writing one here without
# reloading that manager would be a silent no-op until restart.
configure_office_memory_cap() {
  local mem_total_kib mem_total_mib memory_max_mib memory_high_mib
  mem_total_kib=$(awk '$1 == "MemTotal:" { print $2; exit }' "$MEMINFO_PATH" 2>/dev/null || true)
  if [[ ! $mem_total_kib =~ ^[0-9]+$ ]]; then
    warn "could not read MemTotal from $MEMINFO_PATH, so the office memory cap was not written"
    return 0
  fi
  mem_total_mib=$((mem_total_kib / 1024))
  if ((mem_total_mib < OFFICE_MEMORY_MIN_MIB)); then
    warn "this box has ${mem_total_mib} MiB RAM; leaving the office uncapped because the measured 1 GiB reserve is not suitable below ${OFFICE_MEMORY_MIN_MIB} MiB"
    return 0
  fi
  memory_max_mib=$((mem_total_mib - OFFICE_MEMORY_RESERVE_MIB))
  memory_high_mib=$((memory_max_mib * 85 / 100))

  write_file "$OFFICE_MEMORY_DROPIN" 644 <<EOF
# Written by isomux-oom-protect from this box's RAM at the time the tool ran.
[Service]
MemoryMax=${memory_max_mib}M
MemoryHigh=${memory_high_mib}M
MemorySwapMax=${OFFICE_SWAP_MAX_MIB}M
EOF
  run systemctl daemon-reload
  [[ -n $DRY_RUN ]] && return 0

  local cgroup expected_max expected_high expected_swap actual_max actual_high actual_swap
  cgroup=$(systemctl show isomux.service --property=ControlGroup --value 2>/dev/null || true)
  if [[ -z $cgroup || ! -d $CGROUP_ROOT$cgroup ]]; then
    log "office memory cap written; it will take effect when isomux.service starts"
    return 0
  fi
  expected_max=$((memory_max_mib * 1024 * 1024))
  expected_high=$((memory_high_mib * 1024 * 1024))
  expected_swap=$((OFFICE_SWAP_MAX_MIB * 1024 * 1024))
  actual_max=$(cat "$CGROUP_ROOT$cgroup/memory.max" 2>/dev/null || true)
  actual_high=$(cat "$CGROUP_ROOT$cgroup/memory.high" 2>/dev/null || true)
  actual_swap=$(cat "$CGROUP_ROOT$cgroup/memory.swap.max" 2>/dev/null || true)
  if [[ $actual_max == "$expected_max" && $actual_high == "$expected_high" && $actual_swap == "$expected_swap" ]]; then
    log "office memory cap confirmed in the running cgroup: MemoryMax=${memory_max_mib}M, MemoryHigh=${memory_high_mib}M, MemorySwapMax=${OFFICE_SWAP_MAX_MIB}M"
  else
    warn "office memory cap NOT confirmed in the running cgroup: asked for $expected_max/$expected_high/$expected_swap bytes, kernel reports ${actual_max:-unreadable}/${actual_high:-unreadable}/${actual_swap:-unreadable}"
  fi
}

# --- kill order -------------------------------------------------------------

# Lower score = killed later. A best-effort bias, not a guarantee: the kernel
# combines it with its own "roughly biggest" heuristic.
#
#   -900  ssh, tailscaled                    keep the box reachable
#   -900  resolved, networkd, logind         keep it usable once reached
#   -500  isomux, caddy                      keep the office up
#
# The second row is there because of a measured incident, not a theory. During
# the capacity benchmark a box under global memory pressure had earlyoom kill
# its way down the process table at about four kills a second - apparmor_parser,
# rsyslogd, three agettys, systemd-resolved, systemd-timesyncd, systemd-logind -
# and resolved never came back (see the restart note below). The box then
# answered ssh and every liveness probe for three hours while no process on it
# could resolve a hostname.
#
# Two things made that possible, and both are worth knowing before touching this
# table. earlyoom ranks by the kernel's oom_score, which is (1000 + adj) * 2/3
# for anything small: every idle daemon on the box sits at exactly 666,
# regardless of how little memory it holds. So the ordering among small processes
# is arbitrary, and the gap between a 5 MiB daemon and a 300 MB agent is only
# about 20 points. On top of that, the earlyoom drop-in of the day had `bun` in
# its --avoid list, which took 300 off every agent process and left the system
# daemons as the highest-scoring candidates on the box. That part is already
# fixed above; this table fixes the rest, by putting the daemons that must
# survive far below the 666 floor rather than a nudge below it.
#
# --avoid alone would not do it: it is a 300-point bias applied by earlyoom, and
# it does not exist for the kernel's own killer. A negative score is both.
#
# Two are left alone because Ubuntu 24.04 already ships them below the floor,
# measured on a box: `systemd-journald.service` at -250, and `dbus.service` at
# -900, which is exactly what this table would have written anyway. That says
# nothing about `dbus-broker.service`, a different unit that some distributions
# ship instead; it is not tiered here because no box isomux supports runs it.
#
# What this table does NOT fix, and what actually turned that incident into a
# three-hour outage: a daemon that does get killed may not come back. resolved
# was SIGKILLed five times in two seconds, hit systemd's default start limit of
# five starts per ten seconds, logged "Start request repeated too quickly" and
# stayed failed until someone noticed. Surviving the spike and recovering from
# it are separate problems; this is the first one.
#
# Two facts worth remembering. A score is inherited at fork, so these tiers
# would hand the office's own agents and builds the same protection as the
# office - the office undoes that from inside the server by raising its
# descendants back above itself (server/oom-stamp.ts), and earlyoom's --prefer
# above steers by name on top. Neither is this table's job. And on a user-level
# office (systemctl --user) the -500 from the unit file does not apply: Ubuntu's
# user manager lacks the privilege to lower scores, the write fails silently,
# and everything runs at 100. This script repairs the running server from root
# instead, and installs a timer that repeats the repair after every office
# restart. `systemctl show` echoes the configured value either way; only
# /proc/PID/oom_score_adj tells the truth, which is why every write below is
# read back.

# A process's start time; together with its pid it identifies it uniquely
# (a pid on its own can be recycled). Field 22 of PROC_ROOT/PID/stat,
# reached by dropping everything up to the last ')' because the process
# name in field 2 may contain spaces.
proc_starttime() {
  sed 's/.*) //' "$PROC_ROOT/$1/stat" 2>/dev/null | awk '{ print $20 }'
}

# Set the kill order on a running process and read it back from /proc. The
# readback is the point: a refused write is silent and `systemctl show`
# reports what was ASKED for, not what took (task c5b4e89e).
stamp_pid() {
  local pid=$1 score=$2 what=$3
  [[ -n $pid && $pid != 0 && -r $PROC_ROOT/$pid/stat ]] || return 1
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would set oom_score_adj=$score on the running $what (pid $pid)"
    return 0
  fi
  # Start time is read before the write and re-read only AFTER the readback,
  # so one identity check covers both; a recycled pid cannot fake a success.
  local before after actual
  before=$(proc_starttime "$pid")
  printf '%s\n' "$score" >"$PROC_ROOT/$pid/oom_score_adj" 2>/dev/null || true
  actual=$(cat "$PROC_ROOT/$pid/oom_score_adj" 2>/dev/null) || actual=""
  after=$(proc_starttime "$pid")
  if [[ -z $before || -z $after || $after != "$before" ]]; then
    warn "$what (pid $pid) exited mid-write; nothing verified. Re-run this tool."
    return 1
  fi
  if [[ $actual != "$score" ]]; then
    warn "kill order NOT applied to $what (pid $pid): asked for $score, the kernel reports $actual."
    return 1
  fi
  log "  $what (pid $pid): oom_score_adj=$actual confirmed"
  return 0
}

oom_tier() {
  local unit=$1 score=$2
  write_file "/etc/systemd/system/$unit.d/isomux-oom.conf" 644 <<EOF
# Written by isomux-oom-protect.
[Unit]
# Being killed under memory pressure must not be permanent. systemd gives up
# after 5 starts in 10 seconds and leaves the unit failed, and these daemons
# restart at RestartSec=0 out of the box - measured, systemd-resolved spent all
# five inside two seconds during an earlyoom cascade and then stayed dead for
# three hours while the box went on answering ssh and every liveness probe.
# Retry forever instead, with the backoff below so forever is not a spin.
StartLimitIntervalSec=0

[Service]
OOMScoreAdjust=$score
RestartSec=$RESTART_BACKOFF
EOF
  # A unit file only takes effect at the next start, and restarting sshd or
  # tailscaled to pick it up is exactly the disruption this script exists to
  # avoid. Write it to the running process too.
  local pid
  pid=$(systemctl show -p MainPID --value "$unit" 2>/dev/null) || pid=0
  stamp_pid "$pid" "$score" "$unit" || true
}

# The office on a `systemctl --user` install ----------------------------------
#
# The tier above writes a drop-in for a SYSTEM unit. An office installed the
# self-hosted way (docs/self-hosted.md) has no isomux.service on the system bus,
# so that drop-in is inert - and the obvious repair, a matching drop-in under
# the user's own systemd, does not work either.
#
# Measured on a live office box, 2026-07-31. Ubuntu starts every user manager at
# OOMScoreAdjust=100 (/usr/lib/systemd/system/user@.service) and its services
# inherit that. Lowering a score needs CAP_SYS_RESOURCE, which a user manager
# does not have, so its request for -500 is refused by the kernel - while
# `systemctl --user show` still cheerfully reports -500 and the service starts
# clean. The server reads 100.
#
# Root is not subject to that limit and can write the score straight onto the
# running process, which is what this does. Because it is written to a process
# rather than to a config, it dies with it: an office that restarts comes back at
# 100 again. The re-stamp timer further down is what puts it back, so nobody has
# to re-run this tool by hand after every restart.
#
# The other half of the problem - ordering the office's own agents against the
# office - is not solved here at all. The office does that for itself, on every
# install shape, by raising its descendants' scores from inside the server
# (server/oom-stamp.ts): raising a score needs no privilege, only lowering one
# does.
#
# Making the value survive natively would mean lowering the whole user manager,
# putting every process in that operator's login session under the same
# protection - a policy decision this script does not get to make on its own.

# Print the pid of a running user-level isomux service, if there is one.
#
# Found by cgroup rather than by asking systemd: there is no user D-Bus session
# to reach into from here, and this works the same whether the operator happens
# to be logged in or not. The service and everything it spawns share one cgroup,
# so the server is the one whose parent is outside it.
find_user_isomux_pid() {
  local proc pid ppid
  for proc in "$PROC_ROOT"/[0-9]*; do
    pid=${proc##*/}
    grep -qs '/user@[0-9]*\.service/.*/isomux\.service' "$proc/cgroup" || continue
    ppid=$(awk '/^PPid:/ { print $2 }' "$proc/status" 2>/dev/null) || continue
    grep -qs '/user@[0-9]*\.service/.*/isomux\.service' \
      "$PROC_ROOT/$ppid/cgroup" && continue
    printf '%s\n' "$pid"
    return 0
  done
  return 1
}

configure_user_level_office() {
  local pid current
  pid=$(find_user_isomux_pid) || return 0
  current=$(cat "$PROC_ROOT/$pid/oom_score_adj" 2>/dev/null) || current=""
  # The timer below runs this every $RESTAMP_INTERVAL. When the office has not
  # restarted there is nothing to do, and nothing worth a line in the journal.
  if [[ -n $RESTAMP && $current == "$OFFICE_SCORE" ]]; then
    return 0
  fi
  log "found a user-level office (pid $pid); setting its kill order from root"
  if stamp_pid "$pid" "$OFFICE_SCORE" "user-level office"; then
    return 0
  fi
  # In the timer's mode systemd is the only thing watching, so an attempted but
  # unverified stamp has to come back as a failed run. Exiting 0 here would
  # record a minute-by-minute history of success for protection that is not
  # there, which is the exact shape of the bug this whole tool came from.
  # The full install path stays best-effort: it has other work to finish, and
  # stamp_pid has already said what went wrong either way.
  if [[ -n $RESTAMP ]]; then
    return 1
  fi
  return 0
}

# Keeping that stamp applied --------------------------------------------------
#
# Polling, once every $RESTAMP_INTERVAL, rather than reacting to the restart: a
# path unit would need one fixed file to watch, and this tool deliberately does
# not know which user runs the office - it scans /proc for it precisely because
# of that.
#
# Installed on every box, including a hosted one whose office is a system unit
# and already carries the score in its unit file. There the timer finds no
# user-level office and says nothing. The alternative, installing it only when an
# office happens to be running at the moment this tool runs, silently skips the
# operator who sets a box up before starting the office.
#
# One thing to know on a box with more than one login: whoever can create their
# own systemd user unit named isomux.service gets this -500 on it. That is
# already true of running this tool by hand, and an isomux box is a
# single-operator box - everyone with an office account effectively has a shell
# on it (docs/self-hosted.md).
install_restamp_timer() {
  # The unit runs the copy at $OOM_TOOL_PATH, so that copy has to be THIS
  # version of the tool: one installed before --restamp existed would answer
  # every single run with a usage error.
  local self
  self=$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null) || self=""
  if [[ -z $self || ! -r $self ]]; then
    warn "could not find this script on disk, so the automatic re-stamp was not set up. A user-level office loses its kill order at the next restart until this tool is run again."
    return 0
  fi
  if [[ $self != "$OOM_TOOL_PATH" ]]; then
    # Into a sibling and then renamed, never written in place: the timer may be
    # starting a run from that exact path at this moment, and truncating the
    # file underneath it would feed the shell half a script. A rename swaps the
    # name atomically and the running copy keeps the old inode. Sibling so it is
    # the same filesystem, which is what makes the rename atomic.
    #
    # -D so a box without /usr/local/sbin gets it made rather than aborting the
    # run here, after the kill order has been applied but before the swap steps.
    local staged="$OOM_TOOL_PATH.new.$$"
    if run install -D -m 755 "$self" "$staged" && run mv -f "$staged" "$OOM_TOOL_PATH"; then
      [[ -n $DRY_RUN ]] || log "installed this tool at $OOM_TOOL_PATH, which is where the re-stamp timer runs it from"
    else
      run rm -f "$staged"
      warn "could not install this tool at $OOM_TOOL_PATH, so the automatic re-stamp was not set up. A user-level office will lose its kill order at its next restart until this tool is run again."
      return 0
    fi
  fi
  write_file "/etc/systemd/system/$RESTAMP_UNIT.service" 644 <<EOF
# Written by isomux-oom-protect.
[Unit]
Description=Re-apply the isomux office kill order

[Service]
Type=oneshot
ExecStart=$OOM_TOOL_PATH --restamp
# This runs on a $RESTAMP_INTERVAL timer and normally has nothing to say, but
# each run still costs systemd a "Starting"/"Finished" pair. LogLevelMax drops
# those. Measured on systemd 255 with throwaway units rather than taken from the
# manual: it filters what the manager writes ABOUT a unit, leaves the unit's own
# output alone, and a failed run still records at warning. SyslogLevel then puts
# this tool's own lines at that same ceiling instead of below it, so they keep
# surviving if the filter is ever applied to them as well, which is what the
# documentation says it already does.
SyslogLevel=notice
LogLevelMax=notice
EOF
  write_file "/etc/systemd/system/$RESTAMP_UNIT.timer" 644 <<EOF
# Written by isomux-oom-protect.
[Unit]
Description=Re-apply the isomux office kill order after an office restart

[Timer]
OnBootSec=$RESTAMP_INTERVAL
OnUnitActiveSec=$RESTAMP_INTERVAL
# Without this systemd may batch the wakeup up to a minute late, which would
# double the window this timer exists to close.
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
  run systemctl daemon-reload
  # Not fatal if it will not start: everything above this point has already been
  # applied to the running box, and losing the automatic repeat is worth saying
  # out loud rather than aborting the rest of the run over.
  if run systemctl enable --now "$RESTAMP_UNIT.timer"; then
    log "$RESTAMP_UNIT.timer will re-apply a user-level office's kill order within $RESTAMP_INTERVAL of a restart"
  else
    warn "could not start $RESTAMP_UNIT.timer. A user-level office will lose its kill order at its next restart until this tool is run again."
  fi
}

configure_kill_order() {
  # Written whether or not the unit exists yet: tailscale is often installed
  # after the office, and the drop-in is inert until there is a unit to attach
  # to.
  oom_tier ssh.service -900
  oom_tier tailscaled.service -900
  # A box that answers ssh but cannot resolve a hostname, configure its network,
  # or start a user service is broken in a way nothing reports. Measured on an
  # Ubuntu 24.04 box, all three of these run at 0 and are killed as readily as
  # anything else. Inert where the unit does not exist, same as tailscaled above.
  oom_tier systemd-resolved.service -900  # DNS. The one that actually went down.
  oom_tier systemd-networkd.service -900  # addresses and routes
  oom_tier systemd-logind.service -900    # ssh sessions, and `systemctl --user`
  oom_tier caddy.service -500
  oom_tier isomux.service "$OFFICE_SCORE"
  run systemctl daemon-reload
  configure_user_level_office
  install_restamp_timer
}

# --- swap and swappiness ----------------------------------------------------

configure_swappiness() {
  write_file "$SYSCTL_CONF" 644 <<'EOF'
# Written by isomux-oom-protect.
# Prefer dropping cached file pages over swapping out memory that is in use.
# At the default of 60, a memory spike on a box with a large swap file turns
# into minutes of disk grinding rather than one process being killed.
vm.swappiness = 10
EOF
  run sysctl -q -p "$SYSCTL_CONF"
}

# Swap is a safety net, not capacity. An office that is swapping is already
# degraded - measured, an entry-tier box swapping under load runs about 12x its
# unloaded turn latency whatever the file size - so none of this buys headroom.
# What the size decides is how the bad case ends.
#
# It used to be 2 GiB here, on the reasoning that a large swap file lets a box
# keep allocating past the point where it can still respond. Measured, that is
# not what happens: at one load, a 2 GiB file used to the last megabyte gave a
# p95 of 30.7 s where 8 GiB under the identical load gave 3.4 s, with 2.2x the
# throughput. The cliff is swap EXHAUSTION, not swap size - a file that runs out
# mid-spike is worse than either a bigger one or none at all. Hence 8 GiB.
# (internal-docs/sizing-tiers-benchmark-results.md, "Swap: decision 4".)
SWAP_HEADROOM_MIB=4096
# What a small disk falls back to: the size every box got before the measurement
# above, so this change can only ever leave a box with more swap than it had.
SWAP_MIN_SIZE_MIB=2048
# How far under the target still counts as "already that size". mkswap spends a
# page on its header and SwapTotal is reported in kB, so an 8192 MiB file comes
# back as 8191 MiB - without this the tool would decide, on every single run,
# that the swap file it made last time is too small and rebuild it.
SWAP_SIZE_SLACK_MIB=64

# How much swap the kernel currently has, in MiB, and where. Read through the
# seam so deploy/oom-protect.test.ts can drive the decisions below against a box
# it invents rather than the one it runs on.
swap_total_mib() { awk '/^SwapTotal:/ { print int($2 / 1024) }' "$PROC_ROOT/meminfo"; }
# Every swap device the kernel has on, one path per line.
swap_devices() { awk 'NR > 1 { print $1 }' "$PROC_ROOT/swaps"; }

# Free space on the filesystem holding the swapfile, in MiB.
swap_fs_avail_mib() { df --output=avail -m "$(dirname "$SWAPFILE")" | tail -1 | tr -d ' '; }

configure_swap() {
  local total_mib
  total_mib=$(swap_total_mib)
  if [[ ${total_mib:-0} -gt 0 ]]; then
    report_existing_swap "$total_mib"
    return 0
  fi
  swap_size_for_disk || return 0
  local size_mib=$SWAP_SIZE_CHOSEN
  if [[ -e $SWAPFILE ]]; then
    warn "$SWAPFILE already exists but is not in use; leaving it alone"
    return 0
  fi
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would create a ${size_mib} MiB swap file at $SWAPFILE and add it to /etc/fstab"
    return 0
  fi
  if ! make_swapfile "$size_mib"; then
    warn "could not create $SWAPFILE; continuing without swap"
    return 0
  fi
  grep -qs "^$SWAPFILE " /etc/fstab || printf '%s none swap sw 0 0\n' "$SWAPFILE" >>/etc/fstab
  log "created a ${size_mib} MiB swap file at $SWAPFILE"
}

# Sets SWAP_SIZE_CHOSEN to the biggest swap file this disk can take; non-zero
# when the answer is "none". A global rather than stdout because this function
# also has something to say to the operator, and a $(...) around it would
# capture the explanation as part of the number.
#
# The full size plus its headroom asks for 12 GiB of disk where the old 2 GiB
# default asked for 6, so on a small disk this change would otherwise turn a box
# that used to get swap into one that gets none - the worst of the three
# outcomes. Rather than that, take what fits, down to the size boxes used to get.
SWAP_SIZE_CHOSEN=""
swap_size_for_disk() {
  local avail_mib fits
  avail_mib=$(swap_fs_avail_mib)
  fits=$(((${avail_mib:-0} - SWAP_HEADROOM_MIB) / 1024 * 1024)) # whole GiB
  if [[ $fits -ge $SWAP_SIZE_MIB ]]; then
    SWAP_SIZE_CHOSEN=$SWAP_SIZE_MIB
    return 0
  fi
  if [[ $fits -lt $SWAP_MIN_SIZE_MIB ]]; then
    warn "not creating a swap file: ${avail_mib:-0} MiB free on $(dirname "$SWAPFILE") leaves no room for one once ${SWAP_HEADROOM_MIB} MiB is kept back for the box itself"
    return 1
  fi
  warn "only ${avail_mib} MiB free on $(dirname "$SWAPFILE"): making a ${fits} MiB swap file instead of ${SWAP_SIZE_MIB} MiB. A swap file that runs out mid-spike is the worst case measured, so give this box more disk if you can."
  SWAP_SIZE_CHOSEN=$fits
}

# Allocate, format and enable $SWAPFILE at the given size in MiB. fallocate can
# leave a hole-punched file behind on a filesystem that took the call but cannot
# back it, so a failure removes the file rather than leaving a half-made one for
# the next run to find and skip.
make_swapfile() {
  local size_mib=$1
  if ! fallocate -l "${size_mib}M" "$SWAPFILE" 2>/dev/null; then
    dd if=/dev/zero of="$SWAPFILE" bs=1M count="$size_mib" status=none || {
      rm -f "$SWAPFILE"
      return 1
    }
  fi
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE" >/dev/null || { rm -f "$SWAPFILE"; return 1; }
  swapon "$SWAPFILE" || { rm -f "$SWAPFILE"; return 1; }
  return 0
}

# A box installed before the size went up already has swap, so the branch above
# never runs on the boxes that would most benefit from it. This tool does not
# resize it for them, and the reason is worth writing down, because an earlier
# draft did and it was wrong on two counts.
#
# Replacing live swap means `swapoff` first, which reads every swapped-out page
# back into RAM, and then a window where the old file is gone and the new one is
# not yet proven. fallocate, mkswap or swapon failing anywhere in that window
# leaves a running box with no swap at all - a worse state than the small
# swapfile it started with, arrived at unattended, during what is often an
# installer run. Disk and memory prechecks narrow that window; they do not close
# it.
#
# And "only resize the file we made" is not something this tool can actually
# establish. /swapfile is the conventional path on Ubuntu and most cloud images:
# finding swap there says nothing about who put it there or what they expect of
# it. There is no ownership marker to check.
#
# So: existing swap is reported and left exactly as it is, with the command to
# change it if the operator wants to, on their own timing and with the box in a
# state they can see. Anything more needs an ownership marker and a rollback
# that re-enables the old file on every failure path, which is a bigger change
# than the size constant this task is about.
report_existing_swap() {
  local total_mib=$1
  local devices
  devices=$(swap_devices)
  log "swap already set up: ${total_mib} MiB on $(printf '%s' "${devices:-an unreadable device list}" | tr '\n' ' ')"
  if [[ $total_mib -ge $((SWAP_SIZE_MIB - SWAP_SIZE_SLACK_MIB)) ]]; then
    return 0
  fi
  log "  that is under the ${SWAP_SIZE_MIB} MiB this tool makes on a box with no swap, and a swap"
  log "  file that runs out mid-spike is the worst case measured. Resizing swap under a running"
  log "  office is not something to do behind your back, so it is left as it is."
  # The recipe below is only right for a box whose swap is exactly the file this
  # tool would have made. Printing it anyway would tell someone running on a
  # partition or a zram device to swapoff a path that is not their swap, and
  # then to fallocate over whatever happens to be sitting there - the same
  # unfounded assumption about /swapfile that kept the automatic version of this
  # out of the tree, just aimed at the operator instead of the box.
  if [[ $devices != "$SWAPFILE" ]]; then
    log "  How to change that depends on how this box's swap is set up; the devices named above"
    log "  are the ones to look at."
    return 0
  fi
  log "  To do it yourself, on a quiet box:"
  log "    swapoff $SWAPFILE && fallocate -l ${SWAP_SIZE_MIB}M $SWAPFILE &&"
  log "      chmod 600 $SWAPFILE && mkswap $SWAPFILE && swapon $SWAPFILE"
}

# --- main -------------------------------------------------------------------

main() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --dry-run) DRY_RUN=1 ;;
      --restamp) RESTAMP=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage
        exit 3
        ;;
    esac
    shift
  done
  [[ $EUID -eq 0 ]] || {
    log "ERROR: must run as root (try: sudo isomux-oom-protect)"
    exit 3
  }
  # The timer's job, and only that: everything else here is either already in a
  # unit file that survives a restart on its own, or a one-time provisioning
  # step. Doing it every minute would restart earlyoom every minute.
  if [[ -n $RESTAMP ]]; then
    configure_user_level_office || exit 1
    exit 0
  fi
  local have_earlyoom=1
  install_earlyoom || have_earlyoom=""
  [[ -z $have_earlyoom ]] || configure_earlyoom
  configure_office_memory_cap
  configure_kill_order
  configure_swappiness
  configure_swap
  log ""
  if [[ -n $have_earlyoom ]]; then
    log "Out-of-memory protection is on: when free memory drops under 10%, one"
    log "agent process is killed instead of the whole box becoming unresponsive."
    log "SSH, DNS, networking and the office server are killed last (and Tailscale,"
    log "if this box uses it). Re-kick the agent and carry on."
  else
    log "Kill order and swap settings applied, but earlyoom is not installed, so"
    log "nothing steps in early under memory pressure."
  fi
}

main "$@"
ISOMUX_OOM_PROTECT_SH
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would run $OOM_TOOL (earlyoom, kill order, swap)"
    return 0
  fi
  "$OOM_TOOL" || log "warning: out-of-memory protection could not be set up completely (see above); nothing else is affected"
}

enable_auto_updates() {
  step enable-auto-updates
  write_file /etc/apt/apt.conf.d/20auto-upgrades 644 <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
}

# Runs AFTER fetch_isomux so the pin can come from the checkout: the release
# declares its bun in package.json "packageManager", and installing that
# exact version is what makes "a tag fully determines the deployment" true
# (CI tests the same pin via setup-bun's bun-version-file).
install_bun() {
  step install-bun
  local pinned=""
  if [[ -f $INSTALL_DIR/package.json ]]; then
    pinned=$(sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' "$INSTALL_DIR/package.json" | head -1)
  fi
  # The systemd unit hardcodes /usr/local/bin/bun, so check that exact path;
  # a bun elsewhere on root's PATH does not help the service.
  if [[ -x /usr/local/bin/bun ]]; then
    local have
    have=$(/usr/local/bin/bun --version)
    if [[ -z $pinned || $have == "$pinned" ]]; then
      log "bun already installed: $have"
      return 0
    fi
    log "bun $have installed but this ref pins bun@$pinned; installing the pinned version"
  fi
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would install bun ${pinned:-latest} to /usr/local/bin via bun.sh/install"
    return 0
  fi
  if [[ -n $pinned ]]; then
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v$pinned"
  else
    log "warning: no packageManager pin in package.json; installing latest bun"
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
  fi
  [[ -x /usr/local/bin/bun ]] || die "bun installation did not produce /usr/local/bin/bun"
}

create_service_user() {
  step create-service-user
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    # A preexisting account with this name must match the unit contract, or
    # every later step would act on the wrong home.
    local home
    home=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
    [[ $home == "$SERVICE_HOME" ]] ||
      die "user $SERVICE_USER exists with home $home (expected $SERVICE_HOME); this box already uses that account for something else"
    log "user $SERVICE_USER already exists"
  else
    run useradd --create-home --shell /bin/bash "$SERVICE_USER"
  fi
}

# True when a process holding only the isomux service's environment can reach
# the service account's systemd user manager. `env -i` rather than a plain
# call: root's own XDG_RUNTIME_DIR or DBUS_SESSION_BUS_ADDRESS leaking in would
# let this pass while the service - which inherits neither - still cannot
# connect. `show-environment` exits 0 only on a working bus connection.
user_manager_reachable() {
  runuser -u "$SERVICE_USER" -- env -i "HOME=$SERVICE_HOME" \
    "XDG_RUNTIME_DIR=/run/user/$1" /usr/bin/systemctl --user show-environment \
    >/dev/null 2>&1
}

# Agents' apps run as systemd USER units of the service account: the office's
# app supervisor speaks `systemctl --user` and nothing else. A box built by this
# installer cannot do that as it stands - nobody ever logs in as that account,
# so logind never starts its user manager and there is no bus to reach ("Failed
# to connect to bus: No medium found"). Two things fix it, and both need root,
# which is why they belong here and not in the server:
#
#   1. Linger. `enable-linger` starts user@<uid>.service without a login, brings
#      it back at boot, and creates /run/user/<uid>.
#   2. The address of that bus, in the isomux service's own environment - a
#      system unit inherits none. XDG_RUNTIME_DIR is the whole recipe: with
#      DBUS_SESSION_BUS_ADDRESS unset, systemd's bus client falls back to
#      $XDG_RUNTIME_DIR/bus. Measured from a scrubbed environment on the
#      supported target (Ubuntu 24.04, systemd 255) rather than read off a man
#      page.
#
# A drop-in rather than lines in isomux.service, because this same function is
# what converges boxes installed before apps existed: deps_only runs it during
# an update, on a live box, where rewriting the unit would throw away whatever
# the operator had edited into it. Additive also keeps one definition of the
# environment contract instead of a fresh-install copy and an update copy free
# to drift apart.
#
# Linger widens what the service account can do, and the wider grant is not the
# apps: agents already run as this account and can write its
# ~/.config/systemd/user, so a user manager that outlives logout and reboot
# means units an agent writes by hand do too. That comes with running apps as
# user units at all - isomux generating the unit files is an API, not a
# boundary, and a boundary would take a separate Unix identity. Written down in
# internal-docs/agent-apps-design.md rather than papered over here.
configure_user_manager() {
  step configure-user-manager
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would enable linger for $SERVICE_USER, write $USER_MANAGER_DROPIN, and check that the account's systemd user manager answers"
    return 0
  fi
  local uid
  uid=$(id -u "$SERVICE_USER") ||
    die "no $SERVICE_USER account on this box, so linger cannot be enabled for it"
  loginctl enable-linger "$SERVICE_USER"
  install -d -m 755 "$(dirname "$USER_MANAGER_DROPIN")"
  write_file "$USER_MANAGER_DROPIN" 644 <<EOF
# Written by the isomux installer. Isomux runs agents' apps as systemd user
# units of the $SERVICE_USER account; this is where that account's user bus
# lives, and a system unit does not inherit it.
[Service]
Environment=XDG_RUNTIME_DIR=/run/user/$uid
EOF
  systemctl daemon-reload
  # Verify rather than assume: enable-linger returns before logind has finished
  # bringing the user manager up. Fatal, where the browser step only warns -
  # this is the transport a shipped feature runs on, not an optional extra, and
  # an install (or an update) that reports success with an unreachable bus
  # leaves every app operation failing with nothing in the output that said so.
  local waited=0
  until user_manager_reachable "$uid"; do
    ((waited < USER_MANAGER_TIMEOUT_S)) ||
      die "the $SERVICE_USER account's systemd user manager did not become reachable within ${USER_MANAGER_TIMEOUT_S}s, so isomux could not run agents' apps. Check: loginctl show-user $SERVICE_USER (wants Linger=yes), ls -ld /run/user/$uid, systemctl status user@$uid.service"
    sleep 1
    waited=$((waited + 1))
  done
  log "the $SERVICE_USER account's systemd user manager answers; agents' apps can run"
}

# A Chrome-family browser is what backs the agents' page-preview cards
# (POST /api/agents/:id/preview-url). Without one the server answers
# `no_browser` while the agent system prompt advertises the capability, so
# agents offer a feature that always fails.
#
# Google Chrome's own .deb, deliberately NOT snap chromium: on Ubuntu 24.04
# `snap install chromium` succeeds and still cannot screenshot (snap
# confinement + no desktop session makes captures die on D-Bus), and /snap/bin
# is not on the service's PATH either. The .deb lands at $CHROME_PATH, the
# first candidate the server probes.
#
# Non-fatal throughout: a box without a browser is fully functional except for
# page previews, so a download hiccup must not abandon an otherwise good
# install. Every failure path warns and continues.
install_browser() {
  step install-browser
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would install Google Chrome from $CHROME_DEB_URL and verify a real headless capture"
    return 0
  fi
  local arch
  arch=$(dpkg --print-architecture 2>/dev/null || echo unknown)
  if [[ -x $CHROME_PATH ]]; then
    log "browser already installed: $("$CHROME_PATH" --version 2>/dev/null || echo "$CHROME_PATH")"
  elif [[ $arch != amd64 ]]; then
    log "warning: Google Chrome ships no $arch Linux build, so page previews (the preview-url card) will be unavailable. Install a Chrome-family browser yourself to enable them (ask your agent for help); nothing else is affected."
    return 0
  else
    local deb
    deb=$(mktemp /tmp/isomux-chrome.XXXXXXXXXX.deb)
    if ! curl -fsSL -o "$deb" "$CHROME_DEB_URL"; then
      rm -f "$deb"
      log "warning: could not download Google Chrome from $CHROME_DEB_URL, so page previews (the preview-url card) will be unavailable. Re-run this installer to retry; nothing else is affected."
      return 0
    fi
    if ! apt_install "$deb"; then
      rm -f "$deb"
      log "warning: installing the Google Chrome package failed, so page previews (the preview-url card) will be unavailable. Re-run this installer to retry; nothing else is affected."
      return 0
    fi
    rm -f "$deb"
  fi
  verify_browser
}

# Prove the installed browser can actually produce a screenshot, as the service
# user and with the flags that decide the outcome on a headless server (the
# keyring/D-Bus pair, a private profile dir) - not a replica of every flag the
# server passes. A present binary is not the same as a working one (snap
# chromium is the standing counter-example), and without this check the failure
# surfaces much later, to an agent. Non-empty PNG rather than the server's
# full completeness check: this only has to tell a working browser from a
# confined one.
verify_browser() {
  [[ -x $CHROME_PATH ]] || {
    log "warning: $CHROME_PATH is missing after the browser install, so page previews (the preview-url card) will be unavailable."
    return 0
  }
  local probe
  probe=$(mktemp -d /tmp/isomux-browser-check.XXXXXXXXXX)
  chown "$SERVICE_USER:$SERVICE_USER" "$probe" || true
  # Both halves stay in the `if` CONDITION: under `set -e` a failing command in
  # an if BODY aborts the script, and a browser that cannot capture must warn,
  # not abort the install.
  local ok=""
  if as_service_user timeout 60 "$CHROME_PATH" \
    --headless=new "--screenshot=$probe/probe.png" --window-size=320,320 \
    --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --disable-background-networking --disable-component-update \
    --password-store=basic --use-mock-keychain "--user-data-dir=$probe/profile" \
    'data:text/html,<title>isomux</title>' >/dev/null 2>&1 &&
    [[ -s $probe/probe.png ]]; then
    ok=1
  fi
  rm -rf "$probe"
  if [[ -n $ok ]]; then
    log "browser ready for page previews: $("$CHROME_PATH" --version 2>/dev/null || echo "$CHROME_PATH")"
  else
    log "warning: $CHROME_PATH is installed but produced no screenshot in a headless test run, so page previews (the preview-url card) will not work. Nothing else is affected; see: $CHROME_PATH --headless=new --screenshot=/tmp/probe.png about:blank"
  fi
}

# Codex agents confine their own tool calls with bubblewrap, so `bwrap` has to
# work for the service account or the read-only and workspace-write sandbox
# settings have nothing to run in. On Ubuntu 24.04 the package alone is not
# enough: the kernel ships with kernel.apparmor_restrict_unprivileged_userns=1
# and the bubblewrap deb carries no AppArmor profile, so an unprivileged bwrap
# lands in the restriction's deny-capabilities transition and dies with
# "loopback: Failed RTM_NEWADDR: Operation not permitted".
#
# The fix is Ubuntu's own two-stage profile, shipped by apparmor-profiles: the
# bwrap profile keeps the capabilities needed to build a sandbox, and every
# child bwrap execs is stacked into unpriv_bwrap, which denies capability
# outright. bwrap works, and does not become a general way around the box-wide
# user-namespace restriction - which is what matters on a box that runs
# whatever an agent asks it to. Deliberately NOT the two shortcuts that make
# the same symptom go away: a hand-written flags=(unconfined) profile, and
# turning the sysctl off.
#
# Probe-gated, not version-gated: the smoke test decides. A box where bwrap
# already works is left untouched, so a future Ubuntu that fixes this upstream
# gets nothing done to it, and a re-run of this installer does nothing twice.
#
# Non-fatal throughout, like the browser step: an office without a working
# bubblewrap still runs, and codex agents can still be pointed at a different
# sandbox setting. Every failure path says what actually failed rather than
# weakening the policy to make the message stop.
configure_codex_sandbox() {
  step codex-sandbox
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would install bubblewrap, smoke-test it as $SERVICE_USER, and load the $BWRAP_PROFILE_NAME AppArmor profile if unprivileged user namespaces are restricted"
    return 0
  fi
  if ! command -v bwrap >/dev/null 2>&1 && ! apt_install bubblewrap; then
    log "warning: could not install the bubblewrap package, so codex agents have no sandbox to run their tools in (their read-only and workspace-write settings need it). Re-run this installer to retry; nothing else is affected."
    return 0
  fi
  local diag
  if diag=$(bwrap_smoke_test); then
    log "codex sandbox ready: bwrap works for $SERVICE_USER"
    return 0
  fi
  if ! userns_restricted; then
    log "warning: bwrap does not work for $SERVICE_USER, and this box does not restrict unprivileged user namespaces, so AppArmor policy is not the cause and there is nothing safe to change. Codex agents cannot use their sandbox until this is fixed; nothing else is affected. bwrap said: $diag"
    return 0
  fi
  install_bwrap_profile || return 0
  if diag=$(bwrap_smoke_test); then
    log "codex sandbox ready: loaded the $BWRAP_PROFILE_NAME AppArmor profile, bwrap now works for $SERVICE_USER"
  else
    log "warning: the $BWRAP_PROFILE_NAME AppArmor profile is loaded and bwrap still does not work for $SERVICE_USER, so codex agents cannot use their sandbox. Nothing else is affected. bwrap said: $diag"
  fi
}

# The narrowest thing a codex sandbox does that the user-namespace restriction
# breaks: a fresh network namespace with the filesystem bound through. Run as
# the SERVICE ACCOUNT, because the restriction only applies to unprivileged
# users - as root this would pass on a box where codex cannot start at all.
# Prints whatever bwrap said, so a caller can show the real diagnostic.
bwrap_smoke_test() {
  as_service_user bwrap --unshare-net --dev-bind / / /bin/true 2>&1
}

# True when the kernel is refusing unprivileged user namespaces to unconfined
# processes, which is Ubuntu 24.04's default and the reason bwrap needs a
# profile. The knob's absence means a kernel without the feature - a box where
# this whole step has nothing to say.
userns_restricted() {
  [[ -r $USERNS_RESTRICT_SYSCTL ]] || return 1
  [[ $(cat "$USERNS_RESTRICT_SYSCTL" 2>/dev/null) == 1 ]]
}

# Put the two-stage profile in /etc/apparmor.d and load it. Ubuntu's
# apparmor-profiles parks its extras in /usr/share/apparmor/extra-profiles and
# loads none of them - the package calls them experimental - so enabling
# exactly this one is a copy plus a parser run, and the package's other extras
# stay where they are. Returns nonzero (having warned) when the profile could
# not be put in place, so the caller stops rather than re-testing for nothing.
#
# The caller invokes this as `install_bwrap_profile || return 0`, which turns
# errexit off for everything in here. So every step that changes the box is
# checked by hand and reports what it said: without that, a failed copy would
# fall through to the parser and the operator would be told the parser could
# not read a file, never that the copy is what broke. Nothing here goes
# through `run`, for the same reason verify_browser doesn't - the caller
# returns before this in dry-run mode.
install_bwrap_profile() {
  local out=""
  # AppArmor's own opt-out, a symlink in /etc/apparmor.d/disable pointing at
  # the profile. Someone put it there on purpose, and apparmor_parser -r would
  # load the profile regardless: the disable directory is honored by the
  # apparmor service and the aa-* tools, not by the parser given an explicit
  # pathname. So check it here rather than quietly reversing that decision.
  # -L as well as -e: the link is DANGLING whenever its target is missing,
  # which is exactly the box this step runs on - about to create the target -
  # and -e alone is false for a dangling link.
  if [[ -e $BWRAP_PROFILE_DISABLED || -L $BWRAP_PROFILE_DISABLED ]]; then
    log "warning: $BWRAP_PROFILE_DISABLED marks the $BWRAP_PROFILE_NAME AppArmor profile as disabled on this box, so codex agents cannot use their sandbox. Leaving it disabled; remove that link and re-run this installer to enable it."
    return 1
  fi
  if [[ -e $BWRAP_PROFILE ]]; then
    # Already there and bwrap still fails, so it is present but not loaded
    # (a re-run after aa-teardown, or a copy someone left unloaded). Reload
    # what is on the box rather than overwriting it: the file may be the
    # operator's.
    log "reloading the AppArmor profile already at $BWRAP_PROFILE"
  elif apt_install apparmor apparmor-profiles && [[ -r $BWRAP_PROFILE_PACKAGED ]]; then
    if ! out=$(install -m 644 "$BWRAP_PROFILE_PACKAGED" "$BWRAP_PROFILE" 2>&1); then
      log "warning: could not copy the $BWRAP_PROFILE_NAME AppArmor profile to $BWRAP_PROFILE, so codex agents cannot use their sandbox. Nothing else is affected. install said: $out"
      return 1
    fi
    log "enabled Ubuntu's packaged AppArmor profile $BWRAP_PROFILE_NAME so codex's bubblewrap sandbox can start"
  else
    # No package to copy from. Vendored copy of the same upstream profile,
    # never a hand-written permissive one: the point of the exercise is the
    # unpriv_bwrap stage that denies capability to bwrap's children.
    #
    # Deliberately NOT write_file. It creates the file and fills it as two
    # separate commands, and with errexit off in here a failed create followed
    # by a successful write returns 0 - the profile would land with whatever
    # mode the umask gives it and nothing would say so. Both steps are checked
    # here instead. `2>&1 >file` and not `>file 2>&1`: stderr has to be
    # captured BEFORE stdout is pointed at the profile, or the diagnostic
    # would be written into the profile.
    if ! out=$(install -m 644 /dev/null "$BWRAP_PROFILE" 2>&1); then
      log "warning: could not create $BWRAP_PROFILE for the vendored $BWRAP_PROFILE_NAME AppArmor profile, so codex agents cannot use their sandbox. Nothing else is affected. install said: $out"
      return 1
    fi
    if ! out=$(vendored_bwrap_profile 2>&1 >"$BWRAP_PROFILE"); then
      # Leave no empty file behind: the next run would find it, take the
      # "already there, just reload it" branch above, and hand the parser an
      # empty profile. Ours to remove - this branch created it a line ago.
      rm -f "$BWRAP_PROFILE"
      log "warning: could not write the vendored $BWRAP_PROFILE_NAME AppArmor profile to $BWRAP_PROFILE, so codex agents cannot use their sandbox. Nothing else is affected. The error was: $out"
      return 1
    fi
    log "this box ships no $BWRAP_PROFILE_NAME profile to enable, so isomux installed its vendored copy of the upstream one at $BWRAP_PROFILE"
  fi
  if ! out=$(apparmor_parser -r "$BWRAP_PROFILE" 2>&1); then
    log "warning: could not load the AppArmor profile $BWRAP_PROFILE, so codex agents cannot use their sandbox. Nothing else is affected. apparmor_parser said: $out"
    return 1
  fi
}

# The fallback profile itself, kept in its own function so the heredoc's
# column-0 `}` lines stay out of install_bwrap_profile. Byte-equal to
# deploy/bwrap-userns-restrict.apparmor (regenerate with
# `bun run scripts/embed-deploy-scripts.ts`).
vendored_bwrap_profile() {
  cat <<'ISOMUX_BWRAP_USERNS_RESTRICT'
# isomux's vendored copy of Ubuntu's bwrap-userns-restrict AppArmor profile,
# used only when the box has no apparmor-profiles package to copy it from.
# Upstream (AppArmor project, profiles/apparmor/profiles/extras):
# https://gitlab.com/apparmor/apparmor/-/raw/aa74b9b12d9ed55909489403a0c2514b9ea6a95f/profiles/apparmor/profiles/extras/bwrap-userns-restrict
# Byte-identical to the copy apparmor-profiles 4.0.1-0ubuntu0.24.04.7 ships as
# /usr/share/apparmor/extra-profiles/bwrap-userns-restrict, except this header.
# The "disabled by default" note below is upstream's, and describes the
# PACKAGED copy: deploy/install.sh writes this one straight into
# /etc/apparmor.d/ and loads it, and only on a box where bwrap is already
# broken without it.

# This profile allows almost everything and only exists to allow
# bwrap to work on a system with user namespace restrictions
# being enforced.
# bwrap is allowed access to user namespaces and capabilities
# within the user namespace, but its children do not have
# capabilities, blocking bwrap from being able to be used to
# arbitrarily by-pass the user namespace restrictions.
#
# Note: the bwrap child is stacked against the bwrap profile due to
# bwraps use of no-new-privs

# disabled by default as it can break some use cases on a system that
# doesn't have or has disable user namespace restrictions for unconfined
# use aa-enforce to enable it

abi <abi/4.0>,

include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(attach_disconnected) {
  allow capability,
  # not allow all, to allow for pix stack
  # sadly we have to allow  m every where to allow children to work under
  # stacking.
  allow file rwlkm /{**,},
  allow network,
  allow unix,
  allow ptrace,
  allow signal,
  allow mqueue,
  allow io_uring,
  allow userns,
  allow mount,
  allow umount,
  allow pivot_root,
  allow dbus,
  allow px /** -> bwrap//&unpriv_bwrap,

  # the local include should not be used without understanding the userns
  # restriction.
  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/bwrap-userns-restrict>
}

profile unpriv_bwrap flags=(attach_disconnected) {
  # not allow all, to allow for pix stack
  allow file rwlkm /{**,},
  allow network,
  allow unix,
  allow ptrace,
  allow signal,
  allow mqueue,
  allow io_uring,
  allow userns,
  allow mount,
  allow umount,
  allow pivot_root,
  allow dbus,

  allow pix /** -> &unpriv_bwrap,

  audit deny capability,

  # the local include should not be used without understanding the userns
  # restriction.
  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/unpriv_bwrap>
}
ISOMUX_BWRAP_USERNS_RESTRICT
}

# Default ISOMUX_REF: the latest GitHub release of the target repo, so a
# fresh box lands on a pinned, tested version. The main fallback exists for
# exactly one case per repo class: the OFFICIAL repo falls back only on a
# genuine has-no-releases 404 (pre-first-release bootstrap) and FAILS CLOSED
# on transport/parse errors - a GitHub hiccup must not silently install
# un-gated main; forks and non-GitHub repos stay lenient (their release
# discipline is not ours to enforce).
# Any canonical form of the official repo (https with or without .git, ssh)
# counts as official for the fail-closed policy; a fork must not slip into
# the lenient branch by URL spelling alone, and vice versa.
is_official_repo() {
  local u=${ISOMUX_REPO%.git}
  [[ $u == https://github.com/nmamano/isomux || $u == git@github.com:nmamano/isomux ]]
}

resolve_default_ref() {
  [[ -z $ISOMUX_REF ]] || return 0
  local owner_repo=""
  if [[ $ISOMUX_REPO =~ ^https://github\.com/([^/]+/[^/]+)$ ]] ||
    [[ $ISOMUX_REPO =~ ^git@github\.com:([^/]+/[^/]+)$ ]]; then
    owner_repo=${BASH_REMATCH[1]%.git}
  fi
  if [[ -z $owner_repo ]]; then
    ISOMUX_REF=main
    log "no ISOMUX_REF given and the repo is not on github.com; installing main"
    return 0
  fi
  if ! command -v jq >/dev/null; then
    [[ -n $DRY_RUN ]] || die "jq is missing while resolving the default ISOMUX_REF (install_packages should have installed it)"
    ISOMUX_REF=main
    log "DRY-RUN: jq not installed yet; would resolve the latest release, assuming main"
    return 0
  fi
  local resp code body latest
  resp=$(curl -sS --max-time 15 -w '\n%{http_code}' \
    "https://api.github.com/repos/$owner_repo/releases/latest" 2>/dev/null) || resp=$'\n000'
  code=${resp##*$'\n'}
  body=${resp%$'\n'*}
  if [[ $code == 200 ]]; then
    latest=$(jq -r '.tag_name // empty' <<<"$body" 2>/dev/null) || latest=""
    if [[ -z $latest ]]; then
      is_official_repo &&
        die "could not parse the latest release of $owner_repo; set ISOMUX_REF explicitly to proceed"
      ISOMUX_REF=main
      log "warning: could not parse the latest release of $owner_repo; installing main"
      return 0
    fi
    ISOMUX_REF=$latest
    log "no ISOMUX_REF given; installing the latest release: $ISOMUX_REF"
  elif [[ $code == 404 ]]; then
    ISOMUX_REF=main
    log "no ISOMUX_REF given and $owner_repo has no releases yet; installing main"
  else
    is_official_repo &&
      die "could not determine the latest release of $owner_repo (HTTP $code); set ISOMUX_REF explicitly to proceed"
    ISOMUX_REF=main
    log "warning: latest-release lookup for $owner_repo failed (HTTP $code); installing main"
  fi
}

fetch_isomux() {
  step fetch-isomux
  resolve_default_ref
  if [[ ! -d $INSTALL_DIR/.git ]]; then
    run install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$INSTALL_DIR"
    run_as_service_user git clone "$ISOMUX_REPO" "$INSTALL_DIR"
  else
    # Keep origin in sync with ISOMUX_REPO so changing the parameter takes
    # effect on re-runs too. Pruning drops refs/tags that only existed on a
    # previously configured repo, so the ref fallbacks below can't resolve
    # stale objects.
    run_as_service_user git -C "$INSTALL_DIR" remote set-url origin "$ISOMUX_REPO"
  fi
  run_as_service_user git -C "$INSTALL_DIR" fetch --tags --prune --prune-tags origin
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would check out $ISOMUX_REF (detached)"
    return 0
  fi
  # Resolve the ref strictly against freshly fetched origin data: remote
  # branch, then the (pruned) tag namespace, then a direct fetch of the ref
  # (covers raw commits; GitHub allows fetching by SHA). Never generic local
  # resolution - after a repo switch, stale local branches and old-repo
  # objects still resolve locally and would silently install the wrong code.
  if as_service_user git -C "$INSTALL_DIR" rev-parse --verify --quiet "refs/remotes/origin/$ISOMUX_REF" >/dev/null; then
    as_service_user git -C "$INSTALL_DIR" checkout --detach "origin/$ISOMUX_REF"
  elif as_service_user git -C "$INSTALL_DIR" rev-parse --verify --quiet "refs/tags/$ISOMUX_REF" >/dev/null; then
    as_service_user git -C "$INSTALL_DIR" checkout --detach "refs/tags/$ISOMUX_REF"
  else
    as_service_user git -C "$INSTALL_DIR" fetch origin "$ISOMUX_REF"
    as_service_user git -C "$INSTALL_DIR" checkout --detach FETCH_HEAD
  fi
  log "checked out: $(as_service_user git -C "$INSTALL_DIR" rev-parse HEAD)"
}

build_isomux() {
  step build-isomux
  run_as_service_user bash -c "cd $INSTALL_DIR && /usr/local/bin/bun install --frozen-lockfile"
  # bun can leave node-pty configured but uncompiled: when an earlier install
  # attempt died mid-script (the first real VPS run: no toolchain yet), a
  # re-run treats the package as installed and never re-runs its build. The
  # terminal panel needs the binding, so reinstall the one package to force
  # the compile, and fail loudly rather than ship a box with a dead terminal.
  local pty_binding=$INSTALL_DIR/node_modules/node-pty/build/Release/pty.node
  if [[ -z $DRY_RUN && ! -f $pty_binding ]]; then
    log "node-pty native binding missing after bun install; rebuilding node-pty"
    run_as_service_user rm -rf "$INSTALL_DIR/node_modules/node-pty"
    run_as_service_user bash -c "cd $INSTALL_DIR && /usr/local/bin/bun install --frozen-lockfile"
    [[ -f $pty_binding ]] ||
      die "node-pty did not produce its native binding; the terminal panel would not work (check the bun install output above)"
  fi
  run_as_service_user bash -c "cd $INSTALL_DIR && /usr/local/bin/bun run build:ui"
}

# Root-of-trust config for the updater plus an installed copy of it. The
# copy's bytes come from a ROOT-OWNED fetch of $ISOMUX_REPO - never from
# $INSTALL_DIR: that checkout is writable by the service user (which agents
# run shell as), and on a re-run an already-running service could have
# replaced scripts/update.sh there; root promoting it to $UPDATER_PATH would
# hand that user root. scripts/update.sh refreshes itself on updates through
# the same trust repo. Older refs may predate the updater; skip with a note.
install_updater() {
  step install-updater
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would write $UPDATE_CONF, install $UPDATER_PATH from a root-owned fetch of $ISOMUX_REPO @ $ISOMUX_REF, and set up the in-UI trigger (isomux-update@.service + polkit rule)"
    return 0
  fi
  install -d -m 755 "$(dirname "$UPDATE_CONF")"
  install -d -m 700 "$UPDATE_STATE_DIR" "$UPDATE_STATE_DIR/snapshots"
  local trust=$UPDATE_STATE_DIR/trust.git
  [[ -d $trust ]] || git init -q --bare "$trust"
  # Branch and tag names fetch by ref; a raw commit sha also works against
  # GitHub (sha-in-want is enabled there).
  git -C "$trust" fetch -q --depth 1 "$ISOMUX_REPO" "$ISOMUX_REF" ||
    die "could not fetch $ISOMUX_REF from $ISOMUX_REPO for the updater installation"
  if ! git -C "$trust" cat-file -e FETCH_HEAD:scripts/update.sh 2>/dev/null; then
    log "this ref has no scripts/update.sh; skipping updater installation"
    return 0
  fi
  write_file "$UPDATE_CONF" 644 <<EOF
# Written by the isomux installer; read by $UPDATER_PATH.
REPO_DIR=$INSTALL_DIR
REPO_URL=$ISOMUX_REPO
SERVICE_NAME=isomux
SERVICE_KIND=system
SERVICE_USER=$SERVICE_USER
STATE_ROOT=$SERVICE_HOME/.isomux
SNAPSHOT_DIR=$UPDATE_STATE_DIR/snapshots
STATUS_DIR=$UPDATE_STATE_DIR
BUN=/usr/local/bin/bun
BASE_URL=http://127.0.0.1:4000
UPDATER_PATH=$UPDATER_PATH
EOF
  local tmp
  tmp=$(mktemp /tmp/isomux-updater.XXXXXXXXXX)
  git -C "$trust" cat-file -p FETCH_HEAD:scripts/update.sh >"$tmp"
  install -m 755 "$tmp" "$UPDATER_PATH"
  rm -f "$tmp"
  # In-UI update trigger escalation (release-design.md → "Update trigger"): the
  # server runs unprivileged, so the owner's update button asks systemd to
  # start this ROOT-owned template unit; the polkit rule grants the service
  # user exactly that - verb start on isomux-update@<calver-tag>.service, no
  # other unit, no other verb. This IS a new root-mediated capability for the
  # service user (which agents shell as); its safety rests on the tightly
  # constrained target, not on the HTTP layer's owner-only gate: everything
  # root executes is root-owned ($UPDATER_PATH, this unit file), the updater
  # resolves tags only through its root-owned trust repo against the
  # configured upstream, and the one caller-controlled input, the instance
  # name, is constrained by the regex below, by systemd's unit-name charset,
  # and by the updater's own CalVer check. Polkit rather than sudoers because
  # sudoers matches arguments with globs where * also matches spaces: a tag
  # wildcard there would also authorize appending arbitrary extra unit names
  # to the same systemctl call.
  write_file /etc/systemd/system/isomux-update@.service 644 <<EOF
[Unit]
Description=Isomux update to release %i

[Service]
Type=oneshot
ExecStart=$UPDATER_PATH %i
EOF
  install -d -m 755 /etc/polkit-1/rules.d
  write_file /etc/polkit-1/rules.d/50-isomux-update.rules 644 <<EOF
// Installed by the isomux installer. Lets the unprivileged service user start
// the root-owned update unit (and nothing else). polkitd picks this up
// automatically.
polkit.addRule(function (action, subject) {
  if (
    action.id === "org.freedesktop.systemd1.manage-units" &&
    subject.user === "$SERVICE_USER" &&
    action.lookup("verb") === "start" &&
    /^isomux-update@v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?\.service\$/.test(action.lookup("unit") || "")
  ) {
    return polkit.Result.YES;
  }
});
EOF
  systemctl daemon-reload
}

# Fresh installs resolve to v2026.8.22 or newer, where the distinctive
# server/isomux-office.ts entry point exists. Older units keep using the
# server/index.ts back-compat shim because dependency-only updates do not
# rewrite the service unit.
install_service() {
  step install-service
  # NO BACKTICKS AND NO $( ) BELOW, not even inside a comment. The delimiter is
  # unquoted because the unit expands $SERVICE_USER, $SERVICE_HOME and
  # $INSTALL_DIR, so everything else in here is expanded too - and a
  # backtick-quoted "systemctl restart isomux" in a comment ran for real,
  # spliced this installer's own log output into the unit, and made systemd
  # reject it with "Bad message" on every fresh install. Use "double quotes".
  # deploy/install-sh.test.ts renders this unit and fails if it regresses.
  write_file /etc/systemd/system/isomux.service 644 <<EOF
[Unit]
Description=Isomux server
After=network-online.target
Wants=network-online.target
# Restart=always below stops meaning always after 5 starts in 10 seconds:
# systemd's default gives up there and leaves the unit failed until a human
# intervenes. A memory spike can spend that budget in seconds - measured on a
# box under earlyoom pressure, systemd-resolved burned all five in two and
# stayed dead for three hours - and an office that is permanently down is a
# worse outcome than one that keeps trying. Retry forever; RestartSec below is
# what keeps forever from being a spin.
StartLimitIntervalSec=0

[Service]
User=$SERVICE_USER
Environment=HOME=$SERVICE_HOME
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/local/bin/bun run server/isomux-office.ts
Restart=always
# Matches what isomux-oom-protect writes for the daemons it protects. Only
# automatic restarts wait: "systemctl restart isomux" is not delayed by it.
RestartSec=5
Environment=PORT=4000
# Best-effort kill-order bias under memory pressure: killed after everything
# ordinary on the box, before only ssh/tailscaled (-900). Agents and builds
# inherit this score, so the directive cannot protect the server FROM its own
# agents - earlyoom does that steering; isomux-oom-protect sets the other
# tiers and configures it.
OOMScoreAdjust=-500
# systemd's default is "stop": ANY process in the unit being OOM-killed stops
# the unit, and Restart=always then recycles every agent on the box because one
# agent ran out of memory.
#
# Jointly necessary with the +300 stamp the server puts on its own descendants
# (server/oom-stamp.ts), and worth nothing without it: a dead MainPID ends the
# service whatever the policy says, so the stamp is what keeps the victim off
# the server and this is what keeps the unit alive once it is. Both halves
# measured in internal-docs/sizing-tiers-benchmark-results.md, "The blast
# radius, measured" - the pairing is the only configuration of the seven tested
# that cost one agent instead of all of them.
OOMPolicy=continue

[Install]
WantedBy=multi-user.target
EOF
  run systemctl daemon-reload
  run systemctl enable isomux
  run systemctl restart isomux
}

# Wait until the server answers on loopback. /auth/login-bg.png is served
# 200 both before and after the owner claim, with no auth.
wait_for_server() {
  step wait-for-server
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would wait for $BASE_URL to answer"
    return 0
  fi
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  until curl -fsS -o /dev/null --max-time 5 "$BASE_URL/auth/login-bg.png" 2>/dev/null; do
    ((SECONDS < deadline)) || die "isomux did not come up within ${HEALTH_TIMEOUT_S}s; check: journalctl -u isomux"
    sleep 2
  done
  log "isomux is answering on loopback"
}

# True if the saved session cookie still authenticates.
have_valid_session() {
  [[ -s $COOKIE_JAR ]] && api_curl -o /dev/null "$BASE_URL/api/sessions" 2>/dev/null
}

# Resolve the current owner's display name from the live user records (root
# can read the service user's state). The records win over OWNER_NAME: the
# owner may have been renamed since the claim, or OWNER_NAME may differ
# between runs. Precedence: the stable userId this installer saved after its
# last successful mint (rename-proof), then - for state from older runs that
# only saved a name - the saved name, then OWNER_NAME; with a single owner
# the record itself decides.
resolve_owner_name() {
  local users_file=$SERVICE_HOME/.isomux/users.json
  [[ -r $users_file ]] || die "cannot read $users_file to find the office owner"
  local saved_id="" by_id
  [[ -s $STATE_DIR/owner-id ]] && saved_id=$(<"$STATE_DIR/owner-id")
  if [[ -n $saved_id ]]; then
    by_id=$(jq -r --arg id "$saved_id" \
      '.[$id] | select(.role == "owner") | .name // empty' "$users_file")
    if [[ -n $by_id ]]; then
      printf '%s\n' "$by_id"
      return 0
    fi
  fi
  local owners
  owners=$(jq -r '[.[] | select(.role == "owner") | .name] | .[]' "$users_file")
  [[ -n $owners ]] || die "no owner found in $users_file"
  if [[ $(wc -l <<<"$owners") -eq 1 ]]; then
    printf '%s\n' "$owners"
    return 0
  fi
  local saved=""
  [[ -s $STATE_DIR/owner-name ]] && saved=$(<"$STATE_DIR/owner-name")
  local candidate
  for candidate in "$saved" "$OWNER_NAME"; do
    if [[ -n $candidate ]] && grep -Fxq "$candidate" <<<"$owners"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  die "several owners exist ($(paste -sd, <<<"$owners")); re-run with OWNER_NAME set to one of them"
}

# Establish an owner session cookie in $COOKIE_JAR. Three cases:
#   1. office unclaimed -> claim it via the tokenless loopback claim form;
#   2. claimed + saved cookie still valid -> reuse it;
#   3. claimed + no valid cookie (re-run after partial failure) -> mint an
#      owner-login invite over the admin unix socket and accept it.
claim_owner() {
  step claim-owner
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would claim office ownership as \"$OWNER_NAME\" via loopback"
    return 0
  fi
  local probe
  probe=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/")
  if [[ $probe == 200 ]]; then
    # Pre-claim the server serves the claim form at GET /.
    touch "$COOKIE_JAR" && chmod 600 "$COOKIE_JAR"
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" \
      -H "Origin: http://localhost:4000" \
      --data-urlencode "name=$OWNER_NAME" \
      "$BASE_URL/auth/claim")
    [[ $code == 302 ]] || die "owner claim was refused (HTTP $code)"
    printf '%s\n' "$OWNER_NAME" | write_file "$STATE_DIR/owner-name" 600
    log "claimed office ownership as \"$OWNER_NAME\""
    return 0
  fi
  if have_valid_session; then
    log "office already claimed; reusing the saved owner session"
    return 0
  fi
  log "office already claimed and no saved session; recovering via the admin socket"
  [[ -S $ADMIN_SOCK ]] || die "office is claimed but $ADMIN_SOCK is missing; is the isomux service running as $SERVICE_USER?"
  local owner
  owner=$(resolve_owner_name)
  [[ $owner == "$OWNER_NAME" ]] || log "note: the office owner is named \"$owner\"; ignoring OWNER_NAME=\"$OWNER_NAME\""
  local resp url token
  resp=$(curl -fsS --unix-socket "$ADMIN_SOCK" -X POST http://localhost/admin/owner-login \
    -H 'Content-Type: application/json' \
    --data "$(jq -n --arg name "$owner" '{name: $name}')")
  url=$(jq -r '.url // empty' <<<"$resp")
  [[ -n $url ]] || die "admin-socket owner-login failed: $(jq -r '.error // "unknown error"' <<<"$resp")"
  token=${url##*/i/}
  touch "$COOKIE_JAR" && chmod 600 "$COOKIE_JAR"
  # The login token stays off the argv (visible in ps): curl reads it from
  # stdin via the @- form.
  local code
  code=$(printf '%s' "$token" | curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" \
    -H 'Sec-Fetch-Site: same-origin' \
    --data-urlencode "token@-" \
    "$BASE_URL/auth/accept")
  [[ $code == 302 ]] || die "owner-login invite accept was refused (HTTP $code)"
  printf '%s\n' "$owner" | write_file "$STATE_DIR/owner-name" 600
  log "recovered an owner session for \"$owner\""
}

# Persist the public origin + external access, then restart so the server
# rebinds and starts minting URLs at https://DOMAIN.
#
# This deliberately goes through the office-access REST surface (persisted
# to office-config.json) rather than the ISOMUX_PUBLIC_ORIGIN env var: the
# env var is deprecated (the server migrates it to office-config.json and
# rejects a conflicting value on save).
configure_public_access() {
  step configure-public-access
  if [[ -n $DRY_RUN ]]; then
    log "DRY-RUN: would set publicOrigin=https://$DOMAIN, externalAccess=true, and restart isomux"
    return 0
  fi
  api_curl -o /dev/null -X PUT "$BASE_URL/api/office/access" \
    -H 'Content-Type: application/json' \
    --data "$(jq -n --arg origin "https://$DOMAIN" '{externalAccess: true, publicOrigin: $origin}')" ||
    die "saving the public origin failed; check: journalctl -u isomux"
  run systemctl restart isomux
  wait_for_server
  step configure-public-access
}

# Mint the single-use owner invite link the customer signs in with (24h TTL).
mint_invite() {
  step mint-invite
  if [[ -n $DRY_RUN ]]; then
    INVITE_URL="https://$DOMAIN/i/dry-run"
    RESOLVED_OWNER_NAME=$OWNER_NAME
    return 0
  fi
  # Resolve our own userId (and the owner's current display name, for the
  # final report): the session prefix is the first 8 chars of the raw
  # cookie value.
  local raw prefix session user_id
  # Both cookie names can sit in the jar (an HTTPS office writes the
  # __Host- one; a jar carried over from before also holds the legacy one).
  # Prefer __Host- regardless of row order, so the prefix below identifies
  # the session the server itself would select.
  raw=$(awk '
    $6 == "__Host-isomux_session" { h = $7 }
    $6 == "isomux_session" { l = $7 }
    END { print (h != "" ? h : l) }
  ' "$COOKIE_JAR")
  [[ -n $raw ]] || die "no session cookie in $COOKIE_JAR"
  prefix=${raw:0:8}
  session=$(api_curl "$BASE_URL/api/sessions" |
    jq -c --arg p "$prefix" '.sessions[] | select(.sessionPrefix == $p)')
  user_id=$(jq -r '.userId // empty' <<<"$session")
  [[ -n $user_id ]] || die "could not resolve the owner userId from /api/sessions"
  RESOLVED_OWNER_NAME=$(jq -r '.username // empty' <<<"$session")
  # Persist the stable id so a later re-run can recover the session even if
  # the owner has been renamed and other owners exist (ids survive renames;
  # names don't).
  printf '%s\n' "$user_id" | write_file "$STATE_DIR/owner-id" 600
  INVITE_URL=$(api_curl -X POST "$BASE_URL/api/invites/recovery" \
    -H 'Content-Type: application/json' \
    --data "$(jq -n --arg id "$user_id" '{userId: $id}')" | jq -r '.url // empty')
  [[ -n $INVITE_URL ]] || die "minting the owner invite failed"
  printf '%s\n' "$INVITE_URL" | write_file "$INVITE_FILE" 600
}

install_hosted_tls_renewal() {
  [[ -f /etc/isomux/renewal/enrollment.json ]] || return 0
  install -d -m 0750 -o root -g caddy /etc/isomux/tls
  write_file /usr/local/sbin/isomux-renew-certificate 700 <<'RENEW_HELPER'
#!/usr/bin/env bash
set -euo pipefail
enrollment=/etc/isomux/renewal/enrollment.json
tls_dir=/etc/isomux/tls
domain=${DOMAIN:?DOMAIN is required}
endpoint=$(jq -er .endpoint "$enrollment")
token=$(jq -er .token "$enrollment")
status_endpoint=${endpoint%/renew}/status
install -d -m 0750 -o root -g caddy "$tls_dir"
key="$tls_dir/key.pem"
if [[ ! -f $key ]]; then
  key_tmp="$tls_dir/.key.$$"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$key_tmp"
  chown root:caddy "$key_tmp"
  chmod 0640 "$key_tmp"
  sync -f "$key_tmp"
  mv -f "$key_tmp" "$key"
fi
csr=$(mktemp "$tls_dir/.request.XXXXXX")
answer=$(mktemp "$tls_dir/.answer.XXXXXX")
cert_tmp=$(mktemp "$tls_dir/.cert.XXXXXX")
curl_config=$(mktemp "$tls_dir/.curl.XXXXXX")
trap 'rm -f "$csr" "$answer" "$cert_tmp" "$curl_config"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$token" > "$curl_config"
chmod 0600 "$curl_config"
report_status() {
  curl --fail --silent --show-error --config "$curl_config" \
    -H 'Content-Type: application/json' --data "{\"status\":\"$1\"}" \
    "$status_endpoint" >/dev/null
}
trap 'rc=$?; trap - ERR; report_status failed || true; exit "$rc"' ERR
openssl req -new -key "$key" -subj "/CN=$domain" \
  -addext "subjectAltName=DNS:$domain,DNS:*.$domain" -out "$csr"
jq -n --rawfile csr "$csr" '{csr:$csr}' | \
  curl --fail --silent --show-error --retry 3 \
    --config "$curl_config" -H 'Content-Type: application/json' \
    --data-binary @- "$endpoint" > "$answer"
jq -er .certificate "$answer" > "$cert_tmp"
cert_names=$(openssl x509 -in "$cert_tmp" -noout -ext subjectAltName)
grep -Fq "DNS:$domain" <<<"$cert_names"
grep -Fq "DNS:*.$domain" <<<"$cert_names"
[[ $(openssl x509 -in "$cert_tmp" -pubkey -noout | sha256sum) == \
   $(openssl pkey -in "$key" -pubout | sha256sum) ]]
  chown root:caddy "$cert_tmp"
  chmod 0640 "$cert_tmp"
# Test through Caddy's account. A root read would hide a root-only key.
runuser -u caddy -- openssl x509 -in "$cert_tmp" -noout >/dev/null
runuser -u caddy -- openssl pkey -in "$key" -noout >/dev/null
if [[ -f $tls_dir/cert.pem ]] && cmp -s "$cert_tmp" "$tls_dir/cert.pem"; then
  report_status ok
  exit 0
fi
sync -f "$cert_tmp"
old_cert="$tls_dir/.cert.previous"
[[ ! -f $tls_dir/cert.pem ]] || cp -a "$tls_dir/cert.pem" "$old_cert"
mv -f "$cert_tmp" "$tls_dir/cert.pem"
sync -f "$tls_dir"
if systemctl is-active --quiet caddy && ! systemctl restart caddy; then
  if [[ -f $old_cert ]]; then
    mv -f "$old_cert" "$tls_dir/cert.pem"
    sync -f "$tls_dir"
    systemctl restart caddy || true
  fi
  report_status failed || true
  exit 1
fi
rm -f "$old_cert"
report_status ok
RENEW_HELPER
  write_file /etc/systemd/system/isomux-certificate-renew.service 644 <<EOF
[Unit]
Description=Renew the Isomux office certificate
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=DOMAIN=$DOMAIN
ExecStart=/usr/local/sbin/isomux-renew-certificate
EOF
  write_file /etc/systemd/system/isomux-certificate-renew.timer 644 <<'EOF'
[Unit]
Description=Check the Isomux office certificate each day

[Timer]
OnCalendar=daily
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF
  run systemctl daemon-reload
  run env DOMAIN="$DOMAIN" /usr/local/sbin/isomux-renew-certificate
  run systemctl enable --now isomux-certificate-renew.timer
}

install_caddyfile_transaction() {
  local rendered=$1 final=/etc/caddy/Caddyfile old=/etc/caddy/.Caddyfile.isomux-old
  run caddy validate --config "$rendered" --adapter caddyfile
  if [[ -f /etc/isomux/tls/key.pem ]]; then
    assert_caddy_file /etc/isomux/tls/key.pem
    assert_caddy_file /etc/isomux/tls/cert.pem
    run runuser -u caddy -- openssl pkey -in /etc/isomux/tls/key.pem -noout
    run runuser -u caddy -- openssl x509 -in /etc/isomux/tls/cert.pem -noout
  fi
  sync -f "$rendered"
  [[ ! -f $final ]] || cp -a "$final" "$old"
  mv -f "$rendered" "$final"
  sync -f /etc/caddy
  if ! systemctl restart caddy; then
    if [[ -f $old ]]; then
      cp -a "$old" "$rendered"
      sync -f "$rendered"
      mv -f "$rendered" "$final"
      sync -f /etc/caddy
      systemctl restart caddy || true
    fi
    die "Caddy rejected the new configuration; the previous file was restored"
  fi
  rm -f "$old"
}

assert_caddy_file() {
  local file=$1 expected
  expected=$(stat -c '%U:%G:%a' "$file")
  [[ $expected == root:caddy:640 ]] || {
    log "Caddy cannot use $file: expected root:caddy 640, got $expected"
    return 1
  }
  [[ $(stat -c '%U:%G:%a' "$(dirname "$file")") == root:caddy:750 ]]
}

configure_caddy() {
  step configure-caddy
  # `admin off` turns off Caddy's admin API, which otherwise listens on
  # 127.0.0.1:2019 and can rewrite the whole proxy config with no credential.
  # Loopback is not a trust boundary on this box: agents run here as a local
  # user, and any web app they build is one SSRF or open-proxy bug away from
  # reaching it from outside. Nothing in isomux drives Caddy through the API - 
  # this installer restarts the service instead - so the only thing lost is
  # `caddy reload` / `systemctl reload caddy` on this box; a restart still
  # applies a changed Caddyfile.
  #
  # The second site block is what makes registered apps reachable at their own
  # hostnames (`hello.$DOMAIN`). It needs a wildcard DNS record - without one
  # nothing ever arrives there and the block is inert - and it terminates TLS
  # ON DEMAND, because a wildcard record means the set of names is not known in
  # advance. Anyone can therefore point any name under $DOMAIN at this box, so
  # every certificate is gated by `ask`, which the office answers.
  #
  # What `ask` actually gates, measured rather than assumed: Caddy calls it
  # before obtaining a certificate AND before loading one from storage, so a
  # restart of this service asks about every name again and a refusal then
  # refuses the handshake even though the certificate exists. A certificate
  # already in memory is served without asking, so cutting a name off takes
  # effect at the next cold load rather than immediately. The office approves
  # its own host and any live app label. There is no issuance counter in this
  # request gate.
  #
  # Caddy's wildcard matches exactly one label, which is the shape apps use.
  #
  # The `respond` line keeps that gate off the public internet: Caddy calls the
  # ask URL directly over loopback and never through a site block, so refusing
  # the exact path here costs nothing and stops a stranger from asking the
  # office which apps exist. Only on the office's own site - an app host serves
  # its sign-in handshake under the same prefix.
  #
  # The update path deliberately never rewrites this file: turning app
  # hostnames on for an office that already exists is an operator's decision
  # (it needs a DNS record they have to add anyway), so it is a documented
  # step, not something an update does to them.
  install_hosted_tls_renewal
  local rendered
  rendered=$(mktemp /etc/caddy/.Caddyfile.XXXXXX)
  if [[ -f /etc/isomux/renewal/enrollment.json ]]; then
    cat > "$rendered" <<EOF
$CADDY_MARKER
{
	admin off
}

$DOMAIN {
	tls /etc/isomux/tls/cert.pem /etc/isomux/tls/key.pem
	respond /__isomux/tls-ask 404
	reverse_proxy 127.0.0.1:4000
}

*.$DOMAIN {
	tls /etc/isomux/tls/cert.pem /etc/isomux/tls/key.pem
	forward_auth 127.0.0.1:4000 {
		uri /__isomux/tls-ask?domain={http.request.host}
	}
	reverse_proxy 127.0.0.1:4000
}
EOF
  else
    cat > "$rendered" <<EOF
$CADDY_MARKER
{
	admin off
	on_demand_tls {
		ask http://127.0.0.1:4000/__isomux/tls-ask
	}
}

$DOMAIN {
	respond /__isomux/tls-ask 404
	reverse_proxy 127.0.0.1:4000
}

*.$DOMAIN {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:4000
}
EOF
  fi
  chmod 0644 "$rendered"
  run systemctl enable caddy
  install_caddyfile_transaction "$rendered"
}

report() {
  step report
  [[ -z $FAILURE_SENTINEL ]] || rm -f "$FAILURE_SENTINEL"
  log "=============================================================="
  log "Isomux is installed."
  log ""
  log "  Office URL:   https://$DOMAIN"
  if output_is_watched; then
    log "  Owner invite: $INVITE_URL"
    log ""
    log "The invite link is single-use and valid for 24 hours; opening it"
    log "signs you in as \"$RESOLVED_OWNER_NAME\" (changeable later). It is"
    log "also saved on this server at $INVITE_FILE, readable only by root."
  else
    log "  Owner invite: saved at $INVITE_FILE"
    log ""
    log "The invite link is not printed here so it does not end up in a log."
    log "To read it on the server, as root:"
    log ""
    log "  cat $INVITE_FILE"
    log ""
    log "The link is single-use and valid for 24 hours; opening it signs you"
    log "in as \"$RESOLVED_OWNER_NAME\" (changeable later)."
  fi
  log "To mint a fresh one, re-run this installer."
  log ""
  SERVER_IPV4=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)
  if [[ -n $SERVER_IPV4 ]]; then
    log "HTTPS needs the A record for $DOMAIN to point at this server's IP ($SERVER_IPV4);"
  else
    log "HTTPS needs the A record for $DOMAIN to point at this server's IP;"
  fi
  log "Caddy keeps retrying the certificate until it does."
  if [[ -n $SSH_HARDENING_SKIPPED ]]; then
    log ""
    log "One thing left: this box had no SSH key on it, so password logins are"
    log "still allowed. Add your key, then run:  sudo isomux-harden-ssh"
  fi
  log "=============================================================="
  if [[ -n $INSTALL_CALLBACK_URL && -z $DRY_RUN ]]; then
    # The invite URL is a credential; keep it off the argv (visible in ps)
    # by feeding the JSON body through stdin.
    jq -n --arg url "$INVITE_URL" '{inviteUrl: $url, status: "ok"}' |
      curl -fsS -X POST "$INSTALL_CALLBACK_URL" -H 'Content-Type: application/json' --data @- \
        >/dev/null 2>&1 || log "warning: success callback to INSTALL_CALLBACK_URL did not go through"
  fi
}

# System dependencies only (ISOMUX_DEPS_ONLY=1). This is what scripts/update.sh
# runs from the TARGET release, so an update delivers the system dependencies
# that release needs - the checkout-only updater cannot (a box installed before
# the Node.js step, for example, keeps a dead terminal panel through every
# update until someone re-runs the whole installer).
#
# Deliberately narrow, because it runs on a live, configured box:
#   - install_packages, install_browser and configure_codex_sandbox are the
#     steps that install system dependencies, and all three are additive and
#     idempotent. The sandbox step only touches AppArmor on a box where
#     bubblewrap is already broken, so a sync cannot change a working box's
#     policy.
#   - NOT the firewall, SSH hardening, or unattended upgrades: that is box
#     policy the operator may have adjusted since the install, and an update
#     must not silently reimpose ours.
#   - NOT install_bun: a release never switches the runtime under a running
#     box (release-design.md, "Bun invariant" - the updater warns about a pin
#     change instead, and its rollback has to run on the installed bun).
#   - NOT the service, Caddy, the owner claim, or the invite: nothing about
#     this box's identity changes during an update. configure_user_manager is
#     the one deliberate exception, and a narrow one: it enables linger and
#     adds a drop-in naming the service account's user bus, which is what a box
#     installed before apps existed needs before it can run any. It changes the
#     service's runtime environment rather than the box's identity, adds
#     without rewriting the unit or restarting anything, and the updater's own
#     restart is what picks it up. Without it that convergence would be a
#     manual step on every existing install.
deps_only() {
  step preflight-deps
  [[ $EUID -eq 0 ]] || die "ISOMUX_DEPS_ONLY needs root (it installs system packages)"
  command -v apt-get >/dev/null || die "apt-get not found; this installer supports Ubuntu (24.04)"
  # install_browser verifies a real capture AS the service user, so a box
  # missing that account would fail deep inside the browser step instead of
  # here. It exists on every box the updater runs on (the installer created it).
  id -u "$SERVICE_USER" >/dev/null 2>&1 ||
    die "no $SERVICE_USER account on this box; it does not look like an isomux install"
  snapshot_caddy_state
  install_packages
  # A sync that cannot put the proxy back has failed, whatever apt reported:
  # the office would be unreachable and the update would carry on regardless.
  restore_caddy_state ||
    die "installed the system dependencies but could not restore caddy to active=${CADDY_PRIOR_ACTIVE:-no} enabled=${CADDY_PRIOR_ENABLED:-no}; the office's public URL may be down. Check: systemctl status caddy"
  install_browser
  configure_codex_sandbox
  configure_user_manager
  step report
  [[ -z $FAILURE_SENTINEL ]] || rm -f "$FAILURE_SENTINEL"
  log "system dependencies are up to date"
}

main() {
  # Taken before preflight: a dependency sync has no DOMAIN and no business
  # validating full-install parameters.
  if [[ $ISOMUX_DEPS_ONLY == 1 ]]; then
    deps_only
    return
  fi
  preflight
  install_packages
  configure_firewall
  harden_ssh
  enable_auto_updates
  configure_oom_protection
  create_service_user
  configure_user_manager
  check_root_reachability
  install_browser
  configure_codex_sandbox
  fetch_isomux
  install_bun
  build_isomux
  install_updater
  install_service
  wait_for_server
  assert_hardening
  claim_owner
  configure_public_access
  mint_invite
  configure_caddy
  report
}

main "$@"
