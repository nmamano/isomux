#!/bin/sh
# pm P4(b), 2.2.5 copy (task 6dca5910): the binary comes from PM_STRACE_BIN.
exec strace -f -qq --kill-on-exit -e trace=%file -o "$PM_STRACE_OUT" "$PM_STRACE_BIN" "$@"
