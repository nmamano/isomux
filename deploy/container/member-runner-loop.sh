#!/bin/bash
# The restart loop of one member's runner in the container, where no systemd
# runs the isomux-member-runner@ unit (internal-docs/member-os-user-design.md,
# section 1.2). member-users.py starts it as the member, with a fixed
# environment, no_new_privs and no inherited fd. It runs the unit's argv and
# starts the runner again 5 s after it exits, as Restart=always does.
#
#   member-runner-loop.sh <share> <socket> <office uid>
set -u
umask 077
share=$1 socket=$2 office_uid=$3
# The container's match of the unit's PrivateTmp: a temp folder of its own.
mkdir -p -m 700 "$HOME/.tmp"
export TMPDIR=$HOME/.tmp
# Root starts the loop in /: it resolves no path under the data volume.
cd "$HOME" || exit 1
unset OLDPWD
log=$HOME/.isomux-runner.log
while :; do
  if [[ -f $log ]] && (($(stat -c %s "$log") > 1048576)); then
    : >"$log"
  fi
  "$share/runtime/current/bun" "$share/runtime/current/runner.js" runner \
    --socket "$socket" --server-uid "$office_uid" --socket-mode 0666 \
    </dev/null >>"$log" 2>&1
  sleep 5
done
