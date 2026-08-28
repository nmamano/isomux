#!/usr/bin/env bash
# isomux-verify-hardening - read-only checks for an isomux VPS.
#
# The installer runs this after it configures the firewall. The updater runs it
# only on a box whose Caddyfile still carries the installer marker. Operators
# can also run it after a migration or a manual repair:
#
#   sudo isomux-verify-hardening --check
#
# This file is embedded verbatim in deploy/install.sh. Edit this file, then run
# `bun run scripts/embed-deploy-scripts.ts` to update the embedded copy.

set -Eeuo pipefail

HARDEN_TOOL=${HARDEN_TOOL:-/usr/local/sbin/isomux-harden-ssh}
TAG=isomux-verify-hardening

log() { printf '[%s] %s\n' "$TAG" "$*"; }

usage() {
  cat <<'EOF'
Usage: isomux-verify-hardening --check

Checks the active firewall against the ports the installer expects, then runs
the SSH privilege check. It changes nothing.

Exit status: 0 passed, 1 failed, 2 could not tell, 10 no ufw installation.
EOF
}

firewall_check() {
  if ! command -v ufw >/dev/null; then
    return 10
  fi

  local status ports port shortfall=""
  if ! status=$(LC_ALL=C ufw status verbose 2>/dev/null) || [[ -z $status ]]; then
    log "FIREWALL CHECK INCOMPLETE - ufw did not report its status"
    return 2
  fi
  grep -q '^Status: active$' <<<"$status" || shortfall+="; ufw is not active"
  grep -Eq '^Default: deny \(incoming\), allow \(outgoing\)' <<<"$status" ||
    shortfall+="; defaults are not deny incoming and allow outgoing"

  ports=$'80\n443'
  if command -v sshd >/dev/null; then
    local ssh_ports
    ssh_ports=$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }') || true
    if [[ -z $ssh_ports ]]; then
      shortfall+="; sshd would not report its listening port"
    else
      ports+=$'\n'"$ssh_ports"
    fi
  fi

  while IFS= read -r port; do
    [[ -n $port ]] || continue
    if ! awk -v target="$port" '
      $1 == target || $1 == target "/tcp" {
        for (i = 2; i <= NF; i++) if ($i == "ALLOW" || $i == "ALLOW-IN") found = 1
      }
      END { exit found ? 0 : 1 }
    ' <<<"$status"; then
      shortfall+="; TCP port $port is not allowed"
    fi
  done <<<"$(printf '%s\n' "$ports" | awk '!seen[$0]++')"

  if [[ -n $shortfall ]]; then
    log "FIREWALL CHECK FAILED - ${shortfall#; }"
    return 1
  fi
  log "firewall check passed"
}

main() {
  [[ (${1:-} == --check || ${1:-} == --check-firewall) && $# -eq 1 ]] || {
    usage
    exit 3
  }

  local firewall_rc=0 ssh_rc=0
  firewall_check || firewall_rc=$?
  ((firewall_rc == 10)) && exit 10
  if [[ $1 == --check-firewall ]]; then
    exit "$firewall_rc"
  fi

  if [[ ! -x $HARDEN_TOOL ]]; then
    log "HARDENING CHECK INCOMPLETE - $HARDEN_TOOL is not installed"
    ssh_rc=2
  else
    "$HARDEN_TOOL" --check || ssh_rc=$?
  fi

  ((firewall_rc == 0 && ssh_rc == 0)) && exit 0
  ((firewall_rc == 2 || ssh_rc == 2 || ssh_rc == 3)) && exit 2
  exit 1
}

main "$@"
