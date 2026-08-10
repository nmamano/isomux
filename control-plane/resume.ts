// Coming back from a dunning suspension, and from nothing else.
//
// Slice 3 suspended on dunning exhaustion and deliberately stopped there: half a
// ladder is better than an invented one. This is the other half, and the reason
// it is worth building rather than leaving to an operator is that the failure it
// prevents is a PAYING customer's office staying switched off - which is a worse
// outcome than any automation risk it carries.
//
// FOUR PREDICATES, all required, all evaluated inside the transaction that
// writes. The fourth is the one that matters most: a box inside its
// cancellation-retention month is also `suspended` and also has a succeeded
// power_off, and resuming it would restart a server the customer cancelled and
// hand back an office that is on its way to deletion.

import { deadlinesFor } from "./operations.ts";
import { isLifecycleRow } from "./lifecycle.ts";
import { openerStamp } from "./stripe/suspension.ts";
import type { Store } from "./store.ts";
import type { SubscriptionRow } from "./stripe/billing-store.ts";
import type { Handler, HandlerContext, HandlerResult } from "./tick.ts";

export const RESUME_ACTOR = "billing-resume";

/** Stripe statuses that mean the customer is paid up. The same set dunning.ts
 * uses to close an episode: one definition of "recovered", not two. */
const HEALTHY = new Set(["active", "trialing"]);

/**
 * The resume operation's id, derived from the EPISODE the suspension belongs to.
 *
 * Same construction as `suspensionOperationId`, and for the same reason: the
 * operations primary key then refuses a second resume for one episode
 * permanently, terminal or not, so a redelivered recovery event cannot power a
 * box on twice.
 */
export function resumeOperationId(episodeId: string): string {
  return `op-power_on-${episodeId}`;
}

export type ResumeRefusal =
  | "not_suspended"
  | "not_healthy"
  | "no_episode"
  | "cancellation_in_progress"
  | "no_dunning_suspension"
  | "already_open";

export type ResumeOutcome =
  | { ok: true; operationId: string }
  | { ok: false; code: ResumeRefusal };

/**
 * Open the resume for a recovered subscription, at most once per episode.
 *
 * Must run inside the caller's transaction, so the predicates and the enqueue
 * cannot be separated by another writer.
 */
export function requestResume(
  store: Store,
  sub: SubscriptionRow,
  now: number,
  actor: string = RESUME_ACTOR,
): ResumeOutcome {
  if (!store.inTransaction()) {
    throw new Error("requestResume must run inside a transaction");
  }
  if (!sub.instance_id) return { ok: false, code: "no_episode" };
  const instance = store.getInstance(sub.instance_id);
  if (!instance || instance.service_state !== "suspended") {
    return { ok: false, code: "not_suspended" };
  }
  if (!HEALTHY.has(sub.status)) return { ok: false, code: "not_healthy" };

  const operations = store.operationsFor(sub.instance_id);

  // PREDICATE 4, and the one a careless implementation gets wrong: a
  // cancellation-retention box is suspended and recovered-looking too. Any
  // lifecycle row at all - power_off, cancel_asset, remove_dns, in any status -
  // means this office is on its way out and is never resumed.
  if (operations.some(isLifecycleRow)) {
    return { ok: false, code: "cancellation_in_progress" };
  }
  if (sub.ended_at !== null) {
    // Belt and braces on the same fact from the other side: a terminal
    // subscription cannot be the healthy one this function is about.
    return { ok: false, code: "cancellation_in_progress" };
  }

  const episodeId = suspensionEpisodeOf(operations, sub);
  if (!episodeId) return { ok: false, code: "no_dunning_suspension" };

  const opId = resumeOperationId(episodeId);
  if (store.getOperation(opId)) return { ok: false, code: "already_open" };

  const d = deadlinesFor("power_on");
  store.enqueue({
    id: opId,
    instance_id: sub.instance_id,
    kind: "power_on",
    inactivity_deadline_at: now + d.inactivityMs,
    absolute_deadline_at: now + d.absoluteMs,
    evidence: { reason: "dunning", subscription: sub.id, episode: episodeId },
  });
  store.appendAudit({
    actor,
    instance_id: sub.instance_id,
    action: "resume_requested",
    target: opId,
    outcome: "started",
    detail: `dunning episode ${episodeId} recovered`,
  });
  return { ok: true, operationId: opId };
}

/**
 * The episode whose suspension this instance is actually sitting in.
 *
 * Read off the SUCCEEDED power_off row's own evidence rather than from the
 * subscription's current episode columns, because a recovery CLEARS those: by
 * the time we know the customer paid, `episode_id` is already null. The row that
 * powered the box off is the only thing that still remembers which episode did
 * it.
 */
/** The instant the handler recorded, or -Infinity when the row carries none. */
function poweredOffAtOf(evidence: string): number {
  try {
    const parsed = JSON.parse(evidence) as Record<string, unknown>;
    const at = parsed.poweredOffAt;
    return typeof at === "number" && Number.isFinite(at) ? at : -Infinity;
  } catch {
    return -Infinity;
  }
}

function suspensionEpisodeOf(
  operations: { id: string; kind: string; status: string; evidence: string }[],
  sub: SubscriptionRow,
): string | null {
  // THE LATEST SUSPENSION, decided by WHEN THE BOX WAS ACTUALLY POWERED OFF.
  //
  // Taking the first match in row order was a real defect: an account suspended
  // and resumed for episode A, then suspended again for episode B, selected A -
  // found `op-power_on-A` already there - and reported `already_open`, leaving a
  // PAYING customer's box switched off.
  //
  // Reversing the row order fixes that case and is still not a rule: operations
  // are ordered by `created_at`, timestamps have millisecond resolution and can
  // TIE, and SQL promises nothing about the order of tied rows. So the
  // comparison is on `poweredOffAt` - the instant the handler recorded on
  // purpose, which is the semantic thing "latest suspension" means - with the
  // operation id as a deterministic tie-break so two rows that genuinely share
  // an instant still resolve the same way on every engine and every read.
  //
  // NOT skipping episodes whose resume already exists, deliberately. That looks
  // like the obvious extra safeguard and is worse: if the newest suspension has
  // already been resumed, skipping it selects an OLDER, stale episode and opens
  // a resume on its authority. The caller's derived-id guard answers
  // `already_open` for that case, which is the honest thing to say.
  let best: { episode: string; at: number; id: string } | null = null;
  for (const op of operations) {
    if (op.kind !== "power_off" || op.status !== "succeeded") continue;
    const stamp = openerStamp(op.evidence);
    if (stamp.reason !== "dunning") continue;
    const episode = typeof stamp.episode === "string" ? stamp.episode : "";
    if (!episode) continue;
    // A row with no recorded instant loses to any row that has one: it predates
    // the field, so it cannot be the suspension the box is currently in if a
    // dated one exists.
    const at = poweredOffAtOf(op.evidence);
    if (
      !best ||
      at > best.at ||
      (at === best.at && op.id.localeCompare(best.id) > 0)
    ) {
      best = { episode, at, id: op.id };
    }
  }
  if (best) return best.episode;
  // A dunning suspension with no episode stamp is not something to guess at: the
  // whole point of the derived id is that a resume can be opened exactly once,
  // and an invented episode id would defeat it. Fall back to the subscription's
  // own episode only when it is still set.
  return sub.episode_id;
}

export interface ResumeDeps {
  /** Resolves when the provider reports the box on. Throws otherwise; the
   * ticker classifies the throw. */
  powerOn: (providerId: string) => Promise<void>;
  report?: (line: string) => void;
}

export function powerOnHandler(deps: ResumeDeps): Handler {
  return {
    kind: "power_on",
    // A power action is a MUTATION: a killed call proves nothing about whether
    // the provider applied it, so a timeout is ambiguous rather than retryable.
    timeoutIsRetryable: false,
    async run(ctx: HandlerContext): Promise<HandlerResult> {
      const providerId = ctx.asset?.provider_id;
      if (!providerId) {
        return {
          kind: "fatal",
          reason:
            "cannot resume an instance with no provider asset; there is " +
            "nothing to power on",
        };
      }
      ctx.budget.claim("power_on");
      ctx.audit("power_on", "started", `provider ${providerId}`);
      try {
        await deps.powerOn(providerId);
      } catch (err) {
        ctx.audit("power_on", "ambiguous", messageOf(err));
        throw err;
      }
      ctx.audit("power_on", "succeeded", `provider ${providerId}`);
      deps.report?.(`resumed: provider ${providerId} powered on`);
      // It concludes when the PROVIDER has accepted the power-on, not when the
      // office answers again - the same boundary reboot draws, and for the same
      // reason: a slow boot is not a failed resume. Liveness reports the rest.
      return {
        kind: "done",
        evidence: {
          ...openerStamp(ctx.op.evidence),
          poweredOn: true,
          providerId,
          poweredOnAt: ctx.now,
        },
      };
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
