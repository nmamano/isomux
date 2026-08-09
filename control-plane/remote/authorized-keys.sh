#!/usr/bin/env bash
# Shared authorized_keys surgery: match ONE key by its exact base64 field, and
# replace the file durably.
#
# WHY NOT grep -F. A substring match on the blob also matches a line where the
# blob happens to sit inside a longer key, or inside a comment - an
# attacker-controllable field. That is enough to rewrite or delete somebody
# else's key, and enough for a read-back to certify the wrong line. Every
# operation here parses fields and compares the key blob EXACTLY.
#
# An authorized_keys line is: [options] <algorithm> <base64-blob> [comment].
# Options may contain spaces inside quotes, so the blob is found positionally
# relative to the algorithm field rather than by counting from the left.
#
# Sourced by rewrite-key.sh, revoke-key.sh and isomux-cp-cleanup.

# Print the exact base64 blob of a line, or nothing if it has no key.
ak_blob_of() {
  awk '
    {
      for (i = 1; i < NF; i++) {
        if ($i ~ /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[^ ]+|sk-[^ ]+)$/ &&
            $(i+1) ~ /^AAAA[A-Za-z0-9+\/=]+$/) {
          print $(i+1)
          exit
        }
      }
    }
  ' <<<"$1"
}

# Count lines whose key blob is EXACTLY $2, in file $1.
ak_count_exact() {
  local file=$1 blob=$2 line n=0
  [ -f "$file" ] || {
    echo 0
    return 0
  }
  while IFS= read -r line || [ -n "$line" ]; do
    [ "$(ak_blob_of "$line")" = "$blob" ] && n=$((n + 1))
  done <"$file"
  echo "$n"
}

# Replace $1 with the contents of $2, durably: fsync the temp, rename, then
# fsync the parent directory. Without the directory fsync a rename can be lost
# across power failure even though the data was synced, and the box would come
# back with the key we believe we removed.
ak_replace_durably() {
  local target=$1 tmp=$2
  chmod --reference="$target" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  chown --reference="$target" "$tmp" 2>/dev/null || true
  # Bash cannot fsync; python3 is present on Ubuntu 24.04 cloud images, and a
  # missing one is a hard failure rather than a silent downgrade.
  python3 - "$target" "$tmp" <<'PY'
import os, sys
target, tmp = sys.argv[1], sys.argv[2]
fd = os.open(tmp, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
os.rename(tmp, target)
dfd = os.open(os.path.dirname(os.path.abspath(target)) or "/", os.O_RDONLY)
try:
    os.fsync(dfd)
finally:
    os.close(dfd)
PY
}
