// The one non-webhook billing transition: the coupon-lapse hold running out.
//
// The design gives the couponed-account diversion a deadline - "14 days, then the
// ordinary ladder resumes - or an unpaid office serves forever on the strength of
// an unread notification". This is that deadline, and it is deliberately the ONLY
// thing in this slice that writes billing state without a webhook.
//
// What it may touch is narrow on purpose: episode bookkeeping and a suspension
// request. It never writes the Stripe-owned columns - it has no fresh Stripe
// object, and inventing one would break the rule that the cache only ever holds
// what a fetch returned.
//
// It also never suspends merely because the calendar moved. The hold expiring is
// not evidence that Stripe stopped retrying, so expiry either acts on exhaustion
// already observed while the hold stood, or drops the account into the ordinary
// ladder and waits for Stripe to say it is done.

import type { Store } from "../store.ts";
import { applyBillingAttention } from "./billing-attention.ts";
import {
  casEpisodeBookkeeping,
  holdsExpiredAt,
  type SubscriptionRow,
} from "./billing-store.ts";
import { decideHoldExpiry } from "./dunning.ts";
import { requestSuspension } from "./suspension.ts";

export const BILLING_TICK_ACTOR = "billing-tick";

export interface BillingTickSummary {
  examined: number;
  resumedToLadder: number;
  suspensionsRequested: number;
  closed: number;
}

/**
 * One pass over expired coupon-lapse holds. Nothing sleeps in here, like every
 * other tick in this codebase.
 */
export async function billingTick(
  store: Store,
  now: number = store.now(),
  report: (line: string) => void = () => {},
): Promise<BillingTickSummary> {
  const summary: BillingTickSummary = {
    examined: 0,
    resumedToLadder: 0,
    suspensionsRequested: 0,
    closed: 0,
  };

  for (const row of await holdsExpiredAt(store, now)) {
    summary.examined++;
    try {
      // The transaction returns what it COMMITTED, and nothing outside it is touched
      // until it has. Counting or printing from inside would let a failed COMMIT -
      // or a reporter that throws - leave a summary claiming a transition that
      // rolled back, and a printed line claiming an action nobody took.
      // Awaited inside the try, so the catch below still turns a failed COMMIT
      // into a reported line and an unchanged summary.
      const committed = await store.tx(
        async (): Promise<{
          note: string;
          state?: string;
          suspended: boolean;
        } | null> => {
          // Re-read inside the transaction, and DECIDE FROM THE RE-READ ROW.
          //
          // The outer scan runs with no transaction open, so a webhook can change this
          // subscription in between - and not only by leaving the hold. It can record
          // exhaustion_observed_at while the state stays `coupon_hold`, which is
          // precisely the difference between resuming the ordinary ladder and
          // requesting suspension. A decision computed from the scanned copy would be
          // a check-then-act on the one field that decides whether a customer's box
          // gets powered off.
          const fresh = await store.sqlGet<SubscriptionRow>(
            "select * from subscriptions where id = ?",
            [row.id],
          );
          if (!fresh || fresh.episode_state !== "coupon_hold") {
            return {
              note: "left its coupon-lapse hold before this pass could act; leaving it alone",
              suspended: false,
            };
          }
          const decision = decideHoldExpiry(fresh, now);
          if (
            Object.keys(decision.episode).length === 0 &&
            !decision.suspension
          ) {
            // The fresh row says there is nothing to do - a hold whose deadline moved
            // out, for instance. Not an error, and not a transition.
            return { note: decision.note, suspended: false };
          }
          const after = await casEpisodeBookkeeping(
            store,
            fresh.id,
            fresh.version,
            decision.episode,
          );
          if (!after) {
            throw new Error(
              `subscription ${fresh.id} moved while its coupon-lapse hold was expiring`,
            );
          }
          let suspended = false;
          if (decision.suspension) {
            suspended =
              (await requestSuspension(
                store,
                after,
                decision.suspension.episodeId,
                now,
                BILLING_TICK_ACTOR,
              )) !== null;
          }
          await applyBillingAttention(
            store,
            after,
            decision.attention,
            BILLING_TICK_ACTOR,
          );
          await store.appendAudit({
            actor: BILLING_TICK_ACTOR,
            instance_id: after.instance_id,
            action: "coupon_hold_expired",
            target: after.id,
            outcome: "succeeded",
            detail: decision.note,
          });
          return {
            note: decision.note,
            state: decision.episode.episode_state,
            suspended,
          };
        },
      );

      if (!committed) continue;
      if (committed.suspended) summary.suspensionsRequested++;
      if (committed.state === "open") summary.resumedToLadder++;
      if (committed.state === "none") summary.closed++;
      try {
        report(`${row.id}: ${committed.note}`);
      } catch {
        // A reporter that throws must not make committed work look failed. The
        // transition is already durable; the line is not worth an incident.
      }
    } catch (err) {
      // A rolled-back pass is not a lost one: the hold is still expired, so the next
      // tick sees it again. Nothing has been counted, because counting happens after
      // the commit.
      report(
        `could not expire the coupon-lapse hold on ${row.id}: ${messageOf(err)}`,
      );
    }
  }

  return summary;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
