#!/usr/bin/env bash
# Everything after the coarse sweep, in one unattended pass, at the corrected
# cap (MemoryMax 6917 MiB / MemoryHigh 5879 MiB). Roughly 3.5 hours.
#
# Phase order is chosen so the cheap answers land first: if the box is lost
# later in the night, the build composition and the blast-radius verdict are
# already on disk.
#
#   usage: run-all-remaining.sh
set -uo pipefail

BENCH_DIR=${BENCH_DIR:-/home/ubuntu/bench}
cd "$BENCH_DIR" || exit 1
DUR=300

# Retargeted from the coarse sweep rather than from arithmetic. The arithmetic
# predicted the cliff where MemoryHigh is first crossed; measurement showed that
# crossing it is nearly free - throttling starts well before anything hurts,
# because reclaim finds cheap pages first. The usability boundary is where the
# cheap pages run out, which is several agents higher:
#
#   agents only  N=20 clean (p95 276 ms), N=24 painful (p95 1377 ms)
#   with build   N=12 clean (p95 268 ms), N=16 mild (307), N=20 painful (949),
#                N=24 unusable (p95 30.3 s, throughput down 66%)
NS_AGENTS_ONLY=(21 22 23 24)
NS_WITH_BUILD=(14 16 18 20)

echo "############ $(date -Is) PHASE 1: build spike, 200 ms sampling"
# Re-measured fast because memory.peak and memory.stat are not an atomic pair,
# so the anon/file split of the peak needs samples dense enough to sit on it.
BENCH_COLD_INSTALL=1 BENCH_SAMPLE_INTERVAL=0.2 \
  bash run-arm.sh arm0-build-cold-fast 0 1 420

echo "############ $(date -Is) PHASE 2: build spike, cold bun cache (fresh-box worst case)"
rm -rf "$HOME/.bun/install/cache" 2>/dev/null
BENCH_COLD_INSTALL=1 BENCH_SAMPLE_INTERVAL=0.2 \
  bash run-arm.sh arm0-build-coldcache 0 1 420

echo "############ $(date -Is) PHASE 3: OOM blast radius (sacrificial unit)"
bash oom-blast-radius.sh "$BENCH_DIR/results/oom-blast-radius"

echo "############ $(date -Is) PHASE 4: refined sweep, agents + concurrent build"
bash run-refined.sh 1 "$DUR" 2 "${NS_WITH_BUILD[@]}"

echo "############ $(date -Is) PHASE 5: refined sweep, agents only"
bash run-refined.sh 0 "$DUR" 1 "${NS_AGENTS_ONLY[@]}"

echo "############ $(date -Is) PHASE 6: sensitivity (touch fraction, CPU duty)"
# At N=18 with a build, not N=12: the parameters under test only matter where
# reclaim and swap are active, and N=12 sits in the flat region where nothing
# they control has any effect to measure.
bash run-sensitivity.sh 18 1 "$DUR"

echo "############ $(date -Is) PHASE 7: swap arm (decision 4)"
# Below and above the point where the shipped 2 GiB is exhausted, measured
# rather than guessed: the coarse sweep used 1675 MB of swap at N=20 and hit the
# full 2048 MB at N=24. Survival is not the bar, so both loads are reported on
# latency and PSI.
bash run-swap-arm.sh 1 "$DUR" 20 24

echo "############ $(date -Is) ALL REMAINING PHASES DONE"
