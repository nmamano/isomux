import {
  loadSessionsMap,
  listAllAgentIdsOnDisk,
  loadAgentHistory,
  loadLog,
  type PersistedUsage,
} from "./persistence.ts";
import { listCronjobs, readCronjobLifetimeUsage } from "./cronjob-manager.ts";
import {
  listAllCronjobIdsOnDisk,
  loadCronjobHistory,
} from "./cronjob-persistence.ts";
import type { ManagedAgent } from "./internal-types.ts";
import type { RoomWire, UserRecord } from "../shared/types.ts";

// `cacheRead` is discounted cache hits; `cacheCreation` is the 1.25x write
// tier. Raw `input_tokens` (uncached) is usually ~10 — just the new user
// message — so "cached as a % of totalIn" is always ~100% and meaningless.
// The useful signal is hit-rate over *cacheable* input: cacheRead / (cacheRead
// + cacheCreation), which drops when the cache expires and gets rewritten.
export interface UsageBucket {
  totalIn: number;
  cacheRead: number;
  cacheCreation: number;
  totalOut: number;
  costUSD: number;
}

export function emptyBucket(): UsageBucket {
  return {
    totalIn: 0,
    cacheRead: 0,
    cacheCreation: 0,
    totalOut: 0,
    costUSD: 0,
  };
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
// Exported for the Phase 1.4a usage characterization (fork-usage.test.ts) so the
// lifetime/session fork-base math is asserted directly rather than through the
// formatting-coupled renderUsageReport string. Production callers stay internal.
export function readAgentUsage(
  agentId: string,
  currentSessionId: string | null,
): { session: UsageBucket; lifetime: UsageBucket } {
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
    const cacheReadInputTokens =
      (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0);
    const cacheCreationInputTokens =
      (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0);
    const costUSD = (u?.costUSD ?? 0) + (p?.costUSD ?? 0);
    lifetime.totalIn +=
      inputTokens +
      cacheReadInputTokens +
      cacheCreationInputTokens -
      ((base?.inputTokens ?? 0) +
        (base?.cacheReadInputTokens ?? 0) +
        (base?.cacheCreationInputTokens ?? 0));
    lifetime.cacheRead +=
      cacheReadInputTokens - (base?.cacheReadInputTokens ?? 0);
    lifetime.cacheCreation +=
      cacheCreationInputTokens - (base?.cacheCreationInputTokens ?? 0);
    lifetime.totalOut += outputTokens - (base?.outputTokens ?? 0);
    lifetime.costUSD += costUSD - (base?.costUSD ?? 0);
  }
  const session = emptyBucket();
  const sessEntry = currentSessionId ? map[currentSessionId] : undefined;
  if (sessEntry && (sessEntry.usage || sessEntry.priorRunsUsage)) {
    const u = sessEntry.usage;
    const p = sessEntry.priorRunsUsage;
    session.totalIn =
      (u?.inputTokens ?? 0) +
      (p?.inputTokens ?? 0) +
      (u?.cacheReadInputTokens ?? 0) +
      (p?.cacheReadInputTokens ?? 0) +
      (u?.cacheCreationInputTokens ?? 0) +
      (p?.cacheCreationInputTokens ?? 0);
    session.cacheRead =
      (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0);
    session.cacheCreation =
      (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0);
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
export function findUsageAtFork(
  agentId: string,
  parentSessionId: string,
  forkMessageId: string,
): PersistedUsage | undefined {
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
    cacheReadInputTokens:
      (u?.cacheReadInputTokens ?? 0) + (p?.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      (u?.cacheCreationInputTokens ?? 0) + (p?.cacheCreationInputTokens ?? 0),
    costUSD: (u?.costUSD ?? 0) + (p?.costUSD ?? 0),
  };
}

// Who the report is rendered for. Spend is room-scoped data, so the report
// follows the same ACCESS gate as every other read surface (roomAllowedForSession
// / visibleRoomProjection): owners see the whole office by rule, members see
// only the rooms they can access. Cron jobs carry no room, so a member could not
// attribute them to a visible room — they are owner-only, and so is their spend.
export type UsageAudience =
  | { kind: "owner" }
  | { kind: "member"; roomIds: ReadonlySet<string> };

// Resolve the invoking user to an audience. Mirrors canAccess() in index.ts:
// owners access every room by RULE (their `allowedRooms` is empty post-migration
// and must NOT be read), members access exactly their grants. Fails closed on an
// unresolved user — slash commands only arrive on the authenticated user path,
// so this is a defensive branch, not a real caller.
export function usageAudienceForUser(
  user: UserRecord | undefined,
): UsageAudience {
  if (user?.role === "owner") return { kind: "owner" };
  return { kind: "member", roomIds: new Set(user?.allowedRooms ?? []) };
}

export function renderUsageReport(
  agents: Map<string, ManagedAgent>,
  rooms: RoomWire[],
  audience: UsageAudience,
): string {
  const lines: string[] = [];
  const isOwner = audience.kind === "owner";
  const canSeeRoom = (roomId: string): boolean =>
    audience.kind === "owner" || audience.roomIds.has(roomId);
  // Every table below is built from this list, so a room the caller can't
  // access can't leak through any of them.
  const visibleRooms = isOwner ? rooms : rooms.filter((r) => canSeeRoom(r.id));

  lines.push(
    `_Subscription plan limits aren't shown here. Open the embedded terminal and run \`claude\` + \`/usage\` or \`codex\` + \`/status\`._`,
  );
  if (!isOwner) {
    lines.push("");
    lines.push(
      `_Scoped to the rooms you can access; cron job spend isn't included._`,
    );
  }
  lines.push("");

  // Office-wide table: per-agent session and lifetime usage. "In" is all
  // input tiers summed (raw + cache read + cache creation); the inline "%
  // hit" is cache hit rate over cacheable input. Markdown only supports a
  // single header row, so session/lifetime groupings are encoded as
  // parenthesised suffixes on each column.
  lines.push(`## Agent usage`);
  lines.push("");
  lines.push(
    `| Agent | Room | In (sess) | Out (sess) | $ (sess) | In (life) | Out (life) | $ (life) |`,
  );
  lines.push(`| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  // Phase 3c: resolve each agent's room by its authoritative roomId (the only
  // room reference — the dense AgentInfo.room index has been removed). Local map
  // mirrors the id-keyed bucket pass below, so no AgentManager helper needs
  // threading in here.
  const roomByIdMap = new Map(visibleRooms.map((r) => [r.id, r] as const));
  const rows = [...agents.values()]
    .filter((a) => canSeeRoom(a.info.roomId))
    .map((a) => {
      const usage = readAgentUsage(a.info.id, a.sessionId);
      const roomName = roomByIdMap.get(a.info.roomId)?.name ?? "?";
      return {
        id: a.info.id,
        name: a.info.name,
        room: roomName,
        sess: usage.session,
        life: usage.lifetime,
      };
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
  type RoomBucket = {
    id: string;
    name: string;
    deleted: boolean;
    sess: UsageBucket;
    life: UsageBucket;
  };
  const roomBuckets = new Map<string, RoomBucket>();
  const getBucket = (
    id: string,
    name: string,
    deleted: boolean,
  ): RoomBucket => {
    let b = roomBuckets.get(id);
    if (!b) {
      b = { id, name, deleted, sess: emptyBucket(), life: emptyBucket() };
      roomBuckets.set(id, b);
    }
    return b;
  };
  // Seed with all current rooms so they show even when empty.
  for (const r of visibleRooms) getBucket(r.id, r.name, false);

  for (const a of agents.values()) {
    const room = roomByIdMap.get(a.info.roomId);
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
    const currentRoom = visibleRooms.find((r) => r.id === roomId);
    // A member can only be shown spend they can attribute to a room they
    // access, so deleted and unknown rooms (no live room behind them) stay
    // owner-only — as does the non-visible-room spend the filter drops.
    if (!isOwner && !currentRoom) continue;
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

  const sortedBuckets = [...roomBuckets.values()].sort(
    (a, b) => b.life.costUSD - a.life.costUSD,
  );

  lines.push("");
  lines.push(`## Per-room usage`);
  lines.push("");
  lines.push(
    `_Agents contribute to the room they were last in (killed agents included)._`,
  );
  lines.push("");
  lines.push(
    `| Room | In (sess) | Out (sess) | $ (sess) | In (life) | Out (life) | $ (life) |`,
  );
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const r of sortedBuckets) {
    const label = r.deleted ? `${r.name} _(deleted)_` : r.name;
    lines.push(
      `| ${label} | ${formatInCell(r.sess)} | ${formatTokenCount(r.sess.totalOut)} | ${formatUsd(r.sess.costUSD)} | ${formatInCell(r.life)} | ${formatTokenCount(r.life.totalOut)} | ${formatUsd(r.life.costUSD)} |`,
    );
  }

  // Per-cronjob lifetime usage. Mirrors the per-room shape: live cronjobs +
  // any disk-only cronjobs (deleted) so historical spend isn't lost. Cron jobs
  // are not room-scoped, so this whole section — table AND its contribution to
  // the total below — is owner-only.
  if (isOwner) renderCronjobSection(lines, total.life);

  lines.push("");
  lines.push(isOwner ? `## Office total` : `## Total`);
  lines.push("");
  lines.push(
    `| | In (sess) | Out (sess) | $ (sess) | In (life) | Out (life) | $ (life) |`,
  );
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  lines.push(
    `| **Total** | ${formatInCell(total.sess)} | ${formatTokenCount(total.sess.totalOut)} | ${formatUsd(total.sess.costUSD)} | ${formatInCell(total.life)} | ${formatTokenCount(total.life.totalOut)} | ${formatUsd(total.life.costUSD)} |`,
  );

  return lines.join("\n");
}

// Owner-only section: per-cron job lifetime spend, plus the roll-up of that
// spend into the report's lifetime total. Mutates both `lines` and `totalLife`.
function renderCronjobSection(lines: string[], totalLife: UsageBucket): void {
  const liveCronjobs = listCronjobs();
  const liveCronjobIds = new Set(liveCronjobs.map((c) => c.id));
  const cronjobHistory = loadCronjobHistory();
  type CronjobBucket = {
    id: string;
    name: string;
    deleted: boolean;
    life: UsageBucket;
  };
  const cronjobBuckets: CronjobBucket[] = [];
  for (const job of liveCronjobs) {
    const u = readCronjobLifetimeUsage(job.id);
    cronjobBuckets.push({
      id: job.id,
      name: job.name,
      deleted: false,
      life: {
        totalIn: u.totalIn,
        cacheRead: u.cacheRead,
        cacheCreation: u.cacheCreation,
        totalOut: u.totalOut,
        costUSD: u.costUSD,
      },
    });
  }
  for (const id of listAllCronjobIdsOnDisk()) {
    if (liveCronjobIds.has(id)) continue;
    const u = readCronjobLifetimeUsage(id);
    if (u.costUSD === 0 && u.totalIn === 0 && u.totalOut === 0) continue;
    cronjobBuckets.push({
      id,
      name: cronjobHistory[id]?.lastName ?? "(unknown cron job)",
      deleted: true,
      life: {
        totalIn: u.totalIn,
        cacheRead: u.cacheRead,
        cacheCreation: u.cacheCreation,
        totalOut: u.totalOut,
        costUSD: u.costUSD,
      },
    });
  }

  // Roll cronjob spend into the office total so the bottom line is honest.
  const cronjobLifeTotal = emptyBucket();
  for (const b of cronjobBuckets) addBucket(cronjobLifeTotal, b.life);
  addBucket(totalLife, cronjobLifeTotal);

  if (cronjobBuckets.length > 0) {
    cronjobBuckets.sort((a, b) => b.life.costUSD - a.life.costUSD);
    lines.push("");
    lines.push(`## Per-cron job usage`);
    lines.push("");
    lines.push(`| Cron job | In (life) | Out (life) | $ (life) |`);
    lines.push(`| --- | ---: | ---: | ---: |`);
    for (const r of cronjobBuckets) {
      const label = r.deleted ? `${r.name} _(deleted)_` : r.name;
      lines.push(
        `| ${label} | ${formatInCell(r.life)} | ${formatTokenCount(r.life.totalOut)} | ${formatUsd(r.life.costUSD)} |`,
      );
    }
  }
}
