#!/usr/bin/env bun
// Exercise: cancel, un-cancel and cancel again against the REAL Stripe test API.
//
// The unit tests prove the key discipline against an injected fetch, which can
// only ever confirm what we already believe about Stripe. This confirms it
// against Stripe: three user-initiated requests inside one 24-hour window, three
// distinct idempotency keys, and the third one APPLIED rather than replaying the
// first response - which is exactly what a fixed per-subscription key would have
// done while reporting success.
//
// Test mode only (StripeClient refuses a live key in its constructor), and every
// object it creates hangs off a test clock it deletes at the end.
//
// Usage (credentials sourced by the caller):
//   bun control-plane/exercises/cancel-live.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { requestCancel, requestUncancel } from "../cancel.ts";
import { accountForDevSignIn, reserveOffice } from "../signup.ts";
import { Store } from "../store.ts";
import { insertSubscription } from "../stripe/billing-store.ts";
import { StripeClient } from "../stripe/client.ts";
import { databaseUrl } from "../config.ts";
import {
  createTestClock,
  deleteTestClock,
  TEST_PREFIX,
} from "../stripe/test-clock.ts";

const PRICE =
  process.env.CONTROL_PLANE_PRICE_ID ?? "price_1U2gtJAU22RWBcwco5XAN8pH";
const RUN = `s5cancel-${Math.floor(Date.now() / 1000)}`;

const key = process.env.STRIPE_TEST_SECRET_KEY;
if (!key) throw new Error("STRIPE_TEST_SECRET_KEY is not set");
const client = new StripeClient({ key, timeoutMs: 30_000 });

function ok(
  r: Awaited<ReturnType<StripeClient["get"]>>,
  what: string,
): Record<string, unknown> {
  if (r.kind !== "ok") throw new Error(`${what}: ${JSON.stringify(r)}`);
  return r.body;
}

function check(label: string, pass: boolean, detail = ""): void {
  console.log(
    `${pass ? "OK  " : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`,
  );
  if (!pass) process.exitCode = 1;
}

/** What Stripe says right now, read back rather than assumed from our own call. */
async function readBack(subscriptionId: string): Promise<boolean> {
  const sub = ok(
    await client.get(`/v1/subscriptions/${subscriptionId}`),
    "read subscription",
  );
  return sub.cancel_at_period_end === true;
}

// Keys and run records still live in a throwaway directory; the database
// does not, because the store speaks to a server now. Point
// CONTROL_PLANE_DB at a SCRATCH database: this writes rows.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp5-cancel-live-"));
const store = await Store.open(databaseUrl());
let clockId: string | null = null;

try {
  const clock = await createTestClock(
    client,
    {
      label: `s5-cancel-${RUN}`,
      frozenTimeSec: Math.floor(Date.now() / 1000) - 60,
    },
    `${RUN}-clock`,
  );
  clockId = clock.id;
  console.log(`clock ${clock.id} (${TEST_PREFIX} namespace)`);

  const customer = ok(
    await client.post(
      "/v1/customers",
      {
        email: `${TEST_PREFIX}-${RUN}@example.invalid`,
        name: `${TEST_PREFIX}-${RUN}`,
        metadata: { isomux_test: "slice3" },
        test_clock: clock.id,
      },
      `${RUN}-cust`,
    ),
    "create customer",
  );
  if (customer.livemode !== false)
    throw new Error("REFUSING: livemode customer");
  const attached = ok(
    await client.post(
      "/v1/payment_methods/pm_card_visa/attach",
      { customer: String(customer.id) },
      `${RUN}-attach`,
    ),
    "attach pm",
  );
  ok(
    await client.post(
      `/v1/customers/${String(customer.id)}`,
      { invoice_settings: { default_payment_method: String(attached.id) } },
      `${RUN}-default-pm`,
    ),
    "set default pm",
  );
  const sub = ok(
    // This direct create produces non-MoR evidence. Follow-up e818c077 re-measures
    // the lifecycle through Managed Payments Checkout.
    await client.post(
      "/v1/subscriptions",
      {
        customer: String(customer.id),
        items: [{ price: PRICE }],
        metadata: { isomux_test: "slice3" },
      },
      `${RUN}-sub`,
    ),
    "create subscription",
  );
  const subscriptionId = String(sub.id);
  console.log(`subscription ${subscriptionId} ${String(sub.status)}`);

  // The local rows a signup would have written.
  const account = await accountForDevSignIn(store, `${RUN}@example.invalid`);
  const reserved = await reserveOffice(store, {
    accountId: account.id,
    officeName: "cplive",
    plan: "office",
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  const instanceId = reserved.reservation.instance_id;
  const periodEnd =
    ((sub.items as { data?: { current_period_end?: number }[] }).data?.[0]
      ?.current_period_end ?? 0) * 1000;
  await store.tx(() =>
    insertSubscription(store, {
      id: subscriptionId,
      account_id: account.id,
      instance_id: instanceId,
      stripe_customer_id: String(customer.id),
      status: String(sub.status),
      current_period_end: periodEnd,
      cancel_at_period_end: 0,
      ended_at: null,
      canceled_at: null,
      cancellation_reason: null,
      discount_percent_off: null,
      discount_coupon_id: null,
      discount_ends_at: null,
      ever_full_discount: 0,
      latest_invoice_id: null,
      payment_failures: 0,
      exhaustion_observed_at: null,
      coupon_grace_until: null,
      episode_id: null,
      last_event_id: null,
      last_event_created: null,
    }),
  );

  const req = { accountId: account.id, instanceId };
  /** The webhook's job, done by hand: this exercise has no endpoint listening,
   * and cancel.ts deliberately never writes this column itself. */
  const mirror = (to: number) =>
    store.sqlRun(
      "update subscriptions set cancel_at_period_end = $1 where id = $2",
      [to, subscriptionId],
    );

  const first = await requestCancel(store, client, req);
  console.log(`cancel   -> ${JSON.stringify(first)}`);
  check("the first cancel was accepted", first.ok === true);
  check("Stripe reports it scheduled to end", await readBack(subscriptionId));
  await mirror(1);

  const second = await requestUncancel(store, client, req);
  console.log(`uncancel -> ${JSON.stringify(second)}`);
  check("the un-cancel was accepted", second.ok === true);
  check(
    "Stripe reports it NOT scheduled to end",
    !(await readBack(subscriptionId)),
  );
  await mirror(0);

  const third = await requestCancel(store, client, req);
  console.log(`cancel   -> ${JSON.stringify(third)}`);
  check("the third request was accepted", third.ok === true);
  // THE POINT OF THE WHOLE EXERCISE. With a key fixed per subscription this
  // would have replayed the FIRST response - reporting success while Stripe
  // applied nothing - and the read-back would say false.
  check(
    "and Stripe APPLIED it rather than replaying the first response",
    await readBack(subscriptionId),
  );

  const keys = (await store.auditEvents())
    .filter((e) => e.outcome === "started" && e.detail?.startsWith("cp-"))
    .map((e) => e.detail);
  console.log(`keys: ${JSON.stringify(keys)}`);
  check("three distinct idempotency keys were used", new Set(keys).size === 3);
} finally {
  if (clockId) {
    try {
      await deleteTestClock(client, clockId);
      console.log(
        `cleanup: deleted clock ${clockId} with its customer and subscription`,
      );
    } catch (err) {
      console.error(`CLEANUP FAILED for ${clockId}: ${String(err)}`);
      process.exitCode = 1;
    }
  }
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
