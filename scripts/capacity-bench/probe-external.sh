#!/usr/bin/env bash
# External reachability probe for the capacity benchmark. Runs on a DIFFERENT
# box from the one under test, because that is the only place the question
# "can the customer still get in" can honestly be asked: a loopback probe shares
# the page cache and the run queue it is meant to be judging.
#
# Records connect-and-run-a-command latency, not just a TCP banner, so a box
# that accepts connections but cannot fork a shell still reads as a failure.
#
#   usage: probe-external.sh <user@host> <out.csv> [cadence-seconds] [timeout-seconds]
set -uo pipefail

TARGET=${1:?usage: probe-external.sh <user@host> <out.csv> [cadence] [timeout]}
OUT=${2:?}
CADENCE=${3:-5}
TIMEOUT=${4:-10}

echo "ts_ms,result,latency_ms" >"$OUT"
while :; do
  s=$(date +%s%3N)
  if timeout "$TIMEOUT" ssh -o BatchMode=yes -o ConnectTimeout="$TIMEOUT" \
       -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
       "$TARGET" true >/dev/null 2>&1; then
    r=ok
  else
    r=FAIL
  fi
  e=$(date +%s%3N)
  echo "$s,$r,$((e - s))" >>"$OUT"
  sleep "$CADENCE"
done
