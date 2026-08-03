#!/usr/bin/env bash
# The MemorySwapMax arm: what the swap-size arm (run-swap-arm.sh) left open.
#
# That arm compared swapfile SIZES with the cgroup's own swap limit at
# infinity, and found the cliff to be swap EXHAUSTION rather than swap size:
# 2 GiB used to the last megabyte gave a 30.7 s p95 where 8 GiB gave 3.4 s at
# the same load. It could not say what to set MemorySwapMax to, because every
# 8 GiB arm ran uncapped and used up to 4235 MB - so a cap below that number is
# an untested configuration, and one that could recreate the same exhaustion at
# a different threshold.
#
# This runs the same load against a swapfile large enough not to bind (8 GiB)
# and varies only the cgroup cap, from well above observed demand down to well
# below it. Two questions:
#
#   - does a cap BELOW demand cliff the way an exhausted swapfile does, or does
#     the cgroup degrade into MemoryHigh throttling instead?
#   - how much margin over observed demand does a safe cap need?
#
# The difference from an exhausted swapfile is not obvious in advance, which is
# why this is measured: when the FILE runs out, every process on the box loses
# swap at once; when the cgroup's swap.max is reached, only the office does, and
# the kernel still has file reclaim and MemoryHigh throttling to fall back on.
#
#   usage: run-swap-cap-arm.sh <build:0|1> <duration> <n> <cap>...
#   e.g.:  run-swap-cap-arm.sh 1 300 24 infinity 6G 4G 3G 2G infinity
#
# Repeating a cap (the reference at both ends above) is the cheap check that the
# box has not drifted over the run.
set -uo pipefail

BUILD=${1:?usage: run-swap-cap-arm.sh <build:0|1> <duration> <n> <cap>...}
DUR=${2:?}
N=${3:?}
shift 3
CAPS=("$@")
[ ${#CAPS[@]} -gt 0 ] || { echo "usage: run-swap-cap-arm.sh <build> <dur> <n> <cap>..." >&2; exit 2; }

BENCH_DIR=${BENCH_DIR:-/home/ubuntu/bench}
# Big enough that the file never binds at any cap under test: observed demand
# uncapped is ~4.2 GB, and the largest cap below is 6G.
SWAPFILE_SIZE=${SWAPFILE_SIZE:-8G}
cd "$BENCH_DIR" || exit 1

# Same guard rails as run-swap-arm.sh's resize_swap, and for the same reasons:
# removing a live swapfile corrupts the system, and swapoff has to read every
# swapped-out page back into RAM first, so it can fail for lack of headroom and
# must never be assumed to have worked.
resize_swap() { # resize_swap <size>
  if [ -e /swapfile ]; then
    local used_kb avail_kb
    used_kb=$(awk '/^SwapTotal/{t=$2} /^SwapFree/{f=$2} END{print t-f}' /proc/meminfo)
    avail_kb=$(awk '/^MemAvailable/{print $2}' /proc/meminfo)
    if [ "$used_kb" -gt 0 ] && [ "$((used_kb * 2))" -ge "$avail_kb" ]; then
      echo "resize_swap: REFUSING - ${used_kb} kB in swap against ${avail_kb} kB available;" \
           "swapping it back in could take the box down" >&2
      return 1
    fi
    if ! sudo swapoff /swapfile; then
      echo "resize_swap: swapoff /swapfile FAILED - not touching the file" >&2
      return 1
    fi
  fi
  sudo rm -f /swapfile
  sudo fallocate -l "$1" /swapfile || return 1
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null || return 1
  sudo swapon /swapfile || return 1
  swapon --show
}

settle() { source "$BENCH_DIR/settle.sh"; }

# The swapfile is set once and left alone: it is the constant here, and cycling
# it between arms is what settle.sh does anyway.
if ! resize_swap "$SWAPFILE_SIZE"; then
  echo "FATAL: could not set the swapfile to $SWAPFILE_SIZE; refusing to run at whatever" \
       "configuration is left" >&2
  exit 1
fi

# A cap is only meaningful next to the swapfile it sits under, so both go in the
# arm name: cap2G-of-8G.
for cap in "${CAPS[@]}"; do
  label="cap${cap}-of-${SWAPFILE_SIZE}"
  # A repeated cap would overwrite its own earlier results directory: run-arm.sh
  # starts with `rm -rf` on it. The path checked here has to be the one run-arm.sh
  # actually writes, results/$ARM - an earlier version of this loop checked
  # results/$ARM-n$N, never matched, and silently destroyed the first of the two
  # reference arms it had just spent six minutes measuring.
  suffix=""
  i=2
  while [ -d "$BENCH_DIR/results/${label}${suffix}" ]; do
    suffix="-r$i"
    i=$((i + 1))
  done
  echo "=== $(date -Is) ${label}${suffix} n=$N"
  settle
  BENCH_COLD_INSTALL="$BUILD" BENCH_MEM_SWAP_MAX="$cap" \
    bash run-arm.sh "${label}${suffix}" "$N" "$BUILD" "$DUR" ||
    echo "WARNING: arm ${label}${suffix} returned non-zero; check its results dir before quoting it" >&2
done

echo "=== $(date -Is) swap-cap arm done. The swapfile is left at $SWAPFILE_SIZE, NOT at the"
echo "    installed size - set it back before handing the box to another lane."
swapon --show
