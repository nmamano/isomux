// The welcome series pass: which step goes out when, to whom, and what stops
// it. The sender is injected (its wire shape is welcome-mail.test.ts's); what is
// under test is the selection, the advance and the schedule that wakes the
// pass, against a real database.
//
// The rules (task 9d2d7d16): the clock starts when the office first goes live.
// A step goes out only to a live office whose subscription is active and not
// cancelled, and not more than 48 hours late; otherwise it is skipped and the
// series moves on. The series ends with the office or the subscription. Every
// handled row advances BEFORE its mail goes out, whatever the outcome, so a
// handled row is never due again and no mail is sent twice.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { PROVISIONER_GRANTS, WEB_GRANTS } from "./roles.ts";
import { Store, type ServiceState, type WorkScheduleOptions } from "./store.ts";
import {
  freshDsn,
  openTestStore,
  openTestStoreOn,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
  TARGET_IS_LOCAL,
} from "./testing/pg.ts";
import {
  dropLeastPrivilegedRoles,
  leastPrivilegedDsn,
} from "./testing/least-privilege.ts";
import {
  WELCOME_MAIL_OFFSETS_MS,
  WELCOME_MAIL_STALE_MS,
  type sendWelcomeMail,
} from "./welcome-mail.ts";
import { watchWelcomeMail } from "./welcome-mail-watch.ts";

afterEach(releaseTestStores, PG_TEST_HOOK_TIMEOUT_MS);

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;
const POSTAL = "Isomux LLC, 1 Example Street, Springfield";

type Mail = Parameters<typeof sendWelcomeMail>[0];

/** A sender that records every mail and answers with `answer`. */
function sender(
  answer: (mail: Mail) => Awaited<ReturnType<typeof sendWelcomeMail>> = () => ({
    ok: true,
  }),
) {
  const sent: Mail[] = [];
  const send = (async (mail: Mail) => {
    sent.push(mail);
    return answer(mail);
  }) as typeof sendWelcomeMail;
  return { sent, send };
}

function clock(start = T0) {
  const state = { value: start };
  return { now: () => state.value, state };
}

async function account(store: Store, id: string, email: string) {
  await store.sqlRun(
    "insert into accounts (id, email, version, created_at, updated_at) values ($1, $2, 1, 0, 0)",
    [id, email],
  );
}

/** An office of `acct`, reserved by it, in `state`, with a subscription in
 * `sub` (null for none). */
async function office(
  store: Store,
  id: string,
  acct: string,
  opts: {
    state?: ServiceState;
    sub?: {
      status?: string;
      cancel_at_period_end?: number;
      canceled_at?: number | null;
      ended_at?: number | null;
    } | null;
  } = {},
) {
  await store.createInstance({
    id,
    run_id: null,
    name: `${id}.test.isomux.app`,
    plan: "V153",
    region: "EU",
    service_state: opts.state ?? "live",
    goal: "live",
    access_window_expires_at: null,
  });
  await store.sqlRun(
    "insert into name_reservations (name, id, account_id, instance_id, plan, " +
      "coupon_id, version, created_at, updated_at) values ($1, $2, $3, $4, 'V153', null, 1, 0, 0)",
    [`name-${id}`, `res-${id}`, acct, id],
  );
  if (opts.sub === null) return;
  const sub = opts.sub ?? {};
  await store.sqlRun(
    "insert into subscriptions (id, account_id, instance_id, stripe_customer_id, status, " +
      "cancel_at_period_end, canceled_at, ended_at, version, created_at, updated_at) " +
      "values ($1, $2, $3, $4, $5, $6, $7, $8, 1, 0, 0)",
    [
      `sub-${id}`,
      acct,
      id,
      `cus-${acct}`,
      sub.status ?? "active",
      sub.cancel_at_period_end ?? 0,
      sub.canceled_at ?? null,
      sub.ended_at ?? null,
    ],
  );
}

async function audits(store: Store, inst: string) {
  return (await store.auditEvents()).filter(
    (e) => e.action === "welcome_mail" && e.instance_id === inst,
  );
}

const SCHEDULE: WorkScheduleOptions = {
  providerConfigured: false,
  provisioningConfigured: false,
  checkoutConfigured: false,
  cadenceConfigured: false,
  livenessConfigured: true,
  welcomeMailConfigured: true,
  staleProvisioningMs: 30 * 60_000,
  staleProvisioningReason: "stalled",
};

describe("the series", () => {
  test("each step goes out at its offset, to the account's current address, then the series is over", async () => {
    const c = clock();
    const store = await openTestStore(c.now);
    await account(store, "acct-1", "owner@example.com");
    await office(store, "inst-1", "acct-1");
    await store.recordFirstLive("inst-1", T0);
    const token = (await store.getWelcomeMail("inst-1"))!.unsubscribe_token;
    const { sent, send } = sender();
    const deps = { apiKey: "re_k", send, postalAddress: POSTAL };

    expect(await watchWelcomeMail(store, deps)).toBe(1);
    expect(sent[0]).toMatchObject({
      to: "owner@example.com",
      step: 0,
      unsubscribeToken: token,
    });
    expect(new URL(sent[0].officeUrl).hostname).toBe("inst-1.test.isomux.app");
    expect(await store.getWelcomeMail("inst-1")).toMatchObject({
      next_step: 1,
      next_due_at: T0 + WELCOME_MAIL_OFFSETS_MS[1],
    });
    // Handled: the same moment sends nothing more.
    expect(await watchWelcomeMail(store, deps)).toBe(0);

    // The address is read at send time, not copied when the series started.
    await store.sqlRun("update accounts set email = $1 where id = 'acct-1'", [
      "renamed@example.com",
    ]);
    for (let step = 1; step < WELCOME_MAIL_OFFSETS_MS.length; step++) {
      c.state.value = T0 + WELCOME_MAIL_OFFSETS_MS[step] - 1;
      expect([step, await watchWelcomeMail(store, deps)]).toEqual([step, 0]);
      c.state.value = T0 + WELCOME_MAIL_OFFSETS_MS[step];
      expect([step, await watchWelcomeMail(store, deps)]).toEqual([step, 1]);
    }
    expect(sent.map((m) => m.step)).toEqual([0, 1, 2, 3, 4]);
    expect(sent.slice(1).map((m) => m.to)).toEqual(
      Array(4).fill("renamed@example.com"),
    );
    expect((await store.getWelcomeMail("inst-1"))?.next_due_at).toBeNull();
    c.state.value = T0 + 60 * DAY;
    expect(await watchWelcomeMail(store, deps)).toBe(0);
    expect((await audits(store, "inst-1")).map((a) => a.outcome)).toEqual(
      Array(5).fill("succeeded"),
    );
  });

  test("a later office of the same account gets the first mail only", async () => {
    const c = clock();
    const store = await openTestStore(c.now);
    await account(store, "acct-2", "two@example.com");
    await office(store, "inst-a", "acct-2");
    await office(store, "inst-b", "acct-2");
    await store.recordFirstLive("inst-a", T0);
    await store.recordFirstLive("inst-b", T0);
    expect((await store.getWelcomeMail("inst-a"))?.tips).toBe(1);
    expect((await store.getWelcomeMail("inst-b"))?.tips).toBe(0);
    const { sent, send } = sender();
    expect(
      await watchWelcomeMail(store, {
        apiKey: "k",
        send,
        postalAddress: POSTAL,
      }),
    ).toBe(2);
    expect((await store.getWelcomeMail("inst-a"))?.next_due_at).toBe(
      T0 + WELCOME_MAIL_OFFSETS_MS[1],
    );
    expect((await store.getWelcomeMail("inst-b"))?.next_due_at).toBeNull();
    c.state.value = T0 + WELCOME_MAIL_OFFSETS_MS[1];
    await watchWelcomeMail(store, { apiKey: "k", send, postalAddress: POSTAL });
    const steps = async (inst: string) => {
      const token = (await store.getWelcomeMail(inst))!.unsubscribe_token;
      return sent
        .filter((m) => m.unsubscribeToken === token)
        .map((m) => m.step);
    };
    expect(await steps("inst-a")).toEqual([0, 1]);
    expect(await steps("inst-b")).toEqual([0]);
  });

  test("recording first live twice changes nothing", async () => {
    const store = await openTestStore(() => T0);
    await account(store, "acct-3", "three@example.com");
    await office(store, "inst-3", "acct-3");
    await store.recordFirstLive("inst-3", T0);
    const first = await store.getWelcomeMail("inst-3");
    await store.recordFirstLive("inst-3", T0 + DAY);
    expect(await store.getWelcomeMail("inst-3")).toEqual(first);
  });
});

describe("skip and end", () => {
  // Each case: a due step 0 is not sent, and the row still moves on.
  const SKIPS: [string, Parameters<typeof office>[3]][] = [
    ["cancelled at period end", { sub: { cancel_at_period_end: 1 } }],
    ["cancellation recorded", { sub: { canceled_at: T0 - 1 } }],
    ["payment past due", { sub: { status: "past_due" } }],
    ["office suspended", { state: "suspended" }],
  ];
  for (const [label, opts] of SKIPS) {
    test(`skipped, and the series goes on: ${label}`, async () => {
      const store = await openTestStore(() => T0);
      await account(store, "acct-s", "s@example.com");
      await office(store, "inst-s", "acct-s", opts);
      await store.recordFirstLive("inst-s", T0);
      const { sent, send } = sender();
      expect(
        await watchWelcomeMail(store, {
          apiKey: "k",
          send,
          postalAddress: POSTAL,
        }),
      ).toBe(0);
      expect(sent).toEqual([]);
      expect(await store.getWelcomeMail("inst-s")).toMatchObject({
        next_step: 1,
        next_due_at: T0 + WELCOME_MAIL_OFFSETS_MS[1],
      });
      expect(await audits(store, "inst-s")).toHaveLength(1);
    });
  }

  const ENDS: [string, Parameters<typeof office>[3]][] = [
    ["office deprovisioned", { state: "deprovisioned" }],
    ["subscription ended", { sub: { ended_at: T0 - 1, canceled_at: T0 - 2 } }],
    ["no subscription", { sub: null }],
  ];
  for (const [label, opts] of ENDS) {
    test(`the series ends: ${label}`, async () => {
      const store = await openTestStore(() => T0);
      await account(store, "acct-e", "e@example.com");
      await office(store, "inst-e", "acct-e", opts);
      await store.recordFirstLive("inst-e", T0);
      const { sent, send } = sender();
      await watchWelcomeMail(store, {
        apiKey: "k",
        send,
        postalAddress: POSTAL,
      });
      expect(sent).toEqual([]);
      expect((await store.getWelcomeMail("inst-e"))?.next_due_at).toBeNull();
    });
  }

  test("a step more than 48 hours late is skipped; one within the window goes out", async () => {
    const c = clock(T0 + WELCOME_MAIL_STALE_MS + 1);
    const store = await openTestStore(c.now);
    await account(store, "acct-l", "l@example.com");
    await office(store, "inst-late", "acct-l");
    await office(store, "inst-edge", "acct-l");
    await store.recordFirstLive("inst-late", T0);
    await store.recordFirstLive("inst-edge", T0 + 1);
    const { sent, send } = sender();
    const deps = { apiKey: "k", send, postalAddress: POSTAL };
    // inst-late's day 0 is one millisecond past the window; inst-edge's is
    // exactly at its end.
    expect(await watchWelcomeMail(store, deps)).toBe(1);
    expect(sent.map((m) => m.step)).toEqual([0]);
    expect(sent[0].unsubscribeToken).toBe(
      (await store.getWelcomeMail("inst-edge"))!.unsubscribe_token,
    );
    expect((await store.getWelcomeMail("inst-late"))?.next_step).toBe(1);
    // Day 1 of inst-late is due and 24 hours late, inside its own window: the
    // next pass sends it, one step per pass.
    await watchWelcomeMail(store, deps);
    const late = (await store.getWelcomeMail("inst-late"))!.unsubscribe_token;
    expect(
      sent.filter((m) => m.unsubscribeToken === late).map((m) => m.step),
    ).toEqual([1]);
  });
});

describe("a send that fails", () => {
  test("is audited as failed, the row moves on, and it is not retried", async () => {
    const store = await openTestStore(() => T0);
    await account(store, "acct-f", "f@example.com");
    await office(store, "inst-f", "acct-f");
    await store.recordFirstLive("inst-f", T0);
    const { sent, send } = sender(() => ({
      ok: false,
      reason: "Resend answered 503",
    }));
    const deps = { apiKey: "k", send, postalAddress: POSTAL };
    expect(await watchWelcomeMail(store, deps)).toBe(0);
    expect(sent).toHaveLength(1);
    expect((await store.getWelcomeMail("inst-f"))?.next_step).toBe(1);
    expect((await audits(store, "inst-f")).map((a) => a.outcome)).toEqual([
      "failed",
    ]);
    await watchWelcomeMail(store, deps);
    expect(sent).toHaveLength(1);
  });

  test("a sender that throws for one office does not stop the next", async () => {
    const store = await openTestStore(() => T0);
    await account(store, "acct-t", "t@example.com");
    await office(store, "inst-t1", "acct-t");
    await office(store, "inst-t2", "acct-t");
    await store.recordFirstLive("inst-t1", T0);
    await store.recordFirstLive("inst-t2", T0);
    const reports: string[] = [];
    let calls = 0;
    const { sent, send } = sender(() => {
      if (calls++ === 0) throw new Error("scripted sender failure");
      return { ok: true };
    });
    expect(
      await watchWelcomeMail(store, {
        apiKey: "k",
        send,
        postalAddress: POSTAL,
        report: (line) => reports.push(line),
      }),
    ).toBe(1);
    expect(sent).toHaveLength(2);
    for (const inst of ["inst-t1", "inst-t2"])
      expect([inst, (await store.getWelcomeMail(inst))?.next_step]).toEqual([
        inst,
        1,
      ]);
    expect(reports.join("\n")).toContain("scripted sender failure");
  });
});

describe("unsubscribe", () => {
  test("covers every office of the account and no other account, once", async () => {
    const c = clock();
    const store = await openTestStore(c.now);
    await account(store, "acct-u", "u@example.com");
    await account(store, "acct-other", "other@example.com");
    await office(store, "inst-u1", "acct-u");
    await office(store, "inst-u2", "acct-u");
    await office(store, "inst-o", "acct-other");
    for (const inst of ["inst-u1", "inst-u2", "inst-o"])
      await store.recordFirstLive(inst, T0);
    const token = (await store.getWelcomeMail("inst-u2"))!.unsubscribe_token;

    expect(await store.unsubscribeWelcomeMail(token, T0 + 5)).toBe(2);
    for (const inst of ["inst-u1", "inst-u2"])
      expect([inst, (await store.getWelcomeMail(inst))?.opted_out_at]).toEqual([
        inst,
        T0 + 5,
      ]);
    expect((await store.getWelcomeMail("inst-o"))?.opted_out_at).toBeNull();
    // A second click keeps the first moment.
    await store.unsubscribeWelcomeMail(token, T0 + 9);
    expect((await store.getWelcomeMail("inst-u1"))?.opted_out_at).toBe(T0 + 5);
    expect(await store.unsubscribeWelcomeMail("no-such-token", T0)).toBe(0);

    const { sent, send } = sender();
    await watchWelcomeMail(store, { apiKey: "k", send, postalAddress: POSTAL });
    expect(sent.map((m) => m.to)).toEqual(["other@example.com"]);
  });

  test("an account that opted out stays out for its next office", async () => {
    const c = clock();
    const store = await openTestStore(c.now);
    await account(store, "acct-n", "n@example.com");
    // Suspended, so only the welcome rows can add to the schedule below.
    await office(store, "inst-n1", "acct-n", { state: "suspended" });
    await office(store, "inst-n2", "acct-n", { state: "suspended" });
    await store.recordFirstLive("inst-n1", T0);
    await store.unsubscribeWelcomeMail(
      (await store.getWelcomeMail("inst-n1"))!.unsubscribe_token,
      T0 + 1,
    );
    c.state.value = T0 + 10 * DAY;
    await store.recordFirstLive("inst-n2", c.now());
    expect(
      (await store.getWelcomeMail("inst-n2"))?.opted_out_at,
    ).not.toBeNull();
    const { sent, send } = sender();
    await watchWelcomeMail(store, { apiKey: "k", send, postalAddress: POSTAL });
    expect(sent).toEqual([]);
    // Nothing of the account is due, so nothing wakes the loop for it.
    const schedule = await store.workSchedule(c.now(), 1, 1, SCHEDULE);
    expect(schedule.livenessDue).toBe(false);
    expect(schedule.nextDueAt).toBeNull();
  });

  test("an opt-out between the read and the advance wins: the advance refuses", async () => {
    const store = await openTestStore(() => T0);
    await account(store, "acct-r", "r@example.com");
    await office(store, "inst-r", "acct-r");
    await store.recordFirstLive("inst-r", T0);
    const [row] = await store.dueWelcomeMails(T0);
    expect(row.instance_id).toBe("inst-r");
    await store.unsubscribeWelcomeMail(row.unsubscribe_token, T0);
    expect(
      await store.advanceWelcomeMail("inst-r", row.version, {
        next_step: 1,
        next_due_at: T0 + DAY,
      }),
    ).toBeNull();
    // Without the opt-out the same advance wins, and only once.
    await office(store, "inst-r2", "acct-other-r");
    await store.recordFirstLive("inst-r2", T0);
    const fresh = (await store.getWelcomeMail("inst-r2"))!;
    const next = { next_step: 1, next_due_at: T0 + DAY };
    expect(
      await store.advanceWelcomeMail("inst-r2", fresh.version, next),
    ).toMatchObject(next);
    expect(
      await store.advanceWelcomeMail("inst-r2", fresh.version, next),
    ).toBeNull();
  });
});

// The pass runs only when the schedule says the watch class is due. The two
// must agree exactly: a clause that is true for a row the pass does not handle
// is a hot loop, and a row the clause misses is a mail that never goes out.
describe("the schedule", () => {
  // Suspended, so the liveness and certificate checks (live offices only) add
  // nothing: what the schedule shows is the welcome row alone.
  async function bed() {
    const c = clock();
    const store = await openTestStore(c.now);
    await account(store, "acct-w", "w@example.com");
    await office(store, "inst-w", "acct-w", { state: "suspended" });
    return { c, store };
  }

  async function agree(store: Store, now: number) {
    const schedule = await store.workSchedule(now, 1, 1, SCHEDULE);
    const due = await store.dueWelcomeMails(now);
    expect(schedule.livenessDue).toBe(due.length > 0);
    return { schedule, due };
  }

  test("the clause selects exactly the rows the pass handles, and a handled row is idle", async () => {
    const { c, store } = await bed();
    expect((await agree(store, T0)).due).toEqual([]);
    await store.recordFirstLive("inst-w", T0);
    const first = await agree(store, T0);
    expect(first.due.map((r) => r.instance_id)).toEqual(["inst-w"]);
    expect(first.schedule.nextDueAt).toBe(T0);

    await watchWelcomeMail(store, {
      apiKey: "k",
      send: sender().send,
      postalAddress: POSTAL,
    });
    const handled = await agree(store, T0);
    expect(handled.due).toEqual([]);
    expect(handled.schedule.nextDueAt).toBe(T0 + WELCOME_MAIL_OFFSETS_MS[1]);

    c.state.value = T0 + WELCOME_MAIL_OFFSETS_MS[1];
    expect((await agree(store, c.now())).due).toHaveLength(1);

    await store.unsubscribeWelcomeMail(
      (await store.getWelcomeMail("inst-w"))!.unsubscribe_token,
      c.now(),
    );
    const out = await agree(store, c.now());
    expect(out.due).toEqual([]);
    expect(out.schedule.nextDueAt).toBeNull();
  });

  test("with sending off, a due row neither wakes the loop nor sets a wake time", async () => {
    const { store } = await bed();
    await store.recordFirstLive("inst-w", T0);
    for (const welcomeMailConfigured of [false, undefined]) {
      const schedule = await store.workSchedule(T0, 1, 1, {
        ...SCHEDULE,
        welcomeMailConfigured,
      });
      expect([welcomeMailConfigured, schedule.livenessDue]).toEqual([
        welcomeMailConfigured,
        false,
      ]);
      expect([welcomeMailConfigured, schedule.nextDueAt]).toEqual([
        welcomeMailConfigured,
        null,
      ]);
    }
    // The row is still there for the day the flag goes on.
    expect((await store.getWelcomeMail("inst-w"))?.next_due_at).toBe(T0);
  });
});

// THE ROLES THE DEPLOYED CODE RUNS AS. Every case above runs as the owner,
// which can write anything; a grant missing from roles.ts fails only in
// production with 42501. LOCAL ENGINE ONLY: these create login roles.
const privileged = TARGET_IS_LOCAL ? describe : describe.skip;

privileged("the series under the deployed grants", () => {
  const roleStores: Store[] = [];

  afterEach(async () => {
    for (const store of roleStores.splice(0)) await store.close();
  }, PG_TEST_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await dropLeastPrivilegedRoles();
  }, PG_TEST_HOOK_TIMEOUT_MS);

  test("the provisioner records first live and sends; the web unsubscribes", async () => {
    const dsn = await freshDsn();
    const owner = await openTestStoreOn(dsn, () => T0);
    await account(owner, "acct-p", "p@example.com");
    await office(owner, "inst-p1", "acct-p");
    await office(owner, "inst-p2", "acct-p");

    const provisioner = await Store.openRuntime(
      await leastPrivilegedDsn({ dsn, grants: PROVISIONER_GRANTS }),
      () => T0,
    );
    roleStores.push(provisioner);
    await provisioner.recordFirstLive("inst-p1", T0);
    await provisioner.recordFirstLive("inst-p2", T0);
    const { sent, send } = sender();
    expect(
      await watchWelcomeMail(provisioner, {
        apiKey: "k",
        send,
        postalAddress: POSTAL,
      }),
    ).toBe(2);
    expect(await audits(owner, "inst-p1")).toHaveLength(1);

    const web = await Store.openRuntime(
      await leastPrivilegedDsn({ dsn, grants: WEB_GRANTS }),
      () => T0,
    );
    roleStores.push(web);
    expect(
      await web.unsubscribeWelcomeMail(sent[0].unsubscribeToken, T0 + 1),
    ).toBe(2);
    expect((await owner.getWelcomeMail("inst-p2"))?.opted_out_at).toBe(T0 + 1);
  });
});
