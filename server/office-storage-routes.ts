// The storage routes: storage usage and the manual prune and compress, with the
// live state the pruner must not delete. Moved out of buildExecutorDeps in
// server/isomux-office.ts, which registers them.
import { join } from "path";
import { AsksUnavailableError } from "./asks.ts";
import { STATE_ROOT } from "./config.ts";
import { agentManager, askStore, storageRoots } from "./office-managers.ts";
import { loadSessionsMap, peekMessageQueuesRaw } from "./persistence.ts";
import type { RouteHandler } from "./routes/executor.ts";
import {
  storageHandlers,
  type StorageDeps,
} from "./routes/handlers/storage.ts";
import type { PruneTarget } from "../shared/contract-shapes.ts";
import { applyCompress, planCompress } from "./storage-compress.ts";
import { applyPrune, planPrune, type PruneDeps } from "./storage-prune.ts";
import { measureStorageCached } from "./storage-usage.ts";
import {
  liveTerminalRecordingIds,
  TERMINAL_RECORDINGS_DIR,
} from "./terminal-recorder.ts";

// A prune or compress applied, with when and its policy (task e3d1bc63,
// part 5): an action ask is done when one that covers it was applied since it
// opened. Memory only: every apply calls `applied` (the reconcile) right
// after it, so a stamp only has to live from the apply to that reconcile, and
// a restart loses nothing an open ask needs.
export interface StorageApplied {
  at: number;
  olderThanDays: number;
  keepPerAgent: number;
}

export type StorageOps = Pick<
  StorageDeps,
  "planPrune" | "applyPrune" | "planCompress" | "applyCompress"
> & {
  // The last prune applied to the target, and the last compress.
  lastPrune(target: PruneTarget): StorageApplied | null;
  lastCompress(): StorageApplied | null;
};

// The planners and appliers over the live office, shared by the routes and
// the action asks. `applied` runs after each apply that returned a result.
export function createStorageOps(applied: () => void): StorageOps {
  // Storage visibility + the MANUAL pruner. Nothing here is
  // scheduled: the only way anything gets deleted is an owner POSTing
  // apply:true. The three locations are resolved fresh per call by
  // storageRoots(), which the /isomux-storage slash command shares so the two
  // surfaces cannot disagree about what counts as isomux storage.
  //
  // Rebuilt per call so the active-session set is never a stale snapshot: a
  // plan computed a minute ago must not authorize deleting a session an agent
  // has since resumed (applyPrune re-plans against these same live deps).
  // Attachment filenames still owed to undelivered messages, per agent. They
  // are NOT in any transcript yet, so the pruner's reachability scan cannot see
  // them; without this an attachment on a message queued for a stuck agent
  // could be deleted before it is ever delivered.
  //
  // Both sources, unioned: getAllAgents() splices in the live in-memory queue,
  // and message-queues.json is the durable mirror. The durable read matters
  // because Bun.serve binds the listener BEFORE restoreAgents repopulates the
  // in-memory queues, so during that window the live side is empty. peek-, not
  // load-, so a read-only prune plan can never quarantine the file.
  //
  // Returns null when the durable file could not be read or parsed: that is
  // UNKNOWN, not empty, and the pruner fails closed on it. Collapsing the two
  // would let an unreadable queue read as "nothing is owed" during exactly the
  // boot window where the live queue is also empty.
  //
  // An open ask's read files are copies no transcript names either, so they
  // are owed the same way; an unavailable asks store is unknown too.
  const queuedAttachmentsByAgent = (): Map<string, Set<string>> | null => {
    const durable = peekMessageQueuesRaw();
    if (!durable.ok) return null;
    let asks;
    try {
      asks = askStore?.listAll() ?? [];
    } catch (err) {
      if (err instanceof AsksUnavailableError) return null;
      throw err;
    }
    const byAgent = new Map<string, Set<string>>();
    const add = (agentId: string, filename: unknown) => {
      if (typeof filename !== "string" || filename === "") return;
      const set = byAgent.get(agentId) ?? new Set<string>();
      set.add(filename);
      byAgent.set(agentId, set);
    };
    for (const agent of agentManager.getAllAgents()) {
      for (const queued of agent.queue ?? []) {
        for (const att of queued.attachments ?? []) add(agent.id, att.filename);
      }
    }
    for (const ask of asks)
      for (const att of ask.readFiles ?? []) add(ask.agentId, att.filename);
    for (const [agentId, record] of Object.entries(durable.records)) {
      const queue = (record as { queue?: unknown })?.queue;
      if (!Array.isArray(queue)) continue;
      for (const entry of queue) {
        const atts = (entry as { attachments?: unknown })?.attachments;
        if (!Array.isArray(atts)) continue;
        for (const att of atts) {
          add(agentId, (att as { filename?: unknown })?.filename);
        }
      }
    }
    return byAgent;
  };
  const pruneDeps = (): PruneDeps => {
    const queued = queuedAttachmentsByAgent();
    return {
      logsDir: join(STATE_ROOT, "logs"),
      tokenLogsDir: join(STATE_ROOT, "token-logs"),
      terminalRecordingsDir: join(STATE_ROOT, TERMINAL_RECORDINGS_DIR),
      liveTerminalRecordingIds: liveTerminalRecordingIds(),
      now: Date.now(),
      activeSessionIds: new Set(
        agentManager
          .getAllAgents()
          .map((a) => agentManager.getCurrentSessionId(a.id))
          .filter((id): id is string => id !== null),
      ),
      killedAgentIds: agentManager.getKilledAgentIds(),
      loadSessionsMap: (agentId) => loadSessionsMap(agentId),
      queuedAttachments: (agentId) =>
        queued === null ? null : (queued.get(agentId) ?? new Set<string>()),
    };
  };
  const prunes = new Map<PruneTarget, StorageApplied>();
  let compress: StorageApplied | null = null;
  return {
    planPrune: (target, policy) => planPrune(target, policy, pruneDeps()),
    // The stamp only after the apply returned, and not for one abandoned
    // before it deleted anything: a throw or an abort sets none.
    applyPrune: (plan) => {
      const result = applyPrune(plan, pruneDeps());
      if (!result.aborted) {
        prunes.set(plan.target, { at: Date.now(), ...plan.policy });
        applied();
      }
      return result;
    },
    planCompress: (olderThanDays) => planCompress(olderThanDays, pruneDeps()),
    applyCompress: async (plan) => {
      const result = await applyCompress(plan, {
        ...pruneDeps(),
        isActiveNow: (sessionId) =>
          agentManager
            .getAllAgents()
            .some((a) => agentManager.getCurrentSessionId(a.id) === sessionId),
      });
      if (!result.aborted) {
        compress = {
          at: Date.now(),
          olderThanDays: plan.olderThanDays,
          keepPerAgent: 0,
        };
        applied();
      }
      return result;
    },
    lastPrune: (target) => prunes.get(target) ?? null,
    lastCompress: () => compress,
  };
}

export function createStorageRoutes(
  ops: StorageOps,
): Record<string, RouteHandler> {
  return storageHandlers({
    getUsage: () => measureStorageCached(storageRoots()),
    planPrune: ops.planPrune,
    applyPrune: ops.applyPrune,
    planCompress: ops.planCompress,
    applyCompress: ops.applyCompress,
  });
}
