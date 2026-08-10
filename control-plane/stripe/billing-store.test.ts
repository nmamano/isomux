// The billing rows: CAS discipline, the event-id primary key, the transaction
// requirement, and the refusal to open a database written before this slice.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { Store } from "../store.ts";
import {
  accountByEmail,
  casAccount,
  casEpisodeBookkeeping,
  casStripeOwnedSubscription,
  claimEvent,
  ensureAccount,
  eventSeen,
  getSubscription,
  holdsExpiredAt,
  insertSubscription,
  listEvents,
  type SubscriptionRow,
} from "./billing-store.ts";

const temps: string[] = [];

function tempStore(now?: () => number): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-billing-"));
  temps.push(dir);
  return new Store(path.join(dir, "cp.db"), now);
}

function seedSubscription(
  store: Store,
  over: Partial<SubscriptionRow> = {},
): SubscriptionRow {
  return store.tx(() => {
    const account = ensureAccount(store, {
      id: "acct-1",
      email: "a@example.com",
    });
    return insertSubscription(store, {
      id: over.id ?? "sub_1",
      account_id: account.id,
      instance_id: over.instance_id ?? null,
      stripe_customer_id: "cus_1",
      status: over.status ?? "active",
      current_period_end: null,
      cancel_at_period_end: 0,
      ended_at: over.ended_at ?? null,
      canceled_at: null,
      cancellation_reason: over.cancellation_reason ?? null,
      discount_percent_off: over.discount_percent_off ?? null,
      discount_coupon_id: null,
      discount_ends_at: null,
      ever_full_discount: over.ever_full_discount ?? 0,
      latest_invoice_id: null,
      payment_failures: over.payment_failures ?? 0,
      exhaustion_observed_at: over.exhaustion_observed_at ?? null,
      coupon_grace_until: over.coupon_grace_until ?? null,
      episode_id: over.episode_id ?? null,
      episode_state: over.episode_state ?? "none",
      last_event_id: null,
      last_event_created: null,
    });
  });
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the transaction requirement", () => {
  test("every mutator refuses to run outside one", () => {
    // A billing write is half of a transition - the other half is an audit row,
    // an attention row or an operation - so there is no arm that persists one
    // without the other.
    const store = tempStore();
    expect(() =>
      ensureAccount(store, { id: "acct-1", email: "a@example.com" }),
    ).toThrow(/transaction/);
    seedSubscription(store);
    expect(() =>
      casStripeOwnedSubscription(store, "sub_1", 1, { status: "past_due" }),
    ).toThrow(/transaction/);
    expect(() =>
      casEpisodeBookkeeping(store, "sub_1", 1, { payment_failures: 1 }),
    ).toThrow(/transaction/);
    expect(() =>
      claimEvent(store, {
        id: "evt_1",
        type: "x",
        created: 1,
        subscription_id: null,
        outcome: "applied",
        detail: null,
      }),
    ).toThrow(/transaction/);
  });
});

describe("accounts", () => {
  test("are created once per email, whatever id is offered", () => {
    const store = tempStore();
    const first = store.tx(() =>
      ensureAccount(store, { id: "acct-1", email: "a@example.com" }),
    );
    const second = store.tx(() =>
      ensureAccount(store, { id: "acct-2", email: "a@example.com" }),
    );
    expect(second.id).toBe(first.id);
    expect(accountByEmail(store, "a@example.com")?.id).toBe("acct-1");
  });

  test("take a Stripe customer id by CAS, and a stale version loses", () => {
    const store = tempStore();
    const account = store.tx(() =>
      ensureAccount(store, { id: "acct-1", email: "a@example.com" }),
    );
    const won = store.tx(() =>
      casAccount(store, account.id, account.version, {
        stripe_customer_id: "cus_1",
      }),
    );
    expect(won?.stripe_customer_id).toBe("cus_1");
    const lost = store.tx(() =>
      casAccount(store, account.id, account.version, {
        stripe_customer_id: "cus_2",
      }),
    );
    expect(lost).toBeNull();
  });
});

describe("the two setters", () => {
  test("each writes its own columns and bumps the version", () => {
    const store = tempStore();
    const sub = seedSubscription(store);
    const afterOwned = store.tx(() =>
      casStripeOwnedSubscription(store, sub.id, sub.version, {
        status: "past_due",
        ever_full_discount: 1,
      }),
    );
    expect(afterOwned).toMatchObject({
      status: "past_due",
      ever_full_discount: 1,
      version: sub.version + 1,
    });
    const afterEpisode = store.tx(() =>
      casEpisodeBookkeeping(store, sub.id, afterOwned!.version, {
        episode_state: "open",
        episode_id: "dun-evt_1",
        payment_failures: 1,
      }),
    );
    expect(afterEpisode).toMatchObject({
      episode_state: "open",
      episode_id: "dun-evt_1",
      payment_failures: 1,
      // The Stripe-owned columns are untouched by the episode setter.
      status: "past_due",
    });
  });

  test("a stale version loses and changes nothing", () => {
    const store = tempStore();
    const sub = seedSubscription(store);
    store.tx(() =>
      casStripeOwnedSubscription(store, sub.id, sub.version, {
        status: "past_due",
      }),
    );
    const loser = store.tx(() =>
      casStripeOwnedSubscription(store, sub.id, sub.version, {
        status: "canceled",
      }),
    );
    expect(loser).toBeNull();
    expect(getSubscription(store, sub.id)?.status).toBe("past_due");
  });

  test("an unknown episode state is refused by the schema, not by a caller", () => {
    const store = tempStore();
    const sub = seedSubscription(store);
    expect(() =>
      store.tx(() =>
        casEpisodeBookkeeping(store, sub.id, sub.version, {
          // @ts-expect-error - the type forbids it; the database must too.
          episode_state: "whatever",
        }),
      ),
    ).toThrow();
  });
});

describe("the event ledger", () => {
  test("an event id can be claimed once, and the second insert is refused", () => {
    const store = tempStore();
    const row = {
      id: "evt_1",
      type: "customer.subscription.updated",
      created: 1_770_000_000_000,
      subscription_id: "sub_1",
      outcome: "applied",
      detail: null,
    };
    store.tx(() => claimEvent(store, row));
    expect(eventSeen(store, "evt_1")).toMatchObject({ outcome: "applied" });
    // The PRIMARY KEY is the dedupe. Not a check in front of it.
    expect(() => store.tx(() => claimEvent(store, row))).toThrow();
    expect(listEvents(store)).toHaveLength(1);
  });

  test("a claim rolls back with the transaction that made it", () => {
    // This is what makes a crash mid-apply replayable: the id is only claimed if
    // the effect committed.
    const store = tempStore();
    expect(() =>
      store.tx(() => {
        claimEvent(store, {
          id: "evt_2",
          type: "invoice.payment_failed",
          created: 1,
          subscription_id: null,
          outcome: "applied",
          detail: null,
        });
        throw new Error("the apply failed after the claim");
      }),
    ).toThrow(/apply failed/);
    expect(eventSeen(store, "evt_2")).toBeNull();
  });
});

describe("the coupon-hold query", () => {
  test("returns only holds whose deadline has passed", () => {
    const store = tempStore();
    seedSubscription(store, {
      id: "sub_expired",
      episode_state: "coupon_hold",
      coupon_grace_until: 1_000,
    });
    seedSubscription(store, {
      id: "sub_waiting",
      episode_state: "coupon_hold",
      coupon_grace_until: 9_000,
    });
    seedSubscription(store, { id: "sub_open", episode_state: "open" });
    expect(holdsExpiredAt(store, 5_000).map((s) => s.id)).toEqual([
      "sub_expired",
    ]);
  });
});

describe("opening an older database", () => {
  // `create table if not exists` says nothing about a table that exists with the
  // WRONG columns, so the failure has to be at open time. Each GUARDED column is
  // checked on its own: a table missing only that one must still be refused, or the
  // guard would be carried by whichever column happened to be listed first.
  const GUARDED: [string, string, string][] = [
    [
      "accounts",
      "stripe_customer_id",
      "id text primary key, email text not null",
    ],
    [
      "subscriptions",
      "episode_state",
      "id text primary key, exhaustion_observed_at integer",
    ],
    [
      "subscriptions",
      "exhaustion_observed_at",
      "id text primary key, episode_state text",
    ],
    ["stripe_events", "type", "id text primary key, created integer"],
  ];

  for (const [table, missing, columns] of GUARDED) {
    test(`${table} without ${missing} is refused by name`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-billing-old-"));
      temps.push(dir);
      const file = path.join(dir, "cp.db");
      const db = new Database(file, { create: true });
      db.run(`create table ${table} (${columns})`);
      db.close();
      expect(() => new Store(file)).toThrow(
        new RegExp(`${table} has no ${missing}`),
      );
    });
  }
});
