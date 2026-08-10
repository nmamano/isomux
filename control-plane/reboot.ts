// The customer's restart: a VM-level reboot at the provider.
//
// It exists because ruling 3 leaves no way to restart a service from inside a
// handed-off office - the terminal panel runs as the unprivileged service user,
// which by design cannot reach root - so this is the bluntest tool the customer
// has and also the only remote one. It earns its place by fixing a real share
// of "it stopped responding".
//
// It is NEVER automatic. A box failing liveness gets a person, because the
// failure may be ours; restarting somebody's server on a probe we got wrong is
// worse than an alert nobody needed.
//
// The provider call is INJECTED, exactly as suspension.ts does it, so the stub
// tier needs no account and no command in a process without an adapter can
// touch a real box.

import type { Handler, HandlerContext, HandlerResult } from "./tick.ts";

export interface RebootDeps {
  /** Resolves when the provider has accepted the reboot. Throws otherwise; the
   * ticker classifies the throw. */
  reboot: (providerId: string) => Promise<void>;
  report?: (line: string) => void;
}

export function rebootHandler(deps: RebootDeps): Handler {
  return {
    kind: "reboot",
    // A power action is a MUTATION: a killed call proves nothing about whether
    // the provider applied it, so a timeout is ambiguous rather than retryable.
    // Retrying a reboot that already landed would restart an office twice.
    timeoutIsRetryable: false,
    async run(ctx: HandlerContext): Promise<HandlerResult> {
      const providerId = ctx.asset?.provider_id;
      if (!providerId) {
        // Deterministically wrong rather than retried: no amount of waiting
        // gives this instance a provider asset to restart.
        return {
          kind: "fatal",
          reason:
            "cannot restart an instance with no provider asset; there is " +
            "nothing to reboot",
        };
      }
      ctx.budget.claim("reboot");
      await ctx.audit("reboot", "started", `provider ${providerId}`);
      try {
        await deps.reboot(providerId);
      } catch (err) {
        // Rethrown for the ticker's classifier, which is the one place that
        // decides what a transport failure means. The audit row goes down here
        // because this is where we know the call was issued.
        await ctx.audit("reboot", "ambiguous", messageOf(err));
        throw err;
      }
      await ctx.audit("reboot", "succeeded", `provider ${providerId}`);
      deps.report?.(`reboot requested at the provider for ${providerId}`);
      // It concludes when the PROVIDER has accepted the restart, not when the
      // office answers again. Coming back is what liveness reports, and tying
      // this operation to it would turn a slow boot into a failed restart.
      return { kind: "done", evidence: { rebooted: true, providerId } };
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
