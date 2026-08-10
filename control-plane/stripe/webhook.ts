// The inbound seam: one raw HTTP body in, one classified outcome out.
//
// The order of the checks is the design, not an implementation detail:
//
//   1. SIGNATURE, over the raw bytes. Nothing else is looked at first, because
//      an unverified body is attacker-controlled.
//   2. JSON parse.
//   3. TEST MODE. `livemode` must be present and false BEFORE any dedupe lookup,
//      any object fetch, any transaction, any audit row - before any effect at
//      all. A live-mode event means something is pointed at the real company
//      account, and the only safe response is to touch nothing.
//   4. FETCH the object the event is about, with no transaction open.
//   5. APPLY, in one transaction that re-checks the event id first.
//
// A fetch we cannot complete produces a 500 and commits NOTHING, so Stripe
// redelivers the same event id and the dedupe path decides. A refusal (bad
// signature, live mode, malformed object) produces a 4xx, because redelivering it
// would produce the same refusal.

import type { Store } from "../store.ts";
import {
  LiveModeObjectRefused,
  MalformedStripeObject,
  type ReadResult,
  type StripeObjectReader,
} from "./reader.ts";
import {
  applyEvent,
  recordIgnoredEvent,
  type ReconcileOutcome,
} from "./reconcile.ts";
import type {
  InvoiceSnapshot,
  SessionSnapshot,
  SubscriptionSnapshot,
} from "./shapes.ts";
import { verifySignature } from "./signature.ts";

/** A live-mode event reached test-mode-only code. Nothing is read or written. */
export class LiveModeEventRefused extends Error {}

/** The events the design names as the writers of subscription state. */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
] as const;

export type WebhookOutcomeKind =
  | "applied"
  | "duplicate"
  | "ignored"
  | "refused"
  | "retry";

export interface WebhookOutcome {
  status: number;
  kind: WebhookOutcomeKind;
  detail: string;
  subscriptionId?: string | null;
  suspensionOpId?: string | null;
}

export interface WebhookDeps {
  store: Store;
  reader: StripeObjectReader;
  /** The `stripe listen` (or dashboard endpoint) signing secret. Runtime-only
   * state: it arrives in the environment and is never written down. */
  secret: string;
  now?: () => number;
  report?: (line: string) => void;
}

export class WebhookProcessor {
  private readonly deps: WebhookDeps;
  private readonly now: () => number;
  private readonly report: (line: string) => void;
  /**
   * One serial chain per subscription.
   *
   * The fetch happens outside the transaction, so two deliveries about the same
   * subscription could otherwise interleave as fetch-fetch-apply-apply and let
   * the older fetch write last. Serialising per subscription removes that window
   * inside this process; the durable event transaction is what covers crashes and
   * redelivery. A second provisioner would need a database-level lock instead -
   * recorded in the README, not solved here, because nothing deploys this slice.
   */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(deps: WebhookDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.report = deps.report ?? (() => {});
  }

  /**
   * Handle one delivery.
   *
   * `rawBody` must be the exact bytes received: the signature covers them, and a
   * re-serialised object is different bytes.
   */
  async handle(
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<WebhookOutcome> {
    const verdict = verifySignature({
      payload: rawBody,
      header: signatureHeader,
      secret: this.deps.secret,
      now: this.now(),
    });
    if (!verdict.ok) {
      // The detail names the RULE that failed and never the material.
      this.report(`webhook rejected: signature ${verdict.failure}`);
      return {
        status: 400,
        kind: "refused",
        detail: `signature ${verdict.failure}`,
      };
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return { status: 400, kind: "refused", detail: "body is not JSON" };
    }

    // THE MODE GATE. Before dedupe, before any fetch, before any write.
    try {
      assertTestModeEvent(event);
    } catch (err) {
      if (!(err instanceof LiveModeEventRefused)) throw err;
      this.report(`webhook refused: ${err.message}`);
      return {
        status: 400,
        kind: "refused",
        // The message deliberately says nothing about the body, the header or any
        // identifier: a live-mode delivery is exactly the case where we do not
        // want real account details in our logs.
        detail: err.message,
      };
    }

    const id = typeof event.id === "string" ? event.id : null;
    const type = typeof event.type === "string" ? event.type : null;
    const createdSec = typeof event.created === "number" ? event.created : null;
    const object = objectOf(event);
    if (!id || !type || createdSec === null || !object) {
      return {
        status: 400,
        kind: "refused",
        detail: "the event is missing id, type, created or data.object",
      };
    }
    const created = createdSec * 1000;

    if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(type)) {
      return this.recordIgnored(id, type, created, `unhandled type ${type}`);
    }

    // The queue key comes from the untrusted payload on purpose: it only decides
    // what serialises with what, never what gets written, so a wrong key costs
    // ordering inside this process and nothing else.
    const key = queueKeyFor(type, object) ?? id;
    return this.serialise(key, () =>
      this.fetchAndApply(id, type, created, object),
    );
  }

  private serialise<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    // `then(fn, fn)` so a failed predecessor still lets the next delivery run: one
    // bad event must not wedge a subscription forever.
    const next = previous.then(fn, fn);
    const settled = next.then(
      () => {},
      () => {},
    );
    this.chains.set(key, settled);
    // Drop the entry once the chain is idle, so the map does not grow by one per
    // subscription we ever hear about.
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }

  private async fetchAndApply(
    id: string,
    type: string,
    created: number,
    object: Record<string, unknown>,
  ): Promise<WebhookOutcome> {
    let session: SessionSnapshot | null = null;
    let invoice: InvoiceSnapshot | null = null;
    let subscriptionId: string | null = null;

    try {
      if (type === "checkout.session.completed") {
        const sessionId = stringField(object, "id");
        if (!sessionId) {
          return this.recordIgnored(id, type, created, "session has no id");
        }
        const read = await this.deps.reader.getCheckoutSession(sessionId);
        if (read.kind === "unavailable") return retry(read.reason);
        if (read.kind === "absent") {
          return this.recordIgnored(
            id,
            type,
            created,
            "session no longer exists",
          );
        }
        session = read.object;
        subscriptionId = session.subscriptionId;
        if (!subscriptionId) {
          // A one-off payment session, or a subscription that was not created.
          // Nothing to cache, and Stripe should not retry.
          return this.recordIgnored(
            id,
            type,
            created,
            "completed session names no subscription",
          );
        }
      } else if (type === "invoice.payment_failed") {
        const invoiceId = stringField(object, "id");
        if (!invoiceId) {
          return this.recordIgnored(id, type, created, "invoice has no id");
        }
        const read = await this.deps.reader.getInvoice(invoiceId);
        if (read.kind === "unavailable") return retry(read.reason);
        if (read.kind === "absent") {
          return this.recordIgnored(
            id,
            type,
            created,
            "invoice no longer exists",
          );
        }
        invoice = read.object;
        subscriptionId = invoice.subscriptionId;
        if (!subscriptionId) {
          return this.recordIgnored(
            id,
            type,
            created,
            "failed invoice belongs to no subscription",
          );
        }
      } else {
        subscriptionId = stringField(object, "id");
        if (!subscriptionId) {
          return this.recordIgnored(
            id,
            type,
            created,
            "subscription has no id",
          );
        }
      }

      const subRead = await this.deps.reader.getSubscription(subscriptionId);
      if (subRead.kind === "unavailable") return retry(subRead.reason);
      const subscription = this.subscriptionOrDeleted(subRead, subscriptionId);
      if (!subscription) {
        return this.recordIgnored(
          id,
          type,
          created,
          "subscription no longer exists and nothing is cached for it",
        );
      }

      const outcome = this.deps.store.tx(() =>
        applyEvent(
          this.deps.store,
          {
            eventId: id,
            eventType: type,
            eventCreated: created,
            subscription,
            invoice,
            session,
            now: this.now(),
          },
          this.report,
        ),
      );
      return fromReconcile(outcome);
    } catch (err) {
      // A refusal is never retried: the same fetch produces the same object.
      if (err instanceof LiveModeObjectRefused) {
        this.report(`webhook refused: ${err.message}`);
        return {
          status: 400,
          kind: "refused",
          detail: "a fetched Stripe object is live mode",
        };
      }
      if (err instanceof MalformedStripeObject) {
        this.report(`webhook refused: ${err.message}`);
        return { status: 400, kind: "refused", detail: err.message };
      }
      // Anything else - including a rolled-back transaction - leaves the event
      // unclaimed, so Stripe's redelivery is what makes progress.
      this.report(`webhook could not be applied: ${messageOf(err)}`);
      return retry(messageOf(err));
    }
  }

  /**
   * A subscription that Stripe no longer returns.
   *
   * Cancelled subscriptions stay retrievable, so this is the rare case. When we
   * already cache the row, the absence itself is the current deleted fact and is
   * reconciled as `canceled` from the cached identity; with nothing cached there
   * is nothing to say.
   */
  private subscriptionOrDeleted(
    read: ReadResult<SubscriptionSnapshot>,
    subscriptionId: string,
  ): SubscriptionSnapshot | null {
    if (read.kind === "ok") return read.object;
    const cached = this.deps.store.db
      .query<
        {
          stripe_customer_id: string;
          ended_at: number | null;
          canceled_at: number | null;
          cancellation_reason: string | null;
        },
        [string]
      >(
        "select stripe_customer_id, ended_at, canceled_at, cancellation_reason " +
          "from subscriptions where id = ?",
      )
      .get(subscriptionId);
    if (!cached) return null;
    return {
      id: subscriptionId,
      customerId: cached.stripe_customer_id,
      status: "canceled",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      // CARRIED FORWARD, not nulled. This snapshot is an INFERENCE FROM ABSENCE,
      // not a fetched object, and the Stripe-owned patch it feeds overwrites
      // whatever it names - so nulling these three here would erase the
      // cancellation timeline's anchor and its customer-vs-dunning
      // discriminator for an office that is mid-retention. Absence says the
      // subscription is gone; it says nothing about when it ended or why.
      endedAt: cached.ended_at,
      canceledAt: cached.canceled_at,
      cancellationReason: cached.cancellation_reason,
      discount: null,
      latestInvoiceId: null,
      metadata: {},
      livemode: false,
    };
  }

  private recordIgnored(
    id: string,
    type: string,
    created: number,
    note: string,
  ): WebhookOutcome {
    const outcome = this.deps.store.tx(() =>
      recordIgnoredEvent(this.deps.store, {
        eventId: id,
        eventType: type,
        eventCreated: created,
        note,
      }),
    );
    return outcome === "duplicate"
      ? { status: 200, kind: "duplicate", detail: note }
      : { status: 200, kind: "ignored", detail: note };
  }
}

// ----------------------------------------------------------------- helpers

/**
 * The mode gate.
 *
 * A missing or non-boolean `livemode` is refused just as hard as `true`: treating
 * absence as "probably test mode" is precisely how live data would get through.
 * Exported so a test can hold the rule on its own, without a signature or a store.
 */
export function assertTestModeEvent(event: Record<string, unknown>): void {
  if (event.livemode === false) return;
  throw new LiveModeEventRefused(
    event.livemode === true
      ? "the event is LIVE MODE; test-mode-only code will not read or write anything about it"
      : "the event has no boolean livemode field; refusing to guess which mode it belongs to",
  );
}

function fromReconcile(outcome: ReconcileOutcome): WebhookOutcome {
  if (outcome.kind === "duplicate") {
    return {
      status: 200,
      kind: "duplicate",
      detail: "already applied",
      subscriptionId: outcome.subscriptionId,
    };
  }
  return {
    status: 200,
    kind: "applied",
    detail: outcome.note,
    subscriptionId: outcome.subscriptionId,
    suspensionOpId: outcome.suspensionOpId,
  };
}

function retry(reason: string): WebhookOutcome {
  return {
    // 5xx, so Stripe redelivers. Nothing has been written, so the redelivery is
    // the first attempt as far as our ledger is concerned.
    status: 500,
    kind: "retry",
    detail: reason,
  };
}

function objectOf(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  const data = event.data as { object?: unknown } | undefined;
  const object = data?.object;
  if (!object || typeof object !== "object" || Array.isArray(object))
    return null;
  return object as Record<string, unknown>;
}

function stringField(o: Record<string, unknown>, field: string): string | null {
  const v = o[field];
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * What this delivery serialises against.
 *
 * The payload is not trusted as truth anywhere else, and it is not trusted here
 * either - a wrong key only weakens ordering within this process.
 */
function queueKeyFor(
  type: string,
  object: Record<string, unknown>,
): string | null {
  if (type === "checkout.session.completed") {
    return idOf(object.subscription) ?? stringField(object, "id");
  }
  if (type === "invoice.payment_failed") {
    const parent = object.parent as
      | { subscription_details?: { subscription?: unknown } }
      | undefined;
    return (
      idOf(parent?.subscription_details?.subscription) ??
      idOf(object.subscription) ??
      stringField(object, "id")
    );
  }
  return stringField(object, "id");
}

function idOf(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  if (v && typeof v === "object") {
    const id = (v as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
