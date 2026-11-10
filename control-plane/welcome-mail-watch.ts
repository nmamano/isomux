// One pass over the welcome series rows that are due. Each row is advanced
// before its mail goes out, and only the writer that wins the advance sends:
// a crash between the two loses that one mail, and no mail is sent twice.

import { currentSubscriptionForInstance } from "./reinstatement.ts";
import type { Store, WelcomeMailRow } from "./store.ts";
import {
  WELCOME_MAIL_LATE_MS,
  WELCOME_MAIL_OFFSETS_MS,
  sendWelcomeMail,
} from "./welcome-mail.ts";

export interface WelcomeMailWatchDeps {
  /** The Resend key. */
  apiKey: string;
  send?: typeof sendWelcomeMail;
  report?: (line: string) => void;
  /** How many mails have approved copy. Absent means WELCOME_MAILS_APPROVED;
   * the schedule must use the same count (WorkScheduleOptions). */
  approved?: number;
}

type Decision =
  | { kind: "send"; to: string; officeUrl: string; late: boolean }
  | { kind: "skip"; why: string }
  | { kind: "end"; why: string };

/** What to do with a due step, from the office and subscription as they are
 * now. Ending is for a state the series cannot come back from. */
async function decide(
  store: Store,
  row: WelcomeMailRow,
  now: number,
): Promise<Decision> {
  const instance = await store.getInstance(row.instance_id);
  if (!instance || instance.service_state === "deprovisioned") {
    return { kind: "end", why: "office deprovisioned" };
  }
  const subscription = await currentSubscriptionForInstance(
    store,
    row.instance_id,
  );
  if (!subscription) return { kind: "end", why: "no subscription" };
  if (subscription.ended_at !== null) {
    return { kind: "end", why: "subscription ended" };
  }
  if (instance.service_state !== "live") {
    return { kind: "skip", why: `office ${instance.service_state}` };
  }
  if (
    !["active", "trialing"].includes(subscription.status) ||
    subscription.cancel_at_period_end !== 0 ||
    subscription.canceled_at !== null
  ) {
    return { kind: "skip", why: "subscription not in good standing" };
  }
  const account = await store.sqlGet<{ email: string }>(
    "select email from accounts where id = $1",
    [row.account_id],
  );
  if (!account) return { kind: "end", why: "no account" };
  return {
    kind: "send",
    to: account.email,
    officeUrl: `https://${instance.name}`,
    // No step is skipped for lateness (Nil, 2026-11-10): an office that went
    // live before the series sent gets its first mail, with a note, and a
    // tip that waited for its copy goes out when the copy ships.
    late: row.next_step === 0 && now > row.live_at + WELCOME_MAIL_LATE_MS,
  };
}

/** The step after `row`'s, and when it is due; null once the series is over.
 * A later office of an account (tips 0) gets the first mail only. The next
 * step is due the gap between the two offsets after `now`, when this step was
 * handled: a series that starts late, or waits out an outage, moves as a
 * whole, and two mails never go out closer together than their gap. That is
 * never earlier than the next step's own offset: this step was due, so
 * now >= next_due_at >= live_at + its offset. */
function nextStep(
  row: WelcomeMailRow,
  ended: boolean,
  now: number,
): { next_step: number; next_due_at: number | null } {
  const next = row.next_step + 1;
  const over =
    ended || next >= WELCOME_MAIL_OFFSETS_MS.length || row.tips === 0;
  if (over) return { next_step: next, next_due_at: null };
  const gap =
    WELCOME_MAIL_OFFSETS_MS[next] - WELCOME_MAIL_OFFSETS_MS[row.next_step];
  return {
    next_step: next,
    next_due_at: now + gap,
  };
}

/**
 * Handle every row that is due at store.now(): send, skip or end, and always
 * advance. Returns the number of mails sent.
 */
export async function watchWelcomeMail(
  store: Store,
  deps: WelcomeMailWatchDeps,
): Promise<number> {
  const send = deps.send ?? sendWelcomeMail;
  let sent = 0;
  for (const row of await store.dueWelcomeMails(store.now(), deps.approved)) {
    const step = row.next_step;
    const audit = (outcome: string, detail: string) =>
      store.appendAudit({
        actor: "control-plane",
        instance_id: row.instance_id,
        action: "welcome_mail",
        target: row.instance_id,
        outcome,
        detail: `step ${step}: ${detail}`,
      });
    try {
      const now = store.now();
      const decision = await decide(store, row, now);
      if (decision.kind !== "send") {
        // The first mail carries the office address and the sign-in steps:
        // a series without it ends rather than opening with a later tip.
        const ends = decision.kind === "end" || step === 0;
        await store.tx(async () => {
          const advanced = await store.advanceWelcomeMail(
            row.instance_id,
            row.version,
            nextStep(row, ends, now),
          );
          if (advanced) await audit(ends ? "ended" : "skipped", decision.why);
        });
        continue;
      }
      // Advance first: only the winner sends, so a second pass or a second
      // provisioner never sends the same step again.
      const advanced = await store.advanceWelcomeMail(
        row.instance_id,
        row.version,
        nextStep(row, false, now),
      );
      if (!advanced) continue;
      let result: Awaited<ReturnType<typeof sendWelcomeMail>>;
      try {
        result = await send(
          {
            to: decision.to,
            step,
            officeUrl: decision.officeUrl,
            unsubscribeToken: row.unsubscribe_token,
            late: decision.late,
          },
          { apiKey: deps.apiKey },
        );
      } catch (err) {
        result = {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      await store.tx(() =>
        audit(
          result.ok ? "succeeded" : "failed",
          result.ok ? "sent" : result.reason,
        ),
      );
      if (result.ok) sent++;
      else {
        deps.report?.(
          `welcome mail step ${step} for ${row.instance_id} failed: ${result.reason}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.report?.(
        `welcome mail pass failed for ${row.instance_id}: ${message}`,
      );
    }
  }
  return sent;
}
