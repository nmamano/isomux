// The lockdown route (task cdd7883d; Nil, 2026-11-06: owners and their
// agents). POST /api/office/lockdown locks the office from inside it:
//
//   1. write <state>/LOCKDOWN; a failure answers 500 and changes nothing else;
//   2. lock this process (server/office-lock-gate.ts): every later request
//      gets the locked page, and every open WebSocket closes;
//   3. the audit row office.lockdown (a failure is logged; the lock goes on);
//   4. answer 202, then stop the process. Its last stop step moves the
//      sign-ins, API tokens, invites and extension pairings aside, deletes
//      the owner exports and stops the apps (lockStopStep), so the lock does
//      not wait for a restart: a unit with Restart=on-failure leaves the
//      office stopped. A service manager that starts it again gets a locked
//      boot, which does the same again.
//
// The service user cannot write the root marker, so this lock has the state
// marker only; the host command's lock is the one the office user cannot
// remove.

import type { AuditActor } from "../shared/audit.ts";
import { writeStateMarker } from "./lockdown.ts";
import { lockOfficeNow } from "./office-lock-gate.ts";
import { endLeftovers, readProcesses } from "./office-leftovers.ts";
import { getStopFinalStep, setStopFinalStep } from "./server-stop.ts";

/** The longest reason the route takes, after trimming. */
export const LOCKDOWN_REASON_MAX = 500;
/** How long after the answer the process stops: time for the answer to go
 *  out. */
const STOP_DELAY_MS = 250;

export interface OfficeLockdownDeps {
  stateRoot: string;
  /** Closes every open WebSocket of the office listener. */
  closeSockets(): void;
  /** Writes the audit row. */
  audit(input: { actor: AuditActor; reason: string }): void;
  /** Stops the process after the response is sent. Production:
   *  requestStopForLock. The in-process harness injects a recorder. */
  requestStop(): void;
  now(): Date;
}

export type OfficeLockdownResult =
  | { ok: true }
  | { ok: false; status: 422; message: string }
  | { ok: false; status: 500; message: string };

/** Runs steps 1 to 3 and schedules step 4. `reason` is the raw body field. */
export function lockOfficeFromRoute(
  deps: OfficeLockdownDeps,
  input: { reason: unknown; by: string; actor: AuditActor },
): OfficeLockdownResult {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length === 0 || reason.length > LOCKDOWN_REASON_MAX)
    return {
      ok: false,
      status: 422,
      message: `The reason must be text of 1 to ${LOCKDOWN_REASON_MAX} characters.`,
    };
  try {
    writeStateMarker(deps.stateRoot, {
      reason,
      by: input.by,
      now: deps.now(),
    });
  } catch (err) {
    // Without the marker a stop would come back unlocked: change nothing.
    console.error("[lockdown] could not write the lock marker:", err);
    return {
      ok: false,
      status: 500,
      message:
        "The lock marker could not be written. The office is not locked.",
    };
  }
  lockOfficeNow();
  try {
    deps.closeSockets();
  } catch (err) {
    console.error("[lockdown] could not close every socket:", err);
  }
  try {
    deps.audit({ actor: input.actor, reason });
  } catch (err) {
    console.error("[lockdown] could not write the audit row:", err);
  }
  console.log(`[lockdown] locked by ${input.by}; stopping the office`);
  setTimeout(() => {
    try {
      deps.requestStop();
    } catch (err) {
      console.error("[lockdown] could not stop the office:", err);
    }
  }, STOP_DELAY_MS);
  return { ok: true };
}

/** The final stop step of a lock: the previous final step, then the office's
 *  leftover processes, then the lock effects (applyLockEffects), so no
 *  shutdown persist re-creates a credential file after the quarantine. A
 *  throw in the first two is logged and the effects still run. */
export function lockStopStep(deps: {
  previous: ((signalAt: number) => Promise<unknown>) | null;
  /** Ends the office's leftover processes; resolves to how many it ended. */
  endLeftovers(): Promise<number>;
  applyLockEffects(): void;
}): (signalAt: number) => Promise<void> {
  return async (signalAt) => {
    try {
      await deps.previous?.(signalAt);
    } catch (err) {
      console.error("[lockdown] the stop-reap step failed:", err);
    }
    try {
      const ended = await deps.endLeftovers();
      if (ended > 0) console.log(`[lockdown] ended ${ended} office processes`);
    } catch (err) {
      console.error("[lockdown] could not end the office processes:", err);
    }
    deps.applyLockEffects();
  };
}

/** The production stop: after the stop hooks and the stop-reap step, ends the
 *  office's leftover processes (server/office-leftovers.ts) and applies the
 *  lock effects (lockStopStep), then raises SIGTERM on this process, so the
 *  normal stop runs and the process dies by the signal. `applyEffects` is
 *  applyLockEffects over the office's state. */
export function requestStopForLock(applyEffects: () => void): void {
  setStopFinalStep(
    lockStopStep({
      previous: getStopFinalStep(),
      endLeftovers: async () =>
        (
          await endLeftovers({
            officePid: process.pid,
            uids: [process.getuid?.() ?? -1],
            selfPid: process.pid,
            processes: readProcesses,
            kill: (pid, signal) => process.kill(pid, signal),
            sleep: (ms) => Bun.sleep(ms),
          })
        ).length,
      applyLockEffects: applyEffects,
    }),
  );
  process.kill(process.pid, "SIGTERM");
}
