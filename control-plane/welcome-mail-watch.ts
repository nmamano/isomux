// One pass over the welcome series rows that are due. Each row is advanced
// before its mail goes out, and only the writer that wins the advance sends:
// a crash between the two loses that one mail, and no mail is sent twice.

import { currentSubscriptionForInstance } from "./reinstatement.ts";
import type { Store, WelcomeMailRow } from "./store.ts";
import {
  WELCOME_MAIL_OFFSETS_MS,
  WELCOME_MAIL_STALE_MS,
  sendWelcomeMail,
} from "./welcome-mail.ts";

export interface WelcomeMailWatchDeps {
  /** The Resend key. */
  apiKey: string;
  send?: typeof sendWelcomeMail;
  /** Passed to the sender; defaults to WELCOME_MAIL_POSTAL_ADDRESS. */
  postalAddress?: string;
  report?: (line: string) => void;
}

type Decision =
  | { kind: "send"; to: string; officeUrl: string }
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
  if (now > row.next_due_at! + WELCOME_MAIL_STALE_MS) {
    return { kind: "skip", why: "more than 48 hours late" };
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
  };
}

/** The step after `row`'s, and when it is due; null once the series is over.
 * A later office of an account (tips 0) gets the first mail only. */
function nextStep(
  row: WelcomeMailRow,
  ended: boolean,
): { next_step: number; next_due_at: number | null } {
  const next = row.next_step + 1;
  const over =
    ended || next >= WELCOME_MAIL_OFFSETS_MS.length || row.tips === 0;
  return {
    next_step: next,
    next_due_at: over ? null : row.live_at + WELCOME_MAIL_OFFSETS_MS[next],
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
  for (const row of await store.dueWelcomeMails(store.now())) {
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
      const decision = await decide(store, row, store.now());
      if (decision.kind !== "send") {
        await store.tx(async () => {
          const advanced = await store.advanceWelcomeMail(
            row.instance_id,
            row.version,
            nextStep(row, decision.kind === "end"),
          );
          if (advanced) {
            await audit(
              decision.kind === "end" ? "ended" : "skipped",
              decision.why,
            );
          }
        });
        continue;
      }
      // Advance first: only the winner sends, so a second pass or a second
      // provisioner never sends the same step again.
      const advanced = await store.advanceWelcomeMail(
        row.instance_id,
        row.version,
        nextStep(row, false),
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
          },
          { apiKey: deps.apiKey, postalAddress: deps.postalAddress },
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
