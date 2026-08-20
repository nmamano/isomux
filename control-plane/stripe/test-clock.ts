// Test clocks: how a renewal, a coupon lapse and a full retry schedule happen in
// minutes instead of a month.
//
// Everything created here carries the `cp3-` prefix and an `isomux_test` metadata
// tag, and `deleteTestClock` takes its customers and subscriptions with it - so the
// shared test account stays legible after an exercise rather than filling up with
// anonymous objects nobody dares delete.
//
// Test-mode objects are free, so there is no spend question here. The discipline is
// about legibility, not money.

import type { StripeClient } from "./client.ts";

/** Every object this slice creates starts with this. */
export const TEST_PREFIX = "cp3";

/**
 * The exact namespace this slice MINTS names in: `cp3-<label>`.
 *
 * Ownership has to match what we mint, not merely start the same way. A clock named
 * `cp3other` or `cp3rd-party` is somebody else's, and on a shared account the
 * difference between "starts with cp3" and "is in the cp3- namespace" is whose work
 * gets deleted.
 */
export const OWNED_NAME_PREFIX = `${TEST_PREFIX}-`;
export const TEST_TAG = { isomux_test: "slice3" };

/**
 * The parameters for a customer this slice owns.
 *
 * Both signals at once: the metadata tag, which is what cleanup requires, and a
 * `cp3-` name so a human scanning the dashboard can see whose it is. A customer
 * created by Checkout instead of by us carries neither, which is how the first live
 * run left one behind that cleanup could not touch.
 */
export function ownedCustomerParams(args: {
  email: string;
  label: string;
}): Record<string, string | Record<string, string>> {
  return {
    email: args.email,
    name: `${TEST_PREFIX}-${args.label}`,
    metadata: { ...TEST_TAG },
  };
}

export type OwnedCustomerResult =
  | { ok: true; id: string }
  /** The response was wrong in a way a retry cannot fix. No session may follow. */
  | { ok: false; retryable: false; reason: string }
  /** We could not establish whether the customer exists. No session may follow. */
  | { ok: false; retryable: true; reason: string };

/**
 * Create a customer THIS SLICE OWNS, and verify what came back.
 *
 * The checks are not ceremony. `String(body.id)` on a malformed response yields the
 * customer id "undefined", which then travels into a Checkout session and into our
 * metadata; and a customer that reports live mode means this code is talking to the
 * real account, which is the one thing every other object in this flow is checked
 * for. Both are hard refusals, and the caller must create no session after one.
 */
export async function createOwnedCustomer(
  client: StripeClient,
  args: { email: string; label: string },
  idempotencyKey: string,
): Promise<OwnedCustomerResult> {
  const res = await client.post(
    "/v1/customers",
    ownedCustomerParams(args),
    idempotencyKey,
  );
  if (res.kind === "ambiguous") {
    return {
      ok: false,
      retryable: true,
      reason: `could not establish whether the customer was created: ${res.reason}`,
    };
  }
  if (res.kind === "rejected") {
    return { ok: false, retryable: false, reason: res.reason };
  }
  if (res.body.livemode !== (client.mode === "live")) {
    return {
      ok: false,
      retryable: false,
      reason:
        typeof res.body.livemode === "boolean"
          ? `the customer does not match configured ${client.mode} mode`
          : "the customer Stripe returned has no boolean livemode field; refusing " +
            "to guess which mode it belongs to",
    };
  }
  if (typeof res.body.id !== "string" || res.body.id === "") {
    return {
      ok: false,
      retryable: false,
      reason: "the customer Stripe returned has no id",
    };
  }
  return { ok: true, id: res.body.id };
}

export interface TestClock {
  id: string;
  status: string;
  frozenTime: number;
  /** Carried so cleanup can tell OUR clocks from anyone else's. A test clock has
   * no metadata field, so its name is the only ownership signal there is. */
  name: string | null;
}

export async function createTestClock(
  client: StripeClient,
  args: { label: string; frozenTimeSec: number },
  idempotencyKey: string,
): Promise<TestClock> {
  const res = await client.post(
    "/v1/test_helpers/test_clocks",
    {
      frozen_time: args.frozenTimeSec,
      name: `${TEST_PREFIX}-${args.label}`,
    },
    idempotencyKey,
  );
  if (res.kind !== "ok") {
    throw new Error(`could not create a test clock: ${res.reason}`);
  }
  return clockOf(res.body);
}

/**
 * Move a clock forward and wait until Stripe has finished simulating.
 *
 * Advancing is asynchronous: Stripe returns `advancing` and then generates
 * invoices, attempts payments and emits the events that follow. Reading the state
 * before it is `ready` is how a test ends up asserting on half a month.
 */
export async function advanceTestClock(
  client: StripeClient,
  clockId: string,
  toSec: number,
  opts: {
    idempotencyKey: string;
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<TestClock> {
  const res = await client.post(
    `/v1/test_helpers/test_clocks/${encodeURIComponent(clockId)}/advance`,
    { frozen_time: toSec },
    opts.idempotencyKey,
  );
  if (res.kind !== "ok") {
    throw new Error(`could not advance the test clock: ${res.reason}`);
  }
  return waitForClock(client, clockId, opts);
}

export async function waitForClock(
  client: StripeClient,
  clockId: string,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<TestClock> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const until = now() + timeoutMs;
  for (;;) {
    const res = await client.get(
      `/v1/test_helpers/test_clocks/${encodeURIComponent(clockId)}`,
    );
    if (res.kind !== "ok") {
      throw new Error(`could not read the test clock: ${res.reason}`);
    }
    const clock = clockOf(res.body);
    if (clock.status === "ready") return clock;
    if (clock.status === "internal_failure") {
      throw new Error(
        `the test clock reported internal_failure; the simulated month cannot be trusted`,
      );
    }
    if (now() >= until) {
      throw new Error(
        `the test clock was still ${clock.status} after ${timeoutMs}ms`,
      );
    }
    await sleep(pollMs);
  }
}

export async function deleteTestClock(
  client: StripeClient,
  clockId: string,
): Promise<void> {
  const res = await client.del(
    `/v1/test_helpers/test_clocks/${encodeURIComponent(clockId)}`,
  );
  if (res.kind !== "ok" && !(res.kind === "rejected" && res.status === 404)) {
    throw new Error(`could not delete the test clock: ${res.reason}`);
  }
}

export async function listTestClocks(
  client: StripeClient,
): Promise<TestClock[]> {
  const res = await client.get("/v1/test_helpers/test_clocks", { limit: 100 });
  if (res.kind !== "ok") {
    throw new Error(`could not list test clocks: ${res.reason}`);
  }
  const data = res.body.data;
  return Array.isArray(data) ? data.map(clockOf) : [];
}

function clockOf(raw: unknown): TestClock {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof o.id === "string" ? o.id : "",
    status: typeof o.status === "string" ? o.status : "unknown",
    frozenTime: typeof o.frozen_time === "number" ? o.frozen_time : 0,
    name: typeof o.name === "string" ? o.name : null,
  };
}
