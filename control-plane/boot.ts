// What a deployed provisioner proves about itself before it starts working.
//
// Two properties, and they are checked in opposite directions from the same
// seam the store already uses:
//
//   BOUNDS. `Store.open` builds the `options` string that carries
//   statement_timeout and idle_in_transaction_session_timeout and reads both
//   back from the engine, refusing to return a store if either is wrong. So a
//   store handle IS the evidence, and this module does not re-derive it.
//
//   BRANCH. The engine says which branch is answering
//   (`current_setting('neon.branch_id')`). A connection string can name any
//   host, so that setting is the only thing that knows. The deployment pins the
//   id it expects, and a mismatch REFUSES rather than warns: the failure this
//   guards against is a customer's control plane writing into a scratch branch
//   that gets deleted, which is the mirror image of what testing/target.ts
//   refuses for the suites.
//
// The pin is optional in code and mandatory in the deploy procedure. Unset
// means "no claim was made": a local run and CI are unchanged, and
// `branchPinned` is FALSE rather than true, because a check nobody configured
// has not passed - it was not run. The health surface carries that boolean
// straight through, so a deployment missing its pin is visibly not ok.
//
// NEITHER ID IS EVER PRINTED, here or by any caller. The output of this module
// is a boolean.

import type { Store } from "./store.ts";

/** The expected branch id, from the environment. No default, no fallback. */
export const BRANCH_PIN_ENV = "CONTROL_PLANE_DB_BRANCH";

/**
 * What the session says about which branch answered, or null.
 *
 * Goes through the store's own scrubbed seam, so a driver failure arrives
 * already stripped of connection detail and there is no second handle to the
 * database. The third argument to `current_setting` makes an unknown setting
 * null instead of an error, which is what a non-Neon engine gives.
 */
export async function liveBranchId(store: Store): Promise<string | null> {
  const row = await store.sqlGet<{ v: string | null }>(
    "select current_setting('neon.branch_id', true) as v",
  );
  const value = row?.v ?? null;
  return value && value.length > 0 ? value : null;
}

/**
 * Prove the store is talking to the pinned branch.
 *
 * Returns whether a pin was configured AND proved. Throws when a pin was
 * configured and the answer is anything other than that branch - including the
 * case where the engine reports no branch at all, because "the setting is
 * missing" is not evidence that the target is right.
 */
export async function provePinnedBranch(
  store: Store,
  pin: string | undefined,
): Promise<boolean> {
  if (!pin) return false;
  const live = await liveBranchId(store);
  if (live === null) {
    throw new Error(
      "refusing to start: this deployment pins the database branch it expects, " +
        "and the session does not report a branch id, so nothing about which " +
        "branch is answering can be established",
    );
  }
  if (live !== pin) {
    throw new Error(
      "refusing to start: the branch answering is not the one this deployment " +
        "pins",
    );
  }
  return true;
}
