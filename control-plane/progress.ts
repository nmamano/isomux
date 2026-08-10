// What the customer is shown while their office is being built.
//
// A projection, and deliberately a narrow one. Three rules shape it:
//
//   IT MAY NOT INVENT PROGRESS. A step with no operation row is `waiting`,
//   never `done`. The ladder is derived by walking `nextKind` from the
//   instance's OWN goal rather than hand-copied, so it cannot drift from the
//   chain the machine will actually run - and so a goal of `live` does not
//   promise a revocation step nothing will ever enqueue.
//
//   RAW EVIDENCE NEVER CROSSES. Operation evidence is JSON we wrote, but some
//   of its fields carry remote output (an ssh failure, an apt reason, systemd's
//   answer), and a future handler can add more without anyone remembering this
//   file. So the extractor is an ALLOWLIST of typed fields, mapped to our own
//   words; anything unlisted is invisible until somebody adds it here on
//   purpose. Attention reasons get the same treatment for the same reason -
//   they are operator-facing strings and some interpolate remote text - so the
//   customer view carries the reason CLASS and severity, never the string.
//
//   IT IS READ-ONLY. Nothing here writes, enqueues or acts. The web app holds
//   no other verb.

import {
  type Goal,
  type OperationKind,
  DECLARED_UNIMPLEMENTED_KINDS,
  nextKind,
} from "./operations.ts";
import type {
  AttentionReasonRow,
  InstanceRow,
  OperationRow,
  ReasonClass,
  ServiceState,
  Severity,
  Store,
} from "./store.ts";
import { reservationForInstance, type ReservationRow } from "./signup.ts";

export type StepState = "waiting" | "active" | "checking" | "done" | "failed";

export interface ProgressStep {
  kind: OperationKind;
  label: string;
  state: StepState;
  /** Our words, derived from allowlisted evidence fields. Never raw evidence. */
  detail: string | null;
}

export interface AttentionView {
  reasonClass: ReasonClass;
  severity: Severity;
  raisedAt: number;
  acknowledged: boolean;
  /** Our sentence for the class, not the operator-facing reason string. */
  summary: string;
}

export interface SubscriptionView {
  status: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** An ACTIVE full discount, per the design: comped is not a flag we keep.
   * "Active" is load-bearing - a cached 100% discount that has already ended is
   * not a reason to tell somebody they are not being charged. */
  comped: boolean;
}

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

export interface ProgressView {
  instanceId: string;
  officeName: string;
  hostname: string;
  plan: string;
  serviceState: ServiceState;
  goal: Goal;
  /**
   * Where this instance's box came from. `adopted` means an existing server was
   * linked to it rather than ordered - the create step is then omitted from the
   * ladder rather than left waiting forever beside real progress, and this field
   * is what lets the page say so instead of a step silently vanishing.
   */
  origin: "created" | "adopted";
  steps: ProgressStep[];
  /** Operations that are real but not part of this goal's chain - a revocation
   * driven by an operator, a billing suspension. Shown rather than hidden: they
   * happened. */
  otherOperations: ProgressStep[];
  ready: boolean;
  attention: AttentionView[];
  access: AccessView;
  subscription: SubscriptionView | null;
}

/** Human labels. Functional copy only; the provisioning actor is "Hosted Isomux
 * Provisioning" wherever an actor is named. */
const LABELS: Record<OperationKind, string> = {
  create_instance: "Ordering your server",
  wait_for_ssh: "Waiting for the server to answer",
  first_contact: "Securing our temporary access",
  arm_revocation: "Arming the access expiry",
  wait_for_package_manager: "Waiting for the server's package manager",
  run_installer: "Installing isomux",
  verify_https: "Checking your office over HTTPS",
  mint_invite: "Preparing your owner invite",
  revoke_access: "Removing our access",
  power_off: "Suspending the office",
};

/**
 * The chain, walked rather than written down.
 *
 * Starting at `create_instance` and following `nextKind` under the instance's
 * stored goal is what keeps this list honest: if the chain changes, this
 * changes with it, and a kind the chain never reaches cannot appear.
 */
export function ladderFor(goal: Goal): OperationKind[] {
  const ladder: OperationKind[] = ["create_instance"];
  let cursor: OperationKind | null = "create_instance";
  while (cursor) {
    const next: OperationKind | null = nextKind(cursor, goal);
    if (!next) break;
    if (ladder.includes(next)) {
      throw new Error(`the operation chain loops at ${next}`);
    }
    ladder.push(next);
    cursor = next;
  }
  return ladder;
}

function stateOf(op: OperationRow | undefined): StepState {
  if (!op) return "waiting";
  switch (op.status) {
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "ambiguous":
      return "checking";
    default:
      return "active";
  }
}

/** A marker is install.sh's own step name. Shown verbatim only if it looks like
 * one: bounded, lower case, no whitespace. Anything else is dropped rather than
 * trimmed, because a value we cannot vouch for is not made safe by being
 * shorter. */
const MARKER = /^[a-z0-9][a-z0-9-]{0,39}$/;

function stringField(
  evidence: Record<string, unknown>,
  key: string,
  allowed: readonly string[] | RegExp,
): string | null {
  const raw = evidence[key];
  if (typeof raw !== "string") return null;
  if (allowed instanceof RegExp) return allowed.test(raw) ? raw : null;
  return allowed.includes(raw) ? raw : null;
}

function countField(
  evidence: Record<string, unknown>,
  key: string,
): number | null {
  const raw = evidence[key];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.floor(raw);
}

const INSTALLER_PHASES = [
  "staged",
  "launching",
  "running",
  "finished",
] as const;
const RUNGS = ["dns", "wrong-box", "tcp", "tls", "readyz", "ok"] as const;
const RUNG_WORDS: Record<string, string> = {
  dns: "waiting for the name to resolve",
  "wrong-box": "the name points somewhere else",
  tcp: "waiting for the office to accept connections",
  tls: "waiting for the certificate",
  readyz: "waiting for the office to report ready",
  ok: "the office is serving",
};

/**
 * The allowlist. Every field named here is typed and bounded; every field NOT
 * named here - `last`, `busy`, `detail`, `timer`, `expiry`, `boxClockUtc`,
 * `runId` and anything a later handler adds - never reaches a browser.
 */
function detailFor(
  kind: OperationKind,
  op: OperationRow | undefined,
): string | null {
  if (!op) return null;
  let evidence: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(op.evidence);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    evidence = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (kind) {
    case "wait_for_ssh": {
      const probes = countField(evidence, "probes");
      return probes && probes > 0 ? `${probes} attempts so far` : null;
    }
    case "run_installer": {
      const marker = stringField(evidence, "step", MARKER);
      if (marker) return `step: ${marker}`;
      const phase = stringField(evidence, "phase", INSTALLER_PHASES);
      return phase ? `installer ${phase}` : null;
    }
    case "verify_https": {
      const rung = stringField(evidence, "rung", RUNGS);
      return rung ? RUNG_WORDS[rung] : null;
    }
    default:
      return null;
  }
}

const ATTENTION_WORDS: Record<ReasonClass, string> = {
  inactivity_deadline:
    "a step is taking longer than expected and has been raised with us",
  absolute_deadline:
    "a step has passed its time limit and has been raised with us",
  operation_condition: "a step needs a person and has been raised with us",
};

function attentionViews(reasons: AttentionReasonRow[]): AttentionView[] {
  return reasons.map((r) => ({
    reasonClass: r.reason_class,
    severity: r.severity,
    raisedAt: r.raised_at,
    // Acknowledging is NOT clearing (slice 2): a seen condition still renders.
    acknowledged: r.acknowledged_at !== null,
    summary: ATTENTION_WORDS[r.reason_class],
  }));
}

function subscriptionFor(
  store: Store,
  instanceId: string,
  now: number,
): SubscriptionView | null {
  const row = store.db
    .query<
      {
        status: string;
        current_period_end: number | null;
        cancel_at_period_end: number;
        discount_percent_off: number | null;
        discount_ends_at: number | null;
      },
      [string]
    >(
      "select status, current_period_end, cancel_at_period_end, " +
        "discount_percent_off, discount_ends_at from subscriptions " +
        "where instance_id = ? order by created_at desc",
    )
    .get(instanceId);
  if (!row) return null;
  const discountLive =
    row.discount_ends_at === null || row.discount_ends_at > now;
  return {
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    comped: row.discount_percent_off === 100 && discountLive,
  };
}

/**
 * Did this instance's box get ORDERED, or was an existing one linked to it?
 *
 * Decided from rows, never from a flag: no create_instance row, a provider
 * asset that is actually linked, and at least one operation that did run. A
 * fresh signup fails the second and third tests and is `created` with its
 * create step waiting, which is exactly true - nothing has been ordered yet.
 */
function originOf(
  store: Store,
  instanceId: string,
  operations: OperationRow[],
): "created" | "adopted" {
  if (operations.some((op) => op.kind === "create_instance")) return "created";
  const asset = store.assetForInstance(instanceId);
  // LINKED MEANS IT HAS A PROVIDER ID, and nothing more. Requiring
  // asset_state 'active' looked equivalent and is not: asset state tracks the
  // PROVIDER'S lifecycle, so the first reconcile against a box with a cancel
  // date moved it to 'cancel_scheduled' and the create step reappeared as
  // waiting beside a running install. A live run is what showed it.
  const linked = !!asset && asset.provider_id !== null;
  if (!linked) return "created";
  return operations.length > 0 ? "adopted" : "created";
}

/** The one place a claim about our key is decided. Order matters: proof of
 * removal outranks everything, and an absent box outranks a ceiling. */
function accessFor(
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

function stepFor(
  kind: OperationKind,
  byKind: Map<string, OperationRow>,
): ProgressStep {
  const op = byKind.get(kind);
  return {
    kind,
    label: LABELS[kind],
    state: stateOf(op),
    detail: detailFor(kind, op),
  };
}

export interface ProgressArgs {
  accountId: string;
  instanceId: string;
}

/**
 * The signed-in account's view of one instance, or null.
 *
 * Null covers "no such instance" AND "not yours", and the caller answers 404 to
 * both: which of the two it was is not the asker's business.
 */
export function projectionFor(
  store: Store,
  args: ProgressArgs,
): ProgressView | null {
  const reservation: ReservationRow | null = reservationForInstance(
    store,
    args.instanceId,
  );
  if (!reservation || reservation.account_id !== args.accountId) return null;
  const instance: InstanceRow | null = store.getInstance(args.instanceId);
  if (!instance) return null;

  const operations = store.operationsFor(instance.id);
  // Latest row per kind: a retried step opens a new row, and the newest is the
  // one that describes where the machine is now.
  const byKind = new Map<string, OperationRow>();
  for (const op of operations) {
    const seen = byKind.get(op.kind);
    if (!seen || op.created_at >= seen.created_at) byKind.set(op.kind, op);
  }

  const goal = instance.goal as Goal;
  const origin = originOf(store, instance.id, operations);
  const ladder = ladderFor(goal).filter(
    (kind) => !(origin === "adopted" && kind === "create_instance"),
  );
  const inLadder = new Set<string>(ladder);
  const others = [...byKind.keys()]
    .filter((kind) => !inLadder.has(kind))
    .sort();

  const verifyHttps = byKind.get("verify_https");

  return {
    instanceId: instance.id,
    officeName: reservation.name,
    hostname: instance.name,
    plan: reservation.plan,
    serviceState: instance.service_state,
    goal,
    origin,
    steps: ladder.map((kind) => stepFor(kind, byKind)),
    otherOperations: others.map((kind) =>
      stepFor(kind as OperationKind, byKind),
    ),
    // The one terminal claim, and it rests on a SUCCEEDED probe rather than on
    // how far down the ladder we are.
    ready: verifyHttps?.status === "succeeded",
    attention: attentionViews(store.openReasons(instance.id)),
    access: accessFor(store, instance, operations, store.now()),
    subscription: subscriptionFor(store, instance.id, store.now()),
  };
}

/** Kinds the design names but nothing drives. Exported so a test can assert no
 * ladder contains one. */
export const NEVER_IN_LADDER: readonly string[] = DECLARED_UNIMPLEMENTED_KINDS;
