// The three things a customer may ask us to do, and nothing else.
//
// This is the whole verb surface the web app has over the control plane. It
// exists so that the app can ask for work without being able to NAME work: no
// page holds an operation kind, an enqueue, a fence or a store, and adding a
// fourth thing a customer can do is an edit to this file rather than a side
// effect of writing a route. The web-boundary test asserts both halves of that.
//
// Two rules every function here follows, both learned in slice 2:
//
//   EVERY PRECONDITION IS RE-READ INSIDE THE TRANSACTION THAT WRITES. A check
//   in front of a transaction is a check two callers can both pass.
//
//   THE UNIQUE INDEX IS THE ARBITER, not the precondition. The one-active-per
//   (instance, kind) index is what actually stops a second mint or a second
//   reboot, and a constraint failure here is translated into the same refusal
//   the pre-check would have given - so deleting the pre-check changes the
//   message's provenance, never the outcome.

import { accessForInstance, windowIsOpen, type AccessView } from "./access.ts";
import {
  deadlinesFor,
  newOperationId,
  type OperationKind,
} from "./operations.ts";
import { instanceOwnedBy } from "./signup.ts";
import { ACTIVE_STATUSES, type Store } from "./store.ts";

/** The kinds a customer may open. Listed, so this file cannot become a general
 * enqueue by someone passing a different string. */
const CUSTOMER_KINDS: OperationKind[] = [
  "mint_invite",
  "revoke_access",
  "reboot",
];

export type RefusalCode =
  | "not_yours"
  | "no_box"
  | "window_not_started"
  | "window_gone"
  | "window_unknown"
  | "not_live"
  | "mint_in_progress"
  | "revocation_in_progress"
  | "already_revoked"
  | "restart_in_progress";

/**
 * What the customer reads. Functional copy; the provisioning actor is "Hosted
 * Isomux Provisioning" wherever an actor is named.
 *
 * `window_gone` says what it says because it is the end of the road: minting
 * needs a key on the box, and after the window closes there is not one. Telling
 * someone to try again later would be false comfort.
 */
export const REFUSAL_WORDS: Record<RefusalCode, string> = {
  not_yours: "we could not find that office.",
  no_box: "your server has not been ordered yet.",
  window_not_started:
    "Hosted Isomux Provisioning does not have a key to your server yet, so it cannot create an invite.",
  window_gone:
    "Hosted Isomux Provisioning no longer has a key to your server, so it cannot create a new invite. Contact support if you cannot get in.",
  window_unknown:
    "Hosted Isomux Provisioning cannot confirm whether it still has a key to your server, so it will not create an invite. This office is already with a person.",
  not_live: "your office is not serving yet.",
  mint_in_progress:
    "an invite is already being prepared. Try again in a moment.",
  revocation_in_progress: "we are already removing our access.",
  already_revoked: "Hosted Isomux Provisioning has already removed its access.",
  restart_in_progress: "a restart is already running.",
};

export type RequestOutcome =
  | { ok: true; operationId: string; alreadyOpen: boolean }
  | { ok: false; code: RefusalCode; reason: string };

function refuse(code: RefusalCode): RequestOutcome {
  return { ok: false, code, reason: REFUSAL_WORDS[code] };
}

/** Map a closed window onto the sentence that says WHY it is closed. Four
 * states, four answers: a single "cannot mint" would cover a box that does not
 * exist yet and a handoff that is complete with the same words. */
function windowRefusal(access: AccessView): RefusalCode {
  switch (access.state) {
    case "not_started":
      return "window_not_started";
    case "gone":
      return "window_gone";
    default:
      return "window_unknown";
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT"))
    return true;
  const message = err instanceof Error ? err.message : "";
  return /UNIQUE constraint failed|PRIMARY KEY must be unique/i.test(message);
}

/**
 * Open one customer-requested operation.
 *
 * `via: "dashboard"` is the stamp everything downstream keys on: the mint
 * handler delivers to the in-memory hold instead of the operator's reporter,
 * and the projection describes a revocation as the customer's confirmation only
 * when it carries this. It is a status word, not material.
 *
 * Must run inside the caller's transaction.
 */
async function openCustomerOperation(
  store: Store,
  instanceId: string,
  kind: OperationKind,
  now: number,
): Promise<string> {
  if (!CUSTOMER_KINDS.includes(kind)) {
    throw new Error(`a customer may not open a ${kind} operation`);
  }
  const d = deadlinesFor(kind);
  const id = newOperationId(kind, await store.nextSeq("audit"));
  await store.enqueue({
    id,
    instance_id: instanceId,
    kind,
    inactivity_deadline_at: now + d.inactivityMs,
    absolute_deadline_at: now + d.absoluteMs,
    evidence: { via: "dashboard" },
  });
  return id;
}

async function audit(
  store: Store,
  accountId: string,
  instanceId: string,
  action: string,
  outcome: string,
  detail: string,
): Promise<void> {
  await store.appendAudit({
    actor: `account:${accountId}`,
    instance_id: instanceId,
    action,
    target: instanceId,
    outcome,
    detail,
  });
}

export interface CustomerRequest {
  accountId: string;
  instanceId: string;
}

/**
 * Ask for an owner invite.
 *
 * The URL is not produced here and never passes through this file: this opens
 * the operation, the leased tick mints, and the browser collects the result
 * from the provisioner's memory. What this decides is whether a mint may happen
 * at all.
 */
export async function requestInvite(
  store: Store,
  req: CustomerRequest,
): Promise<RequestOutcome> {
  return store.tx(async () => {
    if (!(await instanceOwnedBy(store, req.accountId, req.instanceId))) {
      return refuse("not_yours");
    }
    const access = await accessForInstance(store, req.instanceId);
    if (!access) return refuse("not_yours");
    if (!windowIsOpen(access)) {
      const code = windowRefusal(access);
      await audit(
        store,
        req.accountId,
        req.instanceId,
        "request_invite",
        "failed",
        code,
      );
      return refuse(code);
    }
    const active = await store.activeOperation(req.instanceId, "mint_invite");
    if (active) return refuse("mint_in_progress");
    let id: string;
    try {
      id = await openCustomerOperation(
        store,
        req.instanceId,
        "mint_invite",
        store.now(),
      );
    } catch (err) {
      // The INDEX refused it, which is the same fact the pre-check reports and
      // the one that actually holds under two simultaneous clicks.
      if (isUniqueViolation(err)) return refuse("mint_in_progress");
      throw err;
    }
    await audit(
      store,
      req.accountId,
      req.instanceId,
      "request_invite",
      "started",
      id,
    );
    return { ok: true, operationId: id, alreadyOpen: false };
  });
}

/**
 * "Revoke isomux's access" - the customer confirming they are in.
 *
 * This is the confirmation the design's ruling 7 is about: an observable act,
 * rather than a clock. The 30-day ceiling stays underneath it as the fail-safe
 * for customers who never click.
 *
 * Refusing while the office is not yet live mirrors the operator path, which
 * will not revoke access to a box it never proved was serving: a customer who
 * cannot reach their office yet is not a customer who is safely in.
 */
export async function confirmHandoff(
  store: Store,
  req: CustomerRequest,
): Promise<RequestOutcome> {
  return store.tx(async () => {
    if (!(await instanceOwnedBy(store, req.accountId, req.instanceId))) {
      return refuse("not_yours");
    }
    const access = await accessForInstance(store, req.instanceId);
    if (!access) return refuse("not_yours");
    if (access.state === "gone") return refuse("already_revoked");
    if (access.state === "not_started") return refuse("no_box");

    const operations = await store.operationsFor(req.instanceId);
    const live = operations.some(
      (op) => op.kind === "verify_https" && op.status === "succeeded",
    );
    if (!live) return refuse("not_live");

    const active = operations.find(
      (op) =>
        op.kind === "revoke_access" && ACTIVE_STATUSES.includes(op.status),
    );
    if (active) {
      // Clicking twice is not an error. The attempt is still recorded, because
      // an anxious customer pressing it again is real history.
      await audit(
        store,
        req.accountId,
        req.instanceId,
        "confirm_handoff",
        "succeeded",
        `already open: ${active.id}`,
      );
      return { ok: true, operationId: active.id, alreadyOpen: true };
    }
    let id: string;
    try {
      id = await openCustomerOperation(
        store,
        req.instanceId,
        "revoke_access",
        store.now(),
      );
    } catch (err) {
      if (isUniqueViolation(err)) return refuse("revocation_in_progress");
      throw err;
    }
    await audit(
      store,
      req.accountId,
      req.instanceId,
      "confirm_handoff",
      "started",
      id,
    );
    return { ok: true, operationId: id, alreadyOpen: false };
  });
}

/**
 * Restart the server.
 *
 * Available before AND after handoff, deliberately: once our key is gone this
 * is the only lever the customer has left, and it is the whole reason the
 * design keeps a provider-level reboot in the MVP.
 */
export async function requestRestart(
  store: Store,
  req: CustomerRequest,
): Promise<RequestOutcome> {
  return store.tx(async () => {
    if (!(await instanceOwnedBy(store, req.accountId, req.instanceId))) {
      return refuse("not_yours");
    }
    const asset = await store.assetForInstance(req.instanceId);
    if (!asset || !asset.provider_id) return refuse("no_box");
    const active = await store.activeOperation(req.instanceId, "reboot");
    if (active) return refuse("restart_in_progress");
    let id: string;
    try {
      id = await openCustomerOperation(
        store,
        req.instanceId,
        "reboot",
        store.now(),
      );
    } catch (err) {
      if (isUniqueViolation(err)) return refuse("restart_in_progress");
      throw err;
    }
    await audit(
      store,
      req.accountId,
      req.instanceId,
      "request_restart",
      "started",
      id,
    );
    return { ok: true, operationId: id, alreadyOpen: false };
  });
}
