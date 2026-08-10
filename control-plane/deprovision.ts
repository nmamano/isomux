// The end of life: cancel the asset, and prove the name no longer points at it.
//
// TWO SEPARATE RETRYABLE OPERATIONS, never one "destroy". The design's words:
// "power_off, remove_dns and cancel_asset stay separate retryable operations
// rather than one destroy, because Stripe's clock and the provider's term are
// independent; if cancel_asset succeeds and our write fails, the next tick's
// reconcile against get adopts the truth." Chaining them would also let a DNS
// record nobody has reaped hold open an asset we are still paying for.
//
// Neither of these deletes anything at the instant it succeeds:
//
//   cancel_asset SCHEDULES. Contabo cancels at its paid-term end and returns
//     that date; the box keeps serving until then. So this operation's success
//     means "the provider has accepted the cancellation", and `service_state`
//     becomes `deprovisioned` somewhere else entirely - when reconciliation
//     reports the asset actually cancelled or absent.
//   remove_dns REMOVES NOTHING. This deployment automates no DNS, and an
//     operation that reported a record removed while the record still resolved
//     would be a lie the ops floor could not see. So it raises a person and then
//     VERIFIES: it succeeds only once the name stops resolving to this box.

import * as dnsPromises from "node:dns/promises";
import { clearAttentionIn, raiseAttentionIn } from "./attention.ts";
import type { AssetState } from "./provider.ts";
import { openerStamp } from "./stripe/suspension.ts";
import type { Handler, HandlerContext, HandlerResult } from "./tick.ts";

// ------------------------------------------------------------ cancel_asset

/** Provider states meaning the asset is already gone. */
const GONE = new Set(["cancelled", "absent"]);
/** Provider states meaning a cancellation is already in force. Reaching one of
 * these after a REFUSED cancel is what turns the refusal into a no-op we can
 * conclude on. */
const ALREADY_ENDING = new Set(["cancelled", "absent", "cancel_scheduled"]);

export interface CancelAssetDeps {
  /**
   * The provider's cancel. ONE verb, deliberately: this handler holds no
   * adapter, so renewal, reinstatement and create are unreachable from here by
   * construction rather than by discipline.
   */
  cancel: (
    providerId: string,
  ) => Promise<{ assetState: AssetState; serviceEndsAt?: string }>;
  /**
   * Provider truth, read after a refused cancel.
   *
   * MEASURED 2026-08-10 against Contabo instance 203474835: cancelling an
   * already-cancel-scheduled instance returns HTTP 422 rather than succeeding
   * quietly, and changes nothing (state, power state and cancelDate identical
   * before and after). So the no-op is in the EFFECT, not in the status code -
   * and without this read, a crash between an accepted cancel and our write
   * would leave the operation retrying into a permanent 422 forever.
   *
   * A read. Like `cancel` it cannot renew, reinstate or create.
   */
  get: (providerId: string) => Promise<{
    assetState: AssetState;
    serviceEndsAt?: string;
  }>;
  /**
   * Provider states this handler may cancel FROM, required and with no default.
   *
   * The product set is `active` and `cancel_scheduled`: after R-2026-08-10-3 the
   * asset is deliberately NOT cancel-scheduled during the retention month, so at
   * deprovision_due the state that legitimately exists is `active`. The
   * loop-scoped test-box guard is NOT here - it lives in the live exercise
   * wrapper, because a universal refusal of `active` would be a test rig baked
   * into the product.
   */
  allowedAssetStates: readonly AssetState[];
  report?: (line: string) => void;
}

export function cancelAssetHandler(deps: CancelAssetDeps): Handler {
  return {
    kind: "cancel_asset",
    // A cancellation is a MUTATION at the provider: a killed call proves nothing
    // about whether it landed, so a timeout is ambiguous rather than retryable.
    timeoutIsRetryable: false,
    async run(ctx: HandlerContext): Promise<HandlerResult> {
      const asset = ctx.asset;
      const providerId = asset?.provider_id;
      if (!asset || !providerId) {
        return {
          kind: "fatal",
          reason:
            "cannot cancel an instance with no provider asset; there is " +
            "nothing to cancel",
        };
      }
      // Already gone is DONE, not an error: a redelivered deprovision after a
      // successful cancel must not call again, and the provider's own state is
      // the only thing that can say so.
      if (GONE.has(asset.asset_state)) {
        return {
          kind: "done",
          evidence: {
            ...openerStamp(ctx.op.evidence),
            alreadyGone: true,
            assetState: asset.asset_state,
          },
        };
      }
      if (!deps.allowedAssetStates.includes(asset.asset_state as AssetState)) {
        return {
          kind: "fatal",
          reason:
            `refusing to cancel provider asset ${providerId}: its state is ` +
            `${asset.asset_state}, and this process may only cancel from ` +
            `${deps.allowedAssetStates.join(", ")}`,
        };
      }

      ctx.budget.claim("cancel_asset");
      await ctx.audit("cancel_asset", "started", `provider ${providerId}`);
      let result: { assetState: AssetState; serviceEndsAt?: string };
      let refusal: string | null = null;
      try {
        result = await deps.cancel(providerId);
      } catch (err) {
        await ctx.audit("cancel_asset", "ambiguous", messageOf(err));
        // RECONCILE AGAINST PROVIDER TRUTH before deciding what the refusal
        // meant. This is the design's own recovery rule - "if cancel_asset
        // succeeds and our write fails, the next tick's reconcile against get
        // adopts the truth" - and the live probe is what showed it was load
        // bearing rather than theoretical.
        let truth: { assetState: AssetState; serviceEndsAt?: string };
        try {
          truth = await deps.get(providerId);
        } catch {
          // Two failures in a row establish nothing. The original error
          // describes the situation better than this one.
          throw err;
        }
        if (!ALREADY_ENDING.has(truth.assetState)) throw err;
        await ctx.audit(
          "cancel_asset",
          "succeeded",
          `provider ${providerId} was already ${truth.assetState}`,
        );
        refusal = messageOf(err);
        result = truth;
      }
      if (!refusal) {
        await ctx.audit(
          "cancel_asset",
          "succeeded",
          `provider ${providerId} -> ${result.assetState}`,
        );
      }
      // The provider's answer is adopted immediately rather than left for the
      // next reconcile: `serviceEndsAt` is the only proven deletion date there
      // is, and the ops floor needs it the moment it exists.
      if (
        !(await ctx.store.casAsset(asset.id, asset.version, {
          asset_state: result.assetState,
          ...(result.serviceEndsAt === undefined
            ? {}
            : { service_ends_at: result.serviceEndsAt }),
        }))
      ) {
        // The call HAPPENED. Ambiguous rather than a retry: a plain retry would
        // ask the provider to cancel something it has already cancelled.
        return {
          kind: "ambiguous",
          reason:
            `the provider accepted the cancellation and the asset row moved ` +
            `before it could be recorded; reconcile will adopt provider truth`,
        };
      }
      deps.report?.(
        `provider ${providerId} cancelled; service ends ${result.serviceEndsAt ?? "unknown"}`,
      );
      return {
        kind: "done",
        evidence: {
          ...openerStamp(ctx.op.evidence),
          cancelled: true,
          assetState: result.assetState,
          // Recorded so a transcript shows WHICH way it concluded. A refused
          // second call that reconciled is a different history from a clean
          // first call, even though both end in the same state.
          ...(refusal === null ? {} : { adoptedAfterRefusal: true }),
          ...(result.serviceEndsAt === undefined
            ? {}
            : { serviceEndsAt: result.serviceEndsAt }),
        },
      };
    },
  };
}

// -------------------------------------------------------------- remove_dns

export interface DnsAnswers {
  a: string[];
  aaaa: string[];
  /** True when the name does not exist at all. */
  absent: boolean;
}

export interface RemoveDnsDeps {
  /** Injected so the stub tier needs no resolver and no record to delete. */
  resolve?: (host: string) => Promise<DnsAnswers>;
  report?: (line: string) => void;
}

/**
 * The RECORD queries, not `lookup`.
 *
 * `dns.lookup` goes through the system resolver: it consults /etc/hosts, honours
 * nsswitch, and collapses the answer to a single address. None of that answers
 * "does a record pointing at this box still exist", which is the only question
 * here.
 */
export async function resolveRecords(host: string): Promise<DnsAnswers> {
  const answers: DnsAnswers = { a: [], aaaa: [], absent: false };
  let missing = 0;
  for (const [family, key] of [
    ["resolve4", "a"],
    ["resolve6", "aaaa"],
  ] as const) {
    try {
      answers[key] = await dnsPromises[family](host);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") {
        missing++;
        continue;
      }
      throw err;
    }
  }
  answers.absent = missing === 2;
  return answers;
}

/** The attention this operation raises, and later clears. One constant, because
 * clearing has to name the same string the raise used. */
export function dnsReasonFor(host: string, ipv4: string | null): string {
  return (
    `the DNS record for ${host} still points at ${ipv4 ?? "this office's box"} ` +
    `and has to be removed by hand: this deployment automates no DNS, so the ` +
    `deprovision cannot finish until the record is gone`
  );
}

export function removeDnsHandler(deps: RemoveDnsDeps = {}): Handler {
  const resolve = deps.resolve ?? resolveRecords;
  return {
    kind: "remove_dns",
    // Read-only. A probe that timed out changed nothing anywhere.
    timeoutIsRetryable: true,
    async run(ctx: HandlerContext): Promise<HandlerResult> {
      const host = ctx.instance.name;
      const ipv4 = ctx.asset?.ipv4 ?? null;
      const reason = dnsReasonFor(host, ipv4);

      ctx.budget.claim("dns_probe");
      let answers: DnsAnswers;
      try {
        answers = await resolve(host);
      } catch (err) {
        // A resolver failure establishes NOTHING about the record. It is not
        // evidence that the name is gone, so it is a retry, never a success.
        return {
          kind: "retry",
          reason: `could not read DNS for ${host}: ${messageOf(err)}`,
        };
      }

      const stillOurs = ipv4 !== null && answers.a.includes(ipv4);
      // An AAAA answer is UNPROVABLE, not harmless. We record no ipv6 for an
      // instance, so there is nothing to compare against, and "we cannot check"
      // is not "it is gone". It blocks, and the operator sees why.
      const unprovableV6 = answers.aaaa.length > 0;

      if (stillOurs || unprovableV6) {
        await ctx.store.tx(() =>
          raiseAttentionIn(ctx.store, {
            instanceId: ctx.instance.id,
            reasonClass: "operation_condition",
            sourceOpId: ctx.op.id,
            reason: unprovableV6 && !stillOurs ? `${reason} (AAAA)` : reason,
            severity: "warning",
            actor: "lifecycle",
          }),
        );
        const evidence = {
          ...openerStamp(ctx.op.evidence),
          a: answers.a,
          aaaa: answers.aaaa,
          stillOurs,
        };
        // `waiting` while the answer is unchanged, `progress` when it moved:
        // the inactivity deadline should reset on a record that is being worked
        // on and keep running on one nobody has touched.
        return sameAnswers(ctx.op.evidence, answers)
          ? { kind: "waiting", evidence }
          : { kind: "progress", evidence };
      }

      // Verified. The record no longer points here, so the condition this
      // operation raised is genuinely resolved and the row is cleared with its
      // audit - an incident that stayed open after being fixed would train an
      // operator to ignore the floor.
      await ctx.store.tx(async () => {
        for (const open of await ctx.store.openReasons(ctx.instance.id)) {
          if (open.source_op_id === ctx.op.id) {
            await clearAttentionIn(
              ctx.store,
              ctx.instance.id,
              open.id,
              "lifecycle",
            );
          }
        }
      });
      deps.report?.(`${host} no longer resolves to this office's box`);
      return {
        kind: "done",
        evidence: {
          ...openerStamp(ctx.op.evidence),
          removed: true,
          absent: answers.absent,
          a: answers.a,
        },
      };
    },
  };
}

function sameAnswers(raw: string, answers: DnsAnswers): boolean {
  try {
    const ev = JSON.parse(raw) as Record<string, unknown>;
    return (
      JSON.stringify(ev.a ?? null) === JSON.stringify(answers.a) &&
      JSON.stringify(ev.aaaa ?? null) === JSON.stringify(answers.aaaa)
    );
  } catch {
    return false;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
