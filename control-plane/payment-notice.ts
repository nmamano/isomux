// The payment-suspension mail: one plain-text mail that tells the customer their
// office is powered off for a failed payment and the date its server is deleted.
// Opened by the lifecycle tick's payment arm (lifecycle.ts
// decidePaymentLifecycle); the payment deletion waits until it has succeeded.
//
// A transactional mail about the customer's own service, so it carries no
// unsubscribe line and is not gated by the welcome series' switch. It sends
// through the provisioner's Resend key (welcome-mail.ts), and the handler is
// registered only when that key is set: without it the operation fails through
// the no-handler path, attention is raised, and the deletion stays held.

import { inspect } from "node:util";
import {
  latestDunningSuspension,
  paymentDeletionAt,
  paymentOperationId,
  RETENTION_MS,
} from "./lifecycle.ts";
import { deadlinesFor } from "./operations.ts";
import { credentialValues, redactLogText } from "./report.ts";
import { reservationForInstance } from "./signup.ts";
import { getSubscription } from "./stripe/billing-store.ts";
import { openerStamp } from "./stripe/suspension.ts";
import type { Store } from "./store.ts";
import type { Handler, HandlerContext, HandlerResult } from "./tick.ts";
import {
  STOREFRONT_ORIGIN,
  WELCOME_MAIL_FROM,
  WELCOME_MAIL_REPLY_TO,
} from "./welcome-mail.ts";

export interface PaymentNoticeMail {
  to: string;
  subject: string;
  text: string;
}

export interface PaymentNoticeDeps {
  /** Sends one mail. `idempotencyKey` is the operation id, so a retried send
   * of the same operation is not delivered twice. Throws on failure. */
  send: (mail: PaymentNoticeMail, idempotencyKey: string) => Promise<void>;
  report?: (line: string) => void;
}

/** Stripe statuses that mean the customer is paid up. */
const PAID_UP = new Set(["active", "trialing"]);

const DAY_MS = 24 * 60 * 60 * 1000;

/** "15 December 2026": the UTC day only, like every instant in this schema. */
function deletionDay(instant: number): string {
  return new Date(instant).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The date the mail names, at least 14 days after it goes out.
 *
 * The opener's date while it still falls on or after the day 14 days from
 * now: a mail sent on time names exactly what the opener fixed. A mail held
 * longer (a Resend outage, a key set days after the deploy) names the start
 * of the next whole UTC day after that, so it never names a date that has
 * passed, and a retry later the same day renders the same body for Resend's
 * idempotency key. The decider reads this back as the named date.
 */
export function namedDeletionAt(openerDeletesAt: number, now: number): number {
  const earliest = now + RETENTION_MS;
  if (Math.floor(earliest / DAY_MS) <= Math.floor(openerDeletesAt / DAY_MS)) {
    return openerDeletesAt;
  }
  return Math.ceil(earliest / DAY_MS) * DAY_MS;
}

/**
 * The office's page on the dashboard, where the owner updates the card and pays
 * the open invoice. The dashboard routes on the reserved name, not on the
 * hostname. An office with no reservation gets the dashboard itself.
 */
export function officePageUrl(reservedName: string | null): string {
  return reservedName === null
    ? STOREFRONT_ORIGIN
    : `${STOREFRONT_ORIGIN}/office/${encodeURIComponent(reservedName)}`;
}

/**
 * The mail. A function of the office and the date only, so a retry of one
 * operation renders the same body: Resend refuses a reused idempotency key
 * with a different body.
 */
export function renderPaymentNotice(vars: {
  officeName: string;
  officeUrl: string;
  deletesAt: number;
}): { subject: string; text: string } {
  const date = deletionDay(vars.deletesAt);
  return {
    subject: "Your Isomux office is suspended",
    text:
      `Hello,\n\n` +
      `The payment for your Isomux office ${vars.officeName} failed, and ` +
      `Stripe has stopped retrying. We powered the server off. Your data ` +
      `stays on it, untouched.\n\n` +
      `To keep the office, update your card and pay the open invoice before ` +
      `${date}:\n${vars.officeUrl}\n\n` +
      `The office then comes back exactly as it was.\n\n` +
      `On ${date}, we ask the server provider to delete the server. After ` +
      `that, the data cannot be recovered.\n\n` +
      `Isomux\n`,
  };
}

function numberField(raw: string, key: string): number | null {
  try {
    const value = (JSON.parse(raw) as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function stringField(raw: string, key: string): string | null {
  try {
    const value = (JSON.parse(raw) as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export function paymentNoticeHandler(deps: PaymentNoticeDeps): Handler {
  return {
    kind: "payment_notice",
    // Safe to retry after a timeout: the send carries the operation id as its
    // idempotency key. Resend keeps a key for 24 hours, so only a retry more
    // than a day after the first attempt could deliver a second copy.
    timeoutIsRetryable: true,
    async run(ctx: HandlerContext): Promise<HandlerResult> {
      const stamp = openerStamp(ctx.op.evidence);
      const openerDeletesAt = numberField(ctx.op.evidence, "deletesAt");
      if (openerDeletesAt === null) {
        return {
          kind: "fatal",
          reason: "the suspension mail has no deletion date to name",
        };
      }
      // Re-read at run time: a customer who paid between the open and now gets
      // no deletion mail. A skipped mail records no `sentAt`, so the deletion
      // never counts it as a mail that went out.
      const instance = await ctx.store.getInstance(ctx.instance.id);
      const subscriptionId = stringField(ctx.op.evidence, "subscription");
      const subscription = subscriptionId
        ? await getSubscription(ctx.store, subscriptionId)
        : null;
      if (
        !instance ||
        instance.service_state !== "suspended" ||
        !subscription ||
        PAID_UP.has(subscription.status)
      ) {
        await ctx.audit(
          "payment_notice",
          "succeeded",
          "skipped: the office is no longer payment-suspended",
        );
        return {
          kind: "done",
          evidence: { ...stamp, skipped: "not_suspended" },
        };
      }
      const account = await ctx.store.sqlGet<{ email: string }>(
        "select email from accounts where id = $1",
        [subscription.account_id],
      );
      if (!account) {
        return {
          kind: "fatal",
          reason:
            "the subscription's account has no row, so no address to mail",
        };
      }
      // The link only: an office with no reservation still gets its mail,
      // because a held mail holds the deletion.
      const reservation = await reservationForInstance(ctx.store, instance.id);
      const deletesAt = namedDeletionAt(openerDeletesAt, ctx.now);
      const mail: PaymentNoticeMail = {
        to: account.email,
        ...renderPaymentNotice({
          officeName: instance.name,
          officeUrl: officePageUrl(reservation?.name ?? null),
          deletesAt,
        }),
      };
      ctx.budget.claim("payment_notice");
      await ctx.audit("payment_notice", "started", "suspension mail");
      try {
        await deps.send(mail, ctx.op.id);
      } catch (err) {
        await ctx.audit("payment_notice", "failed", messageOf(err));
        throw err;
      }
      await ctx.audit("payment_notice", "succeeded", "suspension mail sent");
      deps.report?.(`payment notice sent for ${instance.id}`);
      return {
        kind: "done",
        // `sentAt` is the instant the deletion counts its last 14 days from.
        // `deletesAt` is the date the mail named, which a late mail moved.
        evidence: { ...stamp, deletesAt, sent: true, sentAt: ctx.now },
      };
    },
  };
}

const RESEND_URL = "https://api.resend.com/emails";

/**
 * The production sender: one POST to Resend with the operation id as its
 * Idempotency-Key. Throws on any failure, with the key redacted, so the ticker
 * classifies and retries it.
 */
export function resendPaymentNoticeSender(
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): PaymentNoticeDeps["send"] {
  const redact = (text: string) =>
    redactLogText(text, [apiKey, ...credentialValues(process.env)]);
  return async (mail, idempotencyKey) => {
    let response: Response;
    try {
      response = await fetchImpl(RESEND_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          from: WELCOME_MAIL_FROM,
          to: [mail.to],
          reply_to: WELCOME_MAIL_REPLY_TO,
          subject: mail.subject,
          text: mail.text,
        }),
      });
    } catch (err) {
      // No `cause`: the message is redacted, and a cause would carry the
      // unredacted error into every log that prints it.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        redact(`the mail request failed: ${inspect(err, { depth: 2 })}`),
      );
    }
    // The status only: an error body can echo the recipient's address.
    if (!response.ok) throw new Error(`Resend answered ${response.status}`);
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type RequeueOutcome =
  "requeued" | "no_suspension" | "no_notice" | "not_failed";

/**
 * The operator's lever for a held payment deletion: put the office's FAILED
 * suspension mail back in the queue (`attention --resend-payment-notice`).
 *
 * A failed mail is never reopened on its own: its id is derived from the
 * episode, and a mail that failed for a missing key or a missing account would
 * fail again on every pass. Once the cause is fixed, this makes the same row
 * pending again. A late mail names a date at least 14 days away
 * (namedDeletionAt), and the deletion waits for it.
 */
export async function requeuePaymentNotice(
  store: Store,
  instanceId: string,
  by: string,
): Promise<RequeueOutcome> {
  return store.tx(async () => {
    const suspension = latestDunningSuspension(
      await store.operationsFor(instanceId),
    );
    if (!suspension) return "no_suspension";
    const id = paymentOperationId("payment_notice", suspension.episode);
    const row = await store.getOperation(id);
    if (!row) return "no_notice";
    if (row.status !== "failed") return "not_failed";
    const now = store.now();
    const stamp = openerStamp(row.evidence);
    if (
      typeof stamp.deletesAt !== "number" &&
      suspension.poweredOffAt !== null
    ) {
      stamp.deletesAt = paymentDeletionAt(suspension.poweredOffAt);
    }
    const d = deadlinesFor("payment_notice");
    const updated = await store.sqlGet<{ id: string }>(
      "update operations set status = 'pending', attempt = 0, next_attempt_at = $1, " +
        "lease_until = null, lease_holder = null, inactivity_deadline_at = $2, " +
        "absolute_deadline_at = $3, inactivity_flagged = 0, absolute_flagged = 0, " +
        "evidence = $4, evidence_at = $1, updated_at = $1, version = version + 1 " +
        "where id = $5 and status = 'failed' returning id",
      [
        now,
        now + d.inactivityMs,
        now + d.absoluteMs,
        JSON.stringify(stamp),
        id,
      ],
    );
    if (!updated) return "not_failed";
    await store.appendAudit({
      actor: by,
      instance_id: instanceId,
      action: "payment_notice_requeued",
      target: id,
      outcome: "started",
      detail: "a failed suspension mail was put back in the queue",
    });
    return "requeued";
  });
}
