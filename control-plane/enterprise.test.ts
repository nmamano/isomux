// Enterprise accounts at the store (task 71718489, slice S1): one account per
// storefront sign-in, the standard agreement, the seat count N and who may
// change it, the secret and its generations, a negotiated account from the
// operator CLI, and the audit row each change leaves.
//
// The routes, as the deployed web role, are in web-enterprise.test.ts; the
// contract calendar and the quotes are in enterprise-billing.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import {
  AGREEMENT,
  changeSeats,
  createEnterprise,
  createNegotiatedEnterprise,
  enterpriseFor,
  enterpriseForSecret,
  enterpriseSecret,
  renewSecret,
  signAgreement,
  type CreateEnterpriseInput,
} from "./enterprise.ts";
import { accountForDevSignIn } from "./signup.ts";
import type { Store } from "./store.ts";
import {
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  testDsn,
} from "./testing/pg.ts";

afterEach(async () => {
  await releaseTestStores();
}, PG_TEST_HOOK_TIMEOUT_MS);

const SECRET = "enterprise-test-secret-0123456789abcdef";
const T0 = Date.parse("2027-03-10T12:00:00Z");
const DAY = 86_400_000;

/** Every store in a test reads this clock; a test moves it. */
let clock = T0;

interface Setup {
  store: Store;
  dsn: string;
  /** Storefront sign-ins: IT of Acme, IT of Globex, and the negotiated one. */
  it: string;
  other: string;
}

async function setup(): Promise<Setup> {
  clock = T0;
  const dsn = await testDsn();
  const store = await openTestStoreOn(dsn, () => clock);
  const it = (await accountForDevSignIn(store, "it@acme.example")).id;
  const other = (await accountForDevSignIn(store, "it@globex.example")).id;
  return { store, dsn, it, other };
}

function input(
  over: Partial<CreateEnterpriseInput> = {},
): CreateEnterpriseInput {
  return {
    company: "Acme Inc.",
    billingEmail: "billing@acme.example",
    plan: "monthly",
    seats: 50,
    ...over,
  };
}

async function created(
  s: Setup,
  over: Partial<CreateEnterpriseInput> = {},
  accountId = s.it,
): Promise<string> {
  const result = await createEnterprise(s.store, accountId, input(over));
  if (!result.ok) throw new Error(`create refused: ${JSON.stringify(result)}`);
  return result.id;
}

/** Created and signed by the account's IT. */
async function signed(
  s: Setup,
  over: Partial<CreateEnterpriseInput> = {},
  accountId = s.it,
): Promise<string> {
  const id = await created(s, over, accountId);
  const result = await signAgreement(s.store, accountId, {
    name: "Ada Admin",
    title: "IT Director",
    authority: true,
  });
  expect(result).toEqual({ ok: true });
  return id;
}

/** Run SQL as the owner, for the rows only S2's seat service writes. */
async function sql(
  s: Setup,
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: s.dsn });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

/** An office row as the seat service (S2) will write it. */
async function office(
  s: Setup,
  enterpriseId: string,
  id: string,
  members: number,
  over: { joinedAt?: number; removedAt?: number | null } = {},
): Promise<void> {
  const joined = over.joinedAt ?? clock;
  await sql(
    s,
    "insert into enterprise_offices (enterprise_id, id, name, members, joined_at, " +
      "last_seen_at, removed_at) values ($1, $2, null, $3, $4, $4, $5)",
    [enterpriseId, id, members, joined, over.removedAt ?? null],
  );
}

async function auditOf(s: Setup, target: string) {
  return (await s.store.auditEvents())
    .filter((row) => row.target === target)
    .map(({ actor, instance_id, action, detail }) => ({
      actor,
      instance_id,
      action,
      detail,
    }));
}

describe("setting up an account", () => {
  test("makes a standard, unsigned account with no secret, on the sign-in that made it", async () => {
    const s = await setup();
    const id = await created(s, { plan: "yearly", seats: 12 });
    const view = await enterpriseFor(s.store, s.it, SECRET);
    expect(view).toEqual({
      id,
      company: "Acme Inc.",
      billingEmail: "billing@acme.example",
      plan: "yearly",
      seats: 12,
      kind: "standard",
      priceNote: null,
      signature: null,
      contractStart: null,
      inUse: 0,
      offices: [],
      secret: null,
    });
    // Another sign-in sees nothing of it.
    expect(await enterpriseFor(s.store, s.other, SECRET)).toBeNull();
    expect(
      (await auditOf(s, id)).map(({ actor, instance_id, action }) => ({
        actor,
        instance_id,
        action,
      })),
    ).toEqual([
      {
        actor: `account:${s.it}`,
        instance_id: null,
        action: "enterprise.created",
      },
    ]);
  });

  test("one per sign-in: a second create, even at the same moment, is 'exists' and keeps the first", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([
      createEnterprise(s.store, s.it, input({ seats: 20 })),
      createEnterprise(s.store, s.it, input({ seats: 30 })),
    ]);
    const outcomes = [a, b].map((r) => (r.ok ? "ok" : r.reason)).sort();
    expect(outcomes).toEqual(["exists", "ok"]);
    const first = a.ok ? a : b;
    const view = await enterpriseFor(s.store, s.it, SECRET);
    expect(view?.id).toBe(first.ok ? first.id : "");
    expect(await createEnterprise(s.store, s.it, input())).toEqual({
      ok: false,
      reason: "exists",
    });
    const rows = await sql(
      s,
      "select count(*)::int as n from enterprise_accounts",
    );
    expect(rows.rows[0].n).toBe(1);
  });

  test("refuses a bad field by name and writes nothing", async () => {
    const s = await setup();
    const cases: [
      Partial<CreateEnterpriseInput>,
      "company" | "billingEmail" | "plan" | "seats",
    ][] = [
      [{ company: "" }, "company"],
      [{ company: "   " }, "company"],
      [{ company: "x".repeat(201) }, "company"],
      [{ billingEmail: "" }, "billingEmail"],
      [{ billingEmail: `${"b".repeat(243)}@acme.example` }, "billingEmail"],
      [{ plan: "weekly" as never }, "plan"],
      [{ seats: 0 }, "seats"],
      [{ seats: 10_001 }, "seats"],
      [{ seats: 2.5 }, "seats"],
      [{ seats: Number.NaN }, "seats"],
    ];
    for (const [over, field] of cases) {
      const result = await createEnterprise(s.store, s.it, input(over));
      expect({ over, result }).toEqual({
        over,
        result: { ok: false, reason: "invalid", field },
      });
    }
    expect(await enterpriseFor(s.store, s.it, SECRET)).toBeNull();
    // The bounds themselves are accepted.
    await created(s, { company: "x".repeat(200), seats: 10_000 });
    expect((await enterpriseFor(s.store, s.it, SECRET))?.seats).toBe(10_000);
  });
});

describe("signing the standard agreement", () => {
  test("records the signer, the agreement's version and PDF hash, starts the contract, and shows the secret", async () => {
    const s = await setup();
    const id = await created(s);
    clock = T0 + DAY;
    expect(
      await signAgreement(s.store, s.it, {
        name: "Ada Admin",
        title: "IT Director",
        authority: true,
      }),
    ).toEqual({ ok: true });
    const view = await enterpriseFor(s.store, s.it, SECRET);
    expect(view?.signature).toEqual({
      name: "Ada Admin",
      title: "IT Director",
      at: T0 + DAY,
      agreementVersion: AGREEMENT.version,
    });
    expect(view?.contractStart).toBe(T0 + DAY);
    const row = await sql(
      s,
      "select agreement_sha256, agreement_version from enterprise_accounts where id = $1",
      [id],
    );
    expect(row.rows[0]).toEqual({
      agreement_sha256: AGREEMENT.sha256,
      agreement_version: AGREEMENT.version,
    });
    // The secret shown is the one the seat service accepts.
    expect(view?.secret).toBe(enterpriseSecret(SECRET, id, 1));
    expect(
      await enterpriseForSecret(s.store, SECRET, view?.secret ?? ""),
    ).toEqual({ enterpriseId: id, signed: true });
    expect((await auditOf(s, id)).map((r) => r.action)).toEqual([
      "enterprise.created",
      "enterprise.signed",
    ]);
  });

  test("refuses without the authority box, a name or a title, and a second signature", async () => {
    const s = await setup();
    await created(s);
    const sign = (over: object) =>
      signAgreement(s.store, s.it, {
        name: "Ada Admin",
        title: "IT Director",
        authority: true,
        ...over,
      });
    expect(await sign({ authority: false })).toEqual({
      ok: false,
      reason: "invalid",
      field: "authority",
    });
    expect(await sign({ name: "  " })).toEqual({
      ok: false,
      reason: "invalid",
      field: "name",
    });
    expect(await sign({ title: "t".repeat(201) })).toEqual({
      ok: false,
      reason: "invalid",
      field: "title",
    });
    expect((await enterpriseFor(s.store, s.it, SECRET))?.signature).toBeNull();
    expect(await sign({})).toEqual({ ok: true });
    expect(await sign({ name: "Someone Else" })).toEqual({
      ok: false,
      reason: "already_signed",
    });
    expect((await enterpriseFor(s.store, s.it, SECRET))?.signature?.name).toBe(
      "Ada Admin",
    );
  });

  test("an unsigned account has no secret to use and no seat changes; a sign-in with no account has nothing", async () => {
    const s = await setup();
    const id = await created(s);
    // The secret is computable even though the page never shows it.
    expect(
      await enterpriseForSecret(
        s.store,
        SECRET,
        enterpriseSecret(SECRET, id, 1),
      ),
    ).toEqual({ enterpriseId: id, signed: false });
    expect(await changeSeats(s.store, s.it, { from: 50, to: 60 })).toEqual({
      ok: false,
      reason: "not_signed",
    });
    expect(await renewSecret(s.store, s.it, SECRET)).toEqual({
      ok: false,
      reason: "not_signed",
    });
    expect(await changeSeats(s.store, s.other, { from: 50, to: 60 })).toEqual({
      ok: false,
      reason: "no_account",
    });
    expect(await renewSecret(s.store, s.other, SECRET)).toEqual({
      ok: false,
      reason: "no_account",
    });
    expect(
      await signAgreement(s.store, s.other, {
        name: "N",
        title: "T",
        authority: true,
      }),
    ).toEqual({ ok: false, reason: "no_account" });
    expect((await enterpriseFor(s.store, s.it, SECRET))?.seats).toBe(50);
  });

  test("the pinned hash is the shipped PDF's, served at its public path", () => {
    const file = path.join(import.meta.dir, AGREEMENT.pdfPath);
    const sha = createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");
    expect(sha).toBe(AGREEMENT.sha256);
    expect(AGREEMENT.pdfPath).toBe(`web/public${AGREEMENT.publicPath}`);
  });
});

describe("changing the seat count", () => {
  test("monthly: up and down, each change audited as 'from -> to'", async () => {
    const s = await setup();
    const id = await signed(s);
    expect(await changeSeats(s.store, s.it, { from: 50, to: 60 })).toEqual({
      ok: true,
      seats: 60,
    });
    expect(await changeSeats(s.store, s.it, { from: 60, to: 40 })).toEqual({
      ok: true,
      seats: 40,
    });
    expect((await enterpriseFor(s.store, s.it, SECRET))?.seats).toBe(40);
    expect(
      (await auditOf(s, id)).filter(
        (r) => r.action === "enterprise.seats_changed",
      ),
    ).toEqual([
      {
        actor: `account:${s.it}`,
        instance_id: null,
        action: "enterprise.seats_changed",
        detail: "50 -> 60",
      },
      {
        actor: `account:${s.it}`,
        instance_id: null,
        action: "enterprise.seats_changed",
        detail: "60 -> 40",
      },
    ]);
  });

  test("a change from a seat count that is no longer current is 'stale' and changes nothing", async () => {
    const s = await setup();
    const id = await signed(s);
    await changeSeats(s.store, s.it, { from: 50, to: 60 });
    expect(await changeSeats(s.store, s.it, { from: 50, to: 70 })).toEqual({
      ok: false,
      reason: "stale",
      seats: 60,
      inUse: 0,
    });
    expect((await enterpriseFor(s.store, s.it, SECRET))?.seats).toBe(60);
    expect(
      (await auditOf(s, id)).filter(
        (r) => r.action === "enterprise.seats_changed",
      ),
    ).toHaveLength(1);
  });

  test("a change made while another writer holds the row waits for it, then reads its N: 'stale'", async () => {
    const s = await setup();
    const id = await signed(s);
    // Another writer (a second tab) has moved N to 55 and not committed yet.
    const other = new pg.Client({ connectionString: s.dsn });
    await other.connect();
    try {
      await other.query("begin");
      await other.query(
        "update enterprise_accounts set seats = 55 where id = $1",
        [id],
      );
      let settled = false;
      const change = changeSeats(s.store, s.it, { from: 50, to: 60 }).finally(
        () => {
          settled = true;
        },
      );
      // The enabling condition: the change is parked on the row before the
      // other writer commits. Without it the case proves nothing.
      const deadline = Date.now() + 5_000;
      for (;;) {
        const waiting = await sql(
          s,
          "select count(*)::int as n from pg_stat_activity where " +
            "wait_event_type = 'Lock' and datname = current_database() " +
            "and query ilike '%enterprise_accounts%'",
        );
        if (waiting.rows[0].n > 0) break;
        if (settled || Date.now() > deadline)
          throw new Error("the change never waited on the row");
        await Bun.sleep(10);
      }
      await other.query("commit");
      // A read before the lock would see 50, pass, and overwrite 55 with 60.
      expect(await change).toEqual({
        ok: false,
        reason: "stale",
        seats: 55,
        inUse: 0,
      });
    } finally {
      await other.query("rollback").catch(() => {});
      await other.end();
    }
    expect((await enterpriseFor(s.store, s.it, SECRET))?.seats).toBe(55);
  });

  test("N cannot go below the members of the offices not removed, of this account only", async () => {
    const s = await setup();
    const id = await signed(s);
    const globex = await signed(s, { company: "Globex" }, s.other);
    await office(s, id, "a".repeat(32), 30, { joinedAt: T0 - 2 * DAY });
    await office(s, id, "b".repeat(32), 15, { joinedAt: T0 - DAY });
    await office(s, id, "c".repeat(32), 5, { removedAt: T0 });
    // The same office id under another account is another row.
    await office(s, globex, "a".repeat(32), 40);
    const view = await enterpriseFor(s.store, s.it, SECRET);
    expect(view?.inUse).toBe(45);
    expect(view?.offices.map((o) => [o.id, o.members])).toEqual([
      ["a".repeat(32), 30],
      ["b".repeat(32), 15],
    ]);
    expect(await changeSeats(s.store, s.it, { from: 50, to: 44 })).toEqual({
      ok: false,
      reason: "below_in_use",
      seats: 50,
      inUse: 45,
    });
    expect(await changeSeats(s.store, s.it, { from: 50, to: 45 })).toEqual({
      ok: true,
      seats: 45,
    });
  });

  test("yearly: N goes up, never down before renewal", async () => {
    const s = await setup();
    await signed(s, { plan: "yearly" });
    expect(await changeSeats(s.store, s.it, { from: 50, to: 49 })).toEqual({
      ok: false,
      reason: "yearly_decrease",
      seats: 50,
      inUse: 0,
    });
    expect(await changeSeats(s.store, s.it, { from: 50, to: 55 })).toEqual({
      ok: true,
      seats: 55,
    });
  });

  test("a target outside 1..10000 or not a whole number is 'invalid'", async () => {
    const s = await setup();
    const id = await signed(s);
    for (const to of [0, -1, 10_001, 2.5, Number.NaN]) {
      expect({
        to,
        result: await changeSeats(s.store, s.it, { from: 50, to }),
      }).toEqual({
        to,
        result: { ok: false, reason: "invalid" },
      });
    }
    expect(await changeSeats(s.store, s.it, { from: 50, to: 10_000 })).toEqual({
      ok: true,
      seats: 10_000,
    });
    expect(
      (await auditOf(s, id)).filter(
        (r) => r.action === "enterprise.seats_changed",
      ),
    ).toHaveLength(1);
  });
});

describe("the secret", () => {
  test("a new one replaces the old: the old and any forged or foreign one name no account", async () => {
    const s = await setup();
    const id = await signed(s);
    const globex = await signed(s, { company: "Globex" }, s.other);
    const old = (await enterpriseFor(s.store, s.it, SECRET))?.secret ?? "";
    expect(await enterpriseForSecret(s.store, SECRET, old)).toEqual({
      enterpriseId: id,
      signed: true,
    });
    const renewed = await renewSecret(s.store, s.it, SECRET);
    if (!renewed.ok)
      throw new Error(`renew refused: ${JSON.stringify(renewed)}`);
    expect(renewed.secret).not.toBe(old);
    expect((await enterpriseFor(s.store, s.it, SECRET))?.secret).toBe(
      renewed.secret,
    );
    expect(await enterpriseForSecret(s.store, SECRET, renewed.secret)).toEqual({
      enterpriseId: id,
      signed: true,
    });
    const globexSecret = enterpriseSecret(SECRET, globex, 1);
    for (const bad of [
      old,
      "",
      "isx_ent_",
      `isx_ent_${id}`,
      `isx_ent_${id}_`,
      // Acme's MAC under Globex's id, and the other way round.
      renewed.secret.replace(id, globex),
      globexSecret.replace(globex, id),
      // The right shape, made under another AUTH_SECRET.
      enterpriseSecret("another-auth-secret-0123456789abcdef", id, 2),
      `${renewed.secret}x`,
    ]) {
      expect({
        bad,
        found: await enterpriseForSecret(s.store, SECRET, bad),
      }).toEqual({
        bad,
        found: null,
      });
    }
    expect(await enterpriseForSecret(s.store, SECRET, globexSecret)).toEqual({
      enterpriseId: globex,
      signed: true,
    });
    expect((await auditOf(s, id)).map((r) => r.action)).toEqual([
      "enterprise.created",
      "enterprise.signed",
      "enterprise.secret_renewed",
    ]);
  });

  test("starts with the prefix, carries no AUTH_SECRET text, and changes with each input", () => {
    const a = enterpriseSecret(SECRET, "ent-1", 1);
    expect(a.startsWith("isx_ent_")).toBe(true);
    expect(a.includes(SECRET)).toBe(false);
    expect(
      new Set([
        a,
        enterpriseSecret(SECRET, "ent-1", 2),
        enterpriseSecret(SECRET, "ent-2", 1),
        enterpriseSecret(`${SECRET}0`, "ent-1", 1),
      ]).size,
    ).toBe(4);
    expect(enterpriseSecret(SECRET, "ent-1", 1)).toBe(a);
  });
});

describe("a negotiated account", () => {
  test("is signed outside the page: usable at once, its price note shown, never signed on the page", async () => {
    const s = await setup();
    const start = Date.parse("2027-02-01T00:00:00Z");
    const result = await createNegotiatedEnterprise(s.store, {
      email: "it@acme.example",
      company: "Acme Inc.",
      plan: "yearly",
      seats: 300,
      priceNote: "$18 per seat per month, paid yearly",
      start,
    });
    if (!result.ok)
      throw new Error(`negotiated refused: ${JSON.stringify(result)}`);
    const view = await enterpriseFor(s.store, s.it, SECRET);
    expect(view).toMatchObject({
      id: result.id,
      company: "Acme Inc.",
      // Defaults to the sign-in's email.
      billingEmail: "it@acme.example",
      plan: "yearly",
      seats: 300,
      kind: "negotiated",
      priceNote: "$18 per seat per month, paid yearly",
      contractStart: start,
    });
    expect(view?.secret).toBe(enterpriseSecret(SECRET, result.id, 1));
    expect(
      await enterpriseForSecret(s.store, SECRET, view?.secret ?? ""),
    ).toEqual({ enterpriseId: result.id, signed: true });
    expect(
      await signAgreement(s.store, s.it, {
        name: "Ada Admin",
        title: "IT Director",
        authority: true,
      }),
    ).toEqual({ ok: false, reason: "negotiated" });
    expect(await changeSeats(s.store, s.it, { from: 300, to: 310 })).toEqual({
      ok: true,
      seats: 310,
    });
    const [first] = await auditOf(s, result.id);
    expect({
      actor: first?.actor,
      instance_id: first?.instance_id,
      action: first?.action,
    }).toEqual({
      actor: "operator",
      instance_id: null,
      action: "enterprise.created",
    });
  });

  test("starts now by default, needs an existing sign-in, and is one per sign-in", async () => {
    const s = await setup();
    const base = {
      company: "Acme Inc.",
      plan: "monthly" as const,
      seats: 100,
      priceNote: "custom",
    };
    expect(
      await createNegotiatedEnterprise(s.store, {
        ...base,
        email: "nobody@acme.example",
      }),
    ).toEqual({ ok: false, reason: "no_account" });
    const made = await createNegotiatedEnterprise(s.store, {
      ...base,
      email: "it@acme.example",
    });
    expect(made.ok).toBe(true);
    expect((await enterpriseFor(s.store, s.it, SECRET))?.contractStart).toBe(
      T0,
    );
    expect(
      await createNegotiatedEnterprise(s.store, {
        ...base,
        email: "it@acme.example",
      }),
    ).toEqual({ ok: false, reason: "exists" });
    // A standard account set up on the page blocks a negotiated one too.
    await created(s, {}, s.other);
    expect(
      await createNegotiatedEnterprise(s.store, {
        ...base,
        email: "it@globex.example",
      }),
    ).toEqual({ ok: false, reason: "exists" });
  });
});
