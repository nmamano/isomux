#!/usr/bin/env bash
# Refined sweep around a boundary the coarse sweep located, at the corrected cap
# (MemoryMax 6917 MiB). Three things the coarse sweep cannot give:
#
#   - steps of 1-2 agents instead of 4, so the boundary is located rather than
#     bracketed
#   - repeats at each N, because a single run near a cliff is a coin flip
#   - a per-N UNCONSTRAINED run (MemoryMax=infinity) as the baseline, so CPU
#     contention is not mislabelled as memory damage. Without it, "latency rose
#     at N=16" cannot be attributed.
#
# Arm order is repeat-major (all N in ascending order, then the next repeat), so
# a repeat of a given N is separated from its predecessor by the whole sweep.
# That is better than running a single N's repeats back to back, but it is NOT
# randomised or order-reversed: any monotonic drift in box state still lands on
# ascending N the same way in every repeat. Worth fixing if a result ever turns
# on a difference of a few percent between adjacent N.
#
# The unconstrained baseline runs once per N rather than once per repeat: it is
# there to attribute a slowdown, not to locate a boundary, so it does not need
# the same repetition as the constrained arms.
#
#   usage: run-refined.sh <build:0|1> <duration> <repeats> <n1> [n2 ...]
set -uo pipefail

BUILD=${1:?usage: run-refined.sh <build:0|1> <duration> <repeats> <n1> [n2 ...]}
DUR=${2:?}
REPS=${3:?}
shift 3
NS=("$@")
BENCH_DIR=${BENCH_DIR:-/home/ubuntu/bench}
cd "$BENCH_DIR" || exit 1

settle() { source "$BENCH_DIR/settle.sh"; }

for r in $(seq 1 "$REPS"); do
  for n in "${NS[@]}"; do
    echo "=== $(date -Is) refined constrained n=$n rep=$r build=$BUILD"
    settle
    BENCH_COLD_INSTALL="$BUILD" bash run-arm.sh "ref-b${BUILD}-n${n}-r${r}" "$n" "$BUILD" "$DUR"
  done
done

for n in "${NS[@]}"; do
  echo "=== $(date -Is) refined UNCONSTRAINED baseline n=$n build=$BUILD"
  settle
  BENCH_COLD_INSTALL="$BUILD" BENCH_MEM_MAX=infinity BENCH_MEM_HIGH=infinity \
    bash run-arm.sh "base-b${BUILD}-n${n}" "$n" "$BUILD" "$DUR"
done

echo "=== $(date -Is) refined sweep done"
