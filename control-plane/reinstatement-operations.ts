import { clearAttentionIn, raiseAttentionIn } from "./attention.ts";
import {
  attemptById,
  checkoutExpiryOperationId,
  REFUND_REQUIRED,
  type ReinstatementAttemptRow,
} from "./reinstatement.ts";
import type { StripeClient } from "./stripe/client.ts";
import type { StripeObjectReader } from "./stripe/reader.ts";
import type { Handler, HandlerContext, HandlerResult } from "./tick.ts";

export async function raiseRefundRequired(
  store: HandlerContext["store"],
  attempt: ReinstatementAttemptRow,
  detail: string,
): Promise<void> {
  await raiseAttentionIn(store, {
    instanceId: attempt.instance_id,
    sourceOpId: `${REFUND_REQUIRED}:${attempt.id}`,
    reasonClass: "operation_condition",
    reason:
      "a reinstatement Checkout completed but the retained office cannot be linked; in Stripe, paid means refund or reconcile, unpaid means monitor and reconcile if it clears, and no_payment_required means confirm and close because nothing was owed",
    severity: "critical",
    actor: "reinstatement",
    detail,
  });
}

export async function clearRefundRequired(
  store: HandlerContext["store"],
  attempt: ReinstatementAttemptRow,
): Promise<void> {
  const key = `${REFUND_REQUIRED}:${attempt.id}`;
  for (const open of await store.openReasons(attempt.instance_id)) {
    if (open.source_op_id !== key) continue;
    await clearAttentionIn(
      store,
      attempt.instance_id,
      open.id,
      "stripe-webhook",
    );
  }
}

export function checkoutExpiryHandler(deps: {
  client: StripeClient;
  reader: StripeObjectReader;
}): Handler {
  return {
    kind: "expire_checkout",
    timeoutIsRetryable: false,
    async run(ctx: HandlerContext): Promise<HandlerResult> {
      const stamp = JSON.parse(ctx.op.evidence) as { attempt?: string };
      const attempt = stamp.attempt
        ? await attemptById(ctx.store, stamp.attempt)
        : null;
      if (!attempt)
        return { kind: "fatal", reason: "checkout expiry has no attempt" };
      if (!attempt.checkout_session_id) {
        await ctx.store.sqlRun(
          "update reinstatement_attempts set state='expired', updated_at=$1, version=version+1 where id=$2",
          [ctx.now, attempt.id],
        );
        await ctx.audit(
          "expire_checkout",
          "succeeded",
          "no Checkout session was created, so no payment can be in flight",
        );
        return {
          kind: "done",
          evidence: {
            ...stamp,
            stripeStatus: "not_created",
            resolvedAt: ctx.now,
          },
        };
      }
      ctx.budget.claim("expire_checkout");
      await ctx.audit(
        "expire_checkout",
        "started",
        `session ${attempt.checkout_session_id}`,
      );
      const result = await deps.client.post(
        `/v1/checkout/sessions/${encodeURIComponent(attempt.checkout_session_id)}/expire`,
        {},
        checkoutExpiryOperationId(attempt.id),
      );
      let status = result.kind === "ok" ? stringValue(result.body.status) : "";
      let paymentStatus =
        result.kind === "ok" ? stringValue(result.body.payment_status) : "";
      if (result.kind !== "ok") {
        await ctx.audit(
          "expire_checkout",
          result.kind === "ambiguous" ? "ambiguous" : "failed",
          result.kind === "ambiguous"
            ? result.reason
            : `HTTP ${result.status}; ${result.reason}`,
        );
        await ctx.audit(
          "fetch_checkout_after_expiry",
          "started",
          `session ${attempt.checkout_session_id}`,
        );
        const fetched = await deps.reader.getCheckoutSession(
          attempt.checkout_session_id,
        );
        if (fetched.kind !== "ok") {
          await ctx.audit(
            "fetch_checkout_after_expiry",
            "ambiguous",
            fetched.kind,
          );
          await ctx.store.tx(() =>
            raiseAttentionIn(ctx.store, {
              instanceId: attempt.instance_id,
              sourceOpId: ctx.op.id,
              reasonClass: "operation_condition",
              reason:
                "Stripe Checkout expiry is not confirmed; deletion remains closed until Stripe can be read",
              severity: "critical",
              actor: "reinstatement",
              detail: `attempt=${attempt.id}; fetched=${fetched.kind}; observed=${new Date(ctx.now).toISOString()}`,
            }),
          );
          return {
            kind: "retry",
            reason: `Stripe expiry was not accepted and session truth is ${fetched.kind}`,
          };
        }
        status = fetched.object.status ?? "";
        paymentStatus = fetched.object.paymentStatus ?? "";
        await ctx.audit(
          "fetch_checkout_after_expiry",
          "succeeded",
          `status ${status}; paymentStatus ${paymentStatus}`,
        );
      } else {
        await ctx.audit(
          "expire_checkout",
          "succeeded",
          `status ${status}; paymentStatus ${paymentStatus}`,
        );
      }
      if (status === "complete") {
        await ctx.store.tx(async () => {
          await raiseRefundRequired(
            ctx.store,
            attempt,
            `attempt=${attempt.id}; session=${attempt.checkout_session_id}; stripeStatus=complete; paymentStatus=${paymentStatus || "unknown"}; observed=${new Date(ctx.now).toISOString()}`,
          );
          await ctx.store.sqlRun(
            "update reinstatement_attempts set state = 'attention', updated_at = $1, version = version + 1 where id = $2",
            [ctx.now, attempt.id],
          );
        });
      } else if (status === "expired") {
        await ctx.store.sqlRun(
          "update reinstatement_attempts set state = 'expired', updated_at = $1, version = version + 1 where id = $2",
          [ctx.now, attempt.id],
        );
      } else {
        await ctx.store.tx(() =>
          raiseAttentionIn(ctx.store, {
            instanceId: attempt.instance_id,
            sourceOpId: ctx.op.id,
            reasonClass: "operation_condition",
            reason:
              "Stripe Checkout remains open after its reinstatement boundary; deletion remains closed",
            severity: "critical",
            actor: "reinstatement",
            detail: `attempt=${attempt.id}; status=${status || "unreadable"}; observed=${new Date(ctx.now).toISOString()}`,
          }),
        );
        return {
          kind: "retry",
          reason: `Stripe Checkout remains ${status || "unreadable"}; deletion stays closed`,
        };
      }
      return {
        kind: "done",
        evidence: {
          ...stamp,
          stripeStatus: status,
          paymentStatus,
          resolvedAt: ctx.now,
        },
      };
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
