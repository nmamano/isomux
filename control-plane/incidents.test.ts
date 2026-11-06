// The critical-issue status pages, at the store: who may open and post, how
// updates are numbered and closed, what the customer's private link reaches,
// the write key, and when an issue is due or late (agreement section 7: an
// update at least every hour until the issue is resolved).
//
// The routes, the pages and the web role's grants are in
// web-incidents.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import {
  incidentsWithKey,
  openIncident,
  opsIncidents,
  postUpdateAsOperator,
  postUpdateWithKey,
  remakeStatusLink,
  rotateIncidentKey,
  statusIncidentFor,
  statusListFor,
  statusToken,
  type IncidentUpdateInput,
  type OpenIncidentInput,
  type PostedUpdate,
} from "./incidents.ts";
import { setOperator } from "./operator-admin.ts";
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

const SECRET = "incidents-test-secret-0123456789abcdef";
const T0 = Date.parse("2027-06-10T00:00:00Z");
const MIN = 60_000;

/** Every store in a test reads this clock; a test moves it. */
let clock = T0;

interface Setup {
  store: Store;
  dsn: string;
  operator: string;
  plain: string;
}

async function setup(): Promise<Setup> {
  clock = T0;
  const dsn = await testDsn();
  const store = await openTestStoreOn(dsn, () => clock);
  const operator = (await accountForDevSignIn(store, "eng@example.test")).id;
  const plain = (await accountForDevSignIn(store, "someone@example.test")).id;
  const granted = await setOperator(store, {
    email: "eng@example.test",
    on: true,
    actor: "cli:test",
  });
  expect(granted.ok).toBe(true);
  return { store, dsn, operator, plain };
}

function update(over: Partial<IncidentUpdateInput> = {}): IncidentUpdateInput {
  return {
    found: "The sync worker crashes on start.",
    doingNow: "Rolling back the last release.",
    estimateAt: clock + 90 * MIN,
    ...over,
  };
}

function opening(over: Partial<OpenIncidentInput> = {}): OpenIncidentInput {
  return {
    customerLabel: "Acme",
    contacts: ["ops@acme.example", "cto@acme.example"],
    kind: "critical",
    timeZone: "America/Los_Angeles",
    title: "Office down",
    first: update(),
    ...over,
  };
}

async function open(
  { store, operator }: Setup,
  over: Partial<OpenIncidentInput> = {},
): Promise<PostedUpdate> {
  const result = await openIncident(store, operator, opening(over));
  if (!result?.ok) throw new Error(`open refused: ${JSON.stringify(result)}`);
  return result.posted;
}

function tokenOf(posted: PostedUpdate): string {
  return statusToken(SECRET, posted.customerId, posted.linkGeneration);
}

describe("opening an issue", () => {
  test("opening posts the first update; issues are numbered per customer", async () => {
    const s = await setup();
    const a1 = await open(s);
    const a2 = await open(s, { title: "Mail stuck" });
    const b1 = await open(s, { customerLabel: "Beta" });

    expect([a1.n, a1.update.n, a1.update.author]).toEqual([1, 1, "engineer"]);
    expect(a1.contacts).toEqual(["ops@acme.example", "cto@acme.example"]);
    expect([a2.n, a2.customerId]).toEqual([2, a1.customerId]);
    expect(b1.n).toBe(1);
    expect(b1.customerId).not.toBe(a1.customerId);
  });

  test("opens at the same time for a new customer make one customer, numbered without a gap", async () => {
    const s = await setup();
    const other = await openTestStoreOn(s.dsn, () => clock);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        openIncident(
          i % 2 === 0 ? s.store : other,
          s.operator,
          opening({ customerLabel: "Gamma", title: `Issue ${i}` }),
        ),
      ),
    );
    const posted = results.map((r) => (r?.ok ? r.posted : null));
    expect(posted.every((p) => p !== null)).toBe(true);
    expect(new Set(posted.map((p) => p?.customerId)).size).toBe(1);
    expect(posted.map((p) => p?.n).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      [1, 2, 3, 4, 5, 6],
    );
  });

  test("a non-operator opens nothing and sees nothing", async () => {
    const s = await setup();
    expect(await openIncident(s.store, s.plain, opening())).toBeNull();
    expect(await opsIncidents(s.store, s.plain)).toBeNull();
    const view = await opsIncidents(s.store, s.operator);
    expect(view?.incidents).toHaveLength(0);
  });

  test("an input that breaks a rule is refused as invalid and writes nothing", async () => {
    const s = await setup();
    const cases: [string, Partial<OpenIncidentInput>][] = [
      ["unknown time zone", { timeZone: "Mars/Olympus_Mons" }],
      ["no contacts", { contacts: [] }],
      [
        "eleven contacts",
        {
          contacts: Array.from({ length: 11 }, (_, i) => `c${i}@acme.example`),
        },
      ],
      ["a contact that is not an address", { contacts: ["ops at acme"] }],
      ["empty title", { title: "" }],
      ["unknown kind", { kind: "minor" as never }],
      ["empty found", { first: update({ found: "" }) }],
      ["empty doing now", { first: update({ doingNow: "" }) }],
      ["found over 4000", { first: update({ found: "x".repeat(4001) }) }],
      ["no estimate", { first: update({ estimateAt: null }) }],
      ["estimate now", { first: update({ estimateAt: clock }) }],
      ["estimate in the past", { first: update({ estimateAt: clock - MIN }) }],
    ];
    for (const [name, over] of cases) {
      const result = await openIncident(s.store, s.operator, opening(over));
      expect({ name, result }).toMatchObject({
        name,
        result: { ok: false, refused: "invalid" },
      });
    }
    expect((await opsIncidents(s.store, s.operator))?.incidents).toHaveLength(
      0,
    );
    // The limits are limits, not off by one: 4000 characters and ten contacts
    // are accepted.
    const atLimit = await openIncident(
      s.store,
      s.operator,
      opening({
        contacts: Array.from({ length: 10 }, (_, i) => `c${i}@acme.example`),
        first: update({ found: "x".repeat(4000) }),
      }),
    );
    expect(atLimit?.ok).toBe(true);
  });
});

describe("posting updates", () => {
  test("updates number in order; the final one resolves the issue and nothing posts after it", async () => {
    const s = await setup();
    const opened = await open(s);
    const key = (await rotateIncidentKey(s.store, s.operator))?.key ?? "";

    clock = T0 + 30 * MIN;
    const second = await postUpdateAsOperator(
      s.store,
      s.operator,
      opened.incidentId,
      update(),
    );
    expect(second).toMatchObject({ ok: true, posted: { n: 1 } });
    if (!second?.ok) throw new Error("unreachable");
    expect(second.posted.update.n).toBe(2);
    expect(second.posted.contacts).toEqual(opened.contacts);

    clock = T0 + 50 * MIN;
    const final = await postUpdateAsOperator(
      s.store,
      s.operator,
      opened.incidentId,
      update({ estimateAt: null, final: true }),
    );
    expect(final).toMatchObject({
      ok: true,
      posted: { update: { n: 3, final: true, estimateAt: null } },
    });

    const view = await statusIncidentFor(s.store, SECRET, tokenOf(opened), 1);
    expect([view?.status, view?.resolvedAt]).toEqual([
      "resolved",
      T0 + 50 * MIN,
    ]);
    expect(view?.updates.map((u) => u.n)).toEqual([3, 2, 1]);

    clock = T0 + 55 * MIN;
    expect(
      await postUpdateAsOperator(
        s.store,
        s.operator,
        opened.incidentId,
        update(),
      ),
    ).toEqual({ ok: false, refused: "resolved" });
    expect(
      await postUpdateWithKey(s.store, key, opened.incidentId, update()),
    ).toEqual({ ok: false, refused: "resolved" });
  });

  test("a non-final update needs an estimate in the future", async () => {
    const s = await setup();
    const opened = await open(s);
    clock = T0 + 10 * MIN;
    for (const estimateAt of [null, clock, clock - MIN]) {
      const result = await postUpdateAsOperator(
        s.store,
        s.operator,
        opened.incidentId,
        update({ estimateAt }),
      );
      expect({ estimateAt, result }).toMatchObject({
        estimateAt,
        result: { ok: false, refused: "invalid" },
      });
    }
    const view = await statusIncidentFor(s.store, SECRET, tokenOf(opened), 1);
    expect(view?.updates).toHaveLength(1);
  });

  test("an unknown issue is not_found; a non-operator gets null", async () => {
    const s = await setup();
    const opened = await open(s);
    expect(
      await postUpdateAsOperator(s.store, s.operator, "no-such-id", update()),
    ).toEqual({ ok: false, refused: "not_found" });
    expect(
      await postUpdateAsOperator(s.store, s.plain, opened.incidentId, update()),
    ).toBeNull();
    const view = await statusIncidentFor(s.store, SECRET, tokenOf(opened), 1);
    expect(view?.updates).toHaveLength(1);
  });

  test("posts at the same time all land, numbered without a gap", async () => {
    const s = await setup();
    const other = await openTestStoreOn(s.dsn, () => clock);
    const opened = await open(s);
    clock = T0 + 5 * MIN;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        postUpdateAsOperator(
          i % 2 === 0 ? s.store : other,
          s.operator,
          opened.incidentId,
          update({ found: `finding ${i}` }),
        ),
      ),
    );
    expect(results.map((r) => r?.ok)).toEqual(Array(6).fill(true));
    const view = await statusIncidentFor(s.store, SECRET, tokenOf(opened), 1);
    expect(view?.updates.map((u) => u.n).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  test("a post racing the final update never lands after it", async () => {
    const s = await setup();
    const other = await openTestStoreOn(s.dsn, () => clock);
    const opened = await open(s);
    clock = T0 + 5 * MIN;
    const results = await Promise.all([
      postUpdateAsOperator(
        s.store,
        s.operator,
        opened.incidentId,
        update({ estimateAt: null, final: true }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        postUpdateAsOperator(
          i % 2 === 0 ? other : s.store,
          s.operator,
          opened.incidentId,
          update({ found: `racing ${i}` }),
        ),
      ),
    ]);
    expect(results[0]?.ok).toBe(true);
    for (const result of results.slice(1)) {
      if (!result?.ok)
        expect(result).toEqual({ ok: false, refused: "resolved" });
    }
    const view = await statusIncidentFor(s.store, SECRET, tokenOf(opened), 1);
    // Newest first: the final update is the last one posted.
    expect(view?.updates[0]?.final).toBe(true);
    expect(view?.updates.filter((u) => u.final)).toHaveLength(1);
  });
});

describe("the customer's private link", () => {
  test("it shows the customer's own issues, newest first, and nothing private", async () => {
    const s = await setup();
    const a1 = await open(s);
    clock = T0 + MIN;
    await open(s, { title: "Mail stuck" });
    await open(s, { customerLabel: "Beta", title: "Beta's outage" });

    const list = await statusListFor(s.store, SECRET, tokenOf(a1));
    expect(list?.customerLabel).toBe("Acme");
    expect(list?.incidents.map((i) => [i.n, i.title])).toEqual([
      [2, "Mail stuck"],
      [1, "Office down"],
    ]);

    const one = await statusIncidentFor(s.store, SECRET, tokenOf(a1), 1);
    expect(one).toMatchObject({
      customerLabel: "Acme",
      n: 1,
      title: "Office down",
      kind: "critical",
      status: "open",
      timeZone: "America/Los_Angeles",
    });
    expect(one?.updates.map((u) => u.author)).toEqual(["engineer"]);
    const shown = JSON.stringify([list, one]);
    for (const secret of [
      "ops@acme.example",
      "cto@acme.example",
      "eng@example.test",
      s.operator,
      a1.incidentId,
    ]) {
      expect({ secret, leaked: shown.includes(secret) }).toEqual({
        secret,
        leaked: false,
      });
    }
  });

  test("a wrong link reaches nothing, not even another customer's issue", async () => {
    const s = await setup();
    const a1 = await open(s);
    await open(s, { title: "Mail stuck" });
    const b1 = await open(s, { customerLabel: "Beta" });
    const acme = tokenOf(a1);
    const beta = tokenOf(b1);
    const flipped = acme.slice(0, -1) + (acme.endsWith("A") ? "B" : "A");

    // The control: the right link and number work.
    expect(await statusIncidentFor(s.store, SECRET, acme, 2)).not.toBeNull();
    expect(await statusIncidentFor(s.store, SECRET, beta, 1)).not.toBeNull();

    const wrong: [string, string, number][] = [
      ["Beta's link, Acme's second issue", beta, 2],
      ["unknown number", acme, 3],
      ["one character changed", flipped, 1],
      [
        "made with another secret",
        statusToken(
          "another-secret-0123456789abcdef",
          a1.customerId,
          a1.linkGeneration,
        ),
        1,
      ],
      [
        "the next generation",
        statusToken(SECRET, a1.customerId, a1.linkGeneration + 1),
        1,
      ],
      ["the customer id alone", a1.customerId, 1],
      ["empty", "", 1],
      ["garbage", "x.y", 1],
    ];
    for (const [name, token, n] of wrong) {
      expect({
        name,
        issue: await statusIncidentFor(s.store, SECRET, token, n),
      }).toEqual({ name, issue: null });
    }
    for (const [name, token] of wrong.slice(2)) {
      expect({
        name,
        list: await statusListFor(s.store, SECRET, token),
      }).toEqual({ name, list: null });
    }
  });

  test("re-making the link kills the old one", async () => {
    const s = await setup();
    const a1 = await open(s);
    const old = tokenOf(a1);
    expect(
      await remakeStatusLink(s.store, s.plain, SECRET, a1.customerId),
    ).toBeNull();
    expect(await statusListFor(s.store, SECRET, old)).not.toBeNull();

    const remade = await remakeStatusLink(
      s.store,
      s.operator,
      SECRET,
      a1.customerId,
    );
    expect(remade?.token).toBeString();
    expect(remade?.token).not.toBe(old);
    expect(await statusListFor(s.store, SECRET, old)).toBeNull();
    expect(await statusIncidentFor(s.store, SECRET, old, 1)).toBeNull();
    expect(
      (await statusListFor(s.store, SECRET, remade?.token ?? ""))
        ?.customerLabel,
    ).toBe("Acme");
    expect(
      await remakeStatusLink(s.store, s.operator, SECRET, "no-such-customer"),
    ).toBeNull();
  });
});

describe("the write key", () => {
  test("no key works until an operator makes one", async () => {
    const s = await setup();
    const opened = await open(s);
    for (const key of ["", "anything"]) {
      expect(
        await incidentsWithKey(s.store, key, { dueOnly: false }),
      ).toBeNull();
      expect(
        await postUpdateWithKey(s.store, key, opened.incidentId, update()),
      ).toBeNull();
    }
    expect(await rotateIncidentKey(s.store, s.plain)).toBeNull();
    const made = await rotateIncidentKey(s.store, s.operator);
    // At least 256 random bits, in any text encoding.
    expect(made?.key.length ?? 0).toBeGreaterThanOrEqual(43);
    expect(
      (
        await incidentsWithKey(s.store, made?.key ?? "", { dueOnly: false })
      )?.map((i) => i.id),
    ).toEqual([opened.incidentId]);
  });

  test("the key posts as the support agent; a rotated key stops working", async () => {
    const s = await setup();
    const opened = await open(s);
    const first = (await rotateIncidentKey(s.store, s.operator))?.key ?? "";
    clock = T0 + 10 * MIN;
    expect(
      await postUpdateWithKey(s.store, first, opened.incidentId, update()),
    ).toMatchObject({
      ok: true,
      posted: { update: { n: 2, author: "support_agent" } },
    });

    const second = (await rotateIncidentKey(s.store, s.operator))?.key ?? "";
    expect(second).not.toBe(first);
    expect(
      await postUpdateWithKey(s.store, first, opened.incidentId, update()),
    ).toBeNull();
    expect(
      await incidentsWithKey(s.store, first, { dueOnly: false }),
    ).toBeNull();
    expect(
      await postUpdateWithKey(s.store, second, opened.incidentId, update()),
    ).toMatchObject({ ok: true, posted: { update: { n: 3 } } });

    const ops = await opsIncidents(s.store, s.operator);
    expect(
      ops?.incidents[0]?.updates.map((u) => [u.author, u.authorRef]),
    ).toEqual([
      ["engineer", s.operator],
      ["support_agent", "key"],
      ["support_agent", "key"],
    ]);
    const customer = await statusIncidentFor(
      s.store,
      SECRET,
      tokenOf(opened),
      1,
    );
    expect(customer?.updates.map((u) => u.author)).toEqual([
      "support_agent",
      "support_agent",
      "engineer",
    ]);
  });
});

describe("due and late", () => {
  test("an issue is due 40 minutes after its last update and late after 60; a late gap stays on record", async () => {
    const s = await setup();
    const opened = await open(s);
    const key = (await rotateIncidentKey(s.store, s.operator))?.key ?? "";
    const due = () => incidentsWithKey(s.store, key, { dueOnly: true });
    const all = () => incidentsWithKey(s.store, key, { dueOnly: false });

    clock = T0 + 39 * MIN;
    expect(await due()).toEqual([]);
    expect((await all())?.map((i) => i.id)).toEqual([opened.incidentId]);

    clock = T0 + 40 * MIN;
    expect(await due()).toEqual([
      expect.objectContaining({
        id: opened.incidentId,
        n: 1,
        lastUpdateAt: T0,
        dueAt: T0 + 60 * MIN,
        lateByMs: 0,
      }),
    ]);

    clock = T0 + 75 * MIN;
    expect((await due())?.map((i) => i.lateByMs)).toEqual([15 * MIN]);
    const lateView = await opsIncidents(s.store, s.operator);
    expect(lateView?.incidents[0]).toMatchObject({
      dueAt: T0 + 60 * MIN,
      lateByMs: 15 * MIN,
    });

    // The late update lands; the issue is on time again, and the gap that
    // went late is still there as evidence.
    await postUpdateWithKey(s.store, key, opened.incidentId, update());
    clock = T0 + 76 * MIN;
    expect(await due()).toEqual([]);
    const view = await opsIncidents(s.store, s.operator);
    expect(view?.incidents[0]).toMatchObject({
      lastUpdateAt: T0 + 75 * MIN,
      dueAt: T0 + 135 * MIN,
      lateByMs: 0,
    });
    expect(
      view?.incidents[0]?.updates.map((u) => [u.n, u.gapMs, u.lateByMs]),
    ).toEqual([
      [1, 0, 0],
      [2, 75 * MIN, 15 * MIN],
    ]);

    // A resolved issue is never due, and not listed as open.
    await postUpdateWithKey(
      s.store,
      key,
      opened.incidentId,
      update({ estimateAt: null, final: true }),
    );
    clock = T0 + 300 * MIN;
    expect(await due()).toEqual([]);
    expect(await all()).toEqual([]);
    expect(
      (await opsIncidents(s.store, s.operator))?.incidents[0],
    ).toMatchObject({
      status: "resolved",
      dueAt: null,
      lateByMs: 0,
    });
  });
});
