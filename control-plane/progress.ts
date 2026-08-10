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

import { accessFor, windowIsOpen, type AccessView } from "./access.ts";
import {
  isCustomerCancellation,
  phaseAt,
  poweredOffAtFrom,
  type LifecyclePhase,
} from "./lifecycle.ts";
import { LIVENESS_STRIKES } from "./liveness.ts";
import {
  type Goal,
  type OperationKind,
  DECLARED_UNIMPLEMENTED_KINDS,
  nextKind,
} from "./operations.ts";
import {
  ACTIVE_STATUSES,
  type AttentionReasonRow,
  type InstanceRow,
  type LivenessRow,
  type OperationRow,
  type ReasonClass,
  type ServiceState,
  type Severity,
  type Store,
} from "./store.ts";
import { reservationForInstance, type ReservationRow } from "./signup.ts";

export type { AccessView };

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
  /** Set once service has actually ended. Null while it still runs, including
   * while a cancellation is merely SCHEDULED - which is why the page can say
   * "scheduled to end" without claiming it has. */
  endedAt: number | null;
  /** True only for the customer's own cancellation. A dunning cancellation ends
   * the same subscription and means something completely different. */
  customerCancelled: boolean;
}

/**
 * The end-of-life timeline, as dates the customer can plan around.
 *
 * Only ever built from PROVEN instants. Before service ends there is no
 * timeline at all, because a scheduled cancellation is reversible and a page
 * that counted its grace week down from a projection would be counting down
 * something the customer can still cancel.
 *
 * `retentionEnd` is when we REQUEST permanent deletion (manager ruling
 * R-2026-08-10-3), not when the provider performs it. The copy says exactly
 * that, and a provider term that would end sooner raises attention instead of
 * shortening the promise.
 */
export interface LifecycleView {
  phase: LifecyclePhase;
  graceEnd: number | null;
  retentionEnd: number | null;
}

/**
 * The handoff, as the customer's own actions rather than as machine states.
 *
 * `invite` tracks the operation THEY opened, so a mint that is still running,
 * that failed, or that is ambiguous is visible as itself rather than as an
 * absent link. `operationId` is what the browser fetches the minted URL with;
 * it is an opaque row id and carries no material.
 *
 * `handoffConfirmed` is deliberately not a column. Confirmation IS the
 * revocation request: a customer who clicked has a revoke_access row, and one
 * that arrived any other way is not described as their confirmation.
 */
export interface HandoffView {
  /** Whether a mint may be opened at all right now, and if not, why - the
   * same computation that gates the seam, never a second one. */
  canMint: boolean;
  invite: {
    state: StepState | "none";
    operationId: string | null;
    /** Set only once a mint has SUCCEEDED, so the page can say a link was
     * produced without saying anything about the link. */
    mintedAt: number | null;
  };
  revocation: {
    state: StepState | "none";
    /** True only for a revocation the customer asked for. A row opened by an
     * operator or by the chain is still shown, but never described as their
     * confirmation. */
    customerConfirmed: boolean;
    confirmedAt: number | null;
  };
}

/** Where the office is on the probe ladder, and how many consecutive checks
 * have failed. Three strikes is the design's threshold for calling it
 * unreachable, and reboot is never automatic. */
export interface LivenessView {
  rung: string;
  words: string;
  strikes: number;
  checkedAt: number | null;
  unreachable: boolean;
}

/**
 * The customer's restart, as a state rather than as a button that may or may
 * not work.
 *
 * Called RESTART and not reboot throughout the customer-facing surface. That is
 * not only copy: the web-boundary test forbids any file under web/ from
 * containing an operation kind, so the app literally cannot name `reboot`, and
 * a page therefore cannot ask for one by spelling it.
 */
export interface RestartView {
  state: StepState | "none";
  active: boolean;
  lastRequestedAt: number | null;
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
  handoff: HandoffView;
  liveness: LivenessView | null;
  restart: RestartView;
  subscription: SubscriptionView | null;
  /** Null until the customer's cancellation has actually taken effect. */
  lifecycle: LifecycleView | null;
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
  reboot: "Restarting your server",
  power_on: "Bringing your office back",
  cancel_asset: "Cancelling your server with the provider",
  remove_dns: "Removing your office's address",
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

interface SubscriptionFacts {
  status: string;
  current_period_end: number | null;
  cancel_at_period_end: number;
  ended_at: number | null;
  cancellation_reason: string | null;
  discount_percent_off: number | null;
  discount_ends_at: number | null;
}

function subscriptionRowFor(
  store: Store,
  instanceId: string,
): SubscriptionFacts | null {
  return (
    store.db
      .query<
        SubscriptionFacts,
        [string]
      >("select status, current_period_end, cancel_at_period_end, ended_at, " + "cancellation_reason, discount_percent_off, discount_ends_at " + "from subscriptions where instance_id = ? order by created_at desc")
      .get(instanceId) ?? null
  );
}

function subscriptionViewOf(
  row: SubscriptionFacts,
  now: number,
): SubscriptionView {
  const discountLive =
    row.discount_ends_at === null || row.discount_ends_at > now;
  return {
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    comped: row.discount_percent_off === 100 && discountLive,
    endedAt: row.ended_at,
    customerCancelled: isCustomerCancellation({
      endedAt: row.ended_at,
      cancellationReason: row.cancellation_reason,
    }),
  };
}

/** The timeline, from the SAME functions the machine decides with. A second
 * implementation here would eventually show the customer a date the tick does
 * not act on. */
function lifecycleViewOf(
  store: Store,
  instanceId: string,
  row: SubscriptionFacts | null,
  operations: OperationRow[],
  now: number,
): LifecycleView | null {
  if (
    !row ||
    !isCustomerCancellation({
      endedAt: row.ended_at,
      cancellationReason: row.cancellation_reason,
    })
  ) {
    return null;
  }
  const subscriptionId = store.db
    .query<
      { id: string },
      [string]
    >("select id from subscriptions where instance_id = ? order by created_at desc")
    .get(instanceId);
  const asset = store.assetForInstance(instanceId);
  const timeline = phaseAt(
    {
      endedAt: row.ended_at,
      cancellationReason: row.cancellation_reason,
      poweredOffAt: subscriptionId
        ? poweredOffAtFrom(operations, subscriptionId.id, row.ended_at!)
        : null,
      assetGone:
        !!asset &&
        (asset.asset_state === "cancelled" || asset.asset_state === "absent"),
    },
    now,
  );
  return {
    phase: timeline.phase,
    graceEnd: timeline.graceEnd,
    retentionEnd: timeline.retentionEnd,
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

/**
 * The handoff panel's rows.
 *
 * `latest` per kind is already computed by the caller, and it is the right row
 * to describe: a retried mint opens a new row, and the newest one is where the
 * customer's link is coming from.
 */
function handoffFor(
  access: AccessView,
  byKind: Map<string, OperationRow>,
  operations: OperationRow[],
): HandoffView {
  const mint = byKind.get("mint_invite");
  const revoke = byKind.get("revoke_access");
  // Their confirmation is a revocation THEY asked for. requests.ts stamps the
  // asking account into the evidence; a chain- or operator-opened row has no
  // stamp, so it renders as a revocation without being called their choice.
  const customerConfirmed = operations.some(
    (op) => op.kind === "revoke_access" && requestedByCustomer(op),
  );
  const confirmed = operations.find(
    (op) => op.kind === "revoke_access" && requestedByCustomer(op),
  );
  return {
    canMint: windowIsOpen(access),
    invite: {
      state: mint ? stateOf(mint) : "none",
      operationId: mint?.id ?? null,
      mintedAt: mint?.status === "succeeded" ? mint.evidence_at : null,
    },
    revocation: {
      state: revoke ? stateOf(revoke) : "none",
      customerConfirmed,
      confirmedAt: confirmed?.created_at ?? null,
    },
  };
}

/** Did the customer open this row? A stamp we wrote, read back as a boolean -
 * never as a string that could reach a page. */
function requestedByCustomer(op: OperationRow): boolean {
  try {
    const parsed: unknown = JSON.parse(op.evidence);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return false;
    return (parsed as Record<string, unknown>).via === "dashboard";
  } catch {
    return false;
  }
}

function livenessFor(row: LivenessRow | null): LivenessView | null {
  if (!row) return null;
  return {
    rung: row.rung,
    // Our words for the rung, from the same table the installer view uses. An
    // unknown rung would otherwise print a bare machine token at a customer.
    words: RUNG_WORDS[row.rung] ?? "we could not classify the last check",
    strikes: row.strikes,
    checkedAt: row.checked_at,
    unreachable: row.strikes >= LIVENESS_STRIKES,
  };
}

function restartFor(byKind: Map<string, OperationRow>): RestartView {
  const op = byKind.get("reboot");
  const state = op ? stateOf(op) : "none";
  return {
    state,
    // "Active" is what the unique index would refuse a second row against, so
    // the button's availability and the machine's rule cannot disagree.
    active: !!op && ACTIVE_STATUSES.includes(op.status),
    lastRequestedAt: op?.created_at ?? null,
  };
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
  const access = accessFor(store, instance, operations, store.now());
  const subscriptionRow = subscriptionRowFor(store, instance.id);

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
    access,
    handoff: handoffFor(access, byKind, operations),
    liveness: livenessFor(store.getLiveness(instance.id)),
    restart: restartFor(byKind),
    subscription: subscriptionRow
      ? subscriptionViewOf(subscriptionRow, store.now())
      : null,
    lifecycle: lifecycleViewOf(
      store,
      instance.id,
      subscriptionRow,
      operations,
      store.now(),
    ),
  };
}

/** Kinds the design names but nothing drives. Exported so a test can assert no
 * ladder contains one. */
export const NEVER_IN_LADDER: readonly string[] = DECLARED_UNIMPLEMENTED_KINDS;
