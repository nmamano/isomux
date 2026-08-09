#!/usr/bin/env bash
# Mint an owner invite on demand, and print nothing else.
#
# Invites are NEVER persisted by the control plane. The installer's own copy at
# /var/lib/isomux-install/invite-url is single-use with a 24h TTL, so any stored
# copy is a stale credential we would also be responsible for protecting. This
# script mints a fresh one at the moment the operator asks, exactly the way
# install.sh does it:
#
#   1. resolve the CURRENT owner from the office's own user records - the
#      socket takes a name and the customer can rename themselves, so a stored
#      name is not enough. Precedence matches install.sh: the stable owner id
#      the installer saved, then a sole owner, then a saved name;
#   2. mint a 15-minute owner-login URL on the admin unix socket;
#   3. follow it against loopback to obtain an owner session;
#   4. POST /api/invites/recovery for the standard 24h single-use link.
#
# stdout carries the invite URL and nothing else, so the caller never has to
# parse a credential out of chatter. Diagnostics go to stderr.
#
# Usage (as root): mint-invite.sh

set -euo pipefail

SERVICE_HOME=/home/isomux
STATE_DIR=/var/lib/isomux-install
ADMIN_SOCK=$SERVICE_HOME/.isomux/admin.sock
USERS_FILE=$SERVICE_HOME/.isomux/users.json
BASE_URL=http://127.0.0.1:4000

die() {
  echo "mint-invite: $*" >&2
  exit 1
}

[ -S "$ADMIN_SOCK" ] || die "no admin socket at $ADMIN_SOCK; is the isomux service running?"
[ -r "$USERS_FILE" ] || die "cannot read $USERS_FILE to find the office owner"

owner=""
if [ -s "$STATE_DIR/owner-id" ]; then
  saved_id=$(cat "$STATE_DIR/owner-id")
  owner=$(jq -r --arg id "$saved_id" \
    '.[$id] | select(.role == "owner") | .name // empty' "$USERS_FILE")
fi
if [ -z "$owner" ]; then
  owners=$(jq -r '[.[] | select(.role == "owner") | .name] | .[]' "$USERS_FILE")
  [ -n "$owners" ] || die "no owner found in $USERS_FILE"
  if [ "$(printf '%s\n' "$owners" | wc -l)" -eq 1 ]; then
    owner=$owners
  elif [ -s "$STATE_DIR/owner-name" ]; then
    saved=$(cat "$STATE_DIR/owner-name")
    printf '%s\n' "$owners" | grep -Fxq "$saved" && owner=$saved
  fi
fi
[ -n "$owner" ] || die "could not resolve a single office owner"

resp=$(curl -fsS --unix-socket "$ADMIN_SOCK" -X POST http://localhost/admin/owner-login \
  -H 'Content-Type: application/json' \
  --data "$(jq -n --arg name "$owner" '{name: $name}')") ||
  die "admin-socket owner-login request failed"
url=$(printf '%s' "$resp" | jq -r '.url // empty')
[ -n "$url" ] || die "owner-login failed: $(printf '%s' "$resp" | jq -r '.error // "unknown error"')"

jar=$(mktemp)
chmod 600 "$jar"
trap 'rm -f "$jar"' EXIT

# The login token stays off argv, where ps would show it, exactly as install.sh
# does: curl reads it from stdin.
token=${url##*/i/}
code=$(printf '%s' "$token" | curl -s -o /dev/null -w '%{http_code}' -c "$jar" \
  -H 'Sec-Fetch-Site: same-origin' \
  --data-urlencode "token@-" \
  "$BASE_URL/auth/accept")
[ "$code" = "302" ] || die "owner-login accept was refused (HTTP $code)"

# Resolve our own userId the way install.sh does: the session prefix is the
# first 8 characters of the raw cookie value. Prefer the __Host- cookie an
# HTTPS office writes, whatever order the jar holds them in.
raw=$(awk '
  $6 == "__Host-isomux_session" { h = $7 }
  $6 == "isomux_session" { l = $7 }
  END { print (h != "" ? h : l) }
' "$jar")
[ -n "$raw" ] || die "no session cookie after accepting the owner-login link"
prefix=${raw:0:8}
user_id=$(curl -fsS -b "$jar" "$BASE_URL/api/sessions" |
  jq -r --arg p "$prefix" '.sessions[] | select(.sessionPrefix == $p) | .userId // empty')
[ -n "$user_id" ] || die "could not resolve the owner userId from /api/sessions"

invite=$(curl -fsS -b "$jar" -X POST "$BASE_URL/api/invites/recovery" \
  -H 'Content-Type: application/json' \
  --data "$(jq -n --arg id "$user_id" '{userId: $id}')" | jq -r '.url // empty')
[ -n "$invite" ] || die "minting the owner invite failed"

printf '%s\n' "$invite"
