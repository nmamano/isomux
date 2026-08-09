#!/usr/bin/env bash
# isomux-cp-cleanup - the box-local backstop that removes our access.
#
# Early revocation by the control plane is the normal path; this is what happens
# when that never runs. It is armed at first contact with Persistent=true, so an
# overdue timer still fires after a boot.
#
# It is NOT the guarantee. The guarantee is the `expiry-time` option on our
# authorized_keys line, which sshd enforces whether or not anything cleaned up.
# This is the cleanup, and the record it writes is evidence of cleanup rather
# than proof of non-access.
#
# THREE PROPERTIES IT MUST KEEP:
#
#   IT FAILS LOUDLY. `set -e`, and the success record is written ONLY after
#   reading back from disk and finding our key gone and the artifacts gone. A
#   backstop that reports success it did not achieve is worse than one that
#   fails: the unit's ExecStartPost deletes this script and the timer on
#   success, so a false success would remove the enforcement AND the evidence.
#   A failure leaves everything installed for the next fire and for a human.
#
#   IT CANNOT DEPEND ON ANYTHING REVOCATION DELETES. A verified early
#   revocation removes /var/lib/isomux-cp and the run wrapper while this timer
#   is still armed, so this script lives in /usr/local/sbin and writes its
#   record outside that tree. It stays runnable after all of it is gone.
#
#   IT MATCHES ONE KEY EXACTLY. By base64 blob field, never a substring, so it
#   cannot delete a customer key that merely contains ours as text.
#
# Idempotent: removing an absent key is a no-op and every removal is forced, so
# a second fire changes nothing and still succeeds.
#
# The ak_* helpers are prepended at install time (composeRemoteScript).
#
# Usage: isomux-cp-cleanup <authorized_keys_path> <key_blob>

set -euo pipefail

AUTHORIZED_KEYS=${1:?authorized_keys path required}
BLOB=${2:?key blob required}
RECORD=/var/lib/isomux-access-record.json
RUN_ROOT=/var/lib/isomux-cp
WRAPPER=/usr/local/sbin/isomux-cp-run

removed=false
if [ -f "$AUTHORIZED_KEYS" ] && [ "$(ak_count_exact "$AUTHORIZED_KEYS" "$BLOB")" -gt 0 ]; then
  tmp=$(mktemp "${AUTHORIZED_KEYS}.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  while IFS= read -r line || [ -n "$line" ]; do
    [ "$(ak_blob_of "$line")" = "$BLOB" ] || printf '%s\n' "$line"
  done <"$AUTHORIZED_KEYS" >"$tmp"
  ak_replace_durably "$AUTHORIZED_KEYS" "$tmp"
  trap - EXIT
  removed=true
fi

rm -rf "$RUN_ROOT"
rm -f "$WRAPPER"

# VERIFY BEFORE CLAIMING. Every one of these must hold, read back from disk,
# before a success record is written and before the unit is allowed to delete
# this script.
if [ -f "$AUTHORIZED_KEYS" ] && [ "$(ak_count_exact "$AUTHORIZED_KEYS" "$BLOB")" -gt 0 ]; then
  echo "isomux-cp-cleanup: our key is STILL PRESENT after removal; not claiming success" >&2
  exit 1
fi
if [ -e "$RUN_ROOT" ]; then
  echo "isomux-cp-cleanup: $RUN_ROOT still exists; not claiming success" >&2
  exit 1
fi
if [ -e "$WRAPPER" ]; then
  echo "isomux-cp-cleanup: $WRAPPER still exists; not claiming success" >&2
  exit 1
fi

# World-readable so the box's owner can see what happened and when, without
# needing anything from us.
umask 022
cat >"$RECORD" <<JSON
{
  "firedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "removedProvisioningKey": $removed,
  "removedRunDirectory": "$RUN_ROOT",
  "removedWrapper": "$WRAPPER",
  "note": "isomux setup access ended. The provisioning key no longer authenticates on this box."
}
JSON
chmod 0644 "$RECORD"
exit 0
