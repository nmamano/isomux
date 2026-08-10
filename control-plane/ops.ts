// The ops floor: what an operator may see, and the one thing they may write.
//
// This is to operators what requests.ts is to customers - a LISTED verb surface,
// so the operator side of the product cannot grow as a side effect of writing a
// page. Three functions, and a boundary test pins the export list.
//
// Two rules shape every one of them:
//
//   THE AUTHORITY CHECK AND THE WORK ARE ONE TRANSACTION. Not merely "inside
//   the service": a role read that commits separately from the work it guards
//   is a role that can be revoked in between, and the protected read or write
//   still goes through. So every verb opens ONE transaction, re-reads
//   `is_operator` inside it, and does the whole protected operation there -
//   which is also why acknowledgement needs the `In` primitive rather than the
//   one that opens its own transaction. The web app cannot even spell the
//   column.
//
//   REFUSAL IS INDISTINGUISHABLE FROM ABSENCE. A non-operator gets the same
//   `null` a missing instance gets, and the caller answers 404 to both. A 403
//   would confirm that the ops floor exists and that this account is not on it,
//   which is a fact worth nothing to the asker and something to an attacker.
//
// The deliberate difference from progress.ts: this carries the operator-facing
// reason STRING. The customer projection strips it to a class because attention
// reasons interpolate remote text; an operator is the audience that text was
// written for, and a floor that showed only "a step needs a person" would be a
// pager with the message removed.

import { acknowledgeAttentionIn } from "./attention-ack.ts";
import { isOperator } from "./operator.ts";
import type {
  AttentionReasonRow,
  AuditRow,
  InstanceRow,
  OperationRow,
  Severity,
  Store,
} from "./store.ts";

export interface OpsAttentionItem {
  instanceId: string;
  officeName: string;
  reasonId: string;
  reasonClass: string;
  /** The operator-facing string. See the header: this is the audience it was
   * written for. */
  reason: string;
  severity: Severity;
  raisedAt: number;
  /** Milliseconds it has been open. Derived at read time from the same clock the
   * rest of the store uses, so a floor sorted by age cannot disagree with it. */
  ageMs: number;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
}

export interface OpsOperationItem {
  instanceId: string;
  officeName: string;
  operationId: string;
  kind: string;
  status: string;
  attempt: number;
  /** Which ceiling it crossed. Both are shown because they mean different
   * things: an inactivity flag can be cleared by the next piece of evidence, a
   * crossed absolute ceiling stays crossed. */
  inactivityFlagged: boolean;
  absoluteFlagged: boolean;
  absoluteDeadlineAt: number;
  overdueMs: number;
}

export interface OpsFloor {
  now: number;
  attention: OpsAttentionItem[];
  /** Live operations past their ABSOLUTE ceiling. The design's alerting floor
   * names this one specifically. */
  overdue: OpsOperationItem[];
}

export interface OpsInstanceView {
  instanceId: string;
  officeName: string;
  serviceState: string;
  subscriptionState: string;
  attentionState: string;
  attention: OpsAttentionItem[];
  operations: OpsOperationItem[];
  audit: AuditRow[];
}

/** The floor. Null when the caller is not an operator - see the header on why
 * that is not a distinguishable refusal. */
export function opsFloor(store: Store, accountId: string): OpsFloor | null {
  return store.tx(() => floorIn(store, accountId));
}

function floorIn(store: Store, accountId: string): OpsFloor | null {
  if (!isOperator(store, accountId)) return null;
  const now = store.now();
  const attention: OpsAttentionItem[] = [];
  const overdue: OpsOperationItem[] = [];
  for (const instance of store.listInstances()) {
    for (const reason of store.openReasons(instance.id)) {
      attention.push(attentionItem(instance, reason, now));
    }
  }
  // overdueOperations, not liveOperations: a FAILED operation past its ceiling
  // is the one an operator most needs, and it is precisely the row that has
  // left the live set. Succeeded work stays out - a step that finished late is
  // history, not an alert.
  for (const op of store.overdueOperations()) {
    const instance = store.getInstance(op.instance_id);
    if (!instance) continue;
    overdue.push(operationItem(instance, op, now));
  }
  // Worst first, then oldest: an operator reading top-down should meet the thing
  // that matters most before the thing that has simply been there longest.
  attention.sort(
    (a, b) => rank(b.severity) - rank(a.severity) || a.raisedAt - b.raisedAt,
  );
  overdue.sort((a, b) => b.overdueMs - a.overdueMs);
  return { now, attention, overdue };
}

/** One office in full: its attention, its operations and its audit trail. */
export function opsInstance(
  store: Store,
  accountId: string,
  instanceId: string,
): OpsInstanceView | null {
  return store.tx(() => instanceIn(store, accountId, instanceId));
}

function instanceIn(
  store: Store,
  accountId: string,
  instanceId: string,
): OpsInstanceView | null {
  if (!isOperator(store, accountId)) return null;
  const instance = store.getInstance(instanceId);
  if (!instance) return null;
  const now = store.now();
  return {
    instanceId: instance.id,
    officeName: instance.name,
    serviceState: instance.service_state,
    subscriptionState: instance.subscription_state,
    attentionState: instance.attention_state,
    // ALL reasons, not only open ones: a floor that hides resolved incidents
    // cannot answer "has this happened before", which is the question that
    // distinguishes a blip from a pattern.
    attention: store
      .allReasons(instance.id)
      .map((r) => attentionItem(instance, r, now)),
    operations: store
      .operationsFor(instance.id)
      .map((op) => operationItem(instance, op, now)),
    audit: store.auditEvents().filter((e) => e.instance_id === instance.id),
  };
}

/**
 * Record that a human has seen this office's open reasons.
 *
 * Returns null for a non-operator - same shape as the reads, so a refused write
 * cannot be told from a missing office either. The number is how many reasons
 * were marked, which is what lets a caller tell a real acknowledgement from an
 * acknowledgement of nothing.
 */
export function acknowledgeInstance(
  store: Store,
  accountId: string,
  instanceId: string,
): number | null {
  return store.tx(() => {
    if (!isOperator(store, accountId)) return null;
    if (!store.getInstance(instanceId)) return null;
    // The ACCOUNT ID goes in the audit row, not an email: the id is the durable
    // identity and the address is display data that can change under it.
    return acknowledgeAttentionIn(store, instanceId, `account:${accountId}`);
  });
}

function attentionItem(
  instance: InstanceRow,
  r: AttentionReasonRow,
  now: number,
): OpsAttentionItem {
  return {
    instanceId: instance.id,
    officeName: instance.name,
    reasonId: r.id,
    reasonClass: r.reason_class,
    reason: r.reason,
    severity: r.severity,
    raisedAt: r.raised_at,
    ageMs: Math.max(0, now - r.raised_at),
    acknowledgedAt: r.acknowledged_at,
    acknowledgedBy: r.acknowledged_by,
  };
}

function operationItem(
  instance: InstanceRow,
  op: OperationRow,
  now: number,
): OpsOperationItem {
  return {
    instanceId: instance.id,
    officeName: instance.name,
    operationId: op.id,
    kind: op.kind,
    status: op.status,
    attempt: op.attempt,
    inactivityFlagged: op.inactivity_flagged === 1,
    absoluteFlagged: op.absolute_flagged === 1,
    absoluteDeadlineAt: op.absolute_deadline_at,
    overdueMs: Math.max(0, now - op.absolute_deadline_at),
  };
}

function rank(severity: Severity): number {
  return severity === "critical" ? 3 : severity === "warning" ? 2 : 1;
}
