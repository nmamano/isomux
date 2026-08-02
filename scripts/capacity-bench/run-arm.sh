#!/usr/bin/env bash
# Runs one arm of the capacity benchmark (task 6ce6b700). Meant to be run on the
# box under test, not on the office box.
#
#   usage: run-arm.sh <arm-name> <n-agents> <build:0|1> <duration-seconds>
#
# The load runs in a transient systemd scope carrying the memory limits this
# design proposes for isomux.service, so the kernel mechanics under test - the
# cgroup's MemoryHigh throttling, its MemoryMax fence, its own OOM killer, its
# memory.events.local counters and PSI - are the same ones the office would meet.
# Overridable with BENCH_MEM_MAX / BENCH_MEM_HIGH / BENCH_MEM_SWAP_MAX.
set -uo pipefail

ARM=${1:?usage: run-arm.sh <arm-name> <n-agents> <build:0|1> <duration-seconds>}
N=${2:?}
BUILD=${3:?}
DURATION=${4:?}

BENCH_DIR=${BENCH_DIR:-/home/ubuntu/bench}
OUT="$BENCH_DIR/results/$ARM"
SCOPE=isomux-bench
CG=""  # resolved from systemd once the scope exists; see below

# Exact, not casual. The box reports MemTotal 8131784 kB = 7941 MiB, so the
# design's RESERVE of 1024 MiB gives MemoryMax = 6917 MiB - "7G" would be
# 7168 MiB and quietly hand the cgroup 251 MiB of the reserve back.
# MemoryHigh is MemoryMax minus 15% OF MemoryMax; the doc's formula is
# ambiguous and this is the reading being tested.
MEM_MAX=${BENCH_MEM_MAX:-6917M}
MEM_HIGH=${BENCH_MEM_HIGH:-5879M}
MEM_SWAP_MAX=${BENCH_MEM_SWAP_MAX:-infinity}

sudo systemctl stop "$SCOPE.scope" 2>/dev/null
sudo systemctl reset-failed "$SCOPE.scope" 2>/dev/null
rm -rf "$OUT"
mkdir -p "$OUT/agents"

{
  echo "arm=$ARM n=$N build=$BUILD duration=$DURATION"
  echo "limits: MemoryMax=$MEM_MAX MemoryHigh=$MEM_HIGH MemorySwapMax=$MEM_SWAP_MAX"
  echo "started=$(date -Is)"
  echo "--- free -m"; free -m
  echo "--- swapon"; swapon --show
  echo "--- swappiness"; cat /proc/sys/vm/swappiness
  echo "--- uptime"; uptime
} >"$OUT/meta.txt"

# Safety net: if the box wedges badly enough that this script never reaches its
# own teardown, stop the scope anyway.
sudo systemd-run --on-active=$((DURATION + 300)) --unit="bench-guard-$ARM" --collect \
  systemctl stop "$SCOPE.scope" >/dev/null 2>&1

# --slice=system.slice puts the load where a hosted office actually lives, rather
# than under the ssh session that launched it.
sudo systemd-run --scope --unit="$SCOPE" --slice=system.slice --collect \
  -p MemoryAccounting=yes -p MemoryMax="$MEM_MAX" -p MemoryHigh="$MEM_HIGH" \
  -p MemorySwapMax="$MEM_SWAP_MAX" \
  -- setpriv --reuid=ubuntu --regid=ubuntu --init-groups \
     env BENCH_DIR="$BENCH_DIR" BENCH_CHECKOUT="${BENCH_CHECKOUT:-$BENCH_DIR/isomux}" \
         BENCH_CONTEXT_MB="${BENCH_CONTEXT_MB:-280}" \
         BENCH_TOUCH_FRACTION="${BENCH_TOUCH_FRACTION:-0.15}" \
         BENCH_CPU_MS="${BENCH_CPU_MS:-200}" BENCH_IDLE_MS="${BENCH_IDLE_MS:-3000}" \
         BENCH_COLD_INSTALL="${BENCH_COLD_INSTALL:-0}" \
     bash "$BENCH_DIR/inner.sh" "$OUT" "$N" "$BUILD" "$DURATION" \
  >"$OUT/scope.log" 2>&1 &
SCOPE_PID=$!

for _ in $(seq 1 60); do
  rel=$(systemctl show "$SCOPE.scope" -p ControlGroup --value 2>/dev/null)
  if [ -n "$rel" ] && [ -d "/sys/fs/cgroup$rel" ]; then CG="/sys/fs/cgroup$rel"; break; fi
  sleep 0.5
done
if [ -z "$CG" ]; then echo "FATAL: scope cgroup never appeared" | tee -a "$OUT/meta.txt"; exit 1; fi
echo "cgroup=$CG" >>"$OUT/meta.txt"

# Assert the effective limit, not the written config (the doc's design principle).
{
  echo "--- kernel readback of the scope cgroup"
  for f in memory.max memory.high memory.swap.max memory.oom.group; do
    printf '%s=%s\n' "$f" "$(cat "$CG/$f" 2>/dev/null)"
  done
} >>"$OUT/meta.txt"

# memory.peak is an instantaneous kernel maximum; memory.stat is a separate,
# later read. At the default 2 s cadence the anon/file split near a short spike
# can come from a sample the peak never occurred in. Build-only arms therefore
# run at BENCH_SAMPLE_INTERVAL=0.2 so the split can be quoted as approximate
# rather than invented.
nohup bash "$BENCH_DIR/sampler.sh" "$CG" "${BENCH_SAMPLE_INTERVAL:-2}" \
  >"$OUT/samples.csv" 2>"$OUT/sampler.err" &
SAMPLER_PID=$!

# Reachability is measured from OFF the box, by probe-external.sh running on the
# office box: a loopback probe shares the page cache and scheduler it is
# supposed to be judging, and never crosses the network the customer uses. This
# on-box series is kept only as a fallback when no external probe is attached.
nohup bash -c 'while :; do s=$(date +%s%3N);
  if out=$(timeout 8 bash -c "exec 3<>/dev/tcp/127.0.0.1/22; head -c 12 <&3" 2>/dev/null) && [ -n "$out" ]; then r=ok; else r=FAIL; fi
  e=$(date +%s%3N); echo "$s,$r,$((e-s))"; sleep 5; done' \
  >"$OUT/ssh-probe-loopback.csv" 2>/dev/null &
PROBE_PID=$!

sleep "$((DURATION + 15))"

# Snapshot the cgroup before tearing it down: memory.peak and the cumulative
# counters die with the cgroup.
{
  echo "--- final cgroup snapshot $(date -Is)"
  for f in memory.current memory.peak memory.swap.current memory.swap.peak \
           memory.events.local memory.events memory.stat memory.pressure \
           cpu.pressure io.pressure cpu.stat pids.current; do
    echo "== $f"; cat "$CG/$f" 2>/dev/null
  done
  echo "--- box"; free -m; uptime
  echo "--- dmesg oom"; sudo dmesg -T 2>/dev/null | grep -iE 'oom|killed process|earlyoom' | tail -40
  echo "--- earlyoom journal"; sudo journalctl -u earlyoom --since "-${DURATION}s" --no-pager 2>/dev/null | tail -40
} >"$OUT/final.txt"

kill "$SAMPLER_PID" "$PROBE_PID" 2>/dev/null
sudo systemctl stop "$SCOPE.scope" 2>/dev/null
sudo systemctl reset-failed "$SCOPE.scope" 2>/dev/null
sudo systemctl stop "bench-guard-$ARM.timer" 2>/dev/null
wait "$SCOPE_PID" 2>/dev/null

echo "arm $ARM done -> $OUT"
