// WHICH HANDLERS THE TICK LOOP IS BUILT FROM, in one place a test can read.
//
// This used to be an array literal inside `cli.ts`'s `makeTicker`, and `cli.ts`
// runs `main()` at import - so nothing could read the roster without running
// the CLI. That mattered more than it sounds: the grant matrix is derived from
// what the deployed command reaches, and the roster is the first half of that
// derivation. With the list unreadable, the audit's only pin was a
// hand-maintained copy, and a handler added here would touch a new table while
// every test about the matrix stayed green - which is the same class of
// omission that left the invite seam unable to read a reservation row
// (reviewer finding, 2026-08-12).
//
// So the composition lives here, `cli.ts` calls it, and
// `cmdrun-reachability.test.ts` reads the ACTUAL roster and requires every kind
// in it to be audited. A handler added to this function fails that test.
//
// IT DECIDES NOTHING. Every choice - which handlers exist, what
// `allowedAssetStates` means, why `create_instance` is absent - was already
// made and is stated where it was made; moving the list did not move any of it.

import { cancelAssetHandler, removeDnsHandler } from "./deprovision.ts";
import { type HandlerDeps, boxHandlers } from "./handlers.ts";
import { rebootHandler } from "./reboot.ts";
import { powerOnHandler } from "./resume.ts";
import { powerOffHandler } from "./stripe/suspension.ts";
import type { Handler } from "./tick.ts";

/**
 * The provider verbs the credential-dependent handlers need, or nothing.
 *
 * Bound verb by verb rather than as an adapter, and that is a rule rather than
 * a style: a handler holding the adapter holds `create` too, and no command in
 * this build may reach a paid create. The types are taken FROM the handlers, so
 * a handler that changes its parameter cannot leave this interface behind.
 */
export interface ProviderVerbs {
  reboot: Parameters<typeof rebootHandler>[0]["reboot"];
  powerOff: Parameters<typeof powerOffHandler>[0]["powerOff"];
  powerOn: Parameters<typeof powerOnHandler>[0]["powerOn"];
  cancel: Parameters<typeof cancelAssetHandler>[0]["cancel"];
  getAsset: Parameters<typeof cancelAssetHandler>[0]["get"];
}

/**
 * THE PRODUCT SET for a cancel, not a test-box guard.
 *
 * After R-2026-08-10-3 the asset is deliberately not cancel-scheduled during
 * retention, so `active` is the state that legitimately exists at
 * `deprovision_due`; `cancel_scheduled` is here because a term that was already
 * ending is not a reason to refuse. The loop's one-box restriction lives in
 * `exercises/cancel-asset-probe.ts`.
 */
export const CANCEL_ALLOWED_ASSET_STATES = [
  "active",
  "cancel_scheduled",
] as const;

/**
 * Every handler the tick loop registers.
 *
 * `create_instance` is deliberately absent: no flag in this build can reach a
 * paid create, exactly as in slice 1. Its absence is also what makes four verbs
 * unreachable in the grant matrix (`roles.ts`), so the slice that registers it
 * has to widen both.
 *
 * WITHOUT PROVIDER CREDENTIALS the provider handlers stay UNREGISTERED rather
 * than stubbed, the same choice slice 3 made for power_off: an enqueued
 * operation then surfaces as slice 2's no-handler condition - a failed
 * operation with attention raised - instead of looking like work that quietly
 * did nothing.
 */
export function tickerHandlerRoster(args: {
  box: HandlerDeps;
  provider: ProviderVerbs | null;
  report: (line: string) => void;
}): Handler[] {
  const { box, provider, report } = args;
  return [
    ...boxHandlers(box),
    ...(provider
      ? [
          rebootHandler({ reboot: provider.reboot, report }),
          powerOffHandler({ powerOff: provider.powerOff, report }),
          powerOnHandler({ powerOn: provider.powerOn, report }),
          cancelAssetHandler({
            cancel: provider.cancel,
            // The reconcile read after a refused cancel. Contabo answers a
            // second cancel with 422 (measured 2026-08-10), so without this the
            // operation would retry into a permanent error.
            get: provider.getAsset,
            allowedAssetStates: [...CANCEL_ALLOWED_ASSET_STATES],
            report,
          }),
        ]
      : []),
    // No credentials needed: it removes nothing and only READS DNS.
    removeDnsHandler({ report }),
  ];
}
