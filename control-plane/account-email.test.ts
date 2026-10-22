// Changing an account's address, and removing its Google sign-in (task
// 887bfb07): the move from a Google sign-in to an email sign-in at another
// address, end to end through the store.
//
// The properties here are identity properties. A change that lands on the
// wrong row, or lets two accounts share one inbox, hands an account to whoever
// reads that inbox; a Google removal that leaves the subject bound keeps a way
// in the customer asked to close.

import { afterEach, describe, expect, test } from "bun:test";
import {
  accountForEmailSignIn,
  bindGoogleSubject,
  changeAccountEmail,
  emailChangeRefusal,
  removeGoogleSignIn,
  stripeCustomersForAccount,
} from "./signup.ts";
import {
  ensureAccount,
  getAccount,
  insertSubscription,
} from "./stripe/billing-store.ts";
import type { Store } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

const GMAIL = "Customer.Name@Gmail.com";
const SUBJECT = "google-sub-customer";

async function googleAccount(store: Store) {
  return bindGoogleSubject(store, {
    subject: SUBJECT,
    email: GMAIL,
    emailVerified: true,
  });
}

interface AuditLine {
  actor: string;
  instance_id: string | null;
  action: string;
  target: string;
  outcome: string;
  detail: string | null;
}

async function auditFor(store: Store, accountId: string): Promise<AuditLine[]> {
  return store.sqlAll<AuditLine>(
    "select actor, instance_id, action, target, outcome, detail " +
      "from audit_events where target = $1 or actor = $1 order by seq",
    [`account:${accountId}`],
  );
}

describe("moving a Google-made account to an email sign-in", () => {
  test("after the change an email link to the new address reaches it, and after the removal the old Google account does not", async () => {
    const store = await openTestStore();
    const account = await googleAccount(store);

    const changed = await changeAccountEmail(store, {
      accountId: account.id,
      newEmail: "Work@Example.com",
    });
    expect(changed).toEqual({ ok: true, oldEmail: GMAIL, changed: true });
    // Stored lowercased: the exact-string unique index is what refuses a
    // second account at this inbox, and an email sign-in writes lowercase.
    expect((await getAccount(store, account.id))?.email).toBe(
      "work@example.com",
    );

    // The email link reaches this account, not a new one.
    expect((await accountForEmailSignIn(store, "work@example.com")).id).toBe(
      account.id,
    );
    // The Google sign-in still works through its bound subject.
    const viaGoogle = await bindGoogleSubject(store, {
      subject: SUBJECT,
      email: GMAIL,
      emailVerified: true,
    });
    expect(viaGoogle.id).toBe(account.id);

    expect(await removeGoogleSignIn(store, account.id)).toBe(true);
    expect((await getAccount(store, account.id))?.google_subject).toBeNull();
    // Nothing left to remove.
    expect(await removeGoogleSignIn(store, account.id)).toBe(false);

    // The old Google account now lands somewhere else.
    const afterRemoval = await bindGoogleSubject(store, {
      subject: SUBJECT,
      email: GMAIL,
      emailVerified: true,
    });
    expect(afterRemoval.id).not.toBe(account.id);
    // And email stays the way in.
    expect((await accountForEmailSignIn(store, "work@example.com")).id).toBe(
      account.id,
    );

    // One row per change, by and about the account, and no address anywhere
    // in it (the ops.ts audit rule).
    const audit = await auditFor(store, account.id);
    expect(audit).toEqual([
      {
        actor: `account:${account.id}`,
        instance_id: null,
        action: "account.email_changed",
        target: `account:${account.id}`,
        outcome: "succeeded",
        detail: null,
      },
      {
        actor: `account:${account.id}`,
        instance_id: null,
        action: "account.google_removed",
        target: `account:${account.id}`,
        outcome: "succeeded",
        detail: null,
      },
    ]);
    const dump = JSON.stringify(
      await store.sqlAll("select * from audit_events"),
    ).toLowerCase();
    expect(dump).not.toContain("work@example.com");
    expect(dump).not.toContain(GMAIL.toLowerCase());
  });
});

describe("an address that cannot become the account's", () => {
  test("another account's address is taken whatever its case, and the account keeps its own", async () => {
    const store = await openTestStore();
    const account = await googleAccount(store);
    // Google keeps the case the other customer typed.
    await bindGoogleSubject(store, {
      subject: "google-sub-other",
      email: "Taken@Example.com",
      emailVerified: true,
    });

    expect(
      await emailChangeRefusal(store, account.id, "taken@example.com"),
    ).toBe("taken");
    expect(
      await changeAccountEmail(store, {
        accountId: account.id,
        newEmail: "taken@example.com",
      }),
    ).toEqual({ ok: false, code: "taken" });
    expect((await getAccount(store, account.id))?.email).toBe(GMAIL);
    expect(await auditFor(store, account.id)).toEqual([]);

    // The negative control: a free address is not refused.
    expect(
      await emailChangeRefusal(store, account.id, "free@example.com"),
    ).toBeNull();
  });

  test("the account's own address in any case is unchanged: a success that writes nothing", async () => {
    const store = await openTestStore();
    const account = await googleAccount(store);
    const same = GMAIL.toLowerCase();
    expect(await emailChangeRefusal(store, account.id, same)).toBe("unchanged");
    expect(
      await changeAccountEmail(store, {
        accountId: account.id,
        newEmail: same,
      }),
    ).toEqual({ ok: true, oldEmail: GMAIL, changed: false });
    expect((await getAccount(store, account.id))?.version).toBe(
      account.version,
    );
    expect(await auditFor(store, account.id)).toEqual([]);
  });

  test("an account that does not exist", async () => {
    const store = await openTestStore();
    expect(
      await emailChangeRefusal(store, "acct-missing", "a@example.com"),
    ).toBe("no-account");
    expect(
      await changeAccountEmail(store, {
        accountId: "acct-missing",
        newEmail: "a@example.com",
      }),
    ).toEqual({ ok: false, code: "no-account" });
    expect(await removeGoogleSignIn(store, "acct-missing")).toBe(false);
  });

  test("an account made at the same address while the change is in flight wins, and the change answers taken", async () => {
    const store = await openTestStore();
    const account = await googleAccount(store);

    // An email sign-in creating the account at that address, not yet
    // committed: the change's own read cannot see it, so only the unique index
    // can refuse the second account at one inbox.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((r) => (inserted = r));
    const holder = store.tx(async () => {
      await ensureAccount(store, {
        id: "acct-racer",
        email: "racer@example.com",
      });
      inserted();
      await gate;
    });
    await insertedSignal;

    // Mixed case on purpose: only a lowercased write meets the index. Settled
    // into a value at once, so that a failure cannot surface while the other
    // transaction is still held open.
    const changing = changeAccountEmail(store, {
      accountId: account.id,
      newEmail: "Racer@Example.com",
    }).then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error: String(error) }),
    );
    let waited = false;
    try {
      for (let i = 0; i < 60 && !waited; i++) {
        const row = await store.sqlGet<{ n: string }>(
          "select count(*)::text as n from pg_stat_activity " +
            "where datname = current_database() and wait_event_type = 'Lock' " +
            "and query ilike '%accounts%'",
        );
        waited = row?.n !== "0";
        if (!waited) await Bun.sleep(50);
      }
    } finally {
      release();
      await holder;
    }

    expect(await changing).toEqual({ outcome: { ok: false, code: "taken" } });
    // The condition this test exists for: the change reached the index while
    // the other row was uncommitted, rather than reading it afterwards.
    expect(waited).toBe(true);
    expect((await getAccount(store, account.id))?.email).toBe(GMAIL);
    const holders = await store.sqlAll<{ id: string }>(
      "select id from accounts where lower(email) = 'racer@example.com'",
    );
    expect(holders.map((h) => h.id)).toEqual(["acct-racer"]);
  });
});

describe("the Stripe customers an address change follows", () => {
  test("each customer once: every office's subscription and the account's own, never another account's", async () => {
    const store = await openTestStore();
    const account = await googleAccount(store);
    const other = await store.tx(() =>
      ensureAccount(store, { id: "acct-other", email: "other@example.com" }),
    );
    await store.sqlRun(
      "update accounts set stripe_customer_id = 'cus_own' where id = $1",
      [account.id],
    );
    const rows: [string, string, string][] = [
      ["sub_a", account.id, "cus_office_a"],
      ["sub_b", account.id, "cus_office_b"],
      // A second subscription of one customer (a reinstated office).
      ["sub_a2", account.id, "cus_office_a"],
      ["sub_x", other.id, "cus_other"],
    ];
    for (const [id, accountId, customer] of rows) {
      await store.tx(() =>
        insertSubscription(store, {
          id,
          account_id: accountId,
          instance_id: null,
          stripe_customer_id: customer,
          status: "active",
          current_period_end: null,
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
    }
    const customers = await stripeCustomersForAccount(store, account.id);
    expect([...customers].sort()).toEqual([
      "cus_office_a",
      "cus_office_b",
      "cus_own",
    ]);
    expect(customers).toHaveLength(3);
  });
});
