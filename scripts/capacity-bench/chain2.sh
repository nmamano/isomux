#!/usr/bin/env bash
# Re-runs the OOM blast-radius test after the main phase queue finishes.
#
# The first attempt produced no kills at all and had to be discarded. Two
# defects, both in the harness rather than the kernel: MemoryMax was set without
# MemorySwapMax, so every fence hit was absorbed by swap instead of forcing a
# kill; and MemoryOOMGroup= was written as a unit directive, which systemd does
# not recognise, so the atomic-kill variant silently retested the default.
#
# It runs here rather than inline because an 800 MiB balloon would contaminate
# whichever measurement arm happened to be running.
set -uo pipefail
cd /home/ubuntu/bench || exit 1
until grep -q "ALL REMAINING PHASES DONE" remaining.log 2>/dev/null; do sleep 60; done
echo "$(date -Is) phase queue finished; re-running blast radius with the fixes"
bash oom-blast-radius.sh /home/ubuntu/bench/results/oom-blast-radius-v2
echo "$(date -Is) CHAIN2_COMPLETE"
