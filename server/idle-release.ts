// When the office releases an idle agent's engine process (agent-manager's
// sweepIdleAgents). The system prompt names both times to agents.
// prepareRelease serves every release that closes a live session.

import type { ManagedAgent } from "./internal-types.ts";

// 1 h: the Claude prompt cache lasts at most 1 h, so a session idle longer
// pays a full prompt read on its next message, live or not. A resume costs
// little on top: over 21 days of logs (2026-11-05), the first output after
// a wake from eviction came a median 6.1 s after the message, against 5.7 s
// for a live session idle 65-115 min. The sweep runs every minute
// (isomux-office.ts), so an agent goes 60-61 min after its last activity.
export const IDLE_EVICT_MS = 60 * 60_000;

// A session that runs background work (AgentInfo.backgroundTasks: agents,
// commands, Monitors, workflows) keeps its process up to 6 h after its last
// activity, so a build or a watcher outlives the 1 h release. Past that it
// goes like any idle session: a task whose end never arrives does not pin the
// process for ever. Background events stamp no activity, so they cannot
// extend the hold; only a turn can.
export const BACKGROUND_HOLD_MS = 6 * 60 * 60_000;

// Call right before a release closes a live session (the idle sweep, an
// environment change, an account switch). The wake after it says why: an
// environment change the process still waited on wins over `reason`, so the
// agent hears of it. It also names the background work the close ends; read
// it here, because the close clears the list.
export function prepareRelease(
  managed: Pick<
    ManagedAgent,
    "dormantReason" | "envStale" | "releasedBackgroundTasks" | "info"
  >,
  reason: "idle" | "env",
): void {
  managed.dormantReason = managed.envStale ? "env" : reason;
  managed.releasedBackgroundTasks = managed.info.backgroundTasks?.length
    ? managed.info.backgroundTasks
    : null;
}
