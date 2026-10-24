// Signup's two load-bearing properties: the INSERT decides who owns a name, and
// a retry's identity comes from the stored row rather than from the request or
// the clock. The race for one name is in pg-concurrency.test.ts, on two
// backends at once.

import { afterEach, describe, expect, test } from "bun:test";
import {
  ACCESS_WINDOW_MS,
  MAX_NEW_OFFICES_PER_WINDOW,
  NEW_OFFICE_WINDOW_MS,
  accountForDevSignIn,
  accountForEmailSignIn,
  bindGoogleSubject,
  checkoutInputsFor,
  checkoutKeysFor,
  hostnameForNewOffice,
  instanceOwnedBy,
  planById,
  reservationByName,
  customerReason,
  originIsTrusted,
  reservationsForAccount,
  reserveOffice,
  SubjectBindingConflict,
} from "./signup.ts";
import { validateCustomerSshKey } from "./key-lines.ts";
import { accountByEmail } from "./stripe/billing-store.ts";
import { signUpOffice } from "./web/lib/services.server.ts";
import { safeCustomerReason } from "./web/lib/customer-error.ts";
import { isUniqueViolation, type Store } from "./store.ts";
import {
  openTestStore,
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  testDsn,
} from "./testing/pg.ts";

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
    expect(hostnameForNewOffice("acme")).toBe("acme.isomux.app");
    expect(instance?.name).toBe(hostnameForNewOffice("acme"));
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
    expect(refused).toMatchObject({ ok: false, kind: "customer" });
    expect(await reservationByName(store, "next")).toBeNull();
    expect(await store.listInstances()).toHaveLength(1);
    expect(
      await store.sqlGet<{ n: number }>(
        "select count(*) as n from provider_assets",
      ),
    ).toEqual({ n: 1 });
    expect(await store.auditEvents()).toHaveLength(1);
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
    expect(loser).toMatchObject({ ok: false, kind: "customer" });
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
      emailVerified: true,
    });
    const again = await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "a@example.com",
      emailVerified: true,
    });
    expect(again.id).toBe(first.id);
    expect(again.google_subject).toBe("sub-1");
  });

  test("one subject cannot claim a second account", async () => {
    const store = await tempStore();
    await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "a@example.com",
      emailVerified: true,
    });
    await bindGoogleSubject(store, {
      subject: "sub-2",
      email: "b@example.com",
      emailVerified: true,
    });
    expect(
      bindGoogleSubject(store, {
        subject: "sub-1",
        email: "b@example.com",
        emailVerified: true,
      }),
    ).rejects.toThrow(SubjectBindingConflict);
  });

  test("an account bound to one subject is never silently rebound", async () => {
    const store = await tempStore();
    await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "a@example.com",
      emailVerified: true,
    });
    expect(
      bindGoogleSubject(store, {
        subject: "sub-9",
        email: "a@example.com",
        emailVerified: true,
      }),
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
      emailVerified: true,
    });
    const other = await bindGoogleSubject(store, {
      subject: "sub-2",
      email: "b@example.com",
      emailVerified: true,
    });
    const refused = await store
      .sqlRun("update accounts set google_subject = $1 where id = $2", [
        "sub-1",
        other.id,
      ])
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(isUniqueViolation(refused)).toBe(true);
  });
});

// An email sign-in proves control of an inbox, which is the authority Google's
// verified email carries: both sign-ins reach one account per address, in
// either order and whatever case each side wrote the address in. An address
// Google has not verified proves nothing, so it may reach only an account its
// subject is already bound to.
describe("email sign-in and Google share one account per address", () => {
  test("an email sign-in reaches the Google-made account, whatever the case", async () => {
    const store = await tempStore();
    const google = await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "User@Proton.Me",
      emailVerified: true,
    });
    const viaLink = await accountForEmailSignIn(store, "user@proton.me");
    expect(viaLink.id).toBe(google.id);
    expect(viaLink.google_subject).toBe("sub-1");
  });

  test("a new address makes one account, which a later Google sign-in binds to", async () => {
    const store = await tempStore();
    const first = await accountForEmailSignIn(store, "user@proton.me");
    expect(first.email).toBe("user@proton.me");
    expect(first.google_subject).toBeNull();
    expect((await accountForEmailSignIn(store, "user@proton.me")).id).toBe(
      first.id,
    );
    // Google writes the address with the case the customer gave it.
    const google = await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "User@Proton.Me",
      emailVerified: true,
    });
    expect(google.id).toBe(first.id);
    expect(google.google_subject).toBe("sub-1");
    expect((await store.sqlAll("select id from accounts")).length).toBe(1);
  });

  test("an unverified Google address cannot take an account by its address", async () => {
    const store = await tempStore();
    const byLink = await accountForEmailSignIn(store, "user@proton.me");
    const refused = await bindGoogleSubject(store, {
      subject: "sub-attacker",
      email: "user@proton.me",
      emailVerified: false,
    }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(SubjectBindingConflict);
    const after = await accountByEmail(store, "user@proton.me");
    expect(after?.id).toBe(byLink.id);
    expect(after?.google_subject).toBeNull();
  });

  test("an unverified Google address cannot create an account a later email sign-in would land in", async () => {
    const store = await tempStore();
    const refused = await bindGoogleSubject(store, {
      subject: "sub-attacker",
      email: "user@proton.me",
      emailVerified: false,
    }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(SubjectBindingConflict);
    expect(await store.sqlAll("select id from accounts")).toEqual([]);
    // The control: the same call verified does create it, so the refusal
    // above was the verification and not the fixture.
    const made = await bindGoogleSubject(store, {
      subject: "sub-attacker",
      email: "user@proton.me",
      emailVerified: true,
    });
    expect(made.google_subject).toBe("sub-attacker");
  });

  test("a subject already bound still signs in when Google reports the address unverified", async () => {
    const store = await tempStore();
    const first = await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "a@example.com",
      emailVerified: true,
    });
    const again = await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "a@example.com",
      emailVerified: false,
    });
    expect(again.id).toBe(first.id);
  });
});

describe("refusal copy", () => {
  test("a CLI-shaped coupon refusal becomes something a form can show", async () => {
    expect(
      customerReason(
        "--coupon SmON9aoN cannot be used as a full discount: no such coupon",
      ),
    ).toBe("that code cannot be applied: no such coupon");
    expect(
      customerReason(
        "--coupon HALF cannot be used as a full discount: this is 30.5% off, not a 100% discount, so Checkout must still collect a card; pass it as an ordinary discount or use a full-discount coupon",
      ),
    ).toContain("this is 30.5% off");
  });

  test("anything else is refused at the opaque customer boundary", async () => {
    expect(customerReason('"acme" is taken')).toBeNull();
    const rawStripe =
      "invalid_request_error (more_permissions_required): Permission denied for acct_private. Manage keys at https://dashboard.stripe.com/apikeys.";
    expect(
      customerReason(
        `--coupon SECRET cannot be used as a full discount: ${rawStripe}`,
      ),
    ).toBeNull();
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
});

// signUpOffice shows a reserveOffice refusal by the kind reserveOffice gave it.
// It used to show every refusal except one string compared by hand, so a new
// refusal about the deployment reached the customer as words.
describe("the web facade shows a reservation refusal by its kind", () => {
  const STORE_SLOT = Symbol.for("isomux.control-plane.web.store");
  const realError = console.error;

  afterEach(() => {
    delete (globalThis as { [STORE_SLOT]?: unknown })[STORE_SLOT];
    console.error = realError;
    delete process.env.AUTH_URL;
    delete process.env.CONTROL_PLANE_ENTRY_PRICE_ID;
    delete process.env.CONTROL_PLANE_STRIPE_MODE;
    delete process.env.STRIPE_TEST_SECRET_KEY;
  });

  /** signUpOffice against `store`, with everything before reserveOffice
   * configured, and what it logged. */
  async function viaFacade(
    store: Store,
    accountId: string,
    officeName: string,
  ) {
    (globalThis as { [STORE_SLOT]?: { opening?: Promise<Store> } })[
      STORE_SLOT
    ] = { opening: Promise.resolve(store) };
    process.env.AUTH_URL = "https://cloud.example.test";
    process.env.CONTROL_PLANE_ENTRY_PRICE_ID = "price_entry";
    process.env.CONTROL_PLANE_STRIPE_MODE = "test";
    process.env.STRIPE_TEST_SECRET_KEY = "sk_test_NOT_A_REAL_KEY_ONLY_A_SHAPE";
    const logged: string[] = [];
    console.error = (...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    };
    try {
      const result = await signUpOffice({
        language: "en",
        accountId,
        officeName,
        plan: "office",
        customerSshKey: VALID_KEY,
      });
      return { result, logged };
    } finally {
      console.error = realError;
    }
  }

  test("a configuration refusal is opaque, and its reason is logged with the account and office", async () => {
    const store = await tempStore();
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    await store.sqlRun(
      "alter table name_reservations add constraint legacy_one_office unique (account_id)",
    );
    try {
      // The enabling condition: reserveOffice itself gives the migration
      // refusal for this request.
      const direct = await reserveOffice(store, {
        accountId: first.account.id,
        officeName: "acme-two",
        plan: "office",
        customerSshKey: VALID_KEY,
      });
      expect(direct).toMatchObject({ ok: false, kind: "configuration" });
      if (direct.ok) return;

      const { result, logged } = await viaFacade(
        store,
        first.account.id,
        "acme-two",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).not.toContain("migration");
      const reference = /PAY-[0-9A-F]{10}/.exec(result.reason)?.[0];
      expect(reference).toBeDefined();
      const line = logged.find((l) => l.includes(reference!));
      expect(line).toBeDefined();
      expect(line).toContain(direct.reason);
      expect(line).toContain(`account=${first.account.id}`);
      expect(line).toContain(`office=${JSON.stringify("acme-two")}`);
    } finally {
      await store.sqlRun(
        "alter table name_reservations drop constraint legacy_one_office",
      );
    }
  });

  test("a customer refusal shows its own sentence, with nothing logged", async () => {
    const store = await tempStore();
    const held = await signup(store);
    if (!held.ok) throw new Error("signup failed");
    const other = await accountFor(store, "other@example.com");
    const direct = await reserveOffice(store, {
      accountId: other.id,
      officeName: "acme",
      plan: "office",
      customerSshKey: VALID_KEY,
    });
    expect(direct).toMatchObject({ ok: false, kind: "customer" });
    if (direct.ok) return;

    const { result, logged } = await viaFacade(store, other.id, "acme");
    expect(result).toEqual({
      ok: false,
      reason: safeCustomerReason("en", direct.reason, { accountId: other.id }),
    });
    expect(logged.filter((l) => l.includes("customer-error"))).toEqual([]);
  });
});

describe("the tenant key survives a changed email", () => {
  test("one Google subject with a new address still reaches its own account", async () => {
    const store = await tempStore();
    const first = await bindGoogleSubject(store, {
      subject: "sub-1",
      email: "before@example.com",
      emailVerified: true,
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
      emailVerified: true,
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
