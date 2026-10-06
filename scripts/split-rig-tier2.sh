#!/usr/bin/env bash
# Split rig, tier 2: split mode with the real claude and codex binaries and
# the operator's own provider sign-ins, in a throwaway rig container. It never touches the
# live office. It copies ~/.claude/.credentials.json and
# ~/.isomux/codex-home/auth.json into the container volume; the stop at the
# end removes the container and its volume.
#
#   bash scripts/split-rig-tier2.sh [REVISION]      (default: HEAD of the worktree)
#
# Expect for each agent: uid 1000 and "Permission denied" for the office
# state file. For Codex, no safety-hook failure in the office log or the
# agent log (the first "[codex safety] content mismatch ... repairing" line
# is the first install and is expected).
set -euo pipefail
cd ~/nil/isomux-worktrees/loop-os-user
export SPLIT_RIG_REAL_PROVIDERS=1
N=split-rig-tier2
OFFICE=http://127.0.0.1:10000
ASK='Run these two shell commands and show their output verbatim: id -u ; cat /var/data/server/.isomux/users.json'

systemd-run --user --scope -p MemoryMax=6G scripts/split-rig.sh build "${1:-HEAD}"
scripts/split-rig.sh stop "$N"
trap 'scripts/split-rig.sh stop "$N"' EXIT
scripts/split-rig.sh start "$N"
until docker exec "$N" curl -sf -o /dev/null "$OFFICE/readyz"; do sleep 1; done

# Credentials go to the agent user's home only; the server user cannot read them.
docker exec -u node "$N" mkdir -p -m 700 /var/data/home/.claude /var/data/home/.isomux/codex-home /tmp/rig-work
docker cp ~/.claude/.credentials.json "$N:/var/data/home/.claude/.credentials.json"
docker cp ~/.isomux/codex-home/auth.json "$N:/var/data/home/.isomux/codex-home/auth.json"
docker exec "$N" sh -c 'cd /var/data/home && chown node:node .claude/.credentials.json .isomux/codex-home/auth.json && chmod 600 .claude/.credentials.json .isomux/codex-home/auth.json'

COOKIE=$(docker exec "$N" curl -s -i -X POST "$OFFICE/auth/claim" -H "Origin: http://localhost:10000" \
  --data-urlencode "name=Tier2 Owner" | sed -n 's/^[Ss]et-[Cc]ookie: \(isomux_session=[^;]*\).*/\1/p')
[[ -n "$COOKIE" ]] || { echo "claim failed" >&2; exit 1; }
api() { # METHOD PATH JSON
  docker exec -i "$N" curl -s -X "$1" "$OFFICE$2" -H "Cookie: $COOKIE" \
    -H "Origin: http://localhost:10000" -H "Content-Type: application/json" --data-binary @- <<< "$3"
}
ROOM=$(docker exec "$N" curl -s "$OFFICE/agents" -H "Cookie: $COOKIE" |
  docker exec -i "$N" bun -e 'console.log(JSON.parse(await Bun.stdin.text()).find((a) => a.roomId !== "lobby").roomId)')
# No permission prompt for Claude (Codex agents default to danger-full-access):
# a refusal can come only from the kernel.
spawn() { # TYPE DESK EXTRA_JSON
  api POST /api/agents "{\"name\":\"Tier2 $1\",\"cwd\":\"/tmp/rig-work\",\"roomId\":\"$ROOM\",\"desk\":$2,\"agentType\":\"$1\",$3}" |
    docker exec -i "$N" bun -e 'console.log(JSON.parse(await Bun.stdin.text()).agent.id)'
}
CLAUDE=$(spawn claude 1 '"permissionMode":"bypassPermissions"')
CODEX=$(spawn codex 2 '"permissionMode":"never"')
for id in "$CLAUDE" "$CODEX"; do api POST "/api/agents/$id/messages" "{\"text\":\"$ASK\"}" > /dev/null; done

WAIT=${TIER2_WAIT:-180}
echo "waiting $WAIT s for both turns"
sleep "$WAIT"
for id in "$CLAUDE" "$CODEX"; do
  echo "=== $id"
  docker exec "$N" sh -c "cat /var/data/server/.isomux/logs/$id/*.jsonl" |
    docker exec -i "$N" bun -e 'for (const l of (await Bun.stdin.text()).split("\n").filter(Boolean)) {
      const e = JSON.parse(l);
      if (["text", "tool_call", "tool_result", "error", "system"].includes(e.kind)) console.log(e.kind + ": " + String(e.content).slice(0, 400));
    }' || echo "(no log yet: rerun with a longer TIER2_WAIT)"
done
echo "=== safety-hook failures (expect none)"
docker logs "$N" 2>&1 | grep -E 'hook configuration failed|safety check skipped' || echo "(none)"
