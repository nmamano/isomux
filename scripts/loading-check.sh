#!/usr/bin/env bash
# The loading check: a view of the demo while its data is held, then loaded,
# and what jumped. Usage and exit codes: scripts/loading-check.mjs.
#   bash scripts/loading-check.sh /tmp/t-<task8>/loading -- 'button[data-sidebar-nav="settings"]'
exec bun "$(dirname "$0")/loading-check.mjs" "$@"
