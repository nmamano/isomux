#!/usr/bin/env bash
# Rewrite our authorized_keys line so it carries an absolute expiry, then read
# the result back FROM DISK.
#
# This is the first thing that happens on a box, before the wrapper and before
# the installer: the provider injects a BARE key, and until this has taken the
# box holds a key with no ceiling. The read-back is the point of the script -
# proving what sshd will read, not what we believe we wrote.
#
# Our key is identified by its EXACT base64 blob field (see authorized-keys.sh),
# never by a substring: a substring also matches a longer key that contains ours
# and an attacker-controlled comment, either of which would let this rewrite the
# wrong line and then certify it. Every unrelated line is copied byte for byte.
#
# Requires the ak_* helpers to be prepended (composeRemoteScript in driver.ts).
#
# Usage: rewrite-key.sh <authorized_keys> <algorithm> <blob> <expiry>

set -euo pipefail

AK=${1:?authorized_keys path required}
ALGO=${2:?algorithm required}
BLOB=${3:?key blob required}
EXPIRY=${4:?expiry instant required}

[ -f "$AK" ] || {
  echo "RESULT: missing-authorized-keys"
  exit 1
}

tmp=$(mktemp "$AK.XXXXXX")
trap 'rm -f "$tmp"' EXIT
found=0
while IFS= read -r line || [ -n "$line" ]; do
  if [ "$(ak_blob_of "$line")" = "$BLOB" ]; then
    printf 'expiry-time="%s" %s %s isomux-cp\n' "$EXPIRY" "$ALGO" "$BLOB"
    found=$((found + 1))
  else
    printf '%s\n' "$line"
  fi
done <"$AK" >"$tmp"

if [ "$found" -ne 1 ]; then
  echo "RESULT: key-not-present (exact matches: $found)"
  exit 1
fi

ak_replace_durably "$AK" "$tmp"
trap - EXIT

# Read back from disk, matching exactly, so the caller is shown the line sshd
# will actually read.
echo "RESULT: ok"
while IFS= read -r line || [ -n "$line" ]; do
  [ "$(ak_blob_of "$line")" = "$BLOB" ] && printf 'READBACK: %s\n' "$line"
done <"$AK"
