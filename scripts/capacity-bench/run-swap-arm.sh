#!/usr/bin/env bash
# The swap arm of the capacity benchmark: decision 4 in
# internal-docs/sizing-tiers-design.md - keep the shipped 2 GiB swapfile, or go
# larger on the entry tier? Nil's framing is the bar: survival is not the
# question, usability while swapping is. So the same load runs three ways and
# the numbers to compare are per-turn latency, throughput and PSI, not who lived.
#
#   swap-2g   shipped default, cgroup swap unlimited
#   swap-8g   larger swapfile, cgroup swap unlimited
#   swap-off  shipped swapfile, MemorySwapMax=0 - the control. Isolates what
#             swap contributes by taking it away: this config kills instead of
#             stalling, which is the other half of the tradeoff.
#
# Two loads, not one, because a single N can accidentally favour one config: run
# it below the point where 2 GiB is exhausted and above it. Configs are
# interleaved within each load and the box is settled (cache dropped, swap
# cycled) between every arm, so an earlier arm's leftovers are not charged to a
# later one.
#
#   usage: run-swap-arm.sh <build:0|1> <duration> <n-below> <n-above>
set -uo pipefail

BUILD=${1:?usage: run-swap-arm.sh <build:0|1> <duration> <n-below> <n-above>}
DUR=${2:?}
N_BELOW=${3:?}
N_ABOVE=${4:?}
BENCH_DIR=${BENCH_DIR:-/home/ubuntu/bench}
cd "$BENCH_DIR" || exit 1

resize_swap() { # resize_swap <size, e.g. 8G>
  # Deleting a swapfile that is still active corrupts the running system, and
  # swapoff has to read every swapped-out page back into RAM first - so it can
  # fail for lack of headroom, and it must never be assumed to have worked.
  # The earlier version ignored swapoff's status and went straight to rm; with
  # `set -u` but no `-e` nothing stopped it.
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

# resize_swap already discards every swapped-out page, so settle here only has
# to drop page cache and let the box quiesce.
settle() { source "$BENCH_DIR/settle.sh"; }

run_config() { # run_config <label> <swapfile-size> <MemorySwapMax> <n>
  local label=$1 size=$2 swapmax=$3 n=$4
  echo "=== $(date -Is) $label n=$n"
  # Guard explicitly. resize_swap returns non-zero when it refuses or fails, but
  # this script runs under `set -uo pipefail` WITHOUT -e, so an unchecked call
  # would fall through and measure the arm against whatever swap configuration
  # happened to be left behind - a silently mislabelled result, which is the
  # exact failure class that already cost this benchmark two phases. Relying on
  # `set -e` here would be worse: it does not apply inside conditionals and is
  # easy to defeat by accident.
  if ! resize_swap "$size"; then
    echo "ABORT: could not set the swapfile to $size; refusing to run $label at" \
         "whatever configuration is left" >&2
    return 1
  fi
  settle
  BENCH_COLD_INSTALL="$BUILD" BENCH_MEM_SWAP_MAX="$swapmax" \
    bash run-arm.sh "${label}-n${n}" "$n" "$BUILD" "$DUR"
}

fail() { echo "FATAL: $1 - stopping the swap arm rather than producing mislabelled results" >&2; exit 1; }

for n in "$N_BELOW" "$N_ABOVE"; do
  run_config swap-2g 2G infinity "$n" || fail "swap-2g at n=$n"
  run_config swap-8g 8G infinity "$n" || fail "swap-8g at n=$n"
  run_config swap-off 2G 0 "$n" || fail "swap-off at n=$n"
done

# Leave the box as the installer would have it. Checked too: a silent failure
# here hands the next lane a box with 8 GiB of swap or none at all.
if ! resize_swap 2G; then
  echo "FATAL: could not restore the shipped 2 GiB swapfile. The box is NOT in its" \
       "installed state - check /swapfile and 'swapon --show' before running anything else." >&2
  exit 1
fi
echo "=== $(date -Is) swap arm done; swapfile restored to the shipped 2 GiB"
swapon --show
