#!/usr/bin/env bash
# Sensitivity study over the two fixture parameters that were invented rather
# than measured, at a fixed N. Neither has a defensible single value, so the
# honest output is a curve showing how much the result depends on them.
#
#   touch fraction  how much of its context an agent walks per turn. Drives how
#                   much of the context stays hot, so it decides how badly swap
#                   hurts. 1% / 5% / 15%.
#   CPU duty        200 ms per ~3.2 s turn is 6.25%, against 1.90-6.11% measured
#                   across eight live claude agents (mean 4.3%). The pair below
#                   brackets that range instead of asserting its top.
#
#   usage: run-sensitivity.sh <n-agents> <build:0|1> <duration>
set -uo pipefail

N=${1:?usage: run-sensitivity.sh <n-agents> <build:0|1> <duration>}
BUILD=${2:?}
DUR=${3:?}
BENCH_DIR=${BENCH_DIR:-/home/ubuntu/bench}
cd "$BENCH_DIR" || exit 1

settle() { source "$BENCH_DIR/settle.sh"; }

for tf in 0.01 0.05 0.15; do
  echo "=== $(date -Is) touch-fraction $tf n=$N"
  settle
  BENCH_COLD_INSTALL="$BUILD" BENCH_TOUCH_FRACTION="$tf" \
    bash run-arm.sh "sens-touch${tf}-n${N}" "$N" "$BUILD" "$DUR"
done

for cpu in 100 200; do
  echo "=== $(date -Is) cpu-duty ${cpu}ms n=$N"
  settle
  BENCH_COLD_INSTALL="$BUILD" BENCH_CPU_MS="$cpu" \
    bash run-arm.sh "sens-cpu${cpu}-n${N}" "$N" "$BUILD" "$DUR"
done

echo "=== $(date -Is) sensitivity done"
