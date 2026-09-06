import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "../testing/pg.ts";
import {
  advanceExpiredOrdinaryCheckout,
  recordOrdinaryCheckoutSession,
  reserveOffice,
  reservationByName,
} from "../signup.ts";
import { ensureAccount, getSubscription, listEvents } from "./billing-store.ts";
import { pollPendingCheckouts } from "./checkout-poll.ts";
import { applyEvent } from "./reconcile.ts";
import type { ReadResult, StripeObjectReader } from "./reader.ts";
import { continueSignup } from "../web/lib/services.server.ts";
import type {
  InvoiceSnapshot,
  SessionSnapshot,
  SubscriptionSnapshot,
} from "./shapes.ts";

const NOW = 1_777_000_000_000;
const temps: string[] = [];
const STORE_SLOT = Symbol.for("isomux.control-plane.web.store");
const realFetch = globalThis.fetch;

async function tempStore(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-checkout-poll-"));
  temps.push(dir);
  return openTestStore(() => NOW);
}

afterEach(async () => {
  delete (globalThis as { [STORE_SLOT]?: unknown })[STORE_SLOT];
  globalThis.fetch = realFetch;
  delete process.env.AUTH_URL;
  delete process.env.CONTROL_PLANE_ENTRY_PRICE_ID;
  delete process.env.CONTROL_PLANE_STRIPE_MODE;
  delete process.env.STRIPE_TEST_SECRET_KEY;
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

class FakeReader implements StripeObjectReader {
  sessions = new Map<string, SessionSnapshot>();
  subscriptions = new Map<string, SubscriptionSnapshot>();
  throws = new Set<string>();
  unavailable = new Set<string>();

  async getCheckoutSession(id: string): Promise<ReadResult<SessionSnapshot>> {
    if (this.throws.has(id)) throw new Error(`bad ${id}`);
    if (this.unavailable.has(id)) {
      return { kind: "unavailable", reason: "temporary" };
    }
    const object = this.sessions.get(id);
    return object ? { kind: "ok", object } : { kind: "absent" };
  }

  async getSubscription(id: string): Promise<ReadResult<SubscriptionSnapshot>> {
    const object = this.subscriptions.get(id);
    return object ? { kind: "ok", object } : { kind: "absent" };
  }

  async getInvoice(): Promise<ReadResult<InvoiceSnapshot>> {
    return { kind: "absent" };
  }
}

function session(
  id: string,
  status: string,
  subscriptionId: string | null = null,
  paymentStatus: string | null = null,
): SessionSnapshot {
  return {
    id,
    subscriptionId,
    customerId: "cus_1",
    status,
    paymentStatus,
    paymentMethodCollection: "always",
    url: status === "open" ? `https://checkout.test/${id}` : null,
    expiresAt: NOW + 60_000,
    metadata: {},
    livemode: false,
  };
}

function subscription(
  id: string,
  instanceId: string,
  status = "active",
): SubscriptionSnapshot {
  return {
    id,
    customerId: "cus_1",
    status,
    currentPeriodEnd: NOW + 2_592_000_000,
    cancelAtPeriodEnd: false,
    endedAt: null,
    canceledAt: null,
    cancellationReason: null,
    discount: null,
    latestInvoiceId: null,
    metadata: {
      isomux_account: "acct-1",
      isomux_email: "a@example.com",
      isomux_instance: instanceId,
    },
    livemode: false,
  };
}

async function pending(store: Store, officeName: string, sessionId: string) {
  await store.tx(() =>
    ensureAccount(store, { id: "acct-1", email: "a@example.com" }),
  );
  const made = await reserveOffice(
    store,
    { accountId: "acct-1", officeName, plan: "office" },
    { newId: () => officeName, now: () => NOW },
  );
  if (!made.ok) throw new Error(made.reason);
  expect(
    await recordOrdinaryCheckoutSession(store, made.reservation, {
      id: sessionId,
      expiresAt: NOW + 60_000,
    }),
  ).toBe(true);
  await store.sqlRun(
    "update name_reservations set checkout_next_check_at=$1 where id=$2",
    [NOW, made.reservation.id],
  );
  return made.reservation;
}

describe("pending ordinary Checkout polling", () => {
  test("the hosted lifecycle cadence invokes the fallback", () => {
    const cli = fs.readFileSync(
      path.join(import.meta.dir, "../cli.ts"),
      "utf8",
    );
    const cadence = cli.slice(
      cli.indexOf("async function runLifecycleCadence"),
      cli.indexOf("/**\n * The tick loop", cli.indexOf("runLifecycleCadence")),
    );
    expect(cadence).toContain("pollPendingCheckouts(");
  });

  test("an open session stays pending and is deferred", async () => {
    const store = await tempStore();
    const reservation = await pending(store, "alpha", "cs_open");
    const reader = new FakeReader();
    reader.sessions.set("cs_open", session("cs_open", "open"));

    expect(await pollPendingCheckouts(store, reader, NOW)).toMatchObject({
      examined: 1,
      open: 1,
      expired: 0,
      reconciled: 0,
    });
    expect(await reservationByName(store, "alpha")).toMatchObject({
      checkout_state: "pending",
      checkout_session_id: "cs_open",
    });
    expect(
      (await reservationByName(store, "alpha"))!.checkout_next_check_at,
    ).toBeGreaterThan(NOW);
    expect(await store.openReasons(reservation.instance_id)).toEqual([]);
  });

  test("a fetched expired session becomes terminal without attention", async () => {
    const store = await tempStore();
    const reservation = await pending(store, "bravo", "cs_expired");
    const reader = new FakeReader();
    reader.sessions.set("cs_expired", session("cs_expired", "expired"));

    expect(
      await advanceExpiredOrdinaryCheckout(store, reservation.id),
    ).toBeNull();

    expect(await pollPendingCheckouts(store, reader, NOW)).toMatchObject({
      expired: 1,
      failed: 0,
    });
    expect(await reservationByName(store, "bravo")).toMatchObject({
      checkout_state: "expired",
      checkout_next_check_at: null,
    });
    expect(await store.openReasons(reservation.instance_id)).toEqual([]);
    const next = await advanceExpiredOrdinaryCheckout(store, reservation.id);
    expect(next).toMatchObject({
      checkout_generation: 2,
      checkout_state: "opening",
      checkout_session_id: null,
    });
  });

  test("a payment-page refusal reaches the customer in their own language", async () => {
    // THE ACTUAL CALLER PATH, not a render: `continueSignup` is what the
    // /api/signup route calls, and the language it is given is the one
    // `languageForRequest()` resolved from the request. Literal translated
    // strings, so a broken translator cannot pass its own test.
    const store = await tempStore();
    await pending(store, "unreachable", "cs_stuck");
    (
      globalThis as {
        [STORE_SLOT]?: { opening?: Promise<Store> };
      }
    )[STORE_SLOT] = { opening: Promise.resolve(store) };
    process.env.AUTH_URL = "https://cloud.example.test";
    process.env.CONTROL_PLANE_ENTRY_PRICE_ID = "price_entry";
    process.env.CONTROL_PLANE_STRIPE_MODE = "test";
    process.env.STRIPE_TEST_SECRET_KEY = "sk_test_NOT_A_REAL_KEY_ONLY_A_SHAPE";
    // Stripe cannot say whether the session is still usable.
    globalThis.fetch = (async () =>
      new Response("upstream is down", {
        status: 503,
      })) as unknown as typeof fetch;

    expect(await continueSignup("es", "acct-1", "unreachable")).toEqual({
      ok: false,
      reason:
        "No hemos podido comprobar tu página de pago ahora mismo - vuelve a intentarlo en un momento.",
    });
    expect(await continueSignup("ca", "acct-1", "unreachable")).toEqual({
      ok: false,
      reason:
        "No hem pogut comprovar la teva pàgina de pagament ara mateix - torna-ho a provar d'aquí a un moment.",
    });
    // English is unchanged, which is the bytes this branch returned before the
    // catalog (ruling 6).
    expect(await continueSignup("en", "acct-1", "unreachable")).toEqual({
      ok: false,
      reason:
        "We could not check your payment page just now - try again in a moment.",
    });
  });

  test("Continue advances after the poll has already marked the session expired", async () => {
    const store = await tempStore();
    const reservation = await pending(store, "returning", "cs_old");
    const reader = new FakeReader();
    reader.sessions.set("cs_old", session("cs_old", "expired"));
    await pollPendingCheckouts(store, reader, NOW);
    expect(await reservationByName(store, "returning")).toMatchObject({
      checkout_generation: 1,
      checkout_state: "expired",
    });

    (
      globalThis as {
        [STORE_SLOT]?: { opening?: Promise<Store> };
      }
    )[STORE_SLOT] = { opening: Promise.resolve(store) };
    process.env.AUTH_URL = "https://cloud.example.test";
    process.env.CONTROL_PLANE_ENTRY_PRICE_ID = "price_entry";
    process.env.CONTROL_PLANE_STRIPE_MODE = "test";
    process.env.STRIPE_TEST_SECRET_KEY = "sk_test_NOT_A_REAL_KEY_ONLY_A_SHAPE";
    const posts: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const path = new URL(requestUrl).pathname;
      posts.push(path);
      const body =
        path === "/v1/customers"
          ? { id: "cus_new", livemode: false }
          : {
              id: "cs_new",
              url: "https://checkout.stripe.test/cs_new",
              expires_at: Math.floor((NOW + 86_400_000) / 1000),
              payment_method_collection: "always",
              livemode: false,
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    expect(await continueSignup("en", "acct-1", "returning")).toEqual({
      ok: true,
      checkoutUrl: "https://checkout.stripe.test/cs_new",
      instanceId: reservation.instance_id,
    });
    expect(posts).toEqual(["/v1/customers", "/v1/checkout/sessions"]);
    expect(await reservationByName(store, "returning")).toMatchObject({
      checkout_generation: 2,
      checkout_state: "pending",
      checkout_session_id: "cs_new",
    });
  });

  test("Continue opens the next generation when Stripe reports pending as expired", async () => {
    const store = await tempStore();
    const reservation = await pending(store, "remote-expiry", "cs_old");
    (
      globalThis as {
        [STORE_SLOT]?: { opening?: Promise<Store> };
      }
    )[STORE_SLOT] = { opening: Promise.resolve(store) };
    process.env.AUTH_URL = "https://cloud.example.test";
    process.env.CONTROL_PLANE_ENTRY_PRICE_ID = "price_entry";
    process.env.CONTROL_PLANE_STRIPE_MODE = "test";
    process.env.STRIPE_TEST_SECRET_KEY = "sk_test_NOT_A_REAL_KEY_ONLY_A_SHAPE";
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const requestUrl =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const path = new URL(requestUrl).pathname;
      calls.push(path);
      const body =
        path === "/v1/checkout/sessions/cs_old"
          ? {
              id: "cs_old",
              status: "expired",
              expires_at: Math.floor(NOW / 1000),
              livemode: false,
            }
          : path === "/v1/customers"
            ? { id: "cus_new", livemode: false }
            : {
                id: "cs_new",
                url: "https://checkout.stripe.test/cs_new",
                expires_at: Math.floor((NOW + 86_400_000) / 1000),
                payment_method_collection: "always",
                livemode: false,
              };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    expect(await continueSignup("en", "acct-1", "remote-expiry")).toEqual({
      ok: true,
      checkoutUrl: "https://checkout.stripe.test/cs_new",
      instanceId: reservation.instance_id,
    });
    expect(calls).toEqual([
      "/v1/checkout/sessions/cs_old",
      "/v1/customers",
      "/v1/checkout/sessions",
    ]);
    expect(await reservationByName(store, "remote-expiry")).toMatchObject({
      checkout_generation: 2,
      checkout_state: "pending",
      checkout_session_id: "cs_new",
    });
  });

  test("an unavailable session writes no terminal or subscription truth", async () => {
    const store = await tempStore();
    await pending(store, "blocked", "cs_unavailable");
    const reader = new FakeReader();
    reader.unavailable.add("cs_unavailable");

    expect(await pollPendingCheckouts(store, reader, NOW)).toMatchObject({
      failed: 1,
      reconciled: 0,
      expired: 0,
    });
    expect(await reservationByName(store, "blocked")).toMatchObject({
      checkout_state: "pending",
      checkout_session_id: "cs_unavailable",
    });
    expect(await getSubscription(store, "sub_unavailable")).toBeNull();
  });

  test("an absent session becomes terminal instead of polling forever", async () => {
    const store = await tempStore();
    await pending(store, "missing", "cs_absent");
    const reader = new FakeReader();

    expect(await pollPendingCheckouts(store, reader, NOW)).toMatchObject({
      expired: 1,
      failed: 0,
    });
    expect(await reservationByName(store, "missing")).toMatchObject({
      checkout_state: "expired",
      checkout_next_check_at: null,
    });
  });

  test("a legacy reservation adopts generation one when its session is recorded", async () => {
    const store = await tempStore();
    await store.tx(() =>
      ensureAccount(store, { id: "acct-1", email: "a@example.com" }),
    );
    const made = await reserveOffice(
      store,
      { accountId: "acct-1", officeName: "legacy", plan: "office" },
      { newId: () => "legacy", now: () => NOW },
    );
    if (!made.ok) throw new Error(made.reason);
    await store.sqlRun(
      "update name_reservations set checkout_generation=null, checkout_state=null where id=$1",
      [made.reservation.id],
    );
    expect(
      await recordOrdinaryCheckoutSession(store, made.reservation, {
        id: "cs_legacy",
        expiresAt: NOW + 60_000,
      }),
    ).toBe(true);
    expect(await reservationByName(store, "legacy")).toMatchObject({
      checkout_generation: 1,
      checkout_state: "pending",
      checkout_session_id: "cs_legacy",
    });
  });

  test("paid completion creates and links the row without a fake event", async () => {
    const store = await tempStore();
    const reservation = await pending(store, "charlie", "cs_paid");
    const reader = new FakeReader();
    reader.sessions.set(
      "cs_paid",
      session("cs_paid", "complete", "sub_paid", "paid"),
    );
    reader.subscriptions.set(
      "sub_paid",
      subscription("sub_paid", reservation.instance_id),
    );

    expect(await pollPendingCheckouts(store, reader, NOW)).toMatchObject({
      reconciled: 1,
      failed: 0,
    });
    expect(await getSubscription(store, "sub_paid")).toMatchObject({
      instance_id: reservation.instance_id,
      status: "active",
      episode_state: "none",
      last_event_id: null,
      last_event_created: null,
    });
    expect(await listEvents(store)).toEqual([]);
    expect(
      (await store.operationsFor(reservation.instance_id)).filter(
        (op) => op.kind === "create_instance",
      ),
    ).toHaveLength(1);
    expect((await pollPendingCheckouts(store, reader, NOW)).examined).toBe(0);
  });

  test("past_due completion caches truth but opens no dunning episode", async () => {
    const store = await tempStore();
    const reservation = await pending(store, "delta", "cs_late");
    const reader = new FakeReader();
    reader.sessions.set(
      "cs_late",
      session("cs_late", "complete", "sub_late", "paid"),
    );
    reader.subscriptions.set(
      "sub_late",
      subscription("sub_late", reservation.instance_id, "past_due"),
    );

    await pollPendingCheckouts(store, reader, NOW);
    expect(await getSubscription(store, "sub_late")).toMatchObject({
      status: "past_due",
      episode_state: "none",
      episode_id: null,
      payment_failures: 0,
    });
  });

  test("complete but unpaid never opens provisioning", async () => {
    const store = await tempStore();
    const reservation = await pending(store, "echo", "cs_unpaid");
    const reader = new FakeReader();
    reader.sessions.set(
      "cs_unpaid",
      session("cs_unpaid", "complete", "sub_unpaid", "unpaid"),
    );
    reader.subscriptions.set(
      "sub_unpaid",
      subscription("sub_unpaid", reservation.instance_id),
    );

    await pollPendingCheckouts(store, reader, NOW);
    expect(await store.operationsFor(reservation.instance_id)).toEqual([]);
    expect(await getSubscription(store, "sub_unpaid")).toBeNull();
  });

  test("completion without a subscription id remains pending", async () => {
    const store = await tempStore();
    await pending(store, "juliet", "cs_no_sub");
    const reader = new FakeReader();
    reader.sessions.set(
      "cs_no_sub",
      session("cs_no_sub", "complete", null, "paid"),
    );

    expect(await pollPendingCheckouts(store, reader, NOW)).toMatchObject({
      failed: 1,
      reconciled: 0,
    });
    expect(await reservationByName(store, "juliet")).toMatchObject({
      checkout_state: "pending",
    });
  });

  test("one thrown candidate does not stop the next customer", async () => {
    const store = await tempStore();
    await pending(store, "foxtrot", "cs_bad");
    const good = await pending(store, "golf", "cs_good");
    const reader = new FakeReader();
    reader.throws.add("cs_bad");
    reader.sessions.set(
      "cs_good",
      session("cs_good", "complete", "sub_good", "paid"),
    );
    reader.subscriptions.set(
      "sub_good",
      subscription("sub_good", good.instance_id),
    );

    expect(await pollPendingCheckouts(store, reader, NOW)).toMatchObject({
      examined: 2,
      reconciled: 1,
      failed: 1,
    });
  });

  test("webhook first makes the poll a no-op", async () => {
    const store = await tempStore();
    const reservation = await pending(store, "hotel", "cs_race_webhook");
    const fetchedSession = session(
      "cs_race_webhook",
      "complete",
      "sub_race_webhook",
      "paid",
    );
    const fetchedSubscription = subscription(
      "sub_race_webhook",
      reservation.instance_id,
    );
    await store.tx(() =>
      applyEvent(store, {
        eventId: "evt_race_webhook",
        eventType: "checkout.session.completed",
        eventCreated: NOW,
        subscription: fetchedSubscription,
        session: fetchedSession,
        now: NOW,
      }),
    );
    const reader = new FakeReader();
    reader.sessions.set(fetchedSession.id, fetchedSession);
    reader.subscriptions.set(fetchedSubscription.id, fetchedSubscription);
    expect((await pollPendingCheckouts(store, reader, NOW)).examined).toBe(0);
    expect(
      (await store.operationsFor(reservation.instance_id)).filter(
        (op) => op.kind === "create_instance",
      ),
    ).toHaveLength(1);
  });

  test("poll first and a later webhook still open one create", async () => {
    const store = await tempStore();
    const reservation = await pending(store, "india", "cs_race_poll");
    const fetchedSession = session(
      "cs_race_poll",
      "complete",
      "sub_race_poll",
      "paid",
    );
    const fetchedSubscription = subscription(
      "sub_race_poll",
      reservation.instance_id,
    );
    const reader = new FakeReader();
    reader.sessions.set(fetchedSession.id, fetchedSession);
    reader.subscriptions.set(fetchedSubscription.id, fetchedSubscription);
    await pollPendingCheckouts(store, reader, NOW);

    await store.tx(() =>
      applyEvent(store, {
        eventId: "evt_after_poll",
        eventType: "checkout.session.completed",
        eventCreated: NOW + 1,
        subscription: fetchedSubscription,
        session: fetchedSession,
        now: NOW + 1,
      }),
    );
    expect(
      (await store.operationsFor(reservation.instance_id)).filter(
        (op) => op.kind === "create_instance",
      ),
    ).toHaveLength(1);
    expect(await listEvents(store)).toHaveLength(1);
  });
});
