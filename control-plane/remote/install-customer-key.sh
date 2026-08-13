#!/usr/bin/env bash
# Install one normalized customer key without options or customer-controlled text.
# Requires the ak_* helpers to be prepended.

set -euo pipefail

AK=${1:?authorized_keys path required}
ALGORITHM=${2:?algorithm required}
BLOB=${3:?key blob required}
PROVISIONING_BLOB=${4:?provisioning key blob required}

[ "$BLOB" != "$PROVISIONING_BLOB" ] || {
  echo "RESULT: customer-key-matches-provisioning-key"
  exit 1
}
mkdir -p "$(dirname "$AK")"
touch "$AK"
chmod 600 "$AK"

count=$(ak_count_exact "$AK" "$BLOB")
if [ "$count" -eq 0 ]; then
  tmp=$(mktemp "$AK.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  cat "$AK" >"$tmp"
  if [ -s "$tmp" ] && [ "$(tail -c 1 "$tmp" | od -An -t u1 | tr -d ' ')" != "10" ]; then
    printf '\n' >>"$tmp"
  fi
  printf '%s %s hosted-isomux-customer\n' "$ALGORITHM" "$BLOB" >>"$tmp"
  ak_replace_durably "$AK" "$tmp"
  trap - EXIT
elif [ "$count" -ne 1 ]; then
  echo "RESULT: customer-key-duplicate"
  exit 1
else
  echo "RESULT: customer key installed"
  echo "CUSTOMER-KEY: existing"
  exit 0
fi

[ "$(ak_count_exact "$AK" "$BLOB")" -eq 1 ] || {
  echo "RESULT: customer-key-readback-missing"
  exit 1
}
[ "$(grep -Fxc "$ALGORITHM $BLOB hosted-isomux-customer" "$AK")" -eq 1 ] || {
  echo "RESULT: customer-key-readback-not-normalized"
  exit 1
}
echo "RESULT: customer key installed"
echo "CUSTOMER-KEY: added"
