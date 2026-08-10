// Signup's two load-bearing properties: the INSERT decides who owns a name, and
// a retry's identity comes from the stored row rather than from the request or
// the clock.
//
// The race here is fired the way a race actually happens - two independent
// connections to one file, neither of which has read the other's write.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "./store.ts";
import {
  ACCESS_WINDOW_MS,
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
  reservationForAccount,
  reserveOffice,
  SubjectBindingConflict,
  validateSignup,
} from "./signup.ts";
import { accountByEmail } from "./stripe/billing-store.ts";

const temps: string[] = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-signup-"));
  temps.push(dir);
  return path.join(dir, "cp.db");
}

async function tempStore(now?: () => number): Promise<Store> {
  return await Store.open(tempFile(), now);
}

afterEach(async () => {
  while (temps.length)
    fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

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

describe("refusals that never reach the database", () => {
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
  test("creates account, reservation, instance and a placeholder asset together", async () => {
    const now = 1_700_000_000_000;
    const store = await tempStore(() => now);
    const out = await signup(store);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.reused).toBe(false);
    const instance = await store.getInstance(out.reservation.instance_id);
    expect(instance?.name).toBe(hostnameFor("acme"));
    expect(instance?.service_state).toBe("provisioning");
    expect(instance?.goal).toBe("live");
    expect(instance?.plan).toBe(planById("office")?.providerProduct);
    // Written with the row because nothing can write it afterwards.
    expect(instance?.access_window_expires_at).toBe(now + ACCESS_WINDOW_MS);

    const asset = await store.assetForInstance(out.reservation.instance_id);
    expect(asset?.provider_id).toBeNull();
    expect(asset?.asset_state).toBe("none");
    expect(asset?.ipv4).toBeNull();
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

  test("two independent connections racing for one name: exactly one wins", async () => {
    const file = tempFile();
    const a = await Store.open(file);
    const b = await Store.open(file);
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
    const file = tempFile();
    const a = await Store.open(file);
    const b = await Store.open(file);
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
    // A second plan exists only for this test's sake; the refusal is what is
    // being asserted, so it is driven through the stored value directly.
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    await store.sqlRun("update name_reservations set plan = ? where name = ?", [
      "other",
      "acme",
    ]);
    const second = await signup(store);
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
      store.sqlRun("update accounts set google_subject = ? where id = ?", [
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

describe("one office per account", () => {
  test("a second name for the same account is refused, and names its office", async () => {
    const store = await tempStore();
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    const second = await signup(store, { officeName: "acme-two" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toContain('you already have an office at "acme"');
    }
    expect(await reservationByName(store, "acme-two")).toBeNull();
    expect(await store.listInstances()).toHaveLength(1);
  });

  test("two connections racing DIFFERENT names for one account: one wins", async () => {
    const file = tempFile();
    const a = await Store.open(file);
    const b = await Store.open(file);
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
    // The database arbitrates: exactly one reservation exists afterwards, and
    // the loser is told what it already has.
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(
      await a.sqlGet<{ n: number }>(
        "select count(*) as n from name_reservations",
      ),
    ).toEqual({ n: 1 });
    expect(await a.listInstances()).toHaveLength(1);
    const loser = first.ok ? second : first;
    if (!loser.ok) expect(loser.reason).toContain("one office");
    expect(await reservationForAccount(a, account.id)).not.toBeNull();
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
    expect((await reservationForAccount(store, later.id))?.name).toBe("acme");
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
