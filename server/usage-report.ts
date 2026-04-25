import { loadSessionsMap, listAllAgentIdsOnDisk, loadAgentHistory, loadLog, type PersistedUsage } from "./persistence.ts";
import type { ManagedAgent, InternalRoom } from "./internal-types.ts";

// `cacheRead` is discounted cache hits; `cacheCreation` is the 1.25x write
// tier. Raw `input_tokens` (uncached) is usually ~10 — just the new user
// message — so "cached as a % of totalIn" is always ~100% and meaningless.
// The useful signal is hit-rate over *cacheable* input: cacheRead / (cacheRead
// + cacheCreation), which drops when the cache expires and gets rewritten.
export interface UsageBucket { totalIn: number; cacheRead: number; cacheCreation: number; totalOut: number; costUSD: number; }

export function emptyBucket(): UsageBucket {
  return { totalIn: 0, cacheRead: 0, cacheCreation: 0, totalOut: 0, costUSD: 0 };
}

function addBucket(dst: UsageBucket, src: UsageBucket) {
  dst.totalIn += src.totalIn;
  dst.cacheRead += src.cacheRead;
  dst.cacheCreation += src.cacheCreation;
  dst.totalOut += src.totalOut;
  dst.costUSD += src.costUSD;
}

export function formatTokenCount(n: number): string {
  if (n === 0) return "—";
  // 999_500 rounds to "1000k" under naive thresholds; promote to M.
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return n.toLocaleString();
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  const date = new Date(timestamp);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Hide the (N% hit) suffix above 80% since typical usage hovers 92-100% and the
// clutter drowns out the signal. Showing only low hit rates turns absence into
// the default and presence into a cache-thrash canary.
const CACHE_HIT_WARN_THRESHOLD = 80;

function formatInCell(b: UsageBucket): string {
  if (b.totalIn === 0) return "—";
  const cacheable = b.cacheRead + b.cacheCreation;
  if (cacheable === 0) return formatTokenCount(b.totalIn);
  const pct = Math.round((b.cacheRead / cacheable) * 100);
  if (pct >= CACHE_HIT_WARN_THRESHOLD) return formatTokenCount(b.totalIn);
  return `${formatTokenCount(b.totalIn)} (${pct}% hit)`;
}

function formatUsd(n: number): string {
  if (n === 0) return "—";
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

// Read an agent's per-session usage off disk and aggregate into:
//   - session: usage for `currentSessionId` (the agent's active conversation)
//   - lifetime: sum of (entry.usage - entry.forkBaseUsage) across all entries
// `forkBaseUsage` is captured at fork creation by walking the parent's log to
// find the cumulative usage at the exact fork point, so each fork contributes
// only its own new work — no double-counting of the shared parent prefix.
function readAgentUsage(agentId: string, currentSessionId: string | null): { session: UsageBucket; lifetime: UsageBucket } {
  const map = loadSessionsMap(agentId);
  const lifetime = emptyBucket();
  for (const entry of Object.values(map)) {
    if (!entry.usage && !entry.priorRunsUsage) continue;
    const u = entry.usage;
    const p = entry.priorRunsUsage;
    const base = entry.forkBaseUsage;
    // Session total = current-run + all prior completed runs (if any).
    const inputTokens = (u?.inputTokens ?? 0) + (p?.inputTokens ?? 0);
    const outputTokens = (u?.outputTokens ?? 0) + (p?.outputTokens ?? 0);
    const cacheReadInputTokens = (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0);
    const cacheCreationInputTokens = (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0);
    const costUSD = (u?.costUSD ?? 0) + (p?.costUSD ?? 0);
    lifetime.totalIn += inputTokens + cacheReadInputTokens + cacheCreationInputTokens
      - ((base?.inputTokens ?? 0) + (base?.cacheReadInputTokens ?? 0) + (base?.cacheCreationInputTokens ?? 0));
    lifetime.cacheRead += cacheReadInputTokens - (base?.cacheReadInputTokens ?? 0);
    lifetime.cacheCreation += cacheCreationInputTokens - (base?.cacheCreationInputTokens ?? 0);
    lifetime.totalOut += outputTokens - (base?.outputTokens ?? 0);
    lifetime.costUSD += costUSD - (base?.costUSD ?? 0);
  }
  const session = emptyBucket();
  const sessEntry = currentSessionId ? map[currentSessionId] : undefined;
  if (sessEntry && (sessEntry.usage || sessEntry.priorRunsUsage)) {
    const u = sessEntry.usage;
    const p = sessEntry.priorRunsUsage;
    session.totalIn = (u?.inputTokens ?? 0) + (p?.inputTokens ?? 0)
      + (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0)
      + (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0);
    session.cacheRead = (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0);
    session.cacheCreation = (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0);
    session.totalOut = (u?.outputTokens ?? 0) + (p?.outputTokens ?? 0);
    session.costUSD = (u?.costUSD ?? 0) + (p?.costUSD ?? 0);
  }
  return { session, lifetime };
}

// Locate a parent's cumulative usage at a fork point. Walks the parent's log
// to find `forkMessageId`'s position, then returns the latest snapshot whose
// anchor entry sits before that position. When the parent has no snapshots
// (e.g. it predates snapshot tracking), fall back to the parent's current
// cumulative `usage` — best-effort, slightly over-subtracts if the parent
// continued past the fork, but bounded and avoids a full prefix double-count
// in lifetime totals.
export function findUsageAtFork(agentId: string, parentSessionId: string, forkMessageId: string): PersistedUsage | undefined {
  const entries = loadLog(agentId, parentSessionId);
  const positions = new Map<string, number>();
  entries.forEach((e, i) => positions.set(e.id, i));
  const forkPos = positions.get(forkMessageId);
  if (forkPos === undefined) return undefined;
  const parentMeta = loadSessionsMap(agentId)[parentSessionId];
  const snapshots = parentMeta?.usageSnapshots ?? [];
  let best: PersistedUsage | undefined;
  let bestPos = -1;
  for (const snap of snapshots) {
    const p = positions.get(snap.entryId);
    if (p === undefined) continue;
    if (p < forkPos && p > bestPos) {
      bestPos = p;
      best = snap.usage;
    }
  }
  // Fallback when no snapshot sits before the fork point: use the parent's
  // current cumulative (priorRunsUsage + usage). After a resume with no new
  // results yet, `usage` may be undefined while priorRunsUsage holds the real
  // value — sum both so forks off just-resumed parents still get a base.
  if (best) return best;
  const u = parentMeta?.usage;
  const p = parentMeta?.priorRunsUsage;
  if (!u && !p) return undefined;
  return {
    inputTokens: (u?.inputTokens ?? 0) + (p?.inputTokens ?? 0),
    outputTokens: (u?.outputTokens ?? 0) + (p?.outputTokens ?? 0),
    cacheReadInputTokens: (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0),
    costUSD: (u?.costUSD ?? 0) + (p?.costUSD ?? 0),
  };
}

export function renderUsageReport(agents: Map<string, ManagedAgent>, rooms: InternalRoom[]): string {
  const lines: string[] = [];

  lines.push(
    `_Subscription plan limits aren't shown here — open the embedded terminal (desktop only), run \`claude\`, then \`/usage\`._`,
  );
  lines.push("");

  // Office-wide table: per-agent session and lifetime usage. "In" is all
  // input tiers summed (raw + cache read + cache creation); the inline "%
  // hit" is cache hit rate over cacheable input. Markdown only supports a
  // single header row, so session/lifetime groupings are encoded as
  // parenthesised suffixes on each column.
  lines.push(`## Agent usage`);
  lines.push("");
  lines.push(`| Agent | Room | In (sess) | Out (sess) | $ (sess) | In (life) | Out (life) | $ (life) |`);
  lines.push(`| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  const rows = [...agents.values()].map((a) => {
    const usage = readAgentUsage(a.info.id, a.sessionId);
    const roomName = rooms[a.info.room]?.name ?? "?";
    return { id: a.info.id, name: a.info.name, room: roomName, sess: usage.session, life: usage.lifetime };
  });
  rows.sort((a, b) => b.life.costUSD - a.life.costUSD);
  for (const r of rows) {
    lines.push(
      `| ${r.name} | ${r.room} | ${formatInCell(r.sess)} | ${formatTokenCount(r.sess.totalOut)} | ${formatUsd(r.sess.costUSD)} | ${formatInCell(r.life)} | ${formatTokenCount(r.life.totalOut)} | ${formatUsd(r.life.costUSD)} |`,
    );
  }

  // Per-room totals + grand total. Each agent (live or killed) contributes to
  // the room it was last in — resolved via agent-history.json, which persists
  // each live agent's room on every persistAll. Rooms that have since been
  // deleted still appear, labeled "(deleted)", so prior spend isn't lost.
  // Buckets are keyed by stable roomId; current-room names override historical
  // names so renames are reflected immediately.
  const liveAgentIds = new Set([...agents.values()].map((a) => a.info.id));
  const history = loadAgentHistory();
  type RoomBucket = { id: string; name: string; deleted: boolean; sess: UsageBucket; life: UsageBucket };
  const roomBuckets = new Map<string, RoomBucket>();
  const getBucket = (id: string, name: string, deleted: boolean): RoomBucket => {
    let b = roomBuckets.get(id);
    if (!b) {
      b = { id, name, deleted, sess: emptyBucket(), life: emptyBucket() };
      roomBuckets.set(id, b);
    }
    return b;
  };
  // Seed with all current rooms so they show even when empty.
  for (const r of rooms) getBucket(r.id, r.name, false);

  for (const a of agents.values()) {
    const room = rooms[a.info.room];
    if (!room) continue;
    const usage = readAgentUsage(a.info.id, a.sessionId);
    const b = getBucket(room.id, room.name, false);
    addBucket(b.sess, usage.session);
    addBucket(b.life, usage.lifetime);
  }
  for (const id of listAllAgentIdsOnDisk()) {
    if (liveAgentIds.has(id)) continue;
    const h = history[id];
    // Killed agents without a history entry predate this feature; drop into a
    // synthetic bucket so their spend is still counted toward the grand total.
    const roomId = h?.lastRoomId ?? "__unknown__";
    const currentRoom = rooms.find((r) => r.id === roomId);
    const name = currentRoom?.name ?? h?.lastRoomName ?? "(unknown room)";
    const deleted = !currentRoom;
    const usage = readAgentUsage(id, null);
    const b = getBucket(roomId, name, deleted);
    addBucket(b.life, usage.lifetime);
  }

  const total = { sess: emptyBucket(), life: emptyBucket() };
  for (const b of roomBuckets.values()) {
    addBucket(total.sess, b.sess);
    addBucket(total.life, b.life);
  }

  const sortedBuckets = [...roomBuckets.values()].sort((a, b) => b.life.costUSD - a.life.costUSD);

  lines.push("");
  lines.push(`## Per-room usage`);
  lines.push("");
  lines.push(`_Agents contribute to the room they were last in (killed agents included)._`);
  lines.push("");
  lines.push(`| Room | In (sess) | Out (sess) | $ (sess) | In (life) | Out (life) | $ (life) |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const r of sortedBuckets) {
    const label = r.deleted ? `${r.name} _(deleted)_` : r.name;
    lines.push(
      `| ${label} | ${formatInCell(r.sess)} | ${formatTokenCount(r.sess.totalOut)} | ${formatUsd(r.sess.costUSD)} | ${formatInCell(r.life)} | ${formatTokenCount(r.life.totalOut)} | ${formatUsd(r.life.costUSD)} |`,
    );
  }
  lines.push(
    `| **Total** | ${formatInCell(total.sess)} | ${formatTokenCount(total.sess.totalOut)} | ${formatUsd(total.sess.costUSD)} | ${formatInCell(total.life)} | ${formatTokenCount(total.life.totalOut)} | ${formatUsd(total.life.costUSD)} |`,
  );

  return lines.join("\n");
}
