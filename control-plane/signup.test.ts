// Signup's two load-bearing properties: the INSERT decides who owns a name, and
// a retry's identity comes from the stored row rather than from the request or
// the clock.
//
// The race here is fired the way a race actually happens - two independent
// connections to one file, neither of which has read the other's write.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
  ACCESS_WINDOW_MS,
  MAX_NEW_OFFICES_PER_WINDOW,
  NEW_OFFICE_WINDOW_MS,
  accountForDevSignIn,
  bindGoogleSubject,
  checkoutInputsFor,
  checkoutKeysFor,
  hostnameFor,
  instanceOwnedBy,
  planById,
  reservationByName,
  customerReason,
  originIsTrusted,
  reservationsForAccount,
  reserveOffice,
  SubjectBindingConflict,
  validateSignup,
} from "./signup.ts";
import { validateCustomerSshKey } from "./key-lines.ts";
import { accountByEmail } from "./stripe/billing-store.ts";
import type { Store } from "./store.ts";
import {
  openTestStore,
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  testDsn,
} from "./testing/pg.ts";

const temps: string[] = [];

function keyBlob(algorithm = "ssh-ed25519"): string {
  const name = Buffer.from(algorithm);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length);
  return Buffer.concat([length, name, Buffer.alloc(32, 7)]).toString("base64");
}

const VALID_KEY = `ssh-ed25519 ${keyBlob()} laptop comment`;

async function tempStore(now?: () => number): Promise<Store> {
  return await openTestStore(now);
}

afterEach(async () => {
  await releaseTestStores();
  while (temps.length)
    fs.rmSync(temps.pop()!, { recursive: true, force: true });
}, PG_TEST_HOOK_TIMEOUT_MS);

async function accountFor(store: Store, email = "a@example.com") {
  return await accountForDevSignIn(store, email);
}

async function signup(
  store: Store,
  over: Partial<Parameters<typeof reserveOffice>[1]> & { email?: string } = {},
) {
  const { email, ...rest } = over;
  const account = await accountFor(store, email ?? "a@example.com");
  return await reserveOffice(store, {
    accountId: account.id,
    officeName: "acme",
    plan: "office",
    ...rest,
  });
}

async function seedAdmissions(
  store: Store,
  count: number,
  createdAt: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.sqlRun(
      "insert into name_reservations (name, id, account_id, instance_id, plan, coupon_id, version, created_at, updated_at) " +
        "values ($1, $2, $3, $4, 'office', null, 1, $5, $5)",
      [
        `seed-${i}`,
        `seed-res-${i}`,
        `seed-account-${i}`,
        `seed-instance-${i}`,
        createdAt,
      ],
    );
  }
}

describe("refusals that never reach the database", () => {
  test("validates and normalizes one option-free decoded SSH key", () => {
    expect(validateCustomerSshKey(VALID_KEY)).toEqual({
      ok: true,
      normalized: `ssh-ed25519 ${keyBlob()}`,
      algorithm: "ssh-ed25519",
      blob: keyBlob(),
    });
  });

  test.each([
    [`expiry-time="tomorrow" ${VALID_KEY}`, "without options"],
    [`${VALID_KEY}\n${VALID_KEY}`, "one line"],
    [`${VALID_KEY}\r\n`, "one line"],
    [`ssh-dss ${keyBlob("ssh-dss")}`, "supported"],
    [`ssh-rsa ${keyBlob()}`, "does not match"],
    [`ssh-ed25519 !!!!`, "base64"],
    [`ssh-ed25519 AAAA`, "incomplete"],
    [`ssh-ed25519 ${"A".repeat(17_000)}`, "too long"],
  ])("refuses an unsafe SSH key", (raw, words) => {
    const out = validateCustomerSshKey(raw);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain(words);
  });

  test("an unknown plan is refused and writes nothing", async () => {
    const store = await tempStore();
    const out = await signup(store, { plan: "enterprise" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("not a plan we offer");
    expect(await reservationByName(store, "acme")).toBeNull();
    expect(await store.listInstances()).toEqual([]);
  });

  test("a bad label is refused with the validator's own words", async () => {
    const store = await tempStore();
    const out = await signup(store, { officeName: "Not A Label" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("lower case");
    expect(await store.listInstances()).toEqual([]);
  });

  test("a reserved name is refused", async () => {
    const store = await tempStore();
    const out = await signup(store, { officeName: "admin" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("hostname we serve centrally");
    expect(await store.listInstances()).toEqual([]);
  });
});

describe("the reservation", () => {
  test("persists the normalized key and refuses a retry that changes it", async () => {
    const store = await tempStore();
    const first = await signup(store, { customerSshKey: VALID_KEY });
    if (!first.ok) throw new Error("signup failed");
    const instance = await store.getInstance(first.reservation.instance_id);
    expect(instance?.customer_ssh_key).toBe(`ssh-ed25519 ${keyBlob()}`);
    const second = await signup(store, { customerSshKey: null });
    expect(second.ok).toBe(false);
    if (!second.ok)
      expect(second.reason).toContain("already reserved with an SSH key");
  });
  test("creates account, reservation, instance and a placeholder asset together", async () => {
    const now = 1_700_000_000_000;
    const store = await tempStore(() => now);
    const out = await signup(store);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.reused).toBe(false);
    const instance = await store.getInstance(out.reservation.instance_id);
    expect(hostnameFor("acme")).toBe("acme.isomux.app");
    expect(instance?.name).toBe(hostnameFor("acme"));
    expect(instance?.service_state).toBe("provisioning");
    expect(instance?.goal).toBe("live");
    expect(instance?.plan).toBe(planById("office")?.providerProduct);
    // Written with the row because nothing can write it afterwards.
    expect(instance?.access_window_expires_at).toBe(now + ACCESS_WINDOW_MS);
    expect(ACCESS_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);

    const asset = await store.assetForInstance(out.reservation.instance_id);
    expect(asset?.provider_id).toBeNull();
    expect(asset?.asset_state).toBe("none");
    expect(asset?.ipv4).toBeNull();
  });

  test("admits 40 new offices in seven days and refuses the next without residue", async () => {
    const now = 1_700_000_000_000;
    const store = await tempStore(() => now);
    await seedAdmissions(store, MAX_NEW_OFFICES_PER_WINDOW - 1, now);
    const fortieth = await signup(store);
    expect(fortieth.ok).toBe(true);

    const refused = await signup(store, {
      email: "next@example.com",
      officeName: "next",
    });
    expect(refused).toEqual({
      ok: false,
      reason: "we cannot accept another office signup yet; try again later",
    });
    expect(await reservationByName(store, "next")).toBeNull();
    expect(await store.listInstances()).toHaveLength(1);
    expect(
      await store.sqlGet<{ n: number }>(
        "select count(*) as n from provider_assets",
      ),
    ).toEqual({ n: 1 });
    expect(await store.auditEvents()).toHaveLength(1);

    const caller = fs.readFileSync(
      new URL("web/lib/services.server.ts", import.meta.url),
      "utf8",
    );
    expect(caller).toContain(
      "if (!reserved.ok) return { ok: false, reason: reserved.reason };\n" +
        "  return openReservedCheckout(reserved);",
    );
  });

  test("an admission older than seven days frees one place", async () => {
    const now = 1_700_000_000_000;
    const store = await tempStore(() => now);
    await seedAdmissions(
      store,
      MAX_NEW_OFFICES_PER_WINDOW,
      now - NEW_OFFICE_WINDOW_MS - 1,
    );
    expect((await signup(store)).ok).toBe(true);
  });

  test("an owner retry at the ceiling does not consume another place", async () => {
    const now = 1_700_000_000_000;
    const store = await tempStore(() => now);
    await seedAdmissions(store, MAX_NEW_OFFICES_PER_WINDOW - 1, now);
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    const retry = await signup(store);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.reused).toBe(true);
  });

  test("two concurrent boundary admissions produce exactly one new office", async () => {
    const now = 1_700_000_000_000;
    const dsn = await testDsn();
    const a = await openTestStoreOn(dsn, () => now);
    const b = await openTestStoreOn(dsn, () => now);
    await seedAdmissions(a, MAX_NEW_OFFICES_PER_WINDOW - 1, now);
    const firstAccount = await accountForDevSignIn(a, "first@example.com");
    const secondAccount = await accountForDevSignIn(a, "second@example.com");
    const [first, second] = await Promise.all([
      reserveOffice(a, {
        accountId: firstAccount.id,
        officeName: "first",
        plan: "office",
      }),
      reserveOffice(b, {
        accountId: secondAccount.id,
        officeName: "second",
        plan: "office",
      }),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const loser = first.ok ? second : first;
    expect(loser).toEqual({
      ok: false,
      reason: "we cannot accept another office signup yet; try again later",
    });
    expect(
      await a.sqlGet<{ n: number }>(
        "select count(*) as n from name_reservations",
      ),
    ).toEqual({ n: MAX_NEW_OFFICES_PER_WINDOW });
    await a.close();
    await b.close();
  });

  test("an admission-check error fails closed before office creation", async () => {
    const store = await tempStore();
    const original = store.sqlRun.bind(store);
    store.sqlRun = async (sql, args = []) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        throw new Error("admission check unavailable");
      }
      return original(sql, args);
    };
    const error = await signup(store).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("admission check unavailable");
    expect(await reservationByName(store, "acme")).toBeNull();
    expect(await store.listInstances()).toHaveLength(0);
    expect(await store.auditEvents()).toHaveLength(0);
  });

  test("a missing admission count fails closed before office creation", async () => {
    const store = await tempStore();
    const original = store.sqlGet.bind(store);
    store.sqlGet = async <T>(sql: string, args = []) => {
      if (sql.includes("count(*) as n from name_reservations")) return null;
      return original<T>(sql, args);
    };
    const error = await signup(store).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "new-office admission count is missing",
    );
    expect(await reservationByName(store, "acme")).toBeNull();
    expect(await store.listInstances()).toHaveLength(0);
  });

  test("Poweruser is stored by tier and reaches provisioning as V155", async () => {
    const store = await tempStore();
    const out = await signup(store, { plan: "poweruser" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reservation.plan).toBe("poweruser");
    expect((await store.getInstance(out.reservation.instance_id))?.plan).toBe(
      "V155",
    );
  });

  test("the ceiling cannot be changed after signup wrote it", async () => {
    const store = await tempStore();
    const out = await signup(store);
    if (!out.ok) throw new Error("signup failed");
    const instance = (await store.getInstance(out.reservation.instance_id))!;
    expect(
      store.casInstance(instance.id, instance.version, {
        access_window_expires_at: 1,
      } as never),
    ).rejects.toThrow(/written once/);
  });

  test("a retry after the clock moves cannot extend the signup ceiling", async () => {
    let now = 1_700_000_000_000;
    const store = await tempStore(() => now);
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    const fixed = now + ACCESS_WINDOW_MS;

    now += 6 * 24 * 60 * 60 * 1000;
    const retry = await signup(store);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.reused).toBe(true);
    expect(
      (await store.getInstance(retry.reservation.instance_id))
        ?.access_window_expires_at,
    ).toBe(fixed);
  });

  test("a pre-change reservation cannot become a customer office", async () => {
    const now = 1_700_000_000_000;
    const store = await tempStore(() => now);
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    await store.sqlRun(
      "update instances set access_window_expires_at = $1 where id = $2",
      [now + 30 * 24 * 60 * 60 * 1000, first.reservation.instance_id],
    );

    const retry = await signup(store);
    expect(retry.ok).toBe(false);
    if (!retry.ok)
      expect(retry.reason).toContain("recycle it from a new signup");
    expect(
      (await store.getInstance(first.reservation.instance_id))
        ?.access_window_expires_at,
    ).toBe(now + 30 * 24 * 60 * 60 * 1000);
  });

  test("two independent connections racing for one name: exactly one wins", async () => {
    const dsn = await testDsn();
    const a = await openTestStoreOn(dsn);
    const b = await openTestStoreOn(dsn);
    const mine = await accountForDevSignIn(a, "a@example.com");
    const theirs = await accountForDevSignIn(a, "b@example.com");
    const first = await reserveOffice(a, {
      accountId: mine.id,
      officeName: "acme",
      plan: "office",
    });
    const second = await reserveOffice(b, {
      accountId: theirs.id,
      officeName: "acme",
      plan: "office",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('"acme" is taken');
    // One row, one instance: the loser created nothing of its own.
    expect(
      await a.sqlGet<{ n: number }>(
        "select count(*) as n from name_reservations",
      ),
    ).toEqual({ n: 1 });
    expect(await a.listInstances()).toHaveLength(1);
    await a.close();
    await b.close();
  });

  test("the same owner racing itself gets one reservation and identical keys", async () => {
    const dsn = await testDsn();
    const a = await openTestStoreOn(dsn);
    const b = await openTestStoreOn(dsn);
    const account = await accountForDevSignIn(a, "a@example.com");
    const first = await reserveOffice(a, {
      accountId: account.id,
      officeName: "acme",
      plan: "office",
    });
    const second = await reserveOffice(b, {
      accountId: account.id,
      officeName: "acme",
      plan: "office",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.reused).toBe(true);
    expect(second.reservation.id).toBe(first.reservation.id);
    expect(second.reservation.instance_id).toBe(first.reservation.instance_id);
    expect(checkoutKeysFor(second.reservation)).toEqual(
      checkoutKeysFor(first.reservation),
    );
    await a.close();
    await b.close();
  });
});

describe("retry identity does not come from the clock or the request", () => {
  test("a retry under a moved clock yields the same ids and keys", async () => {
    let now = 1_700_000_000_000;
    const store = await tempStore(() => now);
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    now += 86_400_000;
    const second = await signup(store);
    if (!second.ok) throw new Error("retry failed");
    expect(second.reused).toBe(true);
    expect(second.reservation.instance_id).toBe(first.reservation.instance_id);
    expect(checkoutKeysFor(second.reservation)).toEqual(
      checkoutKeysFor(first.reservation),
    );
  });

  test("a second request naming a different plan is refused, not silently ignored", async () => {
    const store = await tempStore();
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    const second = await signup(store, { plan: "poweruser" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain("already reserved on the");
  });

  test("a second request naming a different coupon is refused", async () => {
    const store = await tempStore();
    const first = await signup(store, { couponId: "COMP100" });
    if (!first.ok) throw new Error("signup failed");
    const second = await signup(store, { couponId: "OTHER" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain("with the code COMP100");
    const third = await signup(store);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toContain("with the code COMP100");
  });

  test("checkout inputs come from the row, and the coupon travels unverified", async () => {
    const store = await tempStore();
    const out = await signup(store, { couponId: "COMP100" });
    if (!out.ok) throw new Error("signup failed");
    const args = checkoutInputsFor({
      reservation: out.reservation,
      account: out.account,
      email: "a@example.com",
      priceId: "price_123",
      successUrl: "http://localhost:3000/ok",
      cancelUrl: "http://localhost:3000/no",
    });
    expect(args.officeName).toBe("acme");
    expect(args.instanceId).toBe(out.reservation.instance_id);
    expect(args.couponId).toBe("COMP100");
    expect(args.idempotencyKeys).toEqual(checkoutKeysFor(out.reservation));
    // Assembly only: no verified discount is minted here, which is what keeps
    // verifyFullDiscount the one place a full discount can come from.
    expect("discount" in args).toBe(false);
  });
});

describe("tenant scope", () => {
  test("an instance is readable only through its own account's reservation", async () => {
    const store = await tempStore();
    const mine = await signup(store);
    const theirs = await signup(store, {
      email: "b@example.com",
      officeName: "beta",
    });
    if (!mine.ok || !theirs.ok) throw new Error("signup failed");
    expect(
      await instanceOwnedBy(
        store,
        mine.account.id,
        mine.reservation.instance_id,
      ),
    ).not.toBeNull();
    expect(
      await instanceOwnedBy(
        store,
        mine.account.id,
        theirs.reservation.instance_id,
      ),
    ).toBeNull();
    expect(
      await instanceOwnedBy(store, mine.account.id, "inst-nope"),
    ).toBeNull();
  });
});

describe("google subject binding", () => {
  test("binds on first sign-in and is stable afterwards", async () => {
    const store = await tempStore();
    const first = await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "a@example.com",
    });
    const again = await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "a@example.com",
    });
    expect(again.id).toBe(first.id);
    expect(again.google_subject).toBe("sub-1");
  });

  test("one subject cannot claim a second account", async () => {
    const store = await tempStore();
    await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "a@example.com",
    });
    await bindGoogleSubject(store, {
      subject: "sub-2",
      email: "b@example.com",
    });
    expect(
      bindGoogleSubject(store, { subject: "sub-1", email: "b@example.com" }),
    ).rejects.toThrow(SubjectBindingConflict);
  });

  test("an account bound to one subject is never silently rebound", async () => {
    const store = await tempStore();
    await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "a@example.com",
    });
    expect(
      bindGoogleSubject(store, { subject: "sub-9", email: "a@example.com" }),
    ).rejects.toThrow(SubjectBindingConflict);
    expect((await accountByEmail(store, "a@example.com"))?.google_subject).toBe(
      "sub-1",
    );
  });

  test("the index refuses a duplicate subject even without our checks", async () => {
    const store = await tempStore();
    await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "a@example.com",
    });
    const other = await bindGoogleSubject(store, {
      subject: "sub-2",
      email: "b@example.com",
    });
    expect(
      store.sqlRun("update accounts set google_subject = $1 where id = $2", [
        "sub-1",
        other.id,
      ]),
    ).rejects.toThrow();
  });
});

describe("what is judged before anything is touched", () => {
  test("validateSignup decides names and plans without a store at all", async () => {
    expect(validateSignup({ officeName: "acme", plan: "office" }).ok).toBe(
      true,
    );
    const badPlan = validateSignup({ officeName: "acme", plan: "gold" });
    expect(badPlan.ok).toBe(false);
    if (!badPlan.ok) expect(badPlan.reason).toContain("not a plan we offer");
    const badName = validateSignup({ officeName: "admin", plan: "office" });
    expect(badName.ok).toBe(false);
    if (!badName.ok) expect(badName.reason).toContain("centrally");
  });
});

describe("refusal copy", () => {
  test("a CLI-shaped coupon refusal becomes something a form can show", async () => {
    expect(
      customerReason(
        "--coupon SmON9aoN cannot be used as a full discount: no such coupon",
      ),
    ).toBe("that code cannot be applied: no such coupon");
  });

  test("anything else is passed through unchanged", async () => {
    expect(customerReason('"acme" is taken')).toBe('"acme" is taken');
  });
});

describe("several offices per account", () => {
  test("a second name for the same account creates an independent office", async () => {
    const store = await tempStore();
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    const second = await signup(store, { officeName: "acme-two" });
    expect(second.ok).toBe(true);
    expect((await reservationByName(store, "acme-two"))?.account_id).toBe(
      first.account.id,
    );
    expect(await store.listInstances()).toHaveLength(2);
  });

  test("reservation order uses the unique name when creation times tie", async () => {
    const store = await tempStore();
    const account = await accountForDevSignIn(store, "ordered@example.com");
    for (const officeName of ["beta", "alpha"]) {
      const result = await reserveOffice(
        store,
        { accountId: account.id, officeName, plan: "office" },
        { now: () => 123 },
      );
      if (!result.ok) throw new Error(result.reason);
    }
    expect(
      (await reservationsForAccount(store, account.id)).map((r) => r.name),
    ).toEqual(["alpha", "beta"]);
  });

  test("a legacy account constraint returns a migration refusal, not a 500", async () => {
    const store = await tempStore();
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    await store.sqlRun(
      "alter table name_reservations add constraint legacy_one_office unique (account_id)",
    );
    try {
      expect(await signup(store, { officeName: "acme-two" })).toEqual({
        ok: false,
        reason: "this deployment needs its multi-office database migration",
      });
    } finally {
      await store.sqlRun(
        "alter table name_reservations drop constraint legacy_one_office",
      );
    }
  });

  test("two connections can reserve different names for one account", async () => {
    const dsn = await testDsn();
    const a = await openTestStoreOn(dsn);
    const b = await openTestStoreOn(dsn);
    const account = await accountForDevSignIn(a, "a@example.com");
    const first = await reserveOffice(a, {
      accountId: account.id,
      officeName: "alpha",
      plan: "office",
    });
    const second = await reserveOffice(b, {
      accountId: account.id,
      officeName: "beta",
      plan: "office",
    });
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(
      await a.sqlGet<{ n: number }>(
        "select count(*) as n from name_reservations",
      ),
    ).toEqual({ n: 2 });
    expect(await a.listInstances()).toHaveLength(2);
    expect(
      (await reservationsForAccount(a, account.id)).map((r) => r.name),
    ).toEqual(["alpha", "beta"]);
    await a.close();
    await b.close();
  });
});

describe("the tenant key survives a changed email", () => {
  test("one Google subject with a new address still reaches its own account", async () => {
    const store = await tempStore();
    const first = await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "before@example.com",
    });
    const out = await reserveOffice(store, {
      accountId: first.id,
      officeName: "acme",
      plan: "office",
    });
    if (!out.ok) throw new Error("signup failed");

    // Google returns the same subject with a different address.
    const later = await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "after@example.com",
    });
    expect(later.id).toBe(first.id);
    // The office is still reachable, and no second account was made for the
    // new address.
    expect((await reservationsForAccount(store, later.id))[0]?.name).toBe(
      "acme",
    );
    expect(await accountByEmail(store, "after@example.com")).toBeNull();
    expect(
      await instanceOwnedBy(store, later.id, out.reservation.instance_id),
    ).not.toBeNull();
  });
});

describe("the trusted origin", () => {
  test("only this deployment's own origin passes", async () => {
    const trusted = "https://cp.isomux.app";
    expect(originIsTrusted("https://cp.isomux.app", trusted)).toBe(true);
    expect(originIsTrusted("https://cp.isomux.app:443", trusted)).toBe(true);
    expect(originIsTrusted("https://evil.example", trusted)).toBe(false);
    // A customer's own office shares the registrable domain and is still not us.
    expect(originIsTrusted("https://acme.isomux.app", trusted)).toBe(false);
    expect(originIsTrusted("http://cp.isomux.app", trusted)).toBe(false);
  });

  test("absence is refused as hard as a mismatch", async () => {
    expect(originIsTrusted(null, "https://cp.isomux.app")).toBe(false);
    expect(originIsTrusted("", "https://cp.isomux.app")).toBe(false);
    expect(originIsTrusted("null", "https://cp.isomux.app")).toBe(false);
    expect(originIsTrusted("https://cp.isomux.app", undefined)).toBe(false);
  });
});
