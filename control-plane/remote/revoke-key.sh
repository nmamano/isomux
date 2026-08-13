#!/usr/bin/env bash
# Remove our key and our artifacts from the box, and confirm from disk.
#
# Matching is on the EXACT base64 blob field, never a substring: deleting a line
# because it happens to contain our blob inside a longer key or a comment would
# remove somebody else's access, and the customer's own key is the one thing on
# this box we must not touch.
#
# The cleanup timer is deliberately NOT removed here. It is the backstop that
# has to stay in place while the removal proof runs, and with no customer key
# there is no post-proof SSH path to take it away - so it self-removes at its
# deadline instead. Removing it before the proof would tear down enforcement in
# the exact window where the proof might report that the removal failed.
#
# Idempotent: an absent line is a no-op, and every removal is forced.
#
# Requires the ak_* helpers to be prepended (composeRemoteScript in driver.ts).
#
# Usage: revoke-key.sh <authorized_keys> <blob> [customer_blob]

set -euo pipefail

AK=${1:?authorized_keys path required}
BLOB=${2:?key blob required}
CUSTOMER_BLOB=${3:-}

if [ -f "$AK" ] && [ "$(ak_count_exact "$AK" "$BLOB")" -gt 0 ]; then
  tmp=$(mktemp "$AK.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  while IFS= read -r line || [ -n "$line" ]; do
    [ "$(ak_blob_of "$line")" = "$BLOB" ] || printf '%s\n' "$line"
  done <"$AK" >"$tmp"
  ak_replace_durably "$AK" "$tmp"
  trap - EXIT
fi

rm -rf /var/lib/isomux-cp
rm -f /usr/local/sbin/isomux-cp-run

# Read back from disk. Believing our own write is how a revocation reports
# success it did not achieve.
if [ -f "$AK" ] && [ "$(ak_count_exact "$AK" "$BLOB")" -gt 0 ]; then
  echo "RESULT: still-present"
  exit 1
fi

echo "RESULT: removed"
if [ -n "$CUSTOMER_BLOB" ]; then
  customer_count=$(ak_count_exact "$AK" "$CUSTOMER_BLOB")
  case "$customer_count" in
    1) echo "CUSTOMER-KEY: present" ;;
    0) echo "CUSTOMER-KEY: missing" ;;
    *) echo "CUSTOMER-KEY: duplicate" ;;
  esac
fi
