// Read-only recovery for ordinary signup Checkout sessions whose webhook did
// not arrive. Reinstatement sessions are structurally outside this candidate
// set: they live in reinstatement_attempts and keep their own retention machine.

import type { Store } from "../store.ts";
import {
  CHECKOUT_POLL_INTERVAL_MS,
  deferOrdinaryCheckoutPoll,
  dueOrdinaryCheckouts,
  recordTerminalOrdinarySession,
} from "../signup.ts";
import type { StripeObjectReader } from "./reader.ts";
import { applyPolledCheckout } from "./reconcile.ts";

export interface CheckoutPollSummary {
  examined: number;
  open: number;
  expired: number;
  reconciled: number;
  failed: number;
}

export async function pollPendingCheckouts(
  store: Store,
  reader: StripeObjectReader,
  now: number = store.now(),
  report: (line: string) => void = () => {},
): Promise<CheckoutPollSummary> {
  const summary: CheckoutPollSummary = {
    examined: 0,
    open: 0,
    expired: 0,
    reconciled: 0,
    failed: 0,
  };
  for (const reservation of await dueOrdinaryCheckouts(store, now)) {
    summary.examined++;
    const sessionId = reservation.checkout_session_id!;
    try {
      const fetched = await reader.getCheckoutSession(sessionId);
      if (fetched.kind === "absent") {
        if (
          await recordTerminalOrdinarySession(store, reservation.id, sessionId)
        ) {
          summary.expired++;
        }
        continue;
      }
      if (fetched.kind === "unavailable") {
        summary.failed++;
        await deferOrdinaryCheckoutPoll(
          store,
          reservation.id,
          sessionId,
          now + CHECKOUT_POLL_INTERVAL_MS,
        );
        report(`${reservation.name}: Checkout session is ${fetched.kind}`);
        continue;
      }
      const session = fetched.object;
      if (session.status === "expired") {
        if (
          await recordTerminalOrdinarySession(store, reservation.id, sessionId)
        ) {
          summary.expired++;
        }
        continue;
      }
      if (session.status !== "complete") {
        await deferOrdinaryCheckoutPoll(
          store,
          reservation.id,
          sessionId,
          now + CHECKOUT_POLL_INTERVAL_MS,
        );
        summary.open++;
        continue;
      }
      if (!session.subscriptionId) {
        await deferOrdinaryCheckoutPoll(
          store,
          reservation.id,
          sessionId,
          now + CHECKOUT_POLL_INTERVAL_MS,
        );
        summary.failed++;
        report(`${reservation.name}: completed Checkout names no subscription`);
        continue;
      }
      if (session.paymentStatus !== "paid") {
        await deferOrdinaryCheckoutPoll(
          store,
          reservation.id,
          sessionId,
          now + CHECKOUT_POLL_INTERVAL_MS,
        );
        summary.failed++;
        report(
          `${reservation.name}: completed Checkout is ${session.paymentStatus ?? "unpaid"}`,
        );
        continue;
      }
      const subscription = await reader.getSubscription(session.subscriptionId);
      if (subscription.kind !== "ok") {
        await deferOrdinaryCheckoutPoll(
          store,
          reservation.id,
          sessionId,
          now + CHECKOUT_POLL_INTERVAL_MS,
        );
        summary.failed++;
        report(`${reservation.name}: subscription is ${subscription.kind}`);
        continue;
      }
      await store.tx(() =>
        applyPolledCheckout(store, {
          reservationId: reservation.id,
          subscription: subscription.object,
          session,
          now,
        }),
      );
      summary.reconciled++;
    } catch (err) {
      summary.failed++;
      await deferOrdinaryCheckoutPoll(
        store,
        reservation.id,
        sessionId,
        now + CHECKOUT_POLL_INTERVAL_MS,
      ).catch(() => {});
      report(
        `${reservation.name}: Checkout recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return summary;
}
