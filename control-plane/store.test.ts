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
import {
  acknowledgeAttention,
  clearAttention,
  raiseAttention,
} from "./attention.ts";

const temps: string[] = [];

function tempStore(now?: () => number): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-store-"));
  temps.push(dir);
  return new Store(path.join(dir, "cp.db"), now);
}

function seedInstance(store: Store, id = "inst-1"): string {
  store.createInstance({
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

function seedOp(store: Store, instance: string, kind = "run_installer") {
  return store.enqueue({
    id: `op-${kind}-${Math.random().toString(36).slice(2)}`,
    instance_id: instance,
    kind,
    inactivity_deadline_at: store.now() + 60_000,
    absolute_deadline_at: store.now() + 600_000,
  });
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("compare-and-swap", () => {
  test("a stale version loses and changes nothing", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    const first = store.casInstance(inst, 1, { service_state: "live" });
    expect(first?.service_state).toBe("live");
    // The loser holds the version it read BEFORE the winner wrote.
    const loser = store.casInstance(inst, 1, { service_state: "suspended" });
    expect(loser).toBeNull();
    expect(store.getInstance(inst)?.service_state).toBe("live");
  });

  test("an operation write is fenced by holder as well as version", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    const op = seedOp(store, inst);
    const leased = store.tryLease(op.id, op.version, "holder-a", 10_000, 0);
    expect(leased).not.toBeNull();
    // Right version, wrong holder: the lease moved, so this write must lose.
    const stale = store.casOperation(
      { id: op.id, version: leased!.version, holder: "holder-b" },
      { status: "succeeded" },
    );
    expect(stale).toBeNull();
    expect(store.getOperation(op.id)?.status).toBe("running");
  });
});

describe("leases", () => {
  test("only one of two contenders holding the same read can lease", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    const op = seedOp(store, inst);
    // ONE pre-read, then both attempts from that same version. A second read
    // here would serialise the contenders and prove nothing.
    const seen = store.getOperation(op.id)!;
    const a = store.tryLease(seen.id, seen.version, "a", 10_000, 0);
    const b = store.tryLease(seen.id, seen.version, "b", 10_000, 0);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(store.getOperation(op.id)?.lease_holder).toBe("a");
  });

  test("a live lease is not adoptable, an expired one is", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    const op = seedOp(store, inst);
    const held = store.tryLease(op.id, op.version, "a", 10_000, 0)!;
    // now=5_000 is inside the lease: nobody else may take it.
    expect(
      store.tryLease(held.id, held.version, "b", 20_000, 5_000),
    ).toBeNull();
    // now=10_001 is past it: a crashed holder's lease is adoptable.
    const adopted = store.tryLease(held.id, held.version, "b", 30_000, 10_001);
    expect(adopted?.lease_holder).toBe("b");
  });

  test("renewal requires the holder", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    const op = seedOp(store, inst);
    const held = store.tryLease(op.id, op.version, "a", 10_000, 0)!;
    expect(
      store.renewLease({ id: op.id, version: held.version, holder: "b" }, 99),
    ).toBeNull();
    expect(
      store.renewLease({ id: op.id, version: held.version, holder: "a" }, 99),
    ).not.toBeNull();
  });

  test("taking the lease moves a pending row to running, and leaves others alone", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    const op = store.enqueue({
      id: "op-amb",
      instance_id: inst,
      kind: "create_instance",
      status: "ambiguous",
      inactivity_deadline_at: 1,
      absolute_deadline_at: 2,
    });
    const held = store.tryLease(op.id, op.version, "a", 10_000, 0);
    expect(held?.status).toBe("ambiguous");
  });
});

describe("one active operation per (instance, kind)", () => {
  test("a second active row is refused by the index, not by a check", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    seedOp(store, inst, "mint_invite");
    expect(() => seedOp(store, inst, "mint_invite")).toThrow();
  });

  test("a terminal row frees the slot, so a legitimate second one may open", () => {
    const store = tempStore(() => 1_000);
    const inst = seedInstance(store);
    const first = seedOp(store, inst, "mint_invite");
    // A LIVE lease: concluding an operation is a write, and an expired holder
    // has no authority to make one.
    const held = store.tryLease(first.id, first.version, "a", 60_000, 1_000)!;
    store.casOperation(
      { id: first.id, version: held.version, holder: "a" },
      { status: "succeeded" },
    );
    expect(() => seedOp(store, inst, "mint_invite")).not.toThrow();
  });
});

describe("due selection", () => {
  test("skips leased rows and rows whose backoff has not elapsed", () => {
    const store = tempStore(() => 0);
    const inst = seedInstance(store);
    const soon = seedOp(store, inst, "verify_https");
    const later = store.enqueue({
      id: "op-later",
      instance_id: inst,
      kind: "mint_invite",
      next_attempt_at: 10_000,
      inactivity_deadline_at: 1,
      absolute_deadline_at: 2,
    });
    expect(store.dueOperations(0, 10).map((o) => o.id)).toEqual([soon.id]);
    store.tryLease(soon.id, soon.version, "a", 60_000, 0);
    expect(store.dueOperations(0, 10)).toHaveLength(0);
    expect(store.dueOperations(20_000, 10).map((o) => o.id)).toEqual([
      later.id,
    ]);
  });
});

describe("deadline flagging", () => {
  test("is a version CAS, and a second flagger loses", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    const op = seedOp(store, inst);
    const seen = store.getOperation(op.id)!;
    expect(
      store.flagDeadline(seen.id, seen.version, "inactivity"),
    ).not.toBeNull();
    expect(store.flagDeadline(seen.id, seen.version, "inactivity")).toBeNull();
  });

  test("flagging writes no status: a deadline flags, it never concludes", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    const op = seedOp(store, inst);
    store.flagDeadline(op.id, op.version, "inactivity");
    const after = store.getOperation(op.id)!;
    expect(after.status).toBe("pending");
    expect(after.inactivity_flagged).toBe(1);
    expect(after.absolute_flagged).toBe(0);
  });
});

describe("attention", () => {
  test("one reason cannot overwrite another, and the summary names the worst", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-revoke",
      reason: "revocation failed",
      severity: "critical",
    });
    raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-install",
      reason: "installer passed its inactivity deadline",
      severity: "warning",
    });
    const row = store.getInstance(inst)!;
    expect(row.attention_state).toBe("needs_operator");
    expect(row.attention_reason).toBe("revocation failed");
    expect(store.openReasons(inst)).toHaveLength(2);
  });

  test("clearing the installer reason leaves the revocation one open", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-revoke",
      reason: "revocation failed",
      severity: "critical",
    });
    raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-install",
      reason: "installer stalled",
      severity: "warning",
    });
    const installer = store
      .openReasons(inst)
      .find((r) => r.source_op_id === "op-install")!;
    clearAttention(store, inst, installer.id);
    expect(store.openReasons(inst).map((r) => r.reason)).toEqual([
      "revocation failed",
    ]);
    expect(store.getInstance(inst)?.attention_state).toBe("needs_operator");
  });

  test("raising the same reason twice is idempotent", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    const args = {
      instanceId: inst,
      reasonClass: "operation_condition" as const,
      sourceOpId: "op-1",
      reason: "same",
      severity: "warning" as const,
    };
    expect(raiseAttention(store, args)).toBe(true);
    expect(raiseAttention(store, args)).toBe(false);
    expect(store.openReasons(inst)).toHaveLength(1);
  });

  test("acknowledging is NOT clearing", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-1",
      reason: "revocation failed",
      severity: "critical",
    });
    acknowledgeAttention(store, inst, "nil");
    const row = store.getInstance(inst)!;
    expect(row.acknowledged_by).toBe("nil");
    // The condition has not gone away, so the instance still needs a human.
    expect(row.attention_state).toBe("needs_operator");
    expect(store.openReasons(inst)).toHaveLength(1);
  });

  test("every raise and clear leaves an audit row", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    raiseAttention(store, {
      instanceId: inst,
      reasonClass: "operation_condition",
      sourceOpId: "op-1",
      reason: "stalled",
      severity: "warning",
    });
    const [reason] = store.openReasons(inst);
    clearAttention(store, inst, reason.id);
    const actions = store.auditEvents().map((e) => e.action);
    expect(actions).toContain("raise_attention");
    expect(actions).toContain("clear_attention");
  });

  test("the summary is a CAS: a caller working from a stale read loses", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    const stale = store.getInstance(inst)!.version;
    // Somebody else moves the instance between our read and our write.
    store.casInstance(inst, stale, { goal: "installed" });
    expect(() =>
      store.tx(() => store.refreshAttentionSummary(inst, stale)),
    ).toThrow(/moved while its attention summary/);
    // And the winner's write is intact.
    expect(store.getInstance(inst)?.goal).toBe("installed");
  });

  test("an audit row outside a transaction is refused", () => {
    const store = tempStore();
    expect(() =>
      store.appendAudit({
        actor: "t",
        instance_id: null,
        action: "x",
        target: "y",
        outcome: "succeeded",
        detail: null,
      }),
    ).toThrow(/inside a transaction/);
  });
});

describe("portability rules", () => {
  test("the schema uses no AUTOINCREMENT and no json() calls", () => {
    const store = tempStore();
    const sql = store.db
      .query<{ sql: string | null }, []>("select sql from sqlite_master")
      .all()
      .map((r) => r.sql ?? "")
      .join("\n");
    expect(sql).not.toMatch(/autoincrement/i);
    expect(sql).not.toMatch(/\bjsonb?\s*\(/i);
  });

  test("audit ids come from a sequence, so they are ordered and portable", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    store.tx(() => {
      store.appendAudit({
        actor: "t",
        instance_id: inst,
        action: "a",
        target: "1",
        outcome: "succeeded",
        detail: null,
      });
      store.appendAudit({
        actor: "t",
        instance_id: inst,
        action: "b",
        target: "2",
        outcome: "succeeded",
        detail: null,
      });
    });
    const seqs = store.auditEvents().map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe("deadline flagging never CASes through a live lease", () => {
  test("a lease taken between selection and flagging wins", () => {
    const store = tempStore(() => 1_000);
    const inst = seedInstance(store);
    const op = seedOp(store, inst);
    // The flagger read this row while it was free.
    const seen = store.getOperation(op.id)!;
    // A holder leases it in the gap, at the same version the flagger holds.
    const leased = store.tryLease(
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
      store.flagDeadline(seen.id, seen.version, "inactivity", 1_000),
    ).toBeNull();
    // Even with the CURRENT version, the live lease still refuses it.
    expect(
      store.flagDeadline(seen.id, leased!.version, "inactivity", 1_000),
    ).toBeNull();
    // Once the lease has expired it flags normally.
    expect(
      store.flagDeadline(seen.id, leased!.version, "inactivity", 60_001),
    ).not.toBeNull();
  });
});

describe("finite state sets are enforced by the database", () => {
  test("an unknown asset state is rejected", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    expect(() =>
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
    ).toThrow(/CHECK constraint failed/);
  });

  test("an unknown service state is rejected", () => {
    const store = tempStore();
    expect(() =>
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
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("a database from before this slice", () => {
  test("refuses to open, by name, instead of failing mid-run", () => {
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
    expect(() => new Store(file)).toThrow(/predates this version/);
  });
});

describe("the access-window ceiling is a store invariant, not a convention", () => {
  test("casInstance refuses to write it, whatever the caller believes", () => {
    const store = tempStore();
    const inst = seedInstance(store);
    const row = store.getInstance(inst)!;
    expect(() =>
      store.casInstance(inst, row.version, {
        access_window_expires_at: 123,
      } as never),
    ).toThrow(/written once/);
    // Nothing moved, not even the version.
    expect(store.getInstance(inst)?.version).toBe(row.version);
  });

  test("it is settable at creation, and only there", () => {
    const store = tempStore();
    store.createInstance({
      id: "inst-ceiling",
      run_id: null,
      name: "x",
      plan: "V153",
      region: "EU",
      service_state: "provisioning",
      goal: "live",
      access_window_expires_at: 999,
    });
    expect(store.getInstance("inst-ceiling")?.access_window_expires_at).toBe(
      999,
    );
  });
});

describe("the two fences: time bounds ACTING, the token bounds RECORDING", () => {
  test("an expired holder that nobody adopted may still record what it did", () => {
    let t = 1_000;
    const store = tempStore(() => t);
    const inst = seedInstance(store);
    const op = seedOp(store, inst);
    const held = store.tryLease(op.id, op.version, "A", 2_000, t)!;
    // Past the lease, and the row has not moved: no other holder has adopted,
    // no deadline flag has landed. A is still the only actor there has ever
    // been, and this write is the record of work done while it held the lease.
    // Refusing it would lose evidence without preventing anything.
    t = 2_001;
    expect(
      store.casOperation(
        { id: op.id, version: held.version, holder: "A" },
        { status: "succeeded" },
      ),
    ).not.toBeNull();
  });

  test("the moment another holder adopts, the old result is refused", () => {
    let t = 1_000;
    const store = tempStore(() => t);
    const inst = seedInstance(store);
    const op = seedOp(store, inst);
    const held = store.tryLease(op.id, op.version, "A", 2_000, t)!;
    t = 2_001;
    // B adopts the expired lease. THAT is what ends A's authority to record.
    expect(store.tryLease(op.id, held.version, "B", 62_000, t)).not.toBeNull();
    expect(
      store.casOperation(
        { id: op.id, version: held.version, holder: "A" },
        { status: "succeeded" },
      ),
    ).toBeNull();
    expect(store.getOperation(op.id)?.status).not.toBe("succeeded");
  });

  test("a row with no lease at all cannot be written through the fence", () => {
    const store = tempStore(() => 1_000);
    const inst = seedInstance(store);
    const op = seedOp(store, inst);
    expect(
      store.casOperation(
        { id: op.id, version: op.version, holder: "A" },
        { status: "succeeded" },
      ),
    ).toBeNull();
  });
});
