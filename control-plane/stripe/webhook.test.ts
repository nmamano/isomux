// The inbound seam, end to end over a real store and a fake Stripe.
//
// What is being held here, in order of how badly it would hurt to get wrong:
//
//   - a live-mode event, or one with no livemode field, touches NOTHING - not even
//     a dedupe lookup or a fetch;
//   - a live-mode OBJECT behind a valid test-mode event stops the same way;
//   - the event id is claimed in the transaction that applies the effect, so a
//     throw mid-apply leaves the event replayable;
//   - two events with the SAME one-second `created`, delivered newest first,
//     cannot regress state, because both reconcile from a fetched snapshot;
//   - a dunning episode suspends exactly once, across a replayed event, a second
//     exhaustion event, and a replay after the operation has already failed.

import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.ts";
import { InviteHold } from "../invite-hold.ts";
import { startMintSeam } from "../mint-seam.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "../testing/pg.ts";
import {
  getSubscription,
  listAccounts,
  listEvents,
  listSubscriptions,
} from "./billing-store.ts";
import {
  assertStripeMode,
  type ReadResult,
  type StripeObjectReader,
} from "./reader.ts";
import type { StripeMode } from "./mode.ts";
import type {
  InvoiceSnapshot,
  SessionSnapshot,
  SubscriptionSnapshot,
} from "./shapes.ts";
import { suspensionOperationId } from "./dunning.ts";
import {
  WebhookProcessor,
  assertStripeModeEvent,
  StripeModeEventRefused,
} from "./webhook.ts";
import { WEBHOOK_PATH } from "./server.ts";

const SECRET = "whsec_NOT_A_REAL_SECRET_ONLY_A_SHAPE";
const NOW = 1_770_000_000_000;
const temps: string[] = [];

async function tempStore(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-webhook-"));
  temps.push(dir);
  return await openTestStore(() => NOW);
}

afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

// --------------------------------------------------------------- fake Stripe

interface FakeReaderOptions {
  /** Called before each fetch, so a test can observe what the store looked like at
   * that moment - which is how the serial queue is asserted. */
  onFetch?: (what: string) => Promise<void> | void;
  unavailable?: boolean;
  gate?: Promise<void>;
}

class FakeReader implements StripeObjectReader {
  readonly subscriptions = new Map<string, SubscriptionSnapshot>();
  readonly invoices = new Map<string, InvoiceSnapshot>();
  readonly sessions = new Map<string, SessionSnapshot>();
  readonly calls: string[] = [];
  unavailable = false;
  gate: Promise<void> | null = null;

  constructor(
    private readonly mode: StripeMode,
    private readonly opts: FakeReaderOptions = {},
  ) {
    this.unavailable = opts.unavailable ?? false;
    this.gate = opts.gate ?? null;
  }

  private async answer<T extends { livemode: boolean; id: string }>(
    what: string,
    map: Map<string, T>,
    id: string,
  ): Promise<ReadResult<T>> {
    this.calls.push(`${what}:${id}`);
    await this.opts.onFetch?.(`${what}:${id}`);
    if (this.gate) await this.gate;
    if (this.unavailable) {
      return { kind: "unavailable", reason: "fake Stripe is unreachable" };
    }
    const object = map.get(id);
    if (!object) return { kind: "absent" };
    // The SAME refusal the live reader applies. A fake that skipped it would test
    // a rule nothing enforces.
    assertStripeMode(object, what, this.mode);
    return { kind: "ok", object };
  }

  getSubscription(id: string) {
    return this.answer("subscription", this.subscriptions, id);
  }
  getInvoice(id: string) {
    return this.answer("invoice", this.invoices, id);
  }
  getCheckoutSession(id: string) {
    return this.answer("checkout session", this.sessions, id);
  }
}

function subscription(
  over: Partial<SubscriptionSnapshot> = {},
): SubscriptionSnapshot {
  return {
    id: "sub_1",
    customerId: "cus_1",
    status: "active",
    currentPeriodEnd: NOW + 30 * 86_400_000,
    cancelAtPeriodEnd: false,
    endedAt: null,
    canceledAt: null,
    cancellationReason: null,
    discount: null,
    latestInvoiceId: "in_1",
    metadata: { isomux_account: "acct-1", isomux_email: "buyer@example.com" },
    livemode: false,
    ...over,
  };
}

function invoiceSnap(over: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return {
    id: "in_1",
    subscriptionId: "sub_1",
    customerId: "cus_1",
    status: "open",
    amountDue: 550,
    attemptCount: 1,
    nextPaymentAttempt: NOW + 3 * 86_400_000,
    paid: false,
    livemode: false,
    ...over,
  };
}

// ------------------------------------------------------------- fake delivery

function body(args: {
  id: string;
  type: string;
  object: Record<string, unknown>;
  created?: number;
  livemode?: unknown;
}): string {
  return JSON.stringify({
    id: args.id,
    type: args.type,
    created: args.created ?? Math.floor(NOW / 1000),
    livemode: "livemode" in args ? args.livemode : false,
    data: { object: args.object },
  });
}

function sign(payload: string, secret = SECRET, atMs = NOW): string {
  const t = Math.floor(atMs / 1000);
  const v1 = createHmac("sha256", secret)
    .update(`${t}.${payload}`, "utf8")
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

function processorFor(
  store: Store,
  reader: StripeObjectReader,
  lines: string[] = [],
  onApplied?: () => void,
): WebhookProcessor {
  return new WebhookProcessor({
    store,
    reader,
    secret: SECRET,
    mode: "test",
    now: () => NOW,
    report: (l) => lines.push(l),
    onApplied,
  });
}

async function deliver(
  processor: WebhookProcessor,
  payload: string,
  header = sign(payload),
) {
  return processor.handle(payload, header);
}

async function seedInstance(store: Store, id = "inst-1"): Promise<string> {
  await store.createInstance({
    id,
    run_id: "run-1",
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "handed_off",
    access_window_expires_at: null,
  });
  await store.tx(
    async () =>
      await store.createAsset({
        id: `asset-${id}`,
        instance_id: id,
        provider: "contabo",
        provider_id: "203474835",
        intent_id: null,
        asset_state: "active",
        ipv4: "169.58.97.2",
        service_ends_at: null,
        host_key_fingerprint: null,
        next_reconcile_at: NOW,
      }),
  );
  return id;
}

// --------------------------------------------------------------------- tests

describe("the mode gate", () => {
  test("live mode accepts a live event and live fetched object", async () => {
    const store = await tempStore();
    const reader = new FakeReader("live");
    reader.subscriptions.set(
      "sub_live_shape",
      subscription({ livemode: true }),
    );
    const payload = body({
      id: "evt_live_shape",
      type: "customer.subscription.updated",
      object: { id: "sub_live_shape" },
      livemode: true,
    });
    const processor = new WebhookProcessor({
      store,
      reader,
      secret: SECRET,
      mode: "live",
      now: () => NOW,
    });
    expect(await deliver(processor, payload)).toMatchObject({
      status: 200,
      kind: "applied",
    });
    expect(reader.calls).toEqual(["subscription:sub_live_shape"]);
  });

  test("a live-mode event is refused before any lookup, fetch or write", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    reader.subscriptions.set("sub_1", subscription());
    const outcome = await deliver(
      processorFor(store, reader),
      body({
        id: "evt_live",
        type: "customer.subscription.updated",
        object: { id: "sub_1" },
        livemode: true,
      }),
    );
    expect(outcome).toMatchObject({ status: 400, kind: "refused" });
    expect(reader.calls).toEqual([]);
    expect(await listEvents(store)).toEqual([]);
    expect(await listSubscriptions(store)).toEqual([]);
  });

  test("a MISSING livemode field is refused just as hard", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    reader.subscriptions.set("sub_1", subscription());
    const payload = JSON.stringify({
      id: "evt_nomode",
      type: "customer.subscription.updated",
      created: Math.floor(NOW / 1000),
      data: { object: { id: "sub_1" } },
    });
    const outcome = await deliver(processorFor(store, reader), payload);
    expect(outcome).toMatchObject({ status: 400, kind: "refused" });
    expect(reader.calls).toEqual([]);
    expect(await listEvents(store)).toEqual([]);
  });

  test("the gate is a rule on its own, with a typed failure", async () => {
    expect(() =>
      assertStripeModeEvent({ livemode: false }, "test"),
    ).not.toThrow();
    expect(() =>
      assertStripeModeEvent({ livemode: true }, "live"),
    ).not.toThrow();
    expect(() => assertStripeModeEvent({ livemode: false }, "live")).toThrow(
      StripeModeEventRefused,
    );
    for (const value of [true, undefined, null, "false", 0]) {
      expect(() => assertStripeModeEvent({ livemode: value }, "test")).toThrow(
        StripeModeEventRefused,
      );
    }
  });

  test("the fetched-object gate accepts and refuses both configured directions", () => {
    expect(() =>
      assertStripeMode(
        { id: "sub_test_shape", livemode: false },
        "subscription",
        "test",
      ),
    ).not.toThrow();
    expect(() =>
      assertStripeMode(
        { id: "sub_live_shape", livemode: true },
        "subscription",
        "live",
      ),
    ).not.toThrow();
    expect(() =>
      assertStripeMode(
        { id: "sub_live_shape", livemode: true },
        "subscription",
        "test",
      ),
    ).toThrow();
    expect(() =>
      assertStripeMode(
        { id: "sub_test_shape", livemode: false },
        "subscription",
        "live",
      ),
    ).toThrow();
  });

  test("the refusal says nothing about the body or any identifier", async () => {
    const store = await tempStore();
    const outcome = await deliver(
      processorFor(store, new FakeReader("test")),
      body({
        id: "evt_secretish",
        type: "customer.subscription.updated",
        object: { id: "sub_privatecustomer" },
        livemode: true,
      }),
    );
    expect(outcome.detail).not.toContain("sub_privatecustomer");
    expect(outcome.detail).not.toContain("evt_secretish");
  });

  test("a live-mode OBJECT behind a test-mode event stops with nothing written", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    reader.subscriptions.set("sub_1", subscription({ livemode: true }));
    const outcome = await deliver(
      processorFor(store, reader),
      body({
        id: "evt_1",
        type: "customer.subscription.updated",
        object: { id: "sub_1" },
      }),
    );
    expect(outcome).toMatchObject({ status: 400, kind: "refused" });
    // The fetch DID happen - that is where the refusal came from - and still
    // nothing was written.
    expect(reader.calls).toEqual(["subscription:sub_1"]);
    expect(await listEvents(store)).toEqual([]);
    expect(await listSubscriptions(store)).toEqual([]);
  });
});

describe("the signature", () => {
  test("a bad signature writes nothing and never fetches", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    reader.subscriptions.set("sub_1", subscription());
    const payload = body({
      id: "evt_1",
      type: "customer.subscription.updated",
      object: { id: "sub_1" },
    });
    const outcome = await deliver(
      processorFor(store, reader),
      payload,
      sign(payload, "whsec_SOMEONE_ELSES_SHAPE"),
    );
    expect(outcome).toMatchObject({ status: 400, kind: "refused" });
    expect(reader.calls).toEqual([]);
    expect(await listEvents(store)).toEqual([]);
  });

  test("a body that is not JSON is refused", async () => {
    const store = await tempStore();
    const payload = "not json";
    expect(
      await deliver(
        processorFor(store, new FakeReader("test")),
        payload,
        sign(payload),
      ),
    ).toMatchObject({ status: 400, kind: "refused" });
  });
});

describe("the deployed provisioner route", () => {
  test("only a signed POST reaches the processor without the seam bearer", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    const processor = processorFor(store, reader);
    const seam = startMintSeam({
      store,
      hold: new InviteHold(),
      token: "t".repeat(40),
      webhook: processor,
      port: 0,
    });
    const payload = body({
      id: "evt_route",
      type: "customer.created",
      object: { id: "cus_1" },
    });
    const url = `http://127.0.0.1:${seam.port}${WEBHOOK_PATH}`;
    try {
      const wrongMethod = await fetch(url, {
        headers: { "stripe-signature": sign(payload) },
      });
      expect(wrongMethod.status).toBe(405);

      const forged = await fetch(url, {
        method: "POST",
        headers: {
          "stripe-signature": sign(payload, "whsec_SOMEONE_ELSES_ROUTE_SECRET"),
        },
        body: payload,
      });
      expect(forged.status).toBe(400);
      expect(await listEvents(store)).toEqual([]);

      const genuine = await fetch(url, {
        method: "POST",
        headers: { "stripe-signature": sign(payload) },
        body: payload,
      });
      expect(genuine.status).toBe(200);
      expect(await genuine.json()).toMatchObject({ outcome: "ignored" });
      expect(await listEvents(store)).toHaveLength(1);
    } finally {
      await seam.stop();
    }
  });
});

describe("applying an event", () => {
  test("an applied commit wakes once, while its duplicate does not", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    reader.subscriptions.set("sub_1", subscription());
    let wakes = 0;
    const processor = processorFor(store, reader, [], () => wakes++);
    const payload = body({
      id: "evt_wake",
      type: "customer.subscription.updated",
      object: { id: "sub_1" },
    });
    expect(await deliver(processor, payload)).toMatchObject({
      kind: "applied",
    });
    expect(wakes).toBe(1);
    expect(await listEvents(store)).toHaveLength(1);
    expect(await deliver(processor, payload)).toMatchObject({
      kind: "duplicate",
    });
    expect(wakes).toBe(1);
  });

  test("checkout.session.completed establishes the row from the FETCHED subscription", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    reader.sessions.set("cs_1", {
      id: "cs_1",
      subscriptionId: "sub_1",
      customerId: "cus_1",
      status: "complete",
      paymentStatus: "paid",
      paymentMethodCollection: "always",
      metadata: {
        isomux_account: "acct-1",
        isomux_email: "buyer@example.com",
        isomux_office_name: "acme",
      },
      livemode: false,
    });
    reader.subscriptions.set("sub_1", subscription({ status: "active" }));

    const outcome = await deliver(
      processorFor(store, reader),
      // The event payload claims a WRONG status; the fetched object is what lands.
      body({
        id: "evt_1",
        type: "checkout.session.completed",
        object: { id: "cs_1", status: "open", subscription: "sub_1" },
      }),
    );
    expect(outcome).toMatchObject({ status: 200, kind: "applied" });
    expect(reader.calls).toEqual([
      "checkout session:cs_1",
      "subscription:sub_1",
    ]);
    const row = await getSubscription(store, "sub_1");
    expect(row).toMatchObject({
      status: "active",
      account_id: "acct-1",
      stripe_customer_id: "cus_1",
    });
    expect((await listAccounts(store))[0]?.email).toBe("buyer@example.com");
  });

  test("a completed session naming no subscription is ignored, not retried", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    reader.sessions.set("cs_1", {
      id: "cs_1",
      subscriptionId: null,
      customerId: "cus_1",
      status: "complete",
      paymentStatus: "paid",
      paymentMethodCollection: "always",
      metadata: {},
      livemode: false,
    });
    const outcome = await deliver(
      processorFor(store, reader),
      body({
        id: "evt_1",
        type: "checkout.session.completed",
        object: { id: "cs_1" },
      }),
    );
    expect(outcome).toMatchObject({ status: 200, kind: "ignored" });
    expect(await listEvents(store)).toHaveLength(1);
  });

  test("a delivery for a subscription Stripe does not know is ignored", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    const outcome = await deliver(
      processorFor(store, reader),
      body({
        id: "evt_unknown_subscription",
        type: "customer.subscription.updated",
        object: { id: "sub_unknown" },
      }),
    );
    expect(outcome).toMatchObject({ status: 200, kind: "ignored" });
    expect(reader.calls).toEqual(["subscription:sub_unknown"]);
    expect(await listSubscriptions(store)).toEqual([]);
    expect(await listEvents(store)).toHaveLength(1);
  });

  test("an unhandled type is recorded and answered 200", async () => {
    const store = await tempStore();
    const outcome = await deliver(
      processorFor(store, new FakeReader("test")),
      body({ id: "evt_x", type: "customer.created", object: { id: "cus_1" } }),
    );
    // A 4xx here would make Stripe retry an event we will never handle.
    expect(outcome).toMatchObject({ status: 200, kind: "ignored" });
    expect((await listEvents(store))[0]).toMatchObject({ outcome: "ignored" });
  });

  test("a subscription with no isomux metadata is cached under an unattributed account", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    reader.subscriptions.set("sub_1", subscription({ metadata: {} }));
    const lines: string[] = [];
    const outcome = await deliver(
      processorFor(store, reader, lines),
      body({
        id: "evt_1",
        type: "customer.subscription.updated",
        object: { id: "sub_1" },
      }),
    );
    expect(outcome.kind).toBe("applied");
    expect((await getSubscription(store, "sub_1"))?.account_id).toBe(
      "acct-unattributed-cus_1",
    );
    expect(lines.join("\n")).toContain("no isomux metadata");
  });

  test("the instance's subscription state is mirrored when one is linked", async () => {
    const store = await tempStore();
    await seedInstance(store);
    const reader = new FakeReader("test");
    reader.subscriptions.set(
      "sub_1",
      subscription({
        status: "past_due",
        metadata: {
          isomux_account: "acct-1",
          isomux_email: "buyer@example.com",
          isomux_instance: "inst-1",
        },
      }),
    );
    await deliver(
      processorFor(store, reader),
      body({
        id: "evt_1",
        type: "customer.subscription.updated",
        object: { id: "sub_1" },
      }),
    );
    expect((await store.getInstance("inst-1"))?.subscription_state).toBe(
      "past_due",
    );
  });
});

describe("dedupe and replay", () => {
  test("the same event id twice applies once", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    reader.subscriptions.set("sub_1", subscription({ status: "past_due" }));
    const processor = processorFor(store, reader);
    const payload = body({
      id: "evt_1",
      type: "customer.subscription.updated",
      object: { id: "sub_1" },
    });
    expect((await deliver(processor, payload)).kind).toBe("applied");
    const versionAfterFirst = (await getSubscription(store, "sub_1"))?.version;
    expect((await deliver(processor, payload)).kind).toBe("duplicate");
    // No second write: the version is the proof.
    expect((await getSubscription(store, "sub_1"))?.version).toBe(
      versionAfterFirst,
    );
    expect(await listEvents(store)).toHaveLength(1);
  });

  test("a throw mid-apply leaves the event UNCLAIMED, so the replay works", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    reader.subscriptions.set("sub_1", subscription({ status: "past_due" }));
    const processor = processorFor(store, reader);
    const payload = body({
      id: "evt_1",
      type: "customer.subscription.updated",
      object: { id: "sub_1" },
    });

    // Fault injection at the last write of the transaction: the audit row.
    const realAppend = store.appendAudit.bind(store);
    let fail = true;
    store.appendAudit = (ev: Parameters<Store["appendAudit"]>[0]) => {
      if (fail) throw new Error("the store died before the commit");
      return realAppend(ev);
    };

    expect(await deliver(processor, payload)).toMatchObject({
      status: 500,
      kind: "retry",
    });
    expect(await listEvents(store)).toEqual([]);
    expect(await listSubscriptions(store)).toEqual([]);

    fail = false;
    expect((await deliver(processor, payload)).kind).toBe("applied");
    expect((await getSubscription(store, "sub_1"))?.status).toBe("past_due");
    expect(await listEvents(store)).toHaveLength(1);
  });

  test("a fetch we cannot complete commits nothing and asks for redelivery", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test", { unavailable: true });
    const processor = processorFor(store, reader);
    const payload = body({
      id: "evt_1",
      type: "customer.subscription.updated",
      object: { id: "sub_1" },
    });
    expect(await deliver(processor, payload)).toMatchObject({
      status: 500,
      kind: "retry",
    });
    expect(await listEvents(store)).toEqual([]);

    reader.unavailable = false;
    reader.subscriptions.set("sub_1", subscription());
    expect((await deliver(processor, payload)).kind).toBe("applied");
  });
});

describe("ordering", () => {
  test("two events sharing one second, newest first, cannot regress state", async () => {
    // This is why `created` is not the arbiter: Stripe timestamps have one-second
    // resolution, so the older payload could otherwise land last.
    const store = await tempStore();
    const reader = new FakeReader("test");
    reader.subscriptions.set("sub_1", subscription({ status: "past_due" }));
    const processor = processorFor(store, reader);
    const sameSecond = Math.floor(NOW / 1000);

    const newer = body({
      id: "evt_new",
      type: "customer.subscription.updated",
      created: sameSecond,
      object: { id: "sub_1", status: "past_due" },
    });
    const older = body({
      id: "evt_old",
      type: "customer.subscription.updated",
      created: sameSecond,
      // The stale payload still SAYS active. Nothing reads it.
      object: { id: "sub_1", status: "active" },
    });
    expect((await deliver(processor, newer)).kind).toBe("applied");
    expect((await deliver(processor, older)).kind).toBe("applied");
    expect((await getSubscription(store, "sub_1"))?.status).toBe("past_due");
    expect(await listEvents(store)).toHaveLength(2);
  });

  test("deliveries for one subscription are serialised around fetch and apply", async () => {
    // Without the per-subscription chain, two deliveries could both fetch before
    // either applied, and the first fetch could write last.
    const store = await tempStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const eventsSeenAtFetch: number[] = [];
    const reader = new FakeReader("test", {
      onFetch: async () => {
        eventsSeenAtFetch.push((await listEvents(store)).length);
      },
    });
    reader.gate = gate;
    reader.subscriptions.set("sub_1", subscription({ status: "past_due" }));
    const processor = processorFor(store, reader);

    const first = deliver(
      processor,
      body({
        id: "evt_1",
        type: "customer.subscription.updated",
        object: { id: "sub_1" },
      }),
    );
    const second = deliver(
      processor,
      body({
        id: "evt_2",
        type: "customer.subscription.updated",
        object: { id: "sub_1" },
      }),
    );
    release();
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.map((o) => o.kind)).toEqual(["applied", "applied"]);
    // The second fetch happened AFTER the first apply had committed its event.
    expect(eventsSeenAtFetch).toEqual([0, 1]);
  });
});

describe("suspension: exactly once per episode", () => {
  function exhaustedReader(): FakeReader {
    const reader = new FakeReader("test");
    reader.subscriptions.set(
      "sub_1",
      subscription({
        status: "past_due",
        metadata: {
          isomux_account: "acct-1",
          isomux_email: "buyer@example.com",
          isomux_instance: "inst-1",
        },
      }),
    );
    reader.invoices.set(
      "in_1",
      invoiceSnap({ nextPaymentAttempt: null, attemptCount: 4 }),
    );
    reader.invoices.set(
      "in_2",
      invoiceSnap({ id: "in_2", nextPaymentAttempt: null, attemptCount: 5 }),
    );
    return reader;
  }

  function failedInvoice(id: string, invoiceId = "in_1"): string {
    return body({
      id,
      type: "invoice.payment_failed",
      object: {
        id: invoiceId,
        parent: { subscription_details: { subscription: "sub_1" } },
      },
    });
  }

  test("one operation for a replayed event, a second exhaustion event, and a replay after failure", async () => {
    const store = await tempStore();
    await seedInstance(store);
    const reader = exhaustedReader();
    const processor = processorFor(store, reader);

    const first = await deliver(processor, failedInvoice("evt_1"));
    expect(first).toMatchObject({ status: 200, kind: "applied" });
    const episodeId = (await getSubscription(store, "sub_1"))?.episode_id;
    expect(episodeId).toBe("dun-evt_1");
    const opId = suspensionOperationId(episodeId!);
    expect(first.suspensionOpId).toBe(opId);
    expect(
      (await store.operationsFor("inst-1")).filter(
        (o) => o.kind === "power_off",
      ),
    ).toHaveLength(1);

    // (a) the SAME event again
    expect((await deliver(processor, failedInvoice("evt_1"))).kind).toBe(
      "duplicate",
    );
    // (b) a DISTINCT exhaustion event for the same episode
    expect(
      (await deliver(processor, failedInvoice("evt_2", "in_2"))).kind,
    ).toBe("applied");
    expect(
      (await store.operationsFor("inst-1")).filter(
        (o) => o.kind === "power_off",
      ),
    ).toHaveLength(1);

    // (c) the operation reaches a TERMINAL state - where slice 2's one-active
    // index stops holding - and a further exhaustion event still adds nothing.
    const op = (await store.getOperation(opId))!;
    const leased = await store.tryLease(
      op.id,
      op.version,
      "holder-1",
      NOW + 1000,
      NOW,
    );
    await store.casOperation(
      { id: op.id, version: leased!.version, holder: "holder-1" },
      { status: "failed", lease_until: null, lease_holder: null },
    );
    expect((await store.getOperation(opId))?.status).toBe("failed");
    expect(
      (await deliver(processor, failedInvoice("evt_3", "in_2"))).kind,
    ).toBe("applied");
    const powerOffs = (await store.operationsFor("inst-1")).filter(
      (o) => o.kind === "power_off",
    );
    expect(powerOffs).toHaveLength(1);
    expect(powerOffs[0].id).toBe(opId);
  });

  test("a second exhaustion event for an episode whose STATE regressed still adds nothing", async () => {
    // The state guard is not the durable one: if a `suspension_requested` write is
    // lost or rolled back, the episode is back to `open` and a further exhaustion
    // event asks again. What holds then is that the operation id is derived from the
    // EPISODE, so the operations primary key refuses the second insert.
    const store = await tempStore();
    await seedInstance(store);
    const reader = exhaustedReader();
    const processor = processorFor(store, reader);

    await deliver(processor, failedInvoice("evt_1"));
    const opId = suspensionOperationId("dun-evt_1");
    expect(await store.getOperation(opId)).not.toBeNull();

    // The episode state regresses; its identity and its evidence do not.
    await store.tx(
      async () =>
        await store.sqlRun(
          "update subscriptions set episode_state = 'open', version = version + 1 where id = $1",
          ["sub_1"],
        ),
    );
    expect(await getSubscription(store, "sub_1")).toMatchObject({
      episode_state: "open",
      episode_id: "dun-evt_1",
    });

    const second = await deliver(processor, failedInvoice("evt_2", "in_2"));
    expect(second.kind).toBe("applied");
    // The SAME operation id, and still exactly one operation.
    expect(second.suspensionOpId).toBe(opId);
    const powerOffs = (await store.operationsFor("inst-1")).filter(
      (o) => o.kind === "power_off",
    );
    expect(powerOffs).toHaveLength(1);
    expect(powerOffs[0].id).toBe(opId);
  });

  test("a genuine later episode, after recovery, may suspend again", async () => {
    const store = await tempStore();
    await seedInstance(store);
    const reader = exhaustedReader();
    const processor = processorFor(store, reader);

    await deliver(processor, failedInvoice("evt_1"));
    const firstOp = suspensionOperationId("dun-evt_1");
    expect(await store.getOperation(firstOp)).not.toBeNull();

    // Paid up: the episode closes. That is the ONLY thing that resets it.
    reader.subscriptions.set(
      "sub_1",
      subscription({
        status: "active",
        metadata: {
          isomux_account: "acct-1",
          isomux_email: "buyer@example.com",
          isomux_instance: "inst-1",
        },
      }),
    );
    await deliver(
      processor,
      body({
        id: "evt_ok",
        type: "customer.subscription.updated",
        object: { id: "sub_1" },
      }),
    );
    expect(await getSubscription(store, "sub_1")).toMatchObject({
      episode_state: "none",
      episode_id: null,
      payment_failures: 0,
      exhaustion_observed_at: null,
    });
    // The first operation must be terminal, or the one-active index would refuse
    // the second one for the wrong reason.
    const op = (await store.getOperation(firstOp))!;
    const leased = await store.tryLease(
      op.id,
      op.version,
      "h",
      NOW + 1000,
      NOW,
    );
    await store.casOperation(
      { id: op.id, version: leased!.version, holder: "h" },
      { status: "succeeded", lease_until: null, lease_holder: null },
    );

    // Months later, a real second failure sequence.
    reader.subscriptions.set(
      "sub_1",
      subscription({
        status: "past_due",
        metadata: {
          isomux_account: "acct-1",
          isomux_email: "buyer@example.com",
          isomux_instance: "inst-1",
        },
      }),
    );
    const again = await deliver(processor, failedInvoice("evt_later", "in_2"));
    expect(again.suspensionOpId).toBe(suspensionOperationId("dun-evt_later"));
    expect(
      (await store.operationsFor("inst-1")).filter(
        (o) => o.kind === "power_off",
      ),
    ).toHaveLength(2);
  });

  test("with no instance linked, the suspension is recorded rather than enqueued", async () => {
    const store = await tempStore();
    const reader = new FakeReader("test");
    reader.subscriptions.set("sub_1", subscription({ status: "past_due" }));
    reader.invoices.set("in_1", invoiceSnap({ nextPaymentAttempt: null }));
    const outcome = await deliver(
      processorFor(store, reader),
      body({
        id: "evt_1",
        type: "invoice.payment_failed",
        object: {
          id: "in_1",
          parent: { subscription_details: { subscription: "sub_1" } },
        },
      }),
    );
    expect(outcome.kind).toBe("applied");
    expect(outcome.suspensionOpId).toBeNull();
    expect((await getSubscription(store, "sub_1"))?.episode_state).toBe(
      "suspension_requested",
    );
    const audit = (await store.auditEvents()).map(
      (e) => `${e.action}:${e.outcome}`,
    );
    expect(audit).toContain("suspension_requested:failed");
  });
});

describe("attention", () => {
  test("a coupon lapse raises it on the linked instance, and recovery clears it", async () => {
    const store = await tempStore();
    await seedInstance(store);
    const meta = {
      isomux_account: "acct-1",
      isomux_email: "buyer@example.com",
      isomux_instance: "inst-1",
    };
    const reader = new FakeReader("test");
    reader.subscriptions.set(
      "sub_1",
      subscription({
        status: "past_due",
        discount: null,
        metadata: meta,
      }),
    );
    reader.invoices.set("in_1", invoiceSnap());
    const processor = processorFor(store, reader);

    // First, make it a formerly-comped subscription: a 100%-off discount observed.
    reader.subscriptions.set(
      "sub_1",
      subscription({
        status: "active",
        discount: {
          couponId: "co_full",
          percentOff: 100,
          endsAt: NOW + 86_400_000,
        },
        metadata: meta,
      }),
    );
    await deliver(
      processor,
      body({
        id: "evt_comped",
        type: "customer.subscription.updated",
        object: { id: "sub_1" },
      }),
    );
    expect((await getSubscription(store, "sub_1"))?.ever_full_discount).toBe(1);

    // The coupon lapses and the invoice fails.
    reader.subscriptions.set(
      "sub_1",
      subscription({ status: "past_due", discount: null, metadata: meta }),
    );
    await deliver(
      processor,
      body({
        id: "evt_lapse",
        type: "invoice.payment_failed",
        object: {
          id: "in_1",
          parent: { subscription_details: { subscription: "sub_1" } },
        },
      }),
    );
    const row = (await getSubscription(store, "sub_1"))!;
    expect(row.episode_state).toBe("coupon_hold");
    expect(row.coupon_grace_until).toBe(NOW + 14 * 24 * 60 * 60 * 1000);
    const open = await store.openReasons("inst-1");
    expect(open).toHaveLength(1);
    expect(open[0].reason).toContain("100%-off coupon has lapsed");
    expect((await store.getInstance("inst-1"))?.attention_state).toBe(
      "needs_operator",
    );

    // Paid up: the condition goes away.
    reader.subscriptions.set(
      "sub_1",
      subscription({ status: "active", discount: null, metadata: meta }),
    );
    await deliver(
      processor,
      body({
        id: "evt_paid",
        type: "customer.subscription.updated",
        object: { id: "sub_1" },
      }),
    );
    expect(await store.openReasons("inst-1")).toEqual([]);
    expect((await store.getInstance("inst-1"))?.attention_state).toBe("clear");
  });
});
