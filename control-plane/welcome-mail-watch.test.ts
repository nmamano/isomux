// The welcome series pass: which step goes out when, to whom, and what stops
// it. The sender is injected (its wire shape is welcome-mail.test.ts's); what is
// under test is the selection, the advance and the schedule that wakes the
// pass, against a real database.
//
// The rules (task 9d2d7d16): the clock starts when the office first goes live.
// A step goes out only to a live office whose subscription is active and not
// cancelled; otherwise it is skipped and the series moves on. The series ends
// with the office or the subscription, and when its first mail is not sent.
// Task 733ed11b: only steps with approved copy go out; a series waits at the
// first step past them and goes on when that copy ships. No step is skipped
// for lateness: a first mail sent late opens with a note. Every handled row
// advances BEFORE its mail goes out, whatever the outcome, so a handled row is
// never due again and no mail is sent twice.

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
  WELCOME_MAIL_LATE_MS,
  WELCOME_MAIL_OFFSETS_MS,
  type sendWelcomeMail,
} from "./welcome-mail.ts";
import { WELCOME_MAILS_APPROVED } from "./welcome-mail-copy.ts";
import { watchWelcomeMail } from "./welcome-mail-watch.ts";

afterEach(releaseTestStores, PG_TEST_HOOK_TIMEOUT_MS);

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;
// Every step approved: the cases that walk the whole series pass it. The
// shipped count is WELCOME_MAILS_APPROVED ("a series waits" below).
const ALL = WELCOME_MAIL_OFFSETS_MS.length;

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
    const deps = { apiKey: "re_k", send, approved: ALL };

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
      }),
    ).toBe(2);
    expect((await store.getWelcomeMail("inst-a"))?.next_due_at).toBe(
      T0 + WELCOME_MAIL_OFFSETS_MS[1],
    );
    expect((await store.getWelcomeMail("inst-b"))?.next_due_at).toBeNull();
    c.state.value = T0 + WELCOME_MAIL_OFFSETS_MS[1];
    await watchWelcomeMail(store, { apiKey: "k", send, approved: ALL });
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
  // Each case: a reason not to send now. At step 0 it ends the series; at a
  // later step the series goes on.
  const SKIPS: [string, Parameters<typeof office>[3]][] = [
    ["cancelled at period end", { sub: { cancel_at_period_end: 1 } }],
    ["cancellation recorded", { sub: { canceled_at: T0 - 1 } }],
    ["payment past due", { sub: { status: "past_due" } }],
    ["office suspended", { state: "suspended" }],
  ];
  const ENDS: [string, Parameters<typeof office>[3]][] = [
    ["office deprovisioned", { state: "deprovisioned" }],
    ["subscription ended", { sub: { ended_at: T0 - 1, canceled_at: T0 - 2 } }],
    ["no subscription", { sub: null }],
  ];
  // One pass over one office per case, each under its own account.
  async function onePass(cases: [string, Parameters<typeof office>[3]][]) {
    const store = await openTestStore(() => T0);
    for (const [n, [, opts]] of cases.entries()) {
      await account(store, `acct-${n}`, `${n}@example.com`);
      await office(store, `inst-${n}`, `acct-${n}`, opts);
      await store.recordFirstLive(`inst-${n}`, T0);
    }
    const { sent, send } = sender();
    const handled = await watchWelcomeMail(store, {
      apiKey: "k",
      send,
    });
    return { store, sent, handled };
  }

  test("at the first mail, each skip reason ends the series", async () => {
    // The first mail has the office address and the sign-in steps: a series
    // without it must not open with a later tip.
    const { store, sent, handled } = await onePass(SKIPS);
    expect(handled).toBe(0);
    expect(sent).toEqual([]);
    for (const [n, [label]] of SKIPS.entries()) {
      expect([
        label,
        (await store.getWelcomeMail(`inst-${n}`))?.next_due_at,
        (await audits(store, `inst-${n}`)).map((a) => a.outcome),
      ]).toEqual([label, null, ["ended"]]);
    }
  });

  test("at a later step, a skip reason skips it and the series goes on", async () => {
    const c = clock();
    const store = await openTestStore(c.now);
    await account(store, "acct-s", "s@example.com");
    await office(store, "inst-s", "acct-s");
    await store.recordFirstLive("inst-s", T0);
    const { sent, send } = sender();
    const deps = { apiKey: "k", send, approved: ALL };
    expect(await watchWelcomeMail(store, deps)).toBe(1);
    await store.sqlRun(
      "update instances set service_state = 'suspended' where id = 'inst-s'",
    );
    c.state.value = T0 + WELCOME_MAIL_OFFSETS_MS[1];
    expect(await watchWelcomeMail(store, deps)).toBe(0);
    expect(await store.getWelcomeMail("inst-s")).toMatchObject({
      next_step: 2,
      next_due_at: T0 + WELCOME_MAIL_OFFSETS_MS[2],
    });
    expect((await audits(store, "inst-s")).map((a) => a.outcome)).toEqual([
      "succeeded",
      "skipped",
    ]);
    expect(sent.map((m) => m.step)).toEqual([0]);
  });

  test("each end reason sends nothing, and the series is over", async () => {
    const { store, sent } = await onePass(ENDS);
    expect(sent).toEqual([]);
    for (const [n, [label]] of ENDS.entries()) {
      expect([
        label,
        (await store.getWelcomeMail(`inst-${n}`))?.next_due_at,
      ]).toEqual([label, null]);
    }
  });

  test("a late first mail moves the whole series: each mail keeps its gap to the one before", async () => {
    // Sending starts 30 hours after the office went live: past the second
    // mail's day.
    const late = 30 * 60 * 60 * 1_000;
    const c = clock(T0 + late);
    const store = await openTestStore(c.now);
    await account(store, "acct-g", "g@example.com");
    await office(store, "inst-g", "acct-g");
    await store.recordFirstLive("inst-g", T0);
    const at: number[] = [];
    const { send } = sender(() => {
      at.push(c.now());
      return { ok: true };
    });
    const deps = { apiKey: "k", send, approved: ALL };
    for (let step = 0; step < WELCOME_MAIL_OFFSETS_MS.length; step++) {
      expect([step, await watchWelcomeMail(store, deps)]).toEqual([step, 1]);
      const due = (await store.getWelcomeMail("inst-g"))?.next_due_at;
      if (due == null) break;
      // Nothing goes out before the gap is over.
      c.state.value = due - 1;
      expect([step, await watchWelcomeMail(store, deps)]).toEqual([step, 0]);
      c.state.value = due;
    }
    expect(at).toEqual(
      WELCOME_MAIL_OFFSETS_MS.map((offset) => T0 + late + offset),
    );
  });
});

describe("a late first mail", () => {
  test("is sent, with the note when the office went live more than WELCOME_MAIL_LATE_MS before; a later step never carries it", async () => {
    const now = T0 + 30 * DAY;
    const c = clock(now);
    const store = await openTestStore(c.now);
    const CASES: [string, number, boolean][] = [
      ["on-time", now - WELCOME_MAIL_LATE_MS, false],
      ["just-late", now - WELCOME_MAIL_LATE_MS - 1, true],
      ["weeks-late", T0, true],
    ];
    for (const [id, liveAt] of CASES) {
      await account(store, `acct-${id}`, `${id}@example.com`);
      await office(store, `inst-${id}`, `acct-${id}`);
      await store.recordFirstLive(`inst-${id}`, liveAt);
    }
    const { sent, send } = sender();
    const deps = { apiKey: "k", send, approved: ALL };
    const steps = async (id: string) => {
      const token = (await store.getWelcomeMail(`inst-${id}`))!
        .unsubscribe_token;
      return sent
        .filter((m) => m.unsubscribeToken === token)
        .map((m) => [m.step, m.late]);
    };
    expect(await watchWelcomeMail(store, deps)).toBe(CASES.length);
    for (const [id, , late] of CASES)
      expect([id, await steps(id)]).toEqual([id, [[0, late]]]);
    // However late, the next step goes out without the note.
    c.state.value = now + 10 * DAY;
    expect(await watchWelcomeMail(store, deps)).toBe(CASES.length);
    for (const [id, , late] of CASES)
      expect([id, await steps(id)]).toEqual([
        id,
        [
          [0, late],
          [1, false],
        ],
      ]);
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
    const deps = { apiKey: "k", send };
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
    await watchWelcomeMail(store, { apiKey: "k", send });
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
    await watchWelcomeMail(store, { apiKey: "k", send });
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

  async function agree(store: Store, now: number, approved = ALL) {
    const schedule = await store.workSchedule(now, 1, 1, {
      ...SCHEDULE,
      welcomeMailsApproved: approved,
    });
    const due = await store.dueWelcomeMails(now, approved);
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

    // Live for the first mail only: a skipped first mail ends the series.
    const state = (value: string) =>
      store.sqlRun("update instances set service_state = $1 where id = $2", [
        value,
        "inst-w",
      ]);
    await state("live");
    await watchWelcomeMail(store, {
      apiKey: "k",
      send: sender().send,
    });
    await state("suspended");
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

  test("a series waits at the first mail without approved copy, and goes on when that copy ships", async () => {
    const { c, store } = await bed();
    await store.recordFirstLive("inst-w", T0);
    const state = (value: string) =>
      store.sqlRun("update instances set service_state = $1 where id = $2", [
        value,
        "inst-w",
      ]);
    const { sent, send } = sender();
    await state("live");
    expect(
      await watchWelcomeMail(store, { apiKey: "k", send, approved: 1 }),
    ).toBe(1);
    await state("suspended");
    const waitingRow = await store.getWelcomeMail("inst-w");
    expect(waitingRow?.next_step).toBe(1);
    // Days past the second mail's day, and its copy is not approved: nothing
    // is due and nothing wakes the loop for it.
    c.state.value = T0 + WELCOME_MAIL_OFFSETS_MS[1] + 3 * DAY;
    const waiting = await agree(store, c.now(), 1);
    expect(waiting.due).toEqual([]);
    expect(waiting.schedule.nextDueAt).toBeNull();
    await state("live");
    expect(
      await watchWelcomeMail(store, { apiKey: "k", send, approved: 1 }),
    ).toBe(0);
    expect(await store.getWelcomeMail("inst-w")).toEqual(waitingRow);
    expect((await audits(store, "inst-w")).map((a) => a.outcome)).toEqual([
      "succeeded",
    ]);

    // The copy of the second mail ships: it is due at once and goes out,
    // and the third mail keeps its gap from it.
    await state("suspended");
    expect((await agree(store, c.now(), 2)).due).toHaveLength(1);
    await state("live");
    expect(
      await watchWelcomeMail(store, { apiKey: "k", send, approved: 2 }),
    ).toBe(1);
    expect(sent.map((m) => [m.step, m.late])).toEqual([
      [0, false],
      [1, false],
    ]);
    const gap = WELCOME_MAIL_OFFSETS_MS[2] - WELCOME_MAIL_OFFSETS_MS[1];
    expect(await store.getWelcomeMail("inst-w")).toMatchObject({
      next_step: 2,
      next_due_at: c.now() + gap,
    });
    // And waits again at the third, whose copy is not approved.
    await state("suspended");
    const third = await agree(store, c.now() + gap, 2);
    expect(third.due).toEqual([]);
    expect(third.schedule.nextDueAt).toBeNull();
  });

  test("without a count, the pass and the schedule use the shipped one", async () => {
    const { store } = await bed();
    await store.recordFirstLive("inst-w", T0);
    // Last approved step: due. The step after it: waits.
    for (const [step, due] of [
      [WELCOME_MAILS_APPROVED - 1, true],
      [WELCOME_MAILS_APPROVED, false],
    ] as const) {
      await store.sqlRun(
        "update welcome_mails set next_step = $1 where instance_id = $2",
        [step, "inst-w"],
      );
      const schedule = await store.workSchedule(T0, 1, 1, SCHEDULE);
      expect([step, schedule.livenessDue]).toEqual([step, due]);
      expect([step, schedule.nextDueAt]).toEqual([step, due ? T0 : null]);
      expect([step, (await store.dueWelcomeMails(T0)).length]).toEqual([
        step,
        due ? 1 : 0,
      ]);
    }
    // The pass with no count leaves the waiting row alone.
    const { sent, send } = sender();
    await store.sqlRun(
      "update instances set service_state = 'live' where id = 'inst-w'",
    );
    expect(await watchWelcomeMail(store, { apiKey: "k", send })).toBe(0);
    expect(sent).toEqual([]);
    expect(await audits(store, "inst-w")).toEqual([]);
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
