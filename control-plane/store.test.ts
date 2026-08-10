// The store's invariants: CAS, leases, the one-active index, and the attention
// summary. Every race here is fired the way a race actually happens - one
// pre-read, then two contenders using that same version, with no intervening
// read that would serialise them.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { Store } from "./store.ts";
import { acknowledgeAttention } from "./attention-ack.ts";
import { clearAttention, raiseAttention } from "./attention.ts";

const temps: string[] = [];

async function tempStore(now?: () => number): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-store-"));
  temps.push(dir);
  return await Store.open(path.join(dir, "cp.db"), now);
}

async function seedInstance(store: Store, id = "inst-1"): Promise<string> {
  await store.createInstance({
    id,
    run_id: "run-1",
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "provisioning",
    goal: "live",
    access_window_expires_at: null,
  });
  return id;
}

async function seedOp(store: Store, instance: string, kind = "run_installer") {
  return await store.enqueue({
    id: `op-${kind}-${Math.random().toString(36).slice(2)}`,
    instance_id: instance,
    kind,
    inactivity_deadline_at: store.now() + 60_000,
    absolute_deadline_at: store.now() + 600_000,
  });
}

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("compare-and-swap", () => {
  test("a stale version loses and changes nothing", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const first = await store.casInstance(inst, 1, { service_state: "live" });
    expect(first?.service_state).toBe("live");
    // The loser holds the version it read BEFORE the winner wrote.
    const loser = await store.casInstance(inst, 1, {
      service_state: "suspended",
    });
    expect(loser).toBeNull();
    expect((await store.getInstance(inst))?.service_state).toBe("live");
  });

  test("an operation write is fenced by holder as well as version", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    const leased = await store.tryLease(
      op.id,
      op.version,
      "holder-a",
      10_000,
      0,
    );
    expect(leased).not.toBeNull();
    // Right version, wrong holder: the lease moved, so this write must lose.
    const stale = await store.casOperation(
      { id: op.id, version: leased!.version, holder: "holder-b" },
      { status: "succeeded" },
    );
    expect(stale).toBeNull();
    expect((await store.getOperation(op.id))?.status).toBe("running");
  });
});

describe("leases", () => {
  test("only one of two contenders holding the same read can lease", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    // ONE pre-read, then both attempts from that same version. A second read
    // here would serialise the contenders and prove nothing.
    const seen = (await store.getOperation(op.id))!;
    const a = await store.tryLease(seen.id, seen.version, "a", 10_000, 0);
    const b = await store.tryLease(seen.id, seen.version, "b", 10_000, 0);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await store.getOperation(op.id))?.lease_holder).toBe("a");
  });

  test("a live lease is not adoptable, an expired one is", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    const held = (await store.tryLease(op.id, op.version, "a", 10_000, 0))!;
    // now=5_000 is inside the lease: nobody else may take it.
    expect(
      await store.tryLease(held.id, held.version, "b", 20_000, 5_000),
    ).toBeNull();
    // now=10_001 is past it: a crashed holder's lease is adoptable.
    const adopted = await store.tryLease(
      held.id,
      held.version,
      "b",
      30_000,
      10_001,
    );
    expect(adopted?.lease_holder).toBe("b");
  });

  test("renewal requires the holder", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    const held = (await store.tryLease(op.id, op.version, "a", 10_000, 0))!;
    expect(
      await store.renewLease(
        { id: op.id, version: held.version, holder: "b" },
        99,
      ),
    ).toBeNull();
    expect(
      await store.renewLease(
        { id: op.id, version: held.version, holder: "a" },
        99,
      ),
    ).not.toBeNull();
  });

  test("taking the lease moves a pending row to running, and leaves others alone", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await store.enqueue({
      id: "op-amb",
      instance_id: inst,
      kind: "create_instance",
      status: "ambiguous",
      inactivity_deadline_at: 1,
      absolute_deadline_at: 2,
    });
    const held = await store.tryLease(op.id, op.version, "a", 10_000, 0);
    expect(held?.status).toBe("ambiguous");
  });
});

describe("one active operation per (instance, kind)", () => {
  test("a second active row is refused by the index, not by a check", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await seedOp(store, inst, "mint_invite");
    expect(seedOp(store, inst, "mint_invite")).rejects.toThrow();
  });

  test("a terminal row frees the slot, so a legitimate second one may open", async () => {
    const store = await tempStore(() => 1_000);
    const inst = await seedInstance(store);
    const first = await seedOp(store, inst, "mint_invite");
    // A LIVE lease: concluding an operation is a write, and an expired holder
    // has no authority to make one.
    const held = (await store.tryLease(
      first.id,
      first.version,
      "a",
      60_000,
      1_000,
    ))!;
    await store.casOperation(
      { id: first.id, version: held.version, holder: "a" },
      { status: "succeeded" },
    );
    await seedOp(store, inst, "mint_invite");
  });
});

describe("due selection", () => {
  test("skips leased rows and rows whose backoff has not elapsed", async () => {
    const store = await tempStore(() => 0);
    const inst = await seedInstance(store);
    const soon = await seedOp(store, inst, "verify_https");
    const later = await store.enqueue({
      id: "op-later",
      instance_id: inst,
      kind: "mint_invite",
      next_attempt_at: 10_000,
      inactivity_deadline_at: 1,
      absolute_deadline_at: 2,
    });
    expect((await store.dueOperations(0, 10)).map((o) => o.id)).toEqual([
      soon.id,
    ]);
    await store.tryLease(soon.id, soon.version, "a", 60_000, 0);
    expect(await store.dueOperations(0, 10)).toHaveLength(0);
    expect((await store.dueOperations(20_000, 10)).map((o) => o.id)).toEqual([
      later.id,
    ]);
  });
});

describe("deadline flagging", () => {
  test("is a version CAS, and a second flagger loses", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    const seen = (await store.getOperation(op.id))!;
    expect(
      await store.flagDeadline(seen.id, seen.version, "inactivity"),
    ).not.toBeNull();
    expect(
      await store.flagDeadline(seen.id, seen.version, "inactivity"),
    ).toBeNull();
  });

  test("flagging writes no status: a deadline flags, it never concludes", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    await store.flagDeadline(op.id, op.version, "inactivity");
    const after = (await store.getOperation(op.id))!;
    expect(after.status).toBe("pending");
    expect(after.inactivity_flagged).toBe(1);
    expect(after.absolute_flagged).toBe(0);
  });
});

describe("the transaction guard holds across a suspension", () => {
  /**
   * The case an async body newly makes reachable.
   *
   * Before the flip, a transaction ran start to finish in one synchronous
   * block, so nothing could enter it. Now a body can suspend part-way, and the
   * depth guard is what turns a second `tx` entered in that window into a
   * programming error instead of a silently widened boundary. Per-transaction
   * connections are the real answer and they arrive with the Postgres engine;
   * until then this is the fence, so it is pinned rather than assumed.
   */
  test("a second tx entered while one is suspended is refused, and the first still commits", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);

    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = store.tx(async () => {
      await store.casInstance(inst, 1, { goal: "installed" });
      await gate;
      return "committed";
    });

    // The body is now parked on the gate, with `begin immediate` open.
    let second: string;
    try {
      await store.tx(async () => "should not get here");
      second = "entered";
    } catch (err) {
      second = (err as Error).message;
    }
    expect(second).toBe("nested transaction");

    release();
    expect(await first).toBe("committed");
    // And the suspended transaction's own write is durable, so the refusal
    // above cost the first one nothing.
    expect((await store.getInstance(inst))?.goal).toBe("installed");
    await store.close();
  });
});

describe("attention", () => {
  test("one reason cannot overwrite another, and the summary names the worst", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-revoke",
      reason: "revocation failed",
      severity: "critical",
    });
    await raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-install",
      reason: "installer passed its inactivity deadline",
      severity: "warning",
    });
    const row = (await store.getInstance(inst))!;
    expect(row.attention_state).toBe("needs_operator");
    expect(row.attention_reason).toBe("revocation failed");
    expect(await store.openReasons(inst)).toHaveLength(2);
  });

  test("clearing the installer reason leaves the revocation one open", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-revoke",
      reason: "revocation failed",
      severity: "critical",
    });
    await raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-install",
      reason: "installer stalled",
      severity: "warning",
    });
    const installer = (await store.openReasons(inst)).find(
      (r) => r.source_op_id === "op-install",
    )!;
    await clearAttention(store, inst, installer.id);
    expect((await store.openReasons(inst)).map((r) => r.reason)).toEqual([
      "revocation failed",
    ]);
    expect((await store.getInstance(inst))?.attention_state).toBe(
      "needs_operator",
    );
  });

  test("raising the same reason twice is idempotent", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const args = {
      instanceId: inst,
      reasonClass: "operation_condition" as const,
      sourceOpId: "op-1",
      reason: "same",
      severity: "warning" as const,
    };
    expect(await raiseAttention(store, args)).toBe(true);
    expect(await raiseAttention(store, args)).toBe(false);
    expect(await store.openReasons(inst)).toHaveLength(1);
  });

  test("acknowledging is NOT clearing", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-1",
      reason: "revocation failed",
      severity: "critical",
    });
    await acknowledgeAttention(store, inst, "nil");
    const row = (await store.getInstance(inst))!;
    expect(row.acknowledged_by).toBe("nil");
    // The condition has not gone away, so the instance still needs a human.
    expect(row.attention_state).toBe("needs_operator");
    expect(await store.openReasons(inst)).toHaveLength(1);
  });

  test("every raise and clear leaves an audit row", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-1",
      reason: "stalled",
      severity: "warning",
    });
    const [reason] = await store.openReasons(inst);
    await clearAttention(store, inst, reason.id);
    const actions = (await store.auditEvents()).map((e) => e.action);
    expect(actions).toContain("raise_attention");
    expect(actions).toContain("clear_attention");
  });

  test("the summary is a CAS: a caller working from a stale read loses", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const stale = (await store.getInstance(inst))!.version;
    // Somebody else moves the instance between our read and our write.
    await store.casInstance(inst, stale, { goal: "installed" });
    expect(
      store.tx(async () => await store.refreshAttentionSummary(inst, stale)),
    ).rejects.toThrow(/moved while its attention summary/);
    // And the winner's write is intact.
    expect((await store.getInstance(inst))?.goal).toBe("installed");
  });

  test("an audit row outside a transaction is refused", async () => {
    const store = await tempStore();
    expect(
      store.appendAudit({
        actor: "t",
        instance_id: null,
        action: "x",
        target: "y",
        outcome: "succeeded",
        detail: null,
      }),
    ).rejects.toThrow(/inside a transaction/);
  });
});

describe("portability rules", () => {
  test("the schema uses no AUTOINCREMENT and no json() calls", async () => {
    const store = await tempStore();
    const sql = (
      await store.sqlAll<{ sql: string | null }>(
        "select sql from sqlite_master",
      )
    )
      .map((r) => r.sql ?? "")
      .join("\n");
    expect(sql).not.toMatch(/autoincrement/i);
    expect(sql).not.toMatch(/\bjsonb?\s*\(/i);
  });

  test("audit ids come from a sequence, so they are ordered and portable", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    await store.tx(async () => {
      await store.appendAudit({
        actor: "t",
        instance_id: inst,
        action: "a",
        target: "1",
        outcome: "succeeded",
        detail: null,
      });
      await store.appendAudit({
        actor: "t",
        instance_id: inst,
        action: "b",
        target: "2",
        outcome: "succeeded",
        detail: null,
      });
    });
    const seqs = (await store.auditEvents()).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe("deadline flagging never CASes through a live lease", () => {
  test("a lease taken between selection and flagging wins", async () => {
    const store = await tempStore(() => 1_000);
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    // The flagger read this row while it was free.
    const seen = (await store.getOperation(op.id))!;
    // A holder leases it in the gap, at the same version the flagger holds.
    const leased = await store.tryLease(
      seen.id,
      seen.version,
      "holder",
      60_000,
      1_000,
    );
    expect(leased).not.toBeNull();
    // Flagging must lose. Succeeding would bump the version out from under a
    // fence that is already at a remote seam.
    expect(
      await store.flagDeadline(seen.id, seen.version, "inactivity", 1_000),
    ).toBeNull();
    // Even with the CURRENT version, the live lease still refuses it.
    expect(
      await store.flagDeadline(seen.id, leased!.version, "inactivity", 1_000),
    ).toBeNull();
    // Once the lease has expired it flags normally.
    expect(
      await store.flagDeadline(seen.id, leased!.version, "inactivity", 60_001),
    ).not.toBeNull();
  });
});

describe("finite state sets are enforced by the database", () => {
  test("an unknown asset state is rejected", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    expect(
      store.createAsset({
        id: "asset-bad",
        instance_id: inst,
        provider: "contabo",
        provider_id: "1",
        intent_id: null,
        asset_state: "probably-fine",
        ipv4: null,
        service_ends_at: null,
        host_key_fingerprint: null,
        next_reconcile_at: 0,
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  test("an unknown service state is rejected", async () => {
    const store = await tempStore();
    expect(
      store.createInstance({
        id: "inst-bad",
        run_id: null,
        name: "x",
        plan: "V153",
        region: "EU",
        service_state: "mostly-live" as never,
        goal: "live",
        access_window_expires_at: null,
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe("a database from before this slice", () => {
  test("refuses to open, by name, instead of failing mid-run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-old-"));
    temps.push(dir);
    const file = path.join(dir, "old.db");
    // The shape slice 2 inherited: the tables exist, the new columns do not.
    const legacy = new Database(file, { create: true });
    legacy.run(
      "create table attention_reasons (id text primary key, instance_id text, " +
        "source_op_id text, reason text, severity text, raised_at integer, " +
        "cleared_at integer, acknowledged_at integer, acknowledged_by text)",
    );
    legacy.close();
    expect(Store.open(file)).rejects.toThrow(/predates this version/);
  });

  test("every column slice 5 added is pinned, one at a time", async () => {
    // One database per column, each missing exactly that column, so the pin is
    // proven per name rather than by one table that happens to be old. A column
    // added to the schema and forgotten here opens cleanly and fails somewhere
    // in the middle of a cancellation instead.
    const SLICE_5: [string, string, string][] = [
      [
        "accounts",
        "is_operator",
        "create table accounts (id text primary key, email text, google_subject text, " +
          "stripe_customer_id text, version integer, created_at integer, updated_at integer)",
      ],
      ["subscriptions", "ended_at", subscriptionsWithout("ended_at")],
      ["subscriptions", "canceled_at", subscriptionsWithout("canceled_at")],
      [
        "subscriptions",
        "cancellation_reason",
        subscriptionsWithout("cancellation_reason"),
      ],
    ];
    for (const [table, column, ddl] of SLICE_5) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-col-"));
      temps.push(dir);
      const file = path.join(dir, "old.db");
      const legacy = new Database(file, { create: true });
      legacy.run(ddl);
      legacy.close();
      expect([
        `${table}.${column}`,
        await (async () => {
          try {
            await Store.open(file);
            return "opened";
          } catch (err) {
            return (err as Error).message.includes(`${table} has no ${column}`)
              ? "refused by name"
              : (err as Error).message;
          }
        })(),
      ]).toEqual([`${table}.${column}`, "refused by name"]);
    }
  });
});

/** The subscriptions table with one column left out, and nothing else changed. */
function subscriptionsWithout(missing: string): string {
  const columns = [
    "id text primary key",
    "account_id text",
    "instance_id text",
    "stripe_customer_id text",
    "status text",
    "current_period_end integer",
    "cancel_at_period_end integer",
    "ended_at integer",
    "canceled_at integer",
    "cancellation_reason text",
    "episode_state text",
    "exhaustion_observed_at integer",
    "version integer",
    "created_at integer",
    "updated_at integer",
  ].filter((c) => !c.startsWith(`${missing} `));
  return `create table subscriptions (${columns.join(", ")})`;
}

describe("the access-window ceiling is a store invariant, not a convention", () => {
  test("casInstance refuses to write it, whatever the caller believes", async () => {
    const store = await tempStore();
    const inst = await seedInstance(store);
    const row = (await store.getInstance(inst))!;
    expect(
      store.casInstance(inst, row.version, {
        access_window_expires_at: 123,
      } as never),
    ).rejects.toThrow(/written once/);
    // Nothing moved, not even the version.
    expect((await store.getInstance(inst))?.version).toBe(row.version);
  });

  test("it is settable at creation, and only there", async () => {
    const store = await tempStore();
    await store.createInstance({
      id: "inst-ceiling",
      run_id: null,
      name: "x",
      plan: "V153",
      region: "EU",
      service_state: "provisioning",
      goal: "live",
      access_window_expires_at: 999,
    });
    expect(
      (await store.getInstance("inst-ceiling"))?.access_window_expires_at,
    ).toBe(999);
  });
});

describe("the two fences: time bounds ACTING, the token bounds RECORDING", () => {
  test("an expired holder that nobody adopted may still record what it did", async () => {
    let t = 1_000;
    const store = await tempStore(() => t);
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    const held = (await store.tryLease(op.id, op.version, "A", 2_000, t))!;
    // Past the lease, and the row has not moved: no other holder has adopted,
    // no deadline flag has landed. A is still the only actor there has ever
    // been, and this write is the record of work done while it held the lease.
    // Refusing it would lose evidence without preventing anything.
    t = 2_001;
    expect(
      await store.casOperation(
        { id: op.id, version: held.version, holder: "A" },
        { status: "succeeded" },
      ),
    ).not.toBeNull();
  });

  test("the moment another holder adopts, the old result is refused", async () => {
    let t = 1_000;
    const store = await tempStore(() => t);
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    const held = (await store.tryLease(op.id, op.version, "A", 2_000, t))!;
    t = 2_001;
    // B adopts the expired lease. THAT is what ends A's authority to record.
    expect(
      await store.tryLease(op.id, held.version, "B", 62_000, t),
    ).not.toBeNull();
    expect(
      await store.casOperation(
        { id: op.id, version: held.version, holder: "A" },
        { status: "succeeded" },
      ),
    ).toBeNull();
    expect((await store.getOperation(op.id))?.status).not.toBe("succeeded");
  });

  test("a row with no lease at all cannot be written through the fence", async () => {
    const store = await tempStore(() => 1_000);
    const inst = await seedInstance(store);
    const op = await seedOp(store, inst);
    expect(
      await store.casOperation(
        { id: op.id, version: op.version, holder: "A" },
        { status: "succeeded" },
      ),
    ).toBeNull();
  });
});
