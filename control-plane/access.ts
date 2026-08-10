// Whether we still hold a key to a customer's box - decided ONCE, here.
//
// This moved out of the progress projection in slice 4b because it stopped
// being a display concern. The same question now gates three answers that must
// never disagree: what the dashboard tells the customer, whether a mint may be
// opened at all, and whether a minted link may still be handed over. Two
// implementations of "is the window open" would eventually say different things
// to the same customer in the same second, and the one that gates a credential
// is the one that would be wrong.
//
// It is derived from rows and never stored. There is no window column: the
// ceiling is written once with the instance row, and everything else is
// evidence about what happened on the box.

import type { OperationKind } from "./operations.ts";
import type { InstanceRow, OperationRow, Store } from "./store.ts";

/**
 * What we can HONESTLY say about our provisioning key.
 *
 * Four states, because two were not enough to avoid claiming things we have no
 * evidence for:
 *
 *   not_started - a PRISTINE signup: a placeholder asset, no provider id, and
 *     no create attempt of any kind. A fresh reservation said "holds a
 *     temporary key to your server" before anything had been ordered.
 *     The narrowness is the point. A null provider id does NOT prove there is
 *     no box - the whole ambiguous-create quarantine exists because a provider
 *     may have built a machine carrying our key while we still cannot name it.
 *     After ANY create attempt, an unknown provider id means unknown access,
 *     not absent access.
 *   held - a box is linked and the ceiling has not passed. The ceiling is a
 *     LATEST-POSSIBLE instant, not a promise about when the key goes: the
 *     normal path is a confirmed revocation well before it.
 *   gone - either a revocation SUCCEEDED (proof: the operation completes only
 *     after a reconnect with the removed key is refused), or first_contact
 *     succeeded and the ceiling has passed. First contact is what writes the
 *     expiry option and READS IT BACK from disk, so after it the box itself
 *     enforces the instant, whether or not our cleanup timer ever ran.
 *   needs_attention - a linked box crossed its ceiling with no succeeded
 *     first_contact. The guarantee was never proven onto that box, so neither
 *     "held" nor "gone" is a claim we have earned.
 *
 * `ceilingProven` says whether the instant is enforced by the box rather than
 * merely written in our database, which is what decides whether the page may
 * name a date at all.
 */
export interface AccessView {
  state: "not_started" | "held" | "gone" | "needs_attention";
  expiresAt: number | null;
  ceilingProven: boolean;
}

/**
 * THE window predicate.
 *
 * Only `held` is open. `gone` is closed because there is nothing left to mint
 * with; `needs_attention` is closed because we cannot prove there is; and
 * `not_started` is closed because there is no box yet. A refusal that cannot
 * name which of the three it was would be the same sentence for three
 * completely different situations, so callers get the state, not a boolean.
 */
export function windowIsOpen(access: AccessView): boolean {
  return access.state === "held";
}

/** The one place a claim about our key is decided. Order matters: proof of
 * removal outranks everything, and an absent box outranks a ceiling. */
export function accessFor(
  store: Store,
  instance: InstanceRow,
  operations: OperationRow[],
  now: number,
): AccessView {
  const ceiling = instance.access_window_expires_at;
  const succeeded = (kind: OperationKind): boolean =>
    operations.some((op) => op.kind === kind && op.status === "succeeded");
  const contactProven = succeeded("first_contact");
  const base = {
    expiresAt: ceiling,
    ceilingProven: contactProven && ceiling !== null,
  };

  if (succeeded("revoke_access")) return { ...base, state: "gone" };

  const asset = store.assetForInstance(instance.id);
  if (!asset || asset.provider_id === null) {
    // "No box" is a CLAIM, and only a pristine signup has earned it: the
    // placeholder asset untouched, and no create ever attempted. A create row
    // in any state - or an asset the coordinator has moved to order_pending or
    // order_ambiguous - means a machine may exist carrying our key that we
    // cannot yet name, which is unknown rather than absent. A missing asset
    // row is unknown too: it is a repair case, not evidence.
    const attempted = operations.some((op) => op.kind === "create_instance");
    const pristine = !!asset && asset.asset_state === "none" && !attempted;
    return { ...base, state: pristine ? "not_started" : "needs_attention" };
  }

  const crossed = ceiling !== null && ceiling <= now;
  if (!crossed) return { ...base, state: "held" };
  // Crossed. sshd enforces the instant on the BOX, and first contact is what
  // proved the option is on it - so with that proof the key is gone even if
  // cleanup never ran, and without it we know only that we cannot say.
  return { ...base, state: contactProven ? "gone" : "needs_attention" };
}

/**
 * The same answer, for callers that hold an instance id rather than rows.
 *
 * Used by the request seam and by the invite fetch, so a gate on a credential
 * and the sentence the customer reads come from one computation.
 */
export function accessForInstance(
  store: Store,
  instanceId: string,
): AccessView | null {
  const instance = store.getInstance(instanceId);
  if (!instance) return null;
  return accessFor(
    store,
    instance,
    store.operationsFor(instanceId),
    store.now(),
  );
}
