// Enterprise accounts at the store (task 71718489, slice S1): one account per
// storefront sign-in, the standard agreement, the seat count N and who may
// change it, the secret and its generations, a negotiated account from the
// operator CLI, and the audit row each change leaves. Slice S2: the seat
// service an office calls with the secret (recordSeats), and IT's rename and
// remove of an office.
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
  MAX_OFFICES,
  recordSeats,
  removeOffice,
  renameOffice,
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

// ------------------------------------------------------------------ S2

const A = "a".repeat(32);
const B = "b".repeat(32);

function secretOf(enterpriseId: string, generation = 1): string {
  return enterpriseSecret(SECRET, enterpriseId, generation);
}

function seat(office: string, members: number, add: boolean) {
  return { office, members, add };
}

function call(s: Setup, secret: string, body: unknown) {
  return recordSeats(s.store, SECRET, secret, body);
}

/** The office rows of an account, as stored, removed ones too. */
async function officeRows(s: Setup, enterpriseId: string) {
  const rows = await sql(
    s,
    "select id, name, members, joined_at, last_seen_at, removed_at " +
      "from enterprise_offices where enterprise_id = $1 order by id",
    [enterpriseId],
  );
  return rows.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string | null,
    members: Number(r.members),
    joinedAt: Number(r.joined_at),
    lastSeenAt: Number(r.last_seen_at),
    removedAt: r.removed_at === null ? null : Number(r.removed_at),
  }));
}

async function officeAudit(s: Setup, enterpriseId: string) {
  return (await auditOf(s, enterpriseId)).filter(
    (r) =>
      r.action.startsWith("enterprise.office_") ||
      r.action === "enterprise.seats_raised",
  );
}

/** Resolves once a statement on enterprise_accounts waits on a row lock.
 * Throws when `settled` turns true first: the call never waited. */
async function parkedOnRow(s: Setup, settled: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const waiting = await sql(
      s,
      "select count(*)::int as n from pg_stat_activity where " +
        "wait_event_type = 'Lock' and datname = current_database() " +
        "and query ilike '%enterprise_accounts%'",
    );
    if (waiting.rows[0].n > 0) return;
    if (settled() || Date.now() > deadline)
      throw new Error("the call never waited on the account row");
    await Bun.sleep(10);
  }
}

describe("the seat service: refusals", () => {
  test("a bad secret is refused before the body is looked at, and nothing is written", async () => {
    const s = await setup();
    const id = await signed(s);
    const globex = await signed(s, { company: "Globex" }, s.other);
    const renewed = await renewSecret(s.store, s.it, SECRET);
    if (!renewed.ok) throw new Error("renew refused");
    const bads = [
      "",
      "isx_ent_",
      `isx_ent_${id}_`,
      // The secret before "Make a new secret".
      secretOf(id, 1),
      // The right shape under another AUTH_SECRET.
      enterpriseSecret("another-auth-secret-0123456789abcdef", id, 2),
      // Acme's MAC under Globex's id.
      renewed.secret.replace(id, globex),
      // An id no account has.
      secretOf("ent-00000000-0000-4000-8000-000000000000"),
    ];
    // A good body, a body that did not parse, and a bad body.
    const bodies = [seat(A, 1, false), undefined, { office: "nope" }];
    for (const bad of bads) {
      for (const body of bodies) {
        expect({ bad, body, result: await call(s, bad, body) }).toEqual({
          bad,
          body,
          result: { ok: false, reason: "bad_secret" },
        });
      }
    }
    expect(await officeRows(s, id)).toEqual([]);
    expect(await officeRows(s, globex)).toEqual([]);
    expect((await auditOf(s, id)).map((r) => r.action)).toEqual([
      "enterprise.created",
      "enterprise.signed",
      "enterprise.secret_renewed",
    ]);
    // The control: the current secret with the good body joins.
    expect(await call(s, renewed.secret, seat(A, 1, false))).toMatchObject({
      ok: true,
      inUse: 1,
    });
  });

  test("with a good secret, a bad body is bad_request; the bounds themselves pass", async () => {
    const s = await setup();
    const id = await signed(s, { seats: 10_000 });
    const secret = secretOf(id);
    const bads: unknown[] = [
      undefined,
      null,
      [],
      "body",
      5,
      {},
      { office: A, members: 1 },
      { office: A, members: 1, add: "true" },
      { office: A, members: 1, add: 1 },
      { office: A.toUpperCase(), members: 1, add: false },
      { office: "a".repeat(31), members: 1, add: false },
      { office: "a".repeat(33), members: 1, add: false },
      { office: "g".repeat(32), members: 1, add: false },
      { office: 7, members: 1, add: false },
      { members: 1, add: false },
      { office: A, members: -1, add: false },
      { office: A, members: 100_001, add: false },
      { office: A, members: 2.5, add: false },
      { office: A, members: "5", add: false },
      { office: A, members: Number.NaN, add: false },
      { office: A, add: false },
    ];
    for (const body of bads) {
      expect({ body, result: await call(s, secret, body) }).toEqual({
        body,
        result: { ok: false, reason: "bad_request" },
      });
    }
    expect(await officeRows(s, id)).toEqual([]);
    expect(await call(s, secret, seat(A, 0, true))).toMatchObject({
      ok: true,
      inUse: 0,
      offices: 1,
    });
    expect(await call(s, secret, seat(B, 100_000, false))).toMatchObject({
      ok: true,
      inUse: 100_000,
      offices: 2,
    });
  });

  test("an account not signed yet: a bad body is still bad_request, a good one not_signed", async () => {
    const s = await setup();
    const id = await created(s);
    const secret = secretOf(id);
    expect(await call(s, secret, undefined)).toEqual({
      ok: false,
      reason: "bad_request",
    });
    expect(await call(s, secret, { office: "nope" })).toEqual({
      ok: false,
      reason: "bad_request",
    });
    for (const add of [true, false]) {
      expect(await call(s, secret, seat(A, 1, add))).toEqual({
        ok: false,
        reason: "not_signed",
      });
    }
    expect(await officeRows(s, id)).toEqual([]);
  });
});

describe("the seat service: seats", () => {
  test("a first call joins the office (audited); a later check-in records the count and the time, unaudited", async () => {
    const s = await setup();
    const id = await signed(s);
    const secret = secretOf(id);
    expect(await call(s, secret, seat(A, 10, true))).toEqual({
      ok: true,
      company: "Acme Inc.",
      kind: "standard",
      seats: 50,
      inUse: 10,
      offices: 1,
    });
    clock = T0 + DAY;
    expect(await call(s, secret, seat(A, 12, false))).toEqual({
      ok: true,
      company: "Acme Inc.",
      kind: "standard",
      seats: 50,
      inUse: 12,
      offices: 1,
    });
    expect(await call(s, secret, seat(B, 3, false))).toMatchObject({
      ok: true,
      inUse: 15,
      offices: 2,
    });
    expect(await officeRows(s, id)).toEqual([
      {
        id: A,
        name: null,
        members: 12,
        joinedAt: T0,
        lastSeenAt: T0 + DAY,
        removedAt: null,
      },
      {
        id: B,
        name: null,
        members: 3,
        joinedAt: T0 + DAY,
        lastSeenAt: T0 + DAY,
        removedAt: null,
      },
    ]);
    const view = await enterpriseFor(s.store, s.it, SECRET);
    expect(view?.inUse).toBe(15);
    expect(view?.offices.map((o) => o.id)).toEqual([A, B]);
    expect(await officeAudit(s, id)).toEqual([
      {
        actor: `office:${A}`,
        instance_id: null,
        action: "enterprise.office_joined",
        detail: A,
      },
      {
        actor: `office:${B}`,
        instance_id: null,
        action: "enterprise.office_joined",
        detail: B,
      },
    ]);
  });

  test("an add past the seats is refused with the count and writes nothing; up to the seats it passes", async () => {
    const s = await setup();
    const id = await signed(s);
    const secret = secretOf(id);
    await call(s, secret, seat(A, 30, false));
    // A new office: the others' 30 + 21 > 50.
    expect(await call(s, secret, seat(B, 21, true))).toEqual({
      ok: false,
      reason: "seats_full",
      seats: 50,
      inUse: 30,
    });
    expect((await officeRows(s, id)).map((o) => o.id)).toEqual([A]);
    // Exactly the seats passes.
    expect(await call(s, secret, seat(B, 20, true))).toMatchObject({
      ok: true,
      seats: 50,
      inUse: 50,
    });
    // An office's own recorded count is not counted twice against it.
    expect(await call(s, secret, seat(A, 30, true))).toMatchObject({
      ok: true,
      inUse: 50,
    });
    clock = T0 + DAY;
    expect(await call(s, secret, seat(B, 21, true))).toEqual({
      ok: false,
      reason: "seats_full",
      seats: 50,
      inUse: 50,
    });
    const b = (await officeRows(s, id)).find((o) => o.id === B);
    expect({ members: b?.members, lastSeenAt: b?.lastSeenAt }).toEqual({
      members: 20,
      lastSeenAt: T0,
    });
    expect((await enterpriseFor(s.store, s.it, SECRET))?.seats).toBe(50);
    expect((await officeAudit(s, id)).map((r) => r.action).sort()).toEqual([
      "enterprise.office_joined",
      "enterprise.office_joined",
    ]);
  });

  test("a check-in over the seats raises them to the count in use, audited; an add then counts against the new seats", async () => {
    const s = await setup();
    const id = await signed(s);
    const secret = secretOf(id);
    await call(s, secret, seat(A, 30, false));
    expect(await call(s, secret, seat(B, 25, false))).toEqual({
      ok: true,
      company: "Acme Inc.",
      kind: "standard",
      seats: 55,
      inUse: 55,
      offices: 2,
    });
    expect((await enterpriseFor(s.store, s.it, SECRET))?.seats).toBe(55);
    // IT's change from the N it saw before the raise is stale.
    expect(await changeSeats(s.store, s.it, { from: 50, to: 60 })).toEqual({
      ok: false,
      reason: "stale",
      seats: 55,
      inUse: 55,
    });
    expect(await call(s, secret, seat(B, 26, true))).toEqual({
      ok: false,
      reason: "seats_full",
      seats: 55,
      inUse: 55,
    });
    // A release never lowers N.
    expect(await call(s, secret, seat(A, 20, false))).toMatchObject({
      ok: true,
      seats: 55,
      inUse: 45,
    });
    expect(
      (await officeAudit(s, id)).filter(
        (r) => r.action === "enterprise.seats_raised",
      ),
    ).toEqual([
      {
        actor: `office:${B}`,
        instance_id: null,
        action: "enterprise.seats_raised",
        detail: "50 -> 55",
      },
    ]);
  });

  test("a raise past the seat bound is recorded, and IT can lower N again once the offices report fewer", async () => {
    const s = await setup();
    const id = await signed(s);
    const secret = secretOf(id);
    expect(await call(s, secret, seat(A, 12_000, false))).toMatchObject({
      ok: true,
      seats: 12_000,
      inUse: 12_000,
    });
    await call(s, secret, seat(A, 30, false));
    // `from` is the N IT saw, not a new count: above the bound it still
    // names the current N.
    expect(
      await changeSeats(s.store, s.it, { from: 12_000, to: 9_000 }),
    ).toEqual({ ok: true, seats: 9_000 });
  });

  test("the same office id under another account is another office; a negotiated account answers its kind", async () => {
    const s = await setup();
    const id = await signed(s);
    const made = await createNegotiatedEnterprise(s.store, {
      email: "it@globex.example",
      company: "Globex",
      plan: "monthly",
      seats: 100,
      priceNote: "custom",
    });
    if (!made.ok) throw new Error("negotiated refused");
    expect(await call(s, secretOf(made.id), seat(A, 70, false))).toEqual({
      ok: true,
      company: "Globex",
      kind: "negotiated",
      seats: 100,
      inUse: 70,
      offices: 1,
    });
    expect(await call(s, secretOf(id), seat(A, 1, true))).toMatchObject({
      ok: true,
      seats: 50,
      inUse: 1,
      offices: 1,
    });
    expect((await officeRows(s, made.id))[0]?.members).toBe(70);
    expect((await officeRows(s, id))[0]?.members).toBe(1);
  });

  test("past MAX_OFFICES active offices a new or returning office is bad_request; a joined office keeps working", async () => {
    const s = await setup();
    const id = await signed(s);
    const secret = secretOf(id);
    // MAX_OFFICES - 1 active offices of no members.
    await sql(
      s,
      "insert into enterprise_offices (enterprise_id, id, members, joined_at, last_seen_at) " +
        "select $1, lpad(to_hex(n), 32, '0'), 0, $2, $2 from generate_series(1, $3::int) as n",
      [id, T0, MAX_OFFICES - 1],
    );
    expect(await call(s, secret, seat(A, 0, false))).toMatchObject({
      ok: true,
      offices: MAX_OFFICES,
    });
    expect(await call(s, secret, seat(B, 0, false))).toEqual({
      ok: false,
      reason: "bad_request",
    });
    expect((await officeRows(s, id)).some((o) => o.id === B)).toBe(false);
    expect(await call(s, secret, seat(A, 1, true))).toMatchObject({
      ok: true,
      inUse: 1,
    });
    // A removed office frees a place; then it is the one past the bound.
    expect(await removeOffice(s.store, s.it, { office: A })).toEqual({
      ok: true,
    });
    expect(await call(s, secret, seat(B, 0, false))).toMatchObject({
      ok: true,
      offices: MAX_OFFICES,
    });
    expect(await call(s, secret, seat(A, 1, false))).toEqual({
      ok: false,
      reason: "bad_request",
    });
    expect((await officeRows(s, id)).find((o) => o.id === A)?.removedAt).toBe(
      T0,
    );
  });
});

describe("the seat service: the account row lock", () => {
  test("two adds on the last seats: a call waits for the writer that holds the row, then counts its office", async () => {
    const s = await setup();
    const id = await signed(s);
    const other = new pg.Client({ connectionString: s.dsn });
    await other.connect();
    try {
      // Another call holds the row and has recorded 49 members, uncommitted.
      await other.query("begin");
      await other.query(
        "select id from enterprise_accounts where id = $1 for update",
        [id],
      );
      await other.query(
        "insert into enterprise_offices (enterprise_id, id, members, joined_at, last_seen_at) " +
          "values ($1, $2, 49, $3, $3)",
        [id, A, T0],
      );
      let settled = false;
      const add = call(s, secretOf(id), seat(B, 2, true)).finally(() => {
        settled = true;
      });
      await parkedOnRow(s, () => settled);
      await other.query("commit");
      // A count read before the lock sees 0 others and lets 51 in.
      expect(await add).toEqual({
        ok: false,
        reason: "seats_full",
        seats: 50,
        inUse: 49,
      });
    } finally {
      await other.query("rollback").catch(() => {});
      await other.end();
    }
    expect((await officeRows(s, id)).map((o) => o.id)).toEqual([A]);
  });

  test("a new secret that commits while a call waits on the row wins: the old secret is refused", async () => {
    const s = await setup();
    const id = await signed(s);
    const other = new pg.Client({ connectionString: s.dsn });
    await other.connect();
    try {
      // "Make a new secret" in flight: the generation is bumped, uncommitted.
      await other.query("begin");
      await other.query(
        "update enterprise_accounts set secret_generation = secret_generation + 1 " +
          "where id = $1",
        [id],
      );
      let settled = false;
      const checkIn = call(s, secretOf(id, 1), seat(A, 1, false)).finally(
        () => {
          settled = true;
        },
      );
      await parkedOnRow(s, () => settled);
      await other.query("commit");
      // A MAC checked only before the lock passes on generation 1.
      expect(await checkIn).toEqual({ ok: false, reason: "bad_secret" });
    } finally {
      await other.query("rollback").catch(() => {});
      await other.end();
    }
    expect(await officeRows(s, id)).toEqual([]);
    expect(await call(s, secretOf(id, 2), seat(A, 1, false))).toMatchObject({
      ok: true,
    });
  });
});

describe("IT renames and removes an office", () => {
  test("a removed office leaves the count and rejoins on its next call, with its name and first join", async () => {
    const s = await setup();
    const id = await signed(s);
    const secret = secretOf(id);
    await call(s, secret, seat(A, 10, false));
    await call(s, secret, seat(B, 5, false));
    expect(
      await renameOffice(s.store, s.it, { office: A, name: "  Berlin  " }),
    ).toEqual({ ok: true });
    expect(
      (await enterpriseFor(s.store, s.it, SECRET))?.offices.map((o) => [
        o.id,
        o.name,
      ]),
    ).toEqual([
      [A, "Berlin"],
      [B, null],
    ]);
    clock = T0 + DAY;
    expect(await removeOffice(s.store, s.it, { office: A })).toEqual({
      ok: true,
    });
    const view = await enterpriseFor(s.store, s.it, SECRET);
    expect({
      inUse: view?.inUse,
      offices: view?.offices.map((o) => o.id),
    }).toEqual({ inUse: 5, offices: [B] });
    expect(await removeOffice(s.store, s.it, { office: A })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      await renameOffice(s.store, s.it, { office: A, name: "Paris" }),
    ).toEqual({ ok: false, reason: "not_found" });
    // A's 10 no longer count: 45 fits in 50.
    expect(await call(s, secret, seat(B, 45, true))).toMatchObject({
      ok: true,
      inUse: 45,
    });
    // A refused add keeps the removed office removed.
    expect(await call(s, secret, seat(A, 10, true))).toEqual({
      ok: false,
      reason: "seats_full",
      seats: 50,
      inUse: 45,
    });
    expect(
      (await enterpriseFor(s.store, s.it, SECRET))?.offices.map((o) => o.id),
    ).toEqual([B]);
    clock = T0 + 2 * DAY;
    expect(await call(s, secret, seat(A, 3, false))).toMatchObject({
      ok: true,
      inUse: 48,
      offices: 2,
    });
    expect((await officeRows(s, id)).find((o) => o.id === A)).toEqual({
      id: A,
      name: "Berlin",
      members: 3,
      joinedAt: T0,
      lastSeenAt: T0 + 2 * DAY,
      removedAt: null,
    });
    expect(await officeAudit(s, id)).toEqual([
      {
        actor: `office:${A}`,
        instance_id: null,
        action: "enterprise.office_joined",
        detail: A,
      },
      {
        actor: `office:${B}`,
        instance_id: null,
        action: "enterprise.office_joined",
        detail: B,
      },
      {
        actor: `account:${s.it}`,
        instance_id: null,
        action: "enterprise.office_renamed",
        detail: A,
      },
      {
        actor: `account:${s.it}`,
        instance_id: null,
        action: "enterprise.office_removed",
        detail: A,
      },
      {
        actor: `office:${A}`,
        instance_id: null,
        action: "enterprise.office_joined",
        detail: A,
      },
    ]);
  });

  test("acts only on the caller's own offices and refuses a bad name", async () => {
    const s = await setup();
    const id = await signed(s);
    const globex = await signed(s, { company: "Globex" }, s.other);
    await call(s, secretOf(id), seat(A, 1, false));
    await call(s, secretOf(globex), seat(A, 2, false));
    // Globex's IT names and removes its own A, never Acme's.
    expect(
      await renameOffice(s.store, s.other, { office: A, name: "Paris" }),
    ).toEqual({ ok: true });
    expect(await removeOffice(s.store, s.other, { office: A })).toEqual({
      ok: true,
    });
    expect(
      (await enterpriseFor(s.store, s.it, SECRET))?.offices.map((o) => [
        o.id,
        o.name,
      ]),
    ).toEqual([[A, null]]);
    expect(
      await renameOffice(s.store, s.it, { office: B, name: "Rome" }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await removeOffice(s.store, s.it, { office: B })).toEqual({
      ok: false,
      reason: "not_found",
    });
    for (const name of ["", "   ", "x".repeat(101), 5, null]) {
      expect({
        name,
        result: await renameOffice(s.store, s.it, { office: A, name }),
      }).toEqual({ name, result: { ok: false, reason: "invalid" } });
    }
    expect(
      await renameOffice(s.store, s.it, { office: A, name: "x".repeat(100) }),
    ).toEqual({ ok: true });
    const nobody = (await accountForDevSignIn(s.store, "it@initech.example"))
      .id;
    expect(
      await renameOffice(s.store, nobody, { office: A, name: "Oslo" }),
    ).toEqual({ ok: false, reason: "no_account" });
    expect(await removeOffice(s.store, nobody, { office: A })).toEqual({
      ok: false,
      reason: "no_account",
    });
    expect((await officeRows(s, id))[0]).toMatchObject({
      name: "x".repeat(100),
      removedAt: null,
    });
  });
});
