#!/usr/bin/env bash
# Returns the box to a comparable starting state between arms, and says so on
# stdout so the write-up can show the reset actually happened rather than assume
# it. Sourced by run-refined.sh / run-sensitivity.sh / run-swap-arm.sh.
#
# Clearing swap between arms matters as much as clearing page cache: pages left
# over from an earlier arm make the next arm's swap-in traffic somebody else's.
# But swapoff has to read every swapped-out page back into RAM, so doing it
# without headroom can itself cause the pressure the benchmark is measuring.
# Hence: only with the payload already stopped, and only when what has to come
# back fits in MemAvailable with room to spare.

sync
sudo sh -c 'echo 3 >/proc/sys/vm/drop_caches' 2>/dev/null

_swap_used_kb=$(awk '/^SwapTotal/{t=$2} /^SwapFree/{f=$2} END{print t-f}' /proc/meminfo)
_avail_kb=$(awk '/^MemAvailable/{print $2}' /proc/meminfo)
_swap_total_kb=$(awk '/^SwapTotal/{print $2}' /proc/meminfo)

if [ "${_swap_total_kb:-0}" -eq 0 ]; then
  echo "settle: no swap configured, nothing to cycle"
elif [ "$((_swap_used_kb * 2))" -lt "$_avail_kb" ]; then
  if sudo swapoff -a 2>/dev/null && sudo swapon -a 2>/dev/null; then
    echo "settle: swap cycled ok (was ${_swap_used_kb} kB used, ${_avail_kb} kB available)"
  else
    echo "settle: WARNING swap cycle FAILED; arm starts with residual swap"
  fi
else
  echo "settle: WARNING skipped swap cycle - ${_swap_used_kb} kB in swap against" \
       "${_avail_kb} kB available; swapping it back in could cause the pressure" \
       "being measured. Arm starts with residual swap."
fi

sleep 25
_used_after=$(awk '/^SwapTotal/{t=$2} /^SwapFree/{f=$2} END{print t-f}' /proc/meminfo)
echo "settle: swap in use at arm start = ${_used_after} kB; MemAvailable = $(awk '/^MemAvailable/{print $2}' /proc/meminfo) kB"
