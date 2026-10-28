// Changing an account's address, and removing its Google sign-in (task
// 887bfb07): the move from a Google sign-in to an email sign-in at another
// address, end to end through the store.
//
// The properties here are identity properties. A change that lands on the
// wrong row, or lets two accounts share one inbox, hands an account to whoever
// reads that inbox; a Google removal that leaves the subject bound keeps a way
// in the customer asked to close. Each change that applies moves the account's
// session epoch on by one, which ends every session issued before it
// (web/auth.ts; task 4fe8a83c).

import { afterEach, describe, expect, test } from "bun:test";
import {
  accountForEmailSignIn,
  bindGoogleSubject,
  changeAccountEmail,
  emailChangeRefusal,
  GoogleSignInRemoved,
  removeGoogleSignIn,
  sessionEpoch,
  stripeCustomersForAccount,
  SubjectBindingConflict,
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
// The server secret a removed Google sign-in is marked with.
const SUBJECT_KEY = "test-subject-key-account-email";

/** A verified Google sign-in, under SUBJECT_KEY unless a key is named. */
async function signInWithGoogle(
  store: Store,
  subject: string,
  email: string,
  subjectKey = SUBJECT_KEY,
) {
  return bindGoogleSubject(store, {
    subjectKey,
    subject,
    email,
    emailVerified: true,
  });
}

async function googleAccount(store: Store) {
  return signInWithGoogle(store, SUBJECT, GMAIL);
}

async function accountCount(store: Store): Promise<number> {
  const row = await store.sqlGet<{ n: string }>(
    "select count(*) as n from accounts",
  );
  return Number(row?.n);
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
    // A sign-in, binding included, ends no session.
    expect(await sessionEpoch(store, account.id)).toBe(0);

    const changed = await changeAccountEmail(store, {
      accountId: account.id,
      newEmail: "Work@Example.com",
    });
    expect(changed).toEqual({ ok: true, oldEmail: GMAIL, changed: true });
    expect(await sessionEpoch(store, account.id)).toBe(1);
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
      subjectKey: SUBJECT_KEY,
      subject: SUBJECT,
      email: GMAIL,
      emailVerified: true,
    });
    expect(viaGoogle.id).toBe(account.id);
    expect(await sessionEpoch(store, account.id)).toBe(1);

    expect(await removeGoogleSignIn(store, account.id, SUBJECT_KEY)).toBe(true);
    const removed = await getAccount(store, account.id);
    expect(removed?.google_subject).toBeNull();
    expect(removed?.session_epoch).toBe(2);
    expect(await sessionEpoch(store, account.id)).toBe(2);
    // Nothing left to remove, and nothing ends.
    expect(await removeGoogleSignIn(store, account.id, SUBJECT_KEY)).toBe(
      false,
    );
    expect(await sessionEpoch(store, account.id)).toBe(2);

    // The old Google account no longer reaches it, and does not make a new,
    // empty account either (task f41fae71).
    const accounts = await accountCount(store);
    const refusal = await signInWithGoogle(store, SUBJECT, GMAIL).catch(
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(GoogleSignInRemoved);
    expect(await accountCount(store)).toBe(accounts);
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
      subjectKey: SUBJECT_KEY,
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
    expect(await sessionEpoch(store, account.id)).toBe(0);
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
    expect(await sessionEpoch(store, account.id)).toBe(0);
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
    expect(await removeGoogleSignIn(store, "acct-missing", SUBJECT_KEY)).toBe(
      false,
    );
    // No account is no epoch: web/auth.ts reads that as no session.
    expect(await sessionEpoch(store, "acct-missing")).toBeNull();
  });

  test("an account made at the same address while the change is in flight wins, and the change answers taken", async () => {
    const store = await openTestStore();
    const account = await googleAccount(store);

    // An email sign-in creating the account at that address, not yet
    // committed: the change's own read cannot see it, so only the unique index
    // can refuse the second account at one inbox.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: (pid: number) => void;
    const insertedSignal = new Promise<number>((r) => (inserted = r));
    const holder = store.tx(async () => {
      await ensureAccount(store, {
        id: "acct-racer",
        email: "racer@example.com",
      });
      const self = await store.sqlGet<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      inserted(self!.pid);
      await gate;
    });
    const holderPid = await insertedSignal;

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
        // Blocked by THIS holder: the database is shared with other test
        // files, and their lock waits must not count.
        const row = await store.sqlGet<{ n: string }>(
          "select count(*)::text as n from pg_stat_activity " +
            "where $1 = any(pg_blocking_pids(pid))",
          [holderPid],
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
    // The change rolled back to its savepoint: the epoch did not move either.
    expect(await sessionEpoch(store, account.id)).toBe(0);
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

// After a removal, a Google sign-in for the removed Google account that would
// make a new account is refused (task f41fae71): it used to make an empty
// account at the old address, which then looked like the customer's account
// with its offices gone. An address bind still works: that is how a customer
// adds Google back, and how whoever holds the old inbox signs in.
describe("a removed Google account", () => {
  async function removedAfterMove(store: Store) {
    const account = await googleAccount(store);
    await changeAccountEmail(store, {
      accountId: account.id,
      newEmail: "work@example.com",
    });
    expect(await removeGoogleSignIn(store, account.id, SUBJECT_KEY)).toBe(true);
    return account;
  }

  async function markOf(store: Store, accountId: string) {
    const row = await store.sqlGet<{
      google_subject: string | null;
      removed_google_subject_hash: string | null;
    }>(
      "select google_subject, removed_google_subject_hash from accounts where id = $1",
      [accountId],
    );
    return row;
  }

  test("the refusal names no address, and the account keeps a keyed mark, not the Google id", async () => {
    const store = await openTestStore();
    const account = await removedAfterMove(store);

    const mark = (await markOf(store, account.id))?.removed_google_subject_hash;
    expect(mark).toBeString();
    expect(mark).not.toContain(SUBJECT);

    const accounts = await accountCount(store);
    const refusal = await signInWithGoogle(store, SUBJECT, GMAIL).catch(
      (err: unknown) => err,
    );
    // A SubjectBindingConflict is what identityForSignIn turns into a refused
    // sign-in rather than a server error.
    expect(refusal).toBeInstanceOf(GoogleSignInRemoved);
    expect(refusal).toBeInstanceOf(SubjectBindingConflict);
    const message = (refusal as Error).message.toLowerCase();
    expect(message).not.toContain(GMAIL.toLowerCase());
    expect(message).not.toContain("work@example.com");
    expect(await accountCount(store)).toBe(accounts);

    // The mark is keyed by the server secret: under another secret it is not
    // recognised, so a plain digest of the Google id would not pass here.
    const otherKey = await signInWithGoogle(store, SUBJECT, GMAIL, "other-key");
    expect(otherKey.id).not.toBe(account.id);
    expect(await accountCount(store)).toBe(accounts + 1);
  });

  test("an address bind puts Google back on the account and clears its mark", async () => {
    const store = await openTestStore();
    const account = await googleAccount(store);
    expect(await removeGoogleSignIn(store, account.id, SUBJECT_KEY)).toBe(true);
    // The enabling condition: the removal left a mark.
    expect(
      (await markOf(store, account.id))?.removed_google_subject_hash,
    ).toBeString();

    const back = await signInWithGoogle(store, SUBJECT, GMAIL);
    expect(back.id).toBe(account.id);
    expect(await markOf(store, account.id)).toEqual({
      google_subject: SUBJECT,
      removed_google_subject_hash: null,
    });
  });

  test("a different Google account binding by address leaves the mark, and the removed one stays refused", async () => {
    const store = await openTestStore();
    const account = await removedAfterMove(store);
    const mark = (await markOf(store, account.id))?.removed_google_subject_hash;
    expect(mark).toBeString();

    const other = await signInWithGoogle(
      store,
      "google-sub-work",
      "work@example.com",
    );
    expect(other.id).toBe(account.id);
    expect(await markOf(store, account.id)).toEqual({
      google_subject: "google-sub-work",
      removed_google_subject_hash: mark!,
    });

    const accounts = await accountCount(store);
    expect(
      await signInWithGoogle(store, SUBJECT, GMAIL).catch(
        (err: unknown) => err,
      ),
    ).toBeInstanceOf(GoogleSignInRemoved);
    expect(await accountCount(store)).toBe(accounts);
  });

  test("an account made at the old address takes the removed Google account by address, and keeps it", async () => {
    const store = await openTestStore();
    const account = await removedAfterMove(store);
    // Whoever reads the old inbox signs in by email link: a new account.
    const holder = await accountForEmailSignIn(store, GMAIL);
    expect(holder.id).not.toBe(account.id);

    // Only a sign-in that would MAKE an account is refused.
    expect((await signInWithGoogle(store, SUBJECT, GMAIL)).id).toBe(holder.id);
    // Now bound, the subject reaches that account whatever the mark says.
    expect((await signInWithGoogle(store, SUBJECT, GMAIL)).id).toBe(holder.id);
  });
});
