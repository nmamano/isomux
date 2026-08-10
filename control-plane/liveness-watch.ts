// Is the customer's office answering? Asked once a minute, by one prober.
//
// Two things this deliberately does NOT do.
//
// It does not open an operation row per probe. An operation is a unit of work
// with deadlines, retries and a lease; a liveness reading is a measurement, and
// modelling one as the other would fill the customer's dashboard with hundreds
// of rows describing nothing happening.
//
// It never reboots. The design is explicit: three strikes is when a box gets a
// HUMAN, because the failure may be ours - our DNS, our certificate, our
// provisioning - and restarting somebody's server on a probe we got wrong is a
// worse outcome than an alert nobody needed.

import { raiseAttentionIn, clearAttentionIn } from "./attention.ts";
import {
  LIVENESS_CLAIM_MS,
  LIVENESS_INTERVAL_MS,
  LIVENESS_STRIKES,
  probeLiveness,
  type LivenessDeps,
  type Rung,
  strikesAfter,
} from "./liveness.ts";
import type { Store } from "./store.ts";

/** The reason text carried by a liveness attention row. Matched on to find our
 * own row again, so it is a constant rather than an interpolated sentence. */
export const LIVENESS_REASON = "the office failed its liveness checks";

/**
 * A liveness reason belongs to no operation, and the schema already has a place
 * for that: source_op_id is NOT NULL with an empty-string sentinel, precisely so
 * a non-operation reason can take part in the open-reason unique index like any
 * other. Using a fake operation id here would be a lie in a durable row.
 */
const NO_OPERATION = "";

export interface WatchDeps extends LivenessDeps {
  holder: string;
  report?: (line: string) => void;
}

/**
 * One pass. Probes every live office whose reading is due and that nobody else
 * has claimed.
 *
 * Only `live` offices are probed: an office still being provisioned has
 * verify_https walking the same ladder with its own deadlines, and probing it
 * twice would raise attention for a box that is progressing normally.
 */
export async function watchLiveness(
  store: Store,
  deps: WatchDeps,
): Promise<number> {
  let probed = 0;
  for (const instance of store.listInstances()) {
    if (instance.service_state !== "live") continue;
    const now = store.now();
    store.ensureLiveness(instance.id, now);
    const claimed = store.claimLiveness(
      instance.id,
      deps.holder,
      now + LIVENESS_CLAIM_MS,
      now,
    );
    // Not due, or somebody else is probing it. Either way this pass does not
    // touch it: the claim is the arbiter, so a loser never counts a strike.
    if (!claimed) continue;

    const asset = store.assetForInstance(instance.id);
    let rung: Rung;
    try {
      const result = await probeLiveness(
        instance.name,
        deps,
        asset?.ipv4 ?? undefined,
      );
      rung = result.rung;
    } catch (err) {
      // A probe that throws is a probe that did not answer. It counts as a
      // failure rather than being dropped, because "we could not check" and
      // "it did not respond" are the same thing to the person waiting.
      deps.report?.(
        `liveness probe for ${instance.name} threw: ${messageOf(err)}`,
      );
      rung = "tcp";
    }
    probed++;

    const strikes = strikesAfter(claimed.strikes, rung);
    const checkedAt = store.now();
    const written = store.recordLiveness(
      instance.id,
      claimed.version,
      deps.holder,
      {
        rung,
        strikes,
        checkedAt,
        nextAt: checkedAt + LIVENESS_INTERVAL_MS,
      },
    );
    if (!written) {
      // We lost the claim while probing. The winner's reading is newer than
      // ours; ours is discarded rather than replayed on top of theirs.
      deps.report?.(
        `liveness for ${instance.name} was written by another prober; ` +
          `discarding this reading rather than replaying it`,
      );
      continue;
    }

    // The reading is durable before attention moves, so a crash here leaves a
    // recorded strike rather than an alert with nothing behind it.
    applyAttention(store, instance.id, strikes, rung, deps);
  }
  return probed;
}

/**
 * Raise at the third consecutive failure; clear only on a later `ok`.
 *
 * Clearing on anything less than a successful probe would let an office that is
 * failing differently each time - dns, then tls, then tcp - look like it keeps
 * recovering.
 */
function applyAttention(
  store: Store,
  instanceId: string,
  strikes: number,
  rung: Rung,
  deps: WatchDeps,
): void {
  const open = store
    .openReasons(instanceId)
    .filter(
      (r) => r.source_op_id === NO_OPERATION && r.reason === LIVENESS_REASON,
    );
  try {
    if (rung === "ok") {
      if (open.length === 0) return;
      store.tx(() => {
        for (const row of open) clearAttentionIn(store, instanceId, row.id);
      });
      deps.report?.(`liveness recovered for ${instanceId}`);
      return;
    }
    if (strikes < LIVENESS_STRIKES || open.length > 0) return;
    store.tx(() =>
      raiseAttentionIn(store, {
        instanceId,
        sourceOpId: NO_OPERATION,
        reasonClass: "operation_condition",
        reason: LIVENESS_REASON,
        severity: "critical",
      }),
    );
    deps.report?.(
      `liveness: ${instanceId} has failed ${strikes} consecutive checks ` +
        `(last rung ${rung}); raised for a person`,
    );
  } catch (err) {
    // The reading is already durable. Failing to move attention is worth
    // saying out loud and is not worth losing the measurement over.
    deps.report?.(`could not update liveness attention: ${messageOf(err)}`);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
