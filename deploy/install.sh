#!/usr/bin/env bash
# Unattended isomux VPS installer.
#
# Turns a fresh Ubuntu 24.04 server into an HTTPS-served isomux instance:
# bun + isomux (systemd service) + Caddy with automatic Let's Encrypt +
# firewall/SSH hardening + unattended security updates (a standard Ubuntu
# feature — it patches system packages, never isomux itself). Ends by
# claiming the office owner, minting a single-use owner invite link,
# printing it, saving it to /var/lib/isomux-install/invite-url, and
# optionally POSTing it to a callback URL.
#
# Usage (as root):
#
#   DOMAIN=office.example.com bash install.sh
#
# or as cloud-init user-data:
#
#   #!/bin/bash
#   export DOMAIN=office.example.com
#   curl -fsSL https://raw.githubusercontent.com/nmamano/isomux/main/deploy/install.sh | bash
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

# --- Constants --------------------------------------------------------------

INSTALL_DIR=/opt/isomux
SERVICE_USER=isomux
SERVICE_HOME=/home/isomux
STATE_DIR=/var/lib/isomux-install
UPDATER_PATH=/usr/local/sbin/isomux-update
UPDATE_CONF=/etc/isomux/update.conf
UPDATE_STATE_DIR=/var/lib/isomux-update
COOKIE_JAR=$STATE_DIR/session.cookies
INVITE_FILE=$STATE_DIR/invite-url
BASE_URL=http://127.0.0.1:4000
ADMIN_SOCK=$SERVICE_HOME/.isomux/admin.sock
HEALTH_TIMEOUT_S=180
CADDY_MARKER="# Managed by the isomux installer"

CURRENT_STEP=preflight
INVITE_URL=""
# Set while caddy is temporarily masked around the package operation, so the
# failure path can guarantee the unmask and a re-run starts clean.
CADDY_MASKED=""
# Display name of the owner the minted invite signs in as. Set from the live
# session in mint_invite; OWNER_NAME is only the name used at claim time.
RESOLVED_OWNER_NAME=""

# --- Helpers ----------------------------------------------------------------

log() { printf '[isomux-install] %s\n' "$*"; }

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
# authority boundary (port, path, query, fragment, or end of string) — a
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
  # as literal key=value (never sourced) — but keep the value to a plain
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
  # runs — the mask is what closes the window, because the package postinst
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
  run apt-get install -y curl ca-certificates gnupg git jq unzip ufw unattended-upgrades polkitd build-essential python3
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
    apt-get install -y caddy nodejs
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

harden_ssh() {
  step harden-ssh
  # Refuse to disable password auth when no key can get back in. Assumption:
  # any non-empty authorized_keys under /root or /home belongs to an account
  # the operator can log in with — true on a freshly provisioned VPS, where
  # these are the provider-created login accounts.
  local has_keys=""
  local f
  for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
    [[ -s $f ]] && has_keys=1
  done
  if [[ -z $has_keys ]]; then
    log "warning: no authorized_keys found on this box; skipping SSH hardening so you don't get locked out. Add a key and re-run to apply it."
    return 0
  fi
  write_file /etc/ssh/sshd_config.d/90-isomux-hardening.conf 644 <<'EOF'
# Installed by the isomux VPS installer: key-only SSH auth.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  [[ -n $DRY_RUN ]] && return 0
  # The drop-in composes with whatever sshd config the box already has;
  # validate the aggregate before it can take effect, and back out our file
  # if the result is broken.
  if ! sshd -t 2>/dev/null; then
    rm -f /etc/ssh/sshd_config.d/90-isomux-hardening.conf
    die "sshd rejected the configuration with the hardening drop-in; removed it again. Run sshd -t to inspect the preexisting config."
  fi
  # Ubuntu 24.04 socket-activates ssh; reload only applies if it's running.
  if systemctl is-active -q ssh; then
    systemctl reload ssh
  fi
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

# Default ISOMUX_REF: the latest GitHub release of the target repo, so a
# fresh box lands on a pinned, tested version. The main fallback exists for
# exactly one case per repo class: the OFFICIAL repo falls back only on a
# genuine has-no-releases 404 (pre-first-release bootstrap) and FAILS CLOSED
# on transport/parse errors — a GitHub hiccup must not silently install
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
  # resolution — after a repo switch, stale local branches and old-repo
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
# copy's bytes come from a ROOT-OWNED fetch of $ISOMUX_REPO — never from
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
  # user exactly that — verb start on isomux-update@<calver-tag>.service, no
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

install_service() {
  step install-service
  write_file /etc/systemd/system/isomux.service 644 <<EOF
[Unit]
Description=Isomux server
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
Environment=HOME=$SERVICE_HOME
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/local/bin/bun run server/index.ts
Restart=always
RestartSec=2
Environment=PORT=4000

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
# last successful mint (rename-proof), then — for state from older runs that
# only saved a name — the saved name, then OWNER_NAME; with a single owner
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
  raw=$(awk '$6 == "isomux_session" { v = $7 } END { print v }' "$COOKIE_JAR")
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

configure_caddy() {
  step configure-caddy
  write_file /etc/caddy/Caddyfile 644 <<EOF
$CADDY_MARKER
$DOMAIN {
	reverse_proxy 127.0.0.1:4000
}
EOF
  run systemctl enable caddy
  run systemctl restart caddy
}

report() {
  step report
  [[ -z $FAILURE_SENTINEL ]] || rm -f "$FAILURE_SENTINEL"
  log "=============================================================="
  log "Isomux is installed."
  log ""
  log "  Office URL:   https://$DOMAIN"
  log "  Owner invite: $INVITE_URL"
  log ""
  log "The invite link is single-use and valid for 24 hours; opening it"
  log "signs you in as \"$RESOLVED_OWNER_NAME\" (changeable later). It is"
  log "also saved on this server at $INVITE_FILE, readable only by root."
  log "To mint a fresh one, re-run this installer."
  log ""
  SERVER_IPV4=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)
  if [[ -n $SERVER_IPV4 ]]; then
    log "HTTPS needs the A record for $DOMAIN to point at this server's IP ($SERVER_IPV4);"
  else
    log "HTTPS needs the A record for $DOMAIN to point at this server's IP;"
  fi
  log "Caddy keeps retrying the certificate until it does."
  log "=============================================================="
  if [[ -n $INSTALL_CALLBACK_URL && -z $DRY_RUN ]]; then
    # The invite URL is a credential; keep it off the argv (visible in ps)
    # by feeding the JSON body through stdin.
    jq -n --arg url "$INVITE_URL" '{inviteUrl: $url, status: "ok"}' |
      curl -fsS -X POST "$INSTALL_CALLBACK_URL" -H 'Content-Type: application/json' --data @- \
        >/dev/null 2>&1 || log "warning: success callback to INSTALL_CALLBACK_URL did not go through"
  fi
}

main() {
  preflight
  install_packages
  configure_firewall
  harden_ssh
  enable_auto_updates
  create_service_user
  fetch_isomux
  install_bun
  build_isomux
  install_updater
  install_service
  wait_for_server
  claim_owner
  configure_public_access
  mint_invite
  configure_caddy
  report
}

main "$@"
