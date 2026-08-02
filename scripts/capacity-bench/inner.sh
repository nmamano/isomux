#!/usr/bin/env bash
# Runs inside the benchmark scope (see run-arm.sh). Everything this script
# starts is charged to the scope's cgroup, which is what carries the proposed
# MemoryHigh/MemoryMax/MemorySwapMax limits.
#
# usage: inner.sh <out-dir> <n-agents> <build:0|1> <duration-seconds>
set -uo pipefail

OUT=${1:?}
N=${2:?}
BUILD=${3:?}
DURATION=${4:?}
CHECKOUT=${BENCH_CHECKOUT:-/home/ubuntu/bench/isomux}
BUN=${BENCH_BUN:-/usr/local/bin/bun}
BENCH_DIR=${BENCH_DIR:-/home/ubuntu/bench}

mkdir -p "$OUT/agents"

# The orchestrator runs with a protective oom_score_adj so the harness is not a
# candidate for the killer it is measuring - but that value is inherited across
# fork, and a shielded payload would be a different experiment. Raising is
# always permitted without privilege, so the payload puts itself back to the
# neutral 0 that every agent and build below it then inherits.
echo 0 >/proc/self/oom_score_adj 2>/dev/null
echo "$(date +%s) inner start n=$N build=$BUILD duration=$DURATION oom_score_adj=$(cat /proc/self/oom_score_adj)" >>"$OUT/events.log"

pids=()
for i in $(seq 1 "$N"); do
  BENCH_AGENT_ID="$i" \
  BENCH_CONTEXT_MB="${BENCH_CONTEXT_MB:-280}" \
  BENCH_TOUCH_FRACTION="${BENCH_TOUCH_FRACTION:-0.15}" \
  BENCH_CPU_MS="${BENCH_CPU_MS:-200}" \
  BENCH_IDLE_MS="${BENCH_IDLE_MS:-3000}" \
  BENCH_START_DELAY_MS="$((i * 300))" \
    "$BUN" run "$BENCH_DIR/agentsim.ts" >"$OUT/agents/agent-$i.jsonl" 2>"$OUT/agents/agent-$i.err" &
  pids+=($!)
done
echo "$(date +%s) agents-spawned n=$N" >>"$OUT/events.log"

build_pid=""
if [ "$BUILD" = 1 ]; then
  (
    cd "$CHECKOUT" || exit 1
    while :; do
      echo "$(date +%s) build-cycle-start" >>"$OUT/events.log"
      # A warm install is what an agent does most of the time; a cold one is the
      # worst case and is measured on its own rather than in every cycle.
      if [ "${BENCH_COLD_INSTALL:-0}" = 1 ]; then
        rm -rf node_modules
        echo "$(date +%s) build-node-modules-removed" >>"$OUT/events.log"
      fi
      # A failing install is silent otherwise: it returns in under a second, the
      # arm still runs, and the only trace is a peak ~3 GB lower than it should
      # be. That is how a whole phase was lost when the box's DNS died mid-run.
      # Capture each exit status into a variable BEFORE anything else runs. The
      # earlier form put rc=$? inside a string that also contained $(date ...),
      # so the command substitution reset $? and every line logged the exit
      # status of `date` - reliably 0, and therefore worthless.
      "$BUN" install >>"$OUT/build.log" 2>&1
      rc=$?
      echo "$(date +%s) build-install-done rc=$rc" >>"$OUT/events.log"
      if [ "$rc" -ne 0 ]; then
        echo "$(date +%s) BUILD-INSTALL-FAILED rc=$rc - arm has no build load, results invalid" \
          >>"$OUT/events.log"
      fi
      "$BUN" run build:ui >>"$OUT/build.log" 2>&1
      rc=$?
      echo "$(date +%s) build-ui-done rc=$rc" >>"$OUT/events.log"
      "$BUN" test >>"$OUT/build.log" 2>&1
      rc=$?
      echo "$(date +%s) build-test-done rc=$rc" >>"$OUT/events.log"
    done
  ) &
  build_pid=$!
fi

sleep "$DURATION"
echo "$(date +%s) duration-elapsed" >>"$OUT/events.log"

# Hold the scope open past run-arm.sh's snapshot at DURATION+15. systemd stops a
# scope once its command exits, taking the cgroup - and memory.peak and the
# cumulative counters - with it. One build-only arm lost its entire final
# snapshot to that race before this wait was added.
HOLD=${BENCH_HOLD_OPEN_S:-45}

# Record which agents are still alive: an agent that vanished was killed, which
# is the outcome the benchmark is looking for.
alive=0
for p in "${pids[@]}"; do
  if kill -0 "$p" 2>/dev/null; then alive=$((alive + 1)); fi
done
echo "$(date +%s) agents-alive=$alive of=$N" >>"$OUT/events.log"
sleep "$HOLD"
echo "$(date +%s) hold-open-elapsed" >>"$OUT/events.log"

# Teardown is run-arm.sh's job: it stops the scope, which SIGTERMs every process
# in the cgroup including the build's grandchildren. Killing only what this
# shell can see would leave those behind.
exit 0
