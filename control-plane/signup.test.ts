// Signup's two load-bearing properties: the INSERT decides who owns a name, and
// a retry's identity comes from the stored row rather than from the request or
// the clock. The race for one name is in pg-concurrency.test.ts, on two
// backends at once.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
  recordOrdinaryCheckoutSession,
  recordTerminalOrdinarySession,
  reservationsForAccount,
  reserveOffice,
  SubjectBindingConflict,
  UNPAID_OPENING_HOLD_MS,
  type ReservationRow,
  type SignupSource,
} from "./signup.ts";
import { sweepCustomerKeyRetention } from "./access-retention.ts";
import { validateCustomerSshKey } from "./key-lines.ts";
import { accountByEmail, insertSubscription } from "./stripe/billing-store.ts";
import { signUpOffice, signupPageState } from "./web/lib/services.server.ts";
import { safeCustomerReason } from "./web/lib/customer-error.ts";
import { isUniqueViolation, Store } from "./store.ts";
import { WEB_GRANTS } from "./roles.ts";
import {
  dropLeastPrivilegedRoles,
  leastPrivilegedDsn,
} from "./testing/least-privilege.ts";
import {
  freshDsn,
  openTestStore,
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  TARGET_IS_LOCAL,
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** The subscription row reconciliation writes once a Checkout is paid. */
async function payFor(
  store: Store,
  reservation: Pick<ReservationRow, "account_id" | "instance_id">,
): Promise<void> {
  await store.tx(() =>
    insertSubscription(store, {
      id: `sub-${reservation.instance_id}`,
      account_id: reservation.account_id,
      instance_id: reservation.instance_id,
      stripe_customer_id: `cus-${reservation.instance_id}`,
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

/** Open a Checkout session on the reservation and have Stripe report it
 * expired unpaid, through the writes the poll and Continue make. */
async function expireCheckout(
  store: Store,
  reservation: ReservationRow,
): Promise<void> {
  const sessionId = `cs-${reservation.id}`;
  expect(
    await recordOrdinaryCheckoutSession(store, reservation, {
      id: sessionId,
      expiresAt: store.now() + DAY_MS,
    }),
  ).toBe(true);
  expect(
    await recordTerminalOrdinarySession(store, reservation.id, sessionId),
  ).toBe(true);
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

    // Inside the opening hold, so the reservation is still live and reused.
    now += UNPAID_OPENING_HOLD_MS - 1;
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
  test("a second name for an account whose first office is paid creates an independent office", async () => {
    const store = await tempStore();
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    await payFor(store, first.reservation);
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
      // Paid, so the account may reserve the next name.
      await payFor(store, result.reservation);
    }
    expect(
      (await reservationsForAccount(store, account.id)).map((r) => r.name),
    ).toEqual(["alpha", "beta"]);
  });
});

// An unpaid reservation holds its name and an admission place only while its
// Checkout can still be paid. Once it is over, the name goes to the next signup
// for it and the place to the next office, so a free account cannot close
// signups for everyone by reserving names it never pays for (task 9ed7430a).
describe("an unpaid reservation whose checkout is over", () => {
  const NOW = 1_700_000_000_000;
  const CREATED = NOW - 5 * DAY_MS;

  interface Held {
    state: ReservationRow["checkout_state"];
    updatedAt: number;
    expiresAt?: number;
    paidBy?: "subscription" | "create_instance";
  }

  /** The name "held", reserved by another account inside the admission window,
   * with its office rows as signup writes them. */
  async function seedHeld(store: Store, held: Held): Promise<void> {
    const session =
      held.state === "pending" || held.state === "expired" ? "cs-held" : null;
    await store.tx(async () => {
      await store.sqlRun(
        "insert into name_reservations (name, id, account_id, instance_id, plan, coupon_id, " +
          "checkout_session_id, checkout_generation, checkout_expires_at, checkout_state, " +
          "version, created_at, updated_at) values ('held', 'res-held', 'held-account', " +
          "'inst-held', 'office', null, $1, 1, $2, $3, 1, $4, $5)",
        [session, held.expiresAt ?? null, held.state, CREATED, held.updatedAt],
      );
      await store.createInstance({
        id: "inst-held",
        run_id: null,
        name: hostnameForNewOffice("held"),
        plan: planById("office")!.providerProduct,
        region: planById("office")!.region,
        service_state: "provisioning",
        goal: "live",
        access_window_expires_at: CREATED + ACCESS_WINDOW_MS,
        customer_ssh_key: null,
        ssh_login_user: null,
      });
    });
    if (held.paidBy === "subscription") {
      await payFor(store, {
        account_id: "held-account",
        instance_id: "inst-held",
      });
    }
    if (held.paidBy === "create_instance") {
      await store.enqueue({
        id: "op-held-create",
        instance_id: "inst-held",
        kind: "create_instance",
        inactivity_deadline_at: NOW + DAY_MS,
        absolute_deadline_at: NOW + DAY_MS,
      });
    }
  }

  async function inWindow(store: Store): Promise<number> {
    const row = await store.sqlGet<{ n: number }>(
      "select count(*) as n from name_reservations where created_at >= $1",
      [NOW - NEW_OFFICE_WINDOW_MS],
    );
    return Number(row?.n);
  }

  const OVER: [string, Held][] = [
    [
      "Stripe reported its session expired",
      { state: "expired", updatedAt: NOW },
    ],
    [
      "it recorded no session for the whole hold",
      { state: "opening", updatedAt: NOW - UNPAID_OPENING_HOLD_MS },
    ],
    [
      "a legacy row recorded no session for the whole hold",
      { state: null, updatedAt: NOW - UNPAID_OPENING_HOLD_MS },
    ],
  ];
  const LIVE: [string, Held][] = [
    [
      "it is opening inside the hold",
      { state: "opening", updatedAt: NOW - UNPAID_OPENING_HOLD_MS + 1 },
    ],
    [
      "its session is past expiry and Stripe has not confirmed that",
      { state: "pending", updatedAt: CREATED, expiresAt: NOW - 4 * DAY_MS },
    ],
    [
      "its checkout expired but it has a subscription",
      { state: "expired", updatedAt: NOW, paidBy: "subscription" },
    ],
    [
      "its checkout expired but its office is being created",
      { state: "expired", updatedAt: NOW, paidBy: "create_instance" },
    ],
  ];

  test.each(OVER)("frees its admission place when %s", async (_, held) => {
    const store = await tempStore(() => NOW);
    await seedAdmissions(store, MAX_NEW_OFFICES_PER_WINDOW - 1, NOW);
    await seedHeld(store, held);
    expect(await inWindow(store)).toBe(MAX_NEW_OFFICES_PER_WINDOW);
    const out = await signup(store, {
      email: "next@example.com",
      officeName: "next",
    });
    expect(out.ok).toBe(true);
  });

  test.each(LIVE)("keeps its admission place when %s", async (_, held) => {
    const store = await tempStore(() => NOW);
    await seedAdmissions(store, MAX_NEW_OFFICES_PER_WINDOW - 1, NOW);
    await seedHeld(store, held);
    expect(await inWindow(store)).toBe(MAX_NEW_OFFICES_PER_WINDOW);
    const refused = await signup(store, {
      email: "next@example.com",
      officeName: "next",
    });
    expect(refused).toMatchObject({ ok: false, kind: "customer" });
    expect(await reservationByName(store, "next")).toBeNull();
    // The held row was the place that decided it: without it, "next" fits.
    await store.sqlRun("delete from name_reservations where name = 'held'");
    expect(
      (await signup(store, { email: "next@example.com", officeName: "next" }))
        .ok,
    ).toBe(true);
  });

  test.each(OVER)(
    "gives its name to the next signup when %s",
    async (_, held) => {
      const store = await tempStore(() => NOW);
      await seedHeld(store, held);
      const out = await signup(store, {
        email: "next@example.com",
        officeName: "held",
        plan: "poweruser",
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.reused).toBe(false);
      expect(out.reservation).toMatchObject({
        account_id: out.account.id,
        plan: "poweruser",
        checkout_generation: 1,
        checkout_session_id: null,
        checkout_state: "opening",
        created_at: NOW,
      });
      expect(out.reservation.id).not.toBe("res-held");
      expect(out.reservation.instance_id).not.toBe("inst-held");
      expect((await store.getInstance("inst-held"))?.service_state).toBe(
        "deprovisioned",
      );
      expect(await reservationsForAccount(store, "held-account")).toEqual([]);
    },
  );

  test.each(LIVE)("keeps its name when %s", async (_, held) => {
    const store = await tempStore(() => NOW);
    await seedHeld(store, held);
    const refused = await signup(store, {
      email: "next@example.com",
      officeName: "held",
    });
    expect(refused).toMatchObject({ ok: false, kind: "customer" });
    expect(await reservationByName(store, "held")).toMatchObject({
      id: "res-held",
      account_id: "held-account",
      instance_id: "inst-held",
    });
    expect((await store.getInstance("inst-held"))?.service_state).toBe(
      "provisioning",
    );
  });

  test("a name taken over gets new Stripe keys and a new office, and the old office is released", async () => {
    let now = NOW;
    const store = await tempStore(() => now);
    const first = await signup(store, { customerSshKey: VALID_KEY });
    if (!first.ok) throw new Error("signup failed");
    await expireCheckout(store, first.reservation);
    now += 60 * 60 * 1000;

    const other = await accountFor(store, "b@example.com");
    const out = await reserveOffice(store, {
      accountId: other.id,
      officeName: "acme",
      plan: "office",
      customerSshKey: VALID_KEY,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Both Stripe idempotency keys derive from the reservation id: the old
    // ones would replay the first account's customer and session.
    const before = checkoutKeysFor(first.reservation);
    const after = checkoutKeysFor(out.reservation);
    expect(after.customer).not.toBe(before.customer);
    expect(after.session).not.toBe(before.session);

    const made = await store.getInstance(out.reservation.instance_id);
    expect(made).toMatchObject({
      name: hostnameForNewOffice("acme"),
      service_state: "provisioning",
      access_window_expires_at: now + ACCESS_WINDOW_MS,
      customer_ssh_key: `ssh-ed25519 ${keyBlob()}`,
    });
    expect(
      (await store.assetForInstance(out.reservation.instance_id))?.asset_state,
    ).toBe("none");
    expect(
      (await store.getInstance(first.reservation.instance_id))?.service_state,
    ).toBe("deprovisioned");
    const released = (await store.auditEvents()).filter(
      (e) => e.action === "release_office",
    );
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({
      actor: `account:${other.id}`,
      instance_id: first.reservation.instance_id,
    });
    expect(await reservationsForAccount(store, first.account.id)).toEqual([]);
    expect(
      (await reservationsForAccount(store, other.id)).map((r) => r.id),
    ).toEqual([out.reservation.id]);
  });

  test("a takeover is an admission: at the limit it is refused and the name stays where it was", async () => {
    const store = await tempStore(() => NOW);
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    await expireCheckout(store, first.reservation);
    await seedAdmissions(store, MAX_NEW_OFFICES_PER_WINDOW, NOW);

    const refused = await signup(store, { email: "b@example.com" });
    expect(refused).toMatchObject({ ok: false, kind: "customer" });
    expect(await reservationByName(store, "acme")).toMatchObject({
      id: first.reservation.id,
      account_id: first.account.id,
    });
    expect(
      (await store.getInstance(first.reservation.instance_id))?.service_state,
    ).toBe("provisioning");
    expect(await store.listInstances()).toHaveLength(1);
    // The limit was what refused it: with the window empty, the same
    // takeover is admitted.
    await store.sqlRun(
      "delete from name_reservations where name like 'seed-%'",
    );
    expect((await signup(store, { email: "b@example.com" })).ok).toBe(true);
  });

  test("the owner's own reservation whose checkout is over starts afresh, past the access window too", async () => {
    let now = NOW;
    const store = await tempStore(() => now);
    const first = await signup(store, { customerSshKey: VALID_KEY });
    if (!first.ok) throw new Error("signup failed");
    now += ACCESS_WINDOW_MS + 60 * 60 * 1000;
    await sweepCustomerKeyRetention(store);
    // The state a returning owner meets: the retention sweep has cleared the
    // key from the office the old reservation names.
    expect(
      (await store.getInstance(first.reservation.instance_id))
        ?.customer_ssh_key,
    ).toBeNull();

    const again = await signup(store, { customerSshKey: VALID_KEY });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.reused).toBe(false);
    expect(again.reservation.instance_id).not.toBe(
      first.reservation.instance_id,
    );
    expect(
      await store.getInstance(again.reservation.instance_id),
    ).toMatchObject({
      access_window_expires_at: now + ACCESS_WINDOW_MS,
      customer_ssh_key: `ssh-ed25519 ${keyBlob()}`,
    });
    expect(
      (await store.getInstance(first.reservation.instance_id))?.service_state,
    ).toBe("deprovisioned");
  });
});

// THE ROLE THE DEPLOYED WEB TIER RUNS AS. A takeover locks and rewrites a
// reservation and retires an instance, and a write the web matrix does not
// grant is a 42501 the customer reads as a 500 (the 2026-08-24 signup). LOCAL
// ENGINE ONLY: it creates a login role.
const privileged = TARGET_IS_LOCAL ? describe : describe.skip;

privileged("a takeover as the web role", () => {
  afterAll(async () => {
    await dropLeastPrivilegedRoles();
  }, PG_TEST_HOOK_TIMEOUT_MS);

  test("runs on the deployed web grants", async () => {
    const now = 1_700_000_000_000;
    const dsn = await freshDsn();
    const owner = await openTestStoreOn(dsn, () => now);
    const first = await signup(owner);
    if (!first.ok) throw new Error("signup failed");
    await expireCheckout(owner, first.reservation);
    const other = await accountFor(owner, "b@example.com");
    const web = await Store.openRuntime(
      await leastPrivilegedDsn({ dsn, grants: WEB_GRANTS }),
      () => now,
    );
    try {
      const out = await reserveOffice(web, {
        accountId: other.id,
        officeName: "acme",
        plan: "office",
      });
      expect(out).toMatchObject({ ok: true, reused: false });
      expect(
        (await owner.getInstance(first.reservation.instance_id))?.service_state,
      ).toBe("deprovisioned");
    } finally {
      await web.close();
    }
  });
});

describe("one live unpaid reservation per account", () => {
  test("a second name waits until the first checkout is over, and the refusal writes nothing", async () => {
    const store = await tempStore(() => 1_700_000_000_000);
    const first = await signup(store, { officeName: "alpha" });
    if (!first.ok) throw new Error("signup failed");

    const refused = await signup(store, { officeName: "bravo" });
    expect(refused).toMatchObject({ ok: false, kind: "customer" });
    // It names the office whose checkout the customer can finish.
    if (!refused.ok) expect(refused.reason).toContain("alpha");
    expect(await reservationByName(store, "bravo")).toBeNull();
    expect(await store.listInstances()).toHaveLength(1);
    expect(await store.auditEvents()).toHaveLength(1);

    await expireCheckout(store, first.reservation);
    expect((await signup(store, { officeName: "bravo" })).ok).toBe(true);
  });

  test("an account holding a live unpaid office cannot take over a released name either", async () => {
    const store = await tempStore(() => 1_700_000_000_000);
    const first = await signup(store);
    if (!first.ok) throw new Error("signup failed");
    await expireCheckout(store, first.reservation);
    const beta = await signup(store, {
      email: "b@example.com",
      officeName: "beta",
    });
    if (!beta.ok) throw new Error("signup failed");

    const refused = await signup(store, { email: "b@example.com" });
    expect(refused).toMatchObject({ ok: false, kind: "customer" });
    if (!refused.ok) expect(refused.reason).toContain("beta");
    expect(await reservationByName(store, "acme")).toMatchObject({
      id: first.reservation.id,
      account_id: first.account.id,
    });
    expect(
      (await store.getInstance(first.reservation.instance_id))?.service_state,
    ).toBe("provisioning");
  });

  test("two concurrent signups from one account admit one office", async () => {
    const now = 1_700_000_000_000;
    const dsn = await testDsn();
    const a = await openTestStoreOn(dsn, () => now);
    const b = await openTestStoreOn(dsn, () => now);
    const account = await accountForDevSignIn(a, "racer@example.com");
    const [one, two] = await Promise.all([
      reserveOffice(a, {
        accountId: account.id,
        officeName: "one",
        plan: "office",
      }),
      reserveOffice(b, {
        accountId: account.id,
        officeName: "two",
        plan: "office",
      }),
    ]);
    expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1);
    expect(one.ok ? two : one).toMatchObject({ ok: false, kind: "customer" });
    expect(await reservationsForAccount(a, account.id)).toHaveLength(1);
    expect(await a.listInstances()).toHaveLength(1);
    await a.close();
    await b.close();
  });
});

// The page offers Continue for the reservation the account may still pay, and
// the new-office form once none is live.
describe("the signup page state", () => {
  const STORE_SLOT = Symbol.for("isomux.control-plane.web.store");

  afterEach(() => {
    delete (globalThis as { [STORE_SLOT]?: unknown })[STORE_SLOT];
  });

  test("follows the live unpaid reservation, not the oldest unpaid one", async () => {
    let now = 1_700_000_000_000;
    const store = await tempStore(() => now);
    (globalThis as { [STORE_SLOT]?: { opening?: Promise<Store> } })[
      STORE_SLOT
    ] = { opening: Promise.resolve(store) };
    const alpha = await signup(store, { officeName: "alpha" });
    if (!alpha.ok) throw new Error("signup failed");
    const id = alpha.account.id;
    expect(await signupPageState(id)).toEqual({
      kind: "continue",
      officeName: "alpha",
    });

    await expireCheckout(store, alpha.reservation);
    expect(await signupPageState(id)).toEqual({ kind: "new" });

    const bravo = await signup(store, { officeName: "bravo" });
    if (!bravo.ok) throw new Error(bravo.reason);
    await payFor(store, bravo.reservation);
    expect(await signupPageState(id)).toEqual({ kind: "paid" });

    const charlie = await signup(store, { officeName: "charlie" });
    if (!charlie.ok) throw new Error(charlie.reason);
    expect(await signupPageState(id)).toEqual({
      kind: "continue",
      officeName: "charlie",
    });

    now += UNPAID_OPENING_HOLD_MS;
    expect(await signupPageState(id)).toEqual({ kind: "paid" });
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

// The signup source rides on the reservation until the first paid checkout
// copies it (task 8a12ba81). It belongs to the signup that wrote it: a takeover
// of a dead name is a new signup and must not inherit the old one's source,
// and the owner's own retry is the same signup, so first touch stays.
describe("the signup source on the reservation", () => {
  const NOW = 1_700_000_000_000;
  const FIRST: SignupSource = {
    utmSource: "newsletter",
    utmCampaign: "launch-week",
    referrerHost: "t.co",
    landingPath: "/blog/hosted",
  };
  const SECOND: SignupSource = {
    utmSource: "producthunt",
    utmCampaign: null,
    referrerHost: "www.producthunt.com",
    landingPath: "/",
  };

  async function sourceOf(store: Store, name: string) {
    return store.sqlGet<{
      id: string;
      utm_source: string | null;
      utm_campaign: string | null;
      referrer_host: string | null;
      landing_path: string | null;
    }>(
      "select id, utm_source, utm_campaign, referrer_host, landing_path " +
        "from name_reservations where name = $1",
      [name],
    );
  }

  test("a new reservation keeps the source it was given, and none when it was given none", async () => {
    const store = await tempStore(() => NOW);
    expect((await signup(store, { source: FIRST })).ok).toBe(true);
    expect(
      (await signup(store, { officeName: "plain", email: "b@example.com" })).ok,
    ).toBe(true);
    expect(await sourceOf(store, "acme")).toMatchObject({
      utm_source: "newsletter",
      utm_campaign: "launch-week",
      referrer_host: "t.co",
      landing_path: "/blog/hosted",
    });
    expect(await sourceOf(store, "plain")).toMatchObject({
      utm_source: null,
      utm_campaign: null,
      referrer_host: null,
      landing_path: null,
    });
  });

  test("the owner's retry keeps the first source", async () => {
    const store = await tempStore(() => NOW);
    const first = await signup(store, { source: FIRST });
    if (!first.ok) throw new Error("signup failed");
    const again = await signup(store, { source: SECOND });
    expect(again).toMatchObject({ ok: true, reused: true });
    expect(await sourceOf(store, "acme")).toMatchObject({
      id: first.reservation.id,
      utm_source: "newsletter",
      referrer_host: "t.co",
    });
  });

  test("a takeover of a dead name replaces the old signup's source, with nothing when it brings none", async () => {
    const store = await tempStore(() => NOW);
    const first = await signup(store, { source: FIRST });
    if (!first.ok) throw new Error("signup failed");
    await expireCheckout(store, first.reservation);

    const second = await signup(store, {
      email: "b@example.com",
      source: SECOND,
    });
    if (!second.ok) throw new Error("takeover failed");
    // The enabling condition: this was a takeover, not a fresh name.
    expect(second.reservation.id).not.toBe(first.reservation.id);
    expect(await sourceOf(store, "acme")).toEqual({
      id: second.reservation.id,
      utm_source: "producthunt",
      utm_campaign: null,
      referrer_host: "www.producthunt.com",
      landing_path: "/",
    });

    await expireCheckout(store, second.reservation);
    const third = await signup(store, { email: "c@example.com" });
    if (!third.ok) throw new Error("takeover failed");
    expect(third.reservation.id).not.toBe(second.reservation.id);
    expect(await sourceOf(store, "acme")).toEqual({
      id: third.reservation.id,
      utm_source: null,
      utm_campaign: null,
      referrer_host: null,
      landing_path: null,
    });
  });
});
