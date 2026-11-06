// The cron runs that are live in memory, one slot per run id: a follow-up or
// an edit claims its run while its resume starts, and an owner holds it while
// it runs. An ended run has no slot; its row carries how and when it ended
// (cronjob-run-state.ts).
import type {
  AgentBackendType,
  CronjobRun,
  LogEntry,
} from "../shared/types.ts";
import type { BackendSession } from "./backends/types.ts";

// A session turn that holds its run (a first turn, a follow-up or an edit).
export interface SessionRun {
  kind: "session";
  jobId: string;
  runId: string;
  streamId: string;
  agentType: AgentBackendType;
  session: BackendSession;
  sessionId: string | null;
  rootSessionId: string;
  launchedClaudeConfigDir?: string;
  consumerPromise: Promise<void>;
  hardTimeoutTimer: ReturnType<typeof setTimeout> | null;
  lastWrittenEntryId: string | null;
  lastAssistantText: string;
  trigger: CronjobRun["trigger"];
  // Buffer entries created before system_init assigns a sessionId. Without
  // this, pre-init errors (e.g. "Failed to send prompt") get broadcast to
  // clients but never persisted to disk, so they vanish on reload.
  pendingEntries: LogEntry[];
  // Per-turn tool-call start timestamps, keyed by toolUseId. Used to compute
  // duration_ms on the matching tool_result event when the backend itself
  // doesn't emit a durationMs.
  toolCallTimestamps: Map<string, number>;
  // True for follow-up turns on a previously-finalized run (resumed or
  // edit-forked). On resume the backend reuses the existing sessionId, so
  // system_init must NOT clobber rootSessionId - only currentSessionId
  // tracks the leaf.
  isResume: boolean;
  // Set when this activation runs an edited message's turn (editRunMessage):
  // every error entry of the turn keeps the edited text (FAILED_EDIT_TEXT_KEY),
  // so a turn that fails late still offers the text back.
  failedEditText?: string;
  // The backend sent auth_needed in this activation: its end writes the
  // login hint.
  authNeeded?: boolean;
}

// A send to a job's agent target that holds its run while it is in flight.
export interface DeliveryRun {
  kind: "delivery";
  jobId: string;
  runId: string;
}

export type RunOwner = SessionRun | DeliveryRun;

type RunSlot = { kind: "starting" } | { kind: "running"; owner: RunOwner };

export function createRunSlots() {
  const slots = new Map<string, RunSlot>();

  // Whether `owner` still holds its run. Identity, not presence: a late event
  // of a replaced owner must not act for the owner that took its slot
  // (task 44872c41).
  function owns(owner: RunOwner): boolean {
    const slot = slots.get(owner.runId);
    return slot?.kind === "running" && slot.owner === owner;
  }

  // The session turn that holds `runId`, if any. A send to an agent has no
  // session, transcript tools or weight on the schedule's next slot.
  function sessionOwner(runId: string): SessionRun | null {
    const slot = slots.get(runId);
    return slot?.kind === "running" && slot.owner.kind === "session"
      ? slot.owner
      : null;
  }

  return {
    owns,
    sessionOwner,
    sessionOwners(): SessionRun[] {
      return [...slots.keys()]
        .map(sessionOwner)
        .filter((a): a is SessionRun => a !== null);
    },
    // A follow-up or an edit may start only on a run with no slot.
    busy: (runId: string): boolean => slots.has(runId),
    // Claimed synchronously, before the first await: without it, a second
    // concurrent send/edit for the same run would pass the busy check during
    // the awaits in editRunMessage (getSessionMessages → forkSession), fork
    // twice, and overwrite the first one's owner.
    claim(runId: string): RunSlot {
      const claim: RunSlot = { kind: "starting" };
      slots.set(runId, claim);
      return claim;
    },
    // Releases a claim that no owner replaced.
    release(runId: string, claim: RunSlot): void {
      if (slots.get(runId) === claim) slots.delete(runId);
    },
    hold(owner: RunOwner): void {
      slots.set(owner.runId, { kind: "running", owner });
    },
    // Drops the slot `owner` holds; false when it holds none.
    drop(owner: RunOwner): boolean {
      if (!owns(owner)) return false;
      slots.delete(owner.runId);
      return true;
    },
  };
}
