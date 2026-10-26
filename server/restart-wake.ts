// Wake after a server restart (task 96976e2e): the pure parts.
//
// While the office runs, agent-manager records in ~/.isomux/turns-in-flight.json
// each agent with a turn in flight: written at the turn's start, removed a
// short delay after it ends, never while the server stops. At boot each
// recorded agent gets one self-sent message to continue, a few at a time. The
// record of a turn that such a wake started carries `restartWake`, and the
// next boot does not wake it again, so a turn that crashes the server cannot
// make a restart loop. The state machine lives in agent-manager; this module
// holds the timing, the words and the boot plan.

/** One agent's entry in turns-in-flight.json. */
export interface TurnInFlightRecord {
  since: number;
  restartWake?: true;
}

/** The agent-facing message. The flush sends it as it is, with no prefix. */
export const RESTART_WAKE_TEXT =
  "[Isomux: the server restarted during your turn. Continue where you stopped.]";

// Wakes go out this many at a time.
export const RESTART_WAKE_BATCH = 3;
// The first batch waits this long after boot, so agent restore is done.
export const RESTART_WAKE_BOOT_DELAY_MS = 10_000;
// The wait between two batches.
export const RESTART_WAKE_INTERVAL_MS = 20_000;
// A turn's record is removed this long after the turn ends, so a turn end
// that the server's own stop causes (every backend dies at once) is not
// mistaken for a real one before the stop signal is seen.
export const RESTART_WAKE_CLEAR_DELAY_MS = 1_000;

export type RestartWakeDropReason =
  | "malformed"
  | "agent gone"
  | "already woken"
  | "no conversation";

export interface RestartWakePlan {
  /** Agents to wake, oldest `since` first. */
  wake: string[];
  /** Entries that get no wake. */
  drop: { agentId: string; reason: RestartWakeDropReason }[];
}

/** The boot plan for the entries read from turns-in-flight.json. */
export function planRestartWakes(
  records: Record<string, unknown>,
  opts: {
    exists: (agentId: string) => boolean;
    resumable: (agentId: string) => boolean;
  },
): RestartWakePlan {
  const wake: { agentId: string; since: number }[] = [];
  const drop: RestartWakePlan["drop"] = [];
  for (const [agentId, raw] of Object.entries(records)) {
    const since = (raw as { since?: unknown } | null)?.since;
    if (
      typeof raw !== "object" ||
      typeof since !== "number" ||
      !Number.isFinite(since)
    )
      drop.push({ agentId, reason: "malformed" });
    else if (!opts.exists(agentId))
      drop.push({ agentId, reason: "agent gone" });
    else if ((raw as TurnInFlightRecord).restartWake === true)
      drop.push({ agentId, reason: "already woken" });
    else if (!opts.resumable(agentId))
      drop.push({ agentId, reason: "no conversation" });
    else wake.push({ agentId, since });
  }
  wake.sort((a, b) => a.since - b.since);
  return { wake: wake.map((w) => w.agentId), drop };
}

/** How long after boot the wake at position `index` of the plan goes out. */
export function restartWakeDelayMs(index: number): number {
  return (
    RESTART_WAKE_BOOT_DELAY_MS +
    Math.floor(index / RESTART_WAKE_BATCH) * RESTART_WAKE_INTERVAL_MS
  );
}
