#!/usr/bin/env bash
# Load the target installer, then stop at its TLS boundary. Everything through
# mint_invite runs unchanged; certificate enrollment needs a real control plane.
set -Eeuo pipefail
installer=${1:?installer path required}
[[ $(tail -n 1 "$installer") == 'main "$@"' ]] || {
  echo 'installer entry point changed; update the hosted smoke wrapper' >&2
  exit 1
}
source <(sed '$d' "$installer")
configure_caddy() { echo HOSTED_SMOKE_TLS_BOUNDARY; exit 0; }
main
echo "configure_caddy boundary not reached" >&2
exit 1
