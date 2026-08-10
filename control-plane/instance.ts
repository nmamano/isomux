// Turning a slice-1 run record into an instance row, and the one rule that
// makes the access-window ceiling mean something.
//
// It lives here rather than in cli.ts because the interesting part is a crash
// boundary, and a crash boundary that only exists inside a CLI entry point
// cannot be tested.

import type { Goal } from "./operations.ts";
import type { RunRecord } from "./run-record.ts";
import type { Store } from "./store.ts";

export class CeilingIsImmutable extends Error {}

async function createAssetFor(
  store: Store,
  rec: RunRecord,
  instanceId: string,
  now: number,
): Promise<void> {
  await store.createAsset({
    id: `asset-${rec.runId}`,
    instance_id: instanceId,
    provider: "contabo",
    provider_id: rec.instanceId,
    intent_id: null,
    asset_state: "active",
    ipv4: rec.ipv4,
    service_ends_at: null,
    host_key_fingerprint: null,
    next_reconcile_at: now,
  });
}

export interface EnsureInstanceArgs {
  store: Store;
  rec: RunRecord;
  goal: Goal;
  expiresAt?: Date;
  /** Provider id and address come from the run record; the asset row is created
   * with the instance on first use. */
  createAsset?: boolean;
  now?: () => number;
}

/**
 * The instance row for a run, created on first use.
 *
 * THE CEILING IS WRITTEN ONCE, WITH THE ROW, AND NEVER AGAIN. That is the whole
 * rule, and it is stated as an absence: there is no statement in this file, or
 * anywhere else, that updates `access_window_expires_at` after creation.
 *
 * The version that checked "has first contact opened yet?" and then wrote was a
 * check-then-act, and no amount of care in the check fixes it: another process
 * can open first_contact and start rewriting the box's key in the gap, because
 * opening an operation does not touch the instance row the CAS is guarding. A
 * value that is never written after creation cannot lose that race - the row's
 * own creation is the only writer, and the primary key arbitrates that.
 *
 * The cost is that a re-run asking for a DIFFERENT window is refused rather than
 * silently honoured or silently ignored. `run` continues an instance without
 * naming a window at all, which is the path out.
 */
export async function ensureInstance(
  args: EnsureInstanceArgs,
): Promise<string> {
  const { store, rec, goal, expiresAt } = args;
  const now = args.now ?? (() => Date.now());
  const id = `inst-${rec.runId}`;
  let existing = await store.getInstance(id);
  if (!existing) {
    try {
      // ONE transaction. A death between the instance row and its provider
      // asset would leave an instance with no provider axis at all, and the
      // restart would take the "already exists" branch and never look again -
      // the four-axis model quietly down to three.
      await store.tx(async () => {
        await store.createInstance({
          id,
          run_id: rec.runId,
          name: rec.host,
          plan: "V153",
          region: "EU",
          service_state: "provisioning",
          goal,
          access_window_expires_at: expiresAt ? expiresAt.getTime() : null,
        });
        if (args.createAsset !== false) {
          await createAssetFor(store, rec, id, now());
        }
      });
      return id;
    } catch (err) {
      // The primary key is the arbiter of creation, exactly as it is for the
      // create intent. A loser re-reads and falls through to the immutability
      // check below, where it discovers the winner's ceiling.
      existing = await store.getInstance(id);
      if (!existing) throw err;
    }
  }

  // Repair rather than assume: a row created by an older build, or by a crash
  // between the two inserts before they shared a transaction, can be missing its
  // provider axis. Restart is where that gets noticed.
  if (args.createAsset !== false && !(await store.assetForInstance(id))) {
    await store.tx(() => createAssetFor(store, rec, id, now()));
  }

  if (
    expiresAt &&
    existing.access_window_expires_at !== null &&
    existing.access_window_expires_at !== expiresAt.getTime()
  ) {
    throw new CeilingIsImmutable(
      `this run already has an access-window ceiling of ` +
        `${new Date(existing.access_window_expires_at).toISOString()}` +
        `${rec.expiry ? ` (the box carries ${rec.expiry})` : ""}, and it cannot ` +
        `be changed from here: once first contact runs, the key option and the ` +
        `cleanup timer carry that instant and we cannot reach them afterwards. ` +
        `Continue this run with \`run\` (which needs no window), or recycle the ` +
        `box to start a new one.`,
    );
  }
  // Only the goal. The ceiling is deliberately absent from this patch.
  const patch = { goal };
  if (!(await store.casInstance(id, existing.version, patch))) {
    // A loser RE-READS and decides from current state. The goal is ours to set
    // and carries no claim about the box, so re-reading and re-applying it is
    // safe in a way that re-applying a provider response is not.
    const fresh = await store.getInstance(id);
    if (!fresh) throw new Error(`instance ${id} vanished`);
    if (!(await store.casInstance(id, fresh.version, patch))) {
      throw new Error(
        `instance ${id} is being changed by another process; try again`,
      );
    }
  }
  return id;
}
