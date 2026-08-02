#!/usr/bin/env bash
# Re-runs the phases lost when the box OOMed, plus the corrected blast-radius
# test.
#
# What happened: the UNCONSTRAINED baseline at N=24 (MemoryMax=infinity, ~6.9 GB
# of agents on a 7941 MiB box) drove the host into global memory pressure.
# earlyoom fired at 9.28% MemAvailable and killed its way down the badness list,
# taking the orchestrator with it, so phases 6 and 7 aborted a second apart. The
# constrained arm at the same N had been fine - which is the reachability
# argument the cgroup limits exist to make, demonstrated the hard way.
#
# Two changes: this runs under a scope with OOMScoreAdjust=-900, so the harness
# is not a candidate for the killer it is measuring, and no unconstrained arm is
# re-attempted at a load the box cannot hold.
set -uo pipefail
BENCH_DIR=/home/ubuntu/bench
cd "$BENCH_DIR" || exit 1
DUR=300

# Fail fast on the starting condition rather than discovering it in the data.
# The crash killed the swap arm mid-resize and left /swapfile switched off; the
# rerun then began measuring a box with no swap at all, which is not the shipped
# configuration and would have quietly invalidated every sensitivity arm.
swap_mib=$(awk '/^SwapTotal/{print int($2/1024)}' /proc/meminfo)
if [ "${swap_mib:-0}" -lt 2000 ]; then
  echo "FATAL: expected the shipped 2 GiB swapfile, found ${swap_mib} MiB." \
       "Run 'sudo swapon -a' and check /swapfile before rerunning."
  exit 1
fi
echo "$(date -Is) precondition ok: ${swap_mib} MiB swap, $(awk '/^MemAvailable/{print int($2/1024)}' /proc/meminfo) MiB available"

echo "############ $(date -Is) PHASE 6 (rerun): sensitivity"
bash run-sensitivity.sh 18 1 "$DUR"

echo "############ $(date -Is) PHASE 7 (rerun): swap arm (decision 4)"
bash run-swap-arm.sh 1 "$DUR" 20 24

echo "############ $(date -Is) PHASE 3 (rerun): OOM blast radius, fixed"
bash oom-blast-radius.sh "$BENCH_DIR/results/oom-blast-radius-v2"

echo "############ $(date -Is) CHAIN3 COMPLETE"
