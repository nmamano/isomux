#!/usr/bin/env bash
# Drives the full capacity benchmark on the box under test: the agent-only
# sweep, then the same sweep with a concurrent build, then the swap comparison.
# Run under nohup - it takes over an hour.
#
#   usage: run-sweep.sh [duration-seconds-per-arm]
set -uo pipefail

BENCH_DIR=${BENCH_DIR:-/home/ubuntu/bench}
DUR=${1:-300}
NS=${BENCH_NS:-"4 8 12 16 20 24"}

cd "$BENCH_DIR" || exit 1

for n in $NS; do
  echo "=== $(date -Is) agents-only n=$n"
  bash run-arm.sh "sweep-a-n$n" "$n" 0 "$DUR"
  sleep 20 # let the box settle so the next arm starts from a clean baseline
done

# The build arm installs cold on every cycle. A warm install is a no-op that
# never allocates, so a warm build arm would measure the test suite alone and
# miss the spike the tier reserve exists for.
for n in $NS; do
  echo "=== $(date -Is) agents+build n=$n"
  BENCH_COLD_INSTALL=1 bash run-arm.sh "sweep-b-n$n" "$n" 1 "$DUR"
  sleep 20
done

echo "=== $(date -Is) sweep done"
