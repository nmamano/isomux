#!/usr/bin/env bash
# Copies one tier's run files to $WORK/res/<tier> and prints one analyze.ts
# row per level (also saved as rows.jsonl).
# usage: fetch.sh A|B
set -euo pipefail
. "$(dirname "$0")/lib.sh"
. $WORK/aws.env
ANALYZE=$(realpath "$(dirname "$0")/analyze.ts")
T=${1:?usage: fetch.sh A|B}
R=$WORK/res/$T
mkdir -p "$R"
# shellcheck disable=SC2086
case $T in
  A) ssh $SSH_OPTS ubuntu@"$OFF_PUB" "sudo tar -C /root/lt -cf - A" | tar -C $WORK/res -xf - ;;
  B)
    scp -q $SSH_OPTS -r ubuntu@"$GEN_PUB":lt/B/. "$R"/
    # Tier B's engine receipts and resource samples are on the office VM,
    # one file for the whole run; each level reads its own time window.
    ssh $SSH_OPTS ubuntu@"$OFF_PUB" "sudo cat /root/lt/eng/engine.jsonl" > "$R/engine.jsonl"
    ssh $SSH_OPTS ubuntu@"$OFF_PUB" "sudo cat /root/lt/sample.jsonl" > "$R/sample.jsonl"
    for d in "$R"/*/; do
      [ -f "$d/gen-0.json" ] || continue
      for f in engine.jsonl sample.jsonl server.json; do ln -sf "../$f" "$d/$f"; done
    done
    ;;
  *) echo "usage: fetch.sh A|B" >&2; exit 2 ;;
esac
bun run "$ANALYZE" "$R"/*/ > "$R/rows.jsonl"
cat "$R/rows.jsonl"
