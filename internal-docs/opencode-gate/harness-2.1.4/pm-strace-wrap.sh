#!/bin/sh
# pm P4(b): run the v2 server under strace to see which config paths it opens.
exec strace -f -qq --kill-on-exit -e trace=%file -o "$PM_STRACE_OUT" /tmp/t-4840abc5/oc2/node_modules/@opencode/cli-linux-x64/bin/opencode "$@"
