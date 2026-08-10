#!/usr/bin/env bun
// Exercise: prove that cancelling an ALREADY-CANCELLED asset is a no-op.
//
// The deprovision path ends in one provider call that costs money to get wrong,
// and the loop's money rails allow exercising it against exactly one machine:
// instance 203474835, which is already cancel-scheduled for 2026-08-29. So the
// guard rails are IN THIS FILE, executable, rather than in a paragraph somebody
// has to remember:
//
//   - it refuses any provider id but the one below;
//   - it refuses unless the provider ALREADY reports the instance cancelled or
//     cancel-scheduled, so it can never be the thing that first cancels a live
//     box;
//   - it reads before, calls ONCE, reads after, and exits non-zero on ANY delta
//     in state or date. "We asked and nothing looked different" is the claim,
//     and a delta means the claim is false.
//
// This is a LOOP-SCOPED rig, not the product's rule. The handler in
// deprovision.ts deliberately accepts `active` too, because after manager ruling
// R-2026-08-10-3 the asset is not cancel-scheduled during the retention month
// and `active` is the state a real deprovision meets. That path is NOT exercised
// here: no live asset is cancelled in this loop.
//
// Usage (credentials sourced by the caller):
//   bun control-plane/exercises/cancel-asset-probe.ts

import { ContaboAdapter } from "../contabo/adapter.ts";
import {
  TokenProvider,
  credentialsFromEnv,
  type FetchLike,
} from "../contabo/auth.ts";
import { ContaboHttp } from "../contabo/http.ts";
import { UBUNTU_2404_IMAGE_ID, DEFAULT_LOGIN_USER } from "../config.ts";

/** The one machine this may ever touch. */
const ALLOWED_PROVIDER_ID = "203474835";
/** The only states from which a cancel can be a no-op. */
const ALLOWED_STATES = new Set(["cancel_scheduled", "cancelled"]);

function die(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

const providerId = process.argv[2] ?? ALLOWED_PROVIDER_ID;
if (providerId !== ALLOWED_PROVIDER_ID) {
  die(
    `this probe may only run against ${ALLOWED_PROVIDER_ID}; it was asked for ` +
      `${providerId}`,
  );
}

const fetchImpl = fetch as unknown as FetchLike;
const adapter = new ContaboAdapter({
  http: new ContaboHttp({
    fetchImpl,
    tokens: new TokenProvider(credentialsFromEnv(), fetchImpl),
  }),
  imageId: UBUNTU_2404_IMAGE_ID,
  loginUser: DEFAULT_LOGIN_USER,
});

function snapshot(view: {
  assetState: string;
  powerState: string;
  raw: unknown;
}): { assetState: string; powerState: string; cancelDate: string | null } {
  const raw = view.raw as { cancelDate?: string | null } | null;
  return {
    assetState: view.assetState,
    powerState: view.powerState,
    cancelDate: raw?.cancelDate ?? null,
  };
}

const before = snapshot(await adapter.get(providerId));
console.log(`BEFORE  ${JSON.stringify(before)}`);

if (!ALLOWED_STATES.has(before.assetState)) {
  die(
    `${providerId} is ${before.assetState}; this probe only proves the NO-OP ` +
      `case and will not be the call that first cancels a machine`,
  );
}
if (!before.cancelDate) {
  die(`${providerId} reports no cancel date; refusing to cancel it`);
}

console.log(
  `CANCEL  one call to POST /v1/compute/instances/${providerId}/cancel`,
);
// A REFUSAL IS AN ANSWER. The question this probe asks is what the provider
// does, not whether our adapter likes it, so a throw is recorded and the
// after-read still runs: "it errored" and "it changed something" are different
// findings and only the second one is a problem.
let result: unknown;
let threw: string | null = null;
try {
  result = await adapter.cancel(providerId);
  console.log(`RESULT  ${JSON.stringify(result)}`);
} catch (err) {
  threw = err instanceof Error ? err.message : String(err);
  console.log(`RESULT  threw: ${threw}`);
}

const after = snapshot(await adapter.get(providerId));
console.log(`AFTER   ${JSON.stringify(after)}`);

const deltas: string[] = [];
if (after.assetState !== before.assetState) {
  deltas.push(`assetState ${before.assetState} -> ${after.assetState}`);
}
if (after.cancelDate !== before.cancelDate) {
  deltas.push(`cancelDate ${before.cancelDate} -> ${after.cancelDate}`);
}
if (after.powerState !== before.powerState) {
  deltas.push(`powerState ${before.powerState} -> ${after.powerState}`);
}

if (deltas.length > 0) {
  console.error(`DELTA   ${deltas.join("; ")}`);
  console.error(
    "the cancel was NOT a no-op. Stop and escalate before running it again.",
  );
  process.exit(1);
}
console.log(
  "NO-OP   nothing changed: state, power and cancel date are identical",
);
if (threw) {
  console.log(
    "NOTE    the provider REFUSED the second cancel rather than accepting it " +
      "silently; the no-op is in its effect, not in its status code",
  );
}
