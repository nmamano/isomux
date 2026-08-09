// The scheduler: leases, fencing, the chain, and deadlines that flag rather
// than conclude. Handlers here are fakes - what is under test is the machinery
// around them.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEADLINES, nextKind } from "./operations.ts";
import { ObserverWriteFailed, RemoteTimeoutError } from "./ssh.ts";
import { Store } from "./store.ts";
import { ContaboAdapter } from "./contabo/adapter.ts";
import { ContaboHttp } from "./contabo/http.ts";
import { TokenProvider, type FetchLike } from "./contabo/auth.ts";
import { IndeterminateProviderError } from "./provider.ts";
import {
  auditOutcomeOf,
  LEASE_MS,
  LEASE_SAFETY_MS,
  LeaseHeadroomLost,
  RemoteBudget,
  Ticker,
  serviceStateAfter,
  type Handler,
  type HandlerContext,
  type HandlerResult,
} from "./tick.ts";
import { raiseAttention } from "./attention.ts";

const temps: string[] = [];

function tempStore(now: () => number): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-tick-"));
  temps.push(dir);
  return new Store(path.join(dir, "cp.db"), now);
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function clock(start = 1_000_000) {
  const state = { t: start };
  return {
    now: () => state.t,
    advance: (ms: number) => {
      state.t += ms;
    },
    state,
  };
}

function seed(store: Store, goal = "live"): string {
  store.createInstance({
    id: "inst-1",
    run_id: "run-1",
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "provisioning",
    goal,
    access_window_expires_at: null,
  });
  return "inst-1";
}

function fakeHandler(
  kind: Handler["kind"],
  run: (ctx: HandlerContext) => Promise<HandlerResult>,
  timeoutIsRetryable = false,
): Handler {
  return { kind, run, timeoutIsRetryable };
}

describe("the chain", () => {
  test("completion and the successor enqueue are one transaction", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({
      store,
      handlers: [fakeHandler("first_contact", async () => ({ kind: "done" }))],
      holder: "a",
    });
    ticker.enqueue(inst, "first_contact");
    await ticker.once();
    const kinds = store.operationsFor(inst).map((o) => `${o.kind}:${o.status}`);
    expect(kinds).toEqual([
      "first_contact:succeeded",
      "arm_revocation:pending",
    ]);
  });

  test("if the successor already exists, the completion rolls back whole", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({
      store,
      handlers: [fakeHandler("first_contact", async () => ({ kind: "done" }))],
      holder: "a",
    });
    const first = ticker.enqueue(inst, "first_contact");
    // Another holder already opened the successor: the partial unique index is
    // the arbiter, and this holder must lose the whole transaction. It is
    // parked in the future so this tick dispatches only the row under test.
    store.enqueue({
      id: "op-arm-existing",
      instance_id: inst,
      kind: "arm_revocation",
      next_attempt_at: c.now() + 600_000,
      inactivity_deadline_at: c.now() + 600_000,
      absolute_deadline_at: c.now() + 600_000,
    });
    await ticker.once();
    expect(store.getOperation(first.id)?.status).not.toBe("succeeded");
    expect(
      store.operationsFor(inst).filter((o) => o.kind === "arm_revocation"),
    ).toHaveLength(1);
  });

  test("the goal decides where the chain stops", () => {
    expect(nextKind("arm_revocation", "first_contact")).toBeNull();
    expect(nextKind("arm_revocation", "live")).toBe("wait_for_package_manager");
    expect(nextKind("run_installer", "installed")).toBeNull();
    expect(nextKind("mint_invite", "live")).toBeNull();
    expect(nextKind("mint_invite", "handed_off")).toBe("revoke_access");
  });
});

describe("fencing", () => {
  test("a handler whose lease was adopted mid-act cannot record its result", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({
      store,
      handlers: [
        fakeHandler("verify_https", async (ctx) => {
          // While we are "at the remote seam", the lease expires and another
          // holder adopts the row.
          const live = store.getOperation(ctx.op.id)!;
          store.tryLease(
            live.id,
            live.version,
            "other",
            c.now() + LEASE_MS,
            c.now() + LEASE_MS + 1,
          );
          return { kind: "done" };
        }),
      ],
      holder: "a",
    });
    const op = ticker.enqueue(inst, "verify_https");
    await ticker.once();
    // The result is dropped, not applied: acting on a lost lease is exactly what
    // the fence exists to stop.
    expect(store.getOperation(op.id)?.status).not.toBe("succeeded");
    expect(store.getOperation(op.id)?.lease_holder).toBe("other");
  });

  test("a row someone else holds is not dispatched at all", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    let ran = 0;
    const ticker = new Ticker({
      store,
      handlers: [
        fakeHandler("verify_https", async () => {
          ran++;
          return { kind: "done" };
        }),
      ],
      holder: "a",
    });
    const op = ticker.enqueue(inst, "verify_https");
    store.tryLease(
      op.id,
      op.version,
      "someone-else",
      c.now() + 60_000,
      c.now(),
    );
    await ticker.once();
    expect(ran).toBe(0);
  });

  test("the fence a handler receives carries the CURRENT holder and version", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    let seenFence: { version: number; holder: string } | null = null;
    const ticker = new Ticker({
      store,
      handlers: [
        fakeHandler("verify_https", async (ctx) => {
          seenFence = { version: ctx.fence.version, holder: ctx.fence.holder };
          return { kind: "waiting" };
        }),
      ],
      holder: "a",
    });
    const op = ticker.enqueue(inst, "verify_https");
    await ticker.once();
    expect(seenFence!.holder).toBe("a");
    // The lease write bumped the version, so the pre-lease copy is already stale.
    expect(seenFence!.version).toBeGreaterThan(op.version);
  });
});

describe("remote timeouts", () => {
  test("are ambiguous by default: a killed child proves nothing", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({
      store,
      handlers: [
        fakeHandler("revoke_access", async () => {
          throw new RemoteTimeoutError("killed");
        }),
      ],
      holder: "a",
    });
    const op = ticker.enqueue(inst, "revoke_access");
    await ticker.once();
    expect(store.getOperation(op.id)?.status).toBe("ambiguous");
    expect(store.getInstance(inst)?.attention_state).toBe("needs_operator");
  });

  test("read-only work may opt down to a plain retry", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({
      store,
      handlers: [
        fakeHandler(
          "verify_https",
          async () => {
            throw new RemoteTimeoutError("killed");
          },
          true,
        ),
      ],
      holder: "a",
    });
    const op = ticker.enqueue(inst, "verify_https");
    await ticker.once();
    const after = store.getOperation(op.id)!;
    expect(after.status).toBe("running");
    expect(after.attempt).toBe(1);
    expect(store.getInstance(inst)?.attention_state).toBe("clear");
  });
});

describe("deadlines flag, they do not conclude", () => {
  test("a blown inactivity deadline raises attention and keeps the operation alive", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({
      store,
      handlers: [
        fakeHandler("run_installer", async () => ({ kind: "waiting" })),
      ],
      holder: "a",
    });
    const op = ticker.enqueue(inst, "run_installer");
    c.advance(DEADLINES.run_installer.inactivityMs + 1000);
    await ticker.once();
    const after = store.getOperation(op.id)!;
    expect(after.inactivity_flagged).toBe(1);
    expect(after.absolute_flagged).toBe(0);
    expect(after.status).not.toBe("failed");
    expect(["pending", "running"]).toContain(after.status);
    const inst1 = store.getInstance(inst)!;
    expect(inst1.attention_state).toBe("needs_operator");
    expect(inst1.attention_reason).toMatch(/inactivity deadline/);
  });

  test("progress after a flag clears the attention it raised", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    let step = 0;
    const ticker = new Ticker({
      store,
      handlers: [
        fakeHandler("run_installer", async () => ({
          kind: "progress",
          evidence: { step: `s${step++}` },
        })),
      ],
      holder: "a",
    });
    const op = ticker.enqueue(inst, "run_installer");
    c.advance(DEADLINES.run_installer.inactivityMs + 1000);
    ticker.evaluateDeadlines();
    expect(store.getInstance(inst)?.attention_state).toBe("needs_operator");
    await ticker.once();
    expect(store.getOperation(op.id)?.inactivity_flagged).toBe(0);
    expect(store.getInstance(inst)?.attention_state).toBe("clear");
  });

  test("waiting does not reset the inactivity deadline; progress does", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    let result: HandlerResult = { kind: "waiting" };
    const ticker = new Ticker({
      store,
      handlers: [fakeHandler("run_installer", async () => result)],
      holder: "a",
    });
    const op = ticker.enqueue(inst, "run_installer");
    const seeded = store.getOperation(op.id)!.inactivity_deadline_at;
    c.advance(60_000);
    await ticker.once();
    expect(store.getOperation(op.id)!.inactivity_deadline_at).toBe(seeded);
    result = { kind: "progress", evidence: { step: "moved" } };
    c.advance(60_000);
    await ticker.once();
    expect(store.getOperation(op.id)!.inactivity_deadline_at).toBeGreaterThan(
      seeded,
    );
  });

  test("an operation someone is acting on right now is not flagged", () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({ store, handlers: [], holder: "a" });
    const op = ticker.enqueue(inst, "run_installer");
    c.advance(DEADLINES.run_installer.absoluteMs + 1000);
    store.tryLease(op.id, op.version, "busy", c.now() + LEASE_MS, c.now());
    expect(ticker.evaluateDeadlines()).toBe(0);
  });
});

describe("reconcile", () => {
  test("moves the asset row toward what the provider says", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    store.createAsset({
      id: "asset-1",
      instance_id: inst,
      provider: "contabo",
      provider_id: "203474835",
      intent_id: null,
      asset_state: "active",
      ipv4: null,
      service_ends_at: null,
      host_key_fingerprint: null,
      next_reconcile_at: c.now(),
    });
    const ticker = new Ticker({
      store,
      handlers: [],
      holder: "a",
      reconcile: async () => ({
        assetState: "cancel_scheduled",
        ipv4: "169.58.97.2",
        serviceEndsAt: "2026-08-29",
      }),
    });
    await ticker.once();
    const asset = store.getAsset("asset-1")!;
    expect(asset.asset_state).toBe("cancel_scheduled");
    expect(asset.ipv4).toBe("169.58.97.2");
    expect(asset.next_reconcile_at).toBeGreaterThan(c.now());
  });
});

describe("enqueue", () => {
  test("a kind this slice does not drive cannot be enqueued", () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({ store, handlers: [], holder: "a" });
    // `power_on` rather than `power_off`: slice 3 gave power_off deadlines and a
    // handler for the dunning suspension boundary, so the example of a kind that is
    // declared but not driven is now its counterpart.
    expect(() =>
      ticker.enqueue(inst, "power_on" as unknown as Handler["kind"]),
    ).toThrow(/does not drive it/);
  });
});

describe("the whole-handler remote budget", () => {
  test("a multi-call handler cannot begin a call after its budget is gone", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const started: string[] = [];
    const ticker = new Ticker({
      store,
      handlers: [
        // arm_revocation is the shape that matters: five sequential children
        // under one lease. A per-child bound would let all five run.
        fakeHandler("arm_revocation", async (ctx) => {
          for (let i = 0; i < 5; i++) {
            ctx.budget.claim(`call-${i}`);
            started.push(`call-${i}`);
            // Each call burns most of the budget.
            c.advance(40_000);
          }
          return { kind: "done" };
        }),
      ],
      holder: "a",
      now: c.now,
    });
    const op = ticker.enqueue(inst, "arm_revocation");
    await ticker.once();
    // The budget for arm_revocation is 150s, so four 40s calls exhaust it and
    // the fifth is refused BEFORE it starts.
    expect(started).toEqual(["call-0", "call-1", "call-2", "call-3"]);
    expect(store.getOperation(op.id)?.status).toBe("ambiguous");
  });

  test("the budget is also capped by the lease, not just by the kind's bound", () => {
    const now = 1_000_000;
    // Bound says 150s from now; the lease says only 30s remain after the safety
    // margin. The lease wins.
    const budget = new RemoteBudget(now + 150_000, now + 90_000, () => now);
    expect(budget.remaining()).toBe(30_000);
    const spent = new RemoteBudget(now + 150_000, now + 50_000, () => now);
    expect(() => spent.claim("x")).toThrow(LeaseHeadroomLost);
  });

  test("once the lease is SPENT, no remote work may begin at all", () => {
    // This is the other half of the two-fence rule. An expired holder may still
    // record what it did (the store's version token decides that), but it may
    // not START anything new - and time is what says so, not the token.
    const now = 1_000_000;
    const expired = new RemoteBudget(now + 150_000, now - 1, () => now);
    expect(expired.remaining()).toBeLessThanOrEqual(0);
    expect(() => expired.claim("anything")).toThrow(LeaseHeadroomLost);
    // Even a lease that has not technically expired but is inside the safety
    // margin refuses: the margin exists so a call cannot outlive the lease.
    const marginal = new RemoteBudget(
      now + 150_000,
      now + LEASE_SAFETY_MS - 1,
      () => now,
    );
    expect(() => marginal.claim("anything")).toThrow(LeaseHeadroomLost);
  });
});

describe("the lease is long enough for what it authorises", () => {
  test("every kind's whole-handler budget plus the margin fits inside a lease", () => {
    for (const [kind, d] of Object.entries(DEADLINES)) {
      expect(
        d.maxRemoteMs + LEASE_SAFETY_MS,
        `${kind} cannot be granted enough headroom by a ${LEASE_MS}ms lease`,
      ).toBeLessThanOrEqual(LEASE_MS);
    }
  });
});

describe("attention clearing is about the condition, not the operation", () => {
  test("progress does NOT clear an operation-condition reason", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({
      store,
      handlers: [
        fakeHandler("revoke_access", async () => ({
          kind: "progress",
          evidence: { moved: true },
        })),
      ],
      holder: "a",
      now: c.now,
    });
    const op = ticker.enqueue(inst, "revoke_access");
    raiseAttention(store, {
      instanceId: inst,
      sourceOpId: op.id,
      reasonClass: "operation_condition",
      reason: "the box did not confirm our key was removed from disk",
      severity: "warning",
    });
    await ticker.once();
    // The operation moved; the revocation still has not happened.
    expect(store.openReasons(inst).map((r) => r.reason)).toEqual([
      "the box did not confirm our key was removed from disk",
    ]);
    expect(store.getInstance(inst)?.attention_state).toBe("needs_operator");
  });

  test("terminal success clears the conditions the operation resolved", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({
      store,
      handlers: [fakeHandler("revoke_access", async () => ({ kind: "done" }))],
      holder: "a",
      now: c.now,
    });
    const op = ticker.enqueue(inst, "revoke_access");
    raiseAttention(store, {
      instanceId: inst,
      sourceOpId: op.id,
      reasonClass: "operation_condition",
      reason: "the box did not confirm our key was removed from disk",
      severity: "warning",
    });
    await ticker.once();
    expect(store.openReasons(inst)).toHaveLength(0);
    expect(store.getInstance(inst)?.attention_state).toBe("clear");
  });

  test("a reason raised by ANOTHER operation is never touched", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({
      store,
      handlers: [fakeHandler("verify_https", async () => ({ kind: "done" }))],
      holder: "a",
      now: c.now,
    });
    ticker.enqueue(inst, "verify_https");
    raiseAttention(store, {
      instanceId: inst,
      sourceOpId: "op-someone-else",
      reasonClass: "operation_condition",
      reason: "revocation failed",
      severity: "critical",
    });
    await ticker.once();
    expect(store.openReasons(inst).map((r) => r.reason)).toEqual([
      "revocation failed",
    ]);
  });
});

describe("absolute deadlines do not flap", () => {
  test("progress clears the inactivity flag and leaves the absolute one crossed", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    let step = 0;
    const ticker = new Ticker({
      store,
      handlers: [
        fakeHandler("run_installer", async () => ({
          kind: "progress",
          evidence: { step: `s${step++}` },
        })),
      ],
      holder: "a",
      now: c.now,
    });
    const op = ticker.enqueue(inst, "run_installer");
    c.advance(DEADLINES.run_installer.absoluteMs + 1000);
    ticker.evaluateDeadlines();
    const flagged = store.getOperation(op.id)!;
    expect(flagged.absolute_flagged).toBe(1);
    expect(flagged.inactivity_flagged).toBe(1);

    await ticker.once();
    const after = store.getOperation(op.id)!;
    // New evidence answers "nothing has happened lately". It does not un-cross
    // a ceiling that has been crossed.
    expect(after.inactivity_flagged).toBe(0);
    expect(after.absolute_flagged).toBe(1);
    const reasons = store.openReasons(inst).map((r) => r.reason_class);
    expect(reasons).toEqual(["absolute_deadline"]);
    expect(store.getInstance(inst)?.attention_state).toBe("needs_operator");
  });
});

describe("service state", () => {
  test("moves to live only at the proven boundary", async () => {
    expect(serviceStateAfter("verify_https")).toBe("live");
    expect(serviceStateAfter("run_installer")).toBeNull();
    expect(serviceStateAfter("first_contact")).toBeNull();

    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({
      store,
      handlers: [
        fakeHandler("run_installer", async () => ({ kind: "done" })),
        fakeHandler("verify_https", async () => ({ kind: "done" })),
      ],
      holder: "a",
      now: c.now,
    });
    ticker.enqueue(inst, "run_installer");
    await ticker.once();
    expect(store.getInstance(inst)?.service_state).toBe("provisioning");
    c.advance(POLL);
    await ticker.once();
    expect(store.getInstance(inst)?.service_state).toBe("live");
  });
});

const POLL = 6000;

describe("audit", () => {
  test("a handler's remote steps are recorded, started before the outcome", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({
      store,
      handlers: [
        fakeHandler("verify_https", async (ctx) => {
          ctx.audit("liveness_probe", "started");
          ctx.audit("liveness_probe", "succeeded");
          return { kind: "done" };
        }),
      ],
      holder: "a",
      now: c.now,
    });
    ticker.enqueue(inst, "verify_https");
    await ticker.once();
    const actions = store.auditEvents().map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toContain("liveness_probe:started");
    expect(actions).toContain("liveness_probe:succeeded");
    expect(actions.indexOf("liveness_probe:started")).toBeLessThan(
      actions.indexOf("liveness_probe:succeeded"),
    );
  });
});

describe("a failure to RECORD is not a failure to act", () => {
  test("an audit write that throws after the call is ambiguous, never a retry", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    const ticker = new Ticker({
      store,
      handlers: [
        // verify_https is the read-only kind, so a plain retry would be its
        // normal answer. Even here, failing to write down what happened must
        // not read as "the call failed".
        fakeHandler(
          "verify_https",
          async () => {
            throw new ObserverWriteFailed("disk full");
          },
          true,
        ),
      ],
      holder: "a",
      now: c.now,
    });
    const op = ticker.enqueue(inst, "verify_https");
    await ticker.once();
    expect(store.getOperation(op.id)?.status).toBe("ambiguous");
    expect(store.getInstance(inst)?.attention_state).toBe("needs_operator");
  });
});

describe("reconcile losers re-read", () => {
  test("a losing writer DISCARDS its provider response instead of replaying it", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    store.createAsset({
      id: "asset-1",
      instance_id: inst,
      provider: "contabo",
      provider_id: "203474835",
      intent_id: null,
      asset_state: "active",
      ipv4: null,
      service_ends_at: null,
      host_key_fingerprint: null,
      next_reconcile_at: c.now(),
    });
    const ticker = new Ticker({
      store,
      handlers: [],
      holder: "a",
      now: c.now,
      reconcile: async (asset) => {
        // Another ticker got a NEWER answer from the provider and wrote it
        // while our older request was still in flight.
        store.casAsset(asset.id, asset.version, {
          asset_state: "cancelled",
          ipv4: "10.0.0.1",
        });
        // Ours is the stale one.
        return { assetState: "active", ipv4: "192.0.2.1" };
      },
    });
    await ticker.once();
    const asset = store.getAsset("asset-1")!;
    // The winner's newer truth stands. Re-reading and re-applying our older
    // response on their version would be a blind retry wearing a fresh version
    // number, which is the trap this rule exists to close.
    expect(asset.asset_state).toBe("cancelled");
    expect(asset.ipv4).toBe("10.0.0.1");
  });

  test("a failed read does not push out a newer schedule set by someone else", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    store.createAsset({
      id: "asset-3",
      instance_id: inst,
      provider: "contabo",
      provider_id: "203474835",
      intent_id: null,
      asset_state: "active",
      ipv4: null,
      service_ends_at: null,
      host_key_fingerprint: null,
      next_reconcile_at: c.now(),
    });
    const urgent = c.now() + 1_000;
    const ticker = new Ticker({
      store,
      handlers: [],
      holder: "a",
      now: c.now,
      reconcile: async (asset) => {
        // A successful reconcile elsewhere schedules an urgent re-check.
        store.casAsset(asset.id, asset.version, { next_reconcile_at: urgent });
        throw new Error("our own read failed");
      },
    });
    await ticker.once();
    expect(store.getAsset("asset-3")?.next_reconcile_at).toBe(urgent);
  });

  test("provider reads are audited", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    store.createAsset({
      id: "asset-2",
      instance_id: inst,
      provider: "contabo",
      provider_id: "203474835",
      intent_id: null,
      asset_state: "active",
      ipv4: null,
      service_ends_at: null,
      host_key_fingerprint: null,
      next_reconcile_at: c.now(),
    });
    const ticker = new Ticker({
      store,
      handlers: [],
      holder: "a",
      now: c.now,
      reconcile: async () => ({ assetState: "active" }),
    });
    await ticker.once();
    const actions = store.auditEvents().map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toContain("provider_get:started");
    expect(actions).toContain("provider_get:succeeded");
  });
});

describe("audit outcomes distinguish ambiguous from failed", () => {
  test("a provider read that establishes nothing is ambiguous, not failed", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    store.createAsset({
      id: "asset-4",
      instance_id: inst,
      provider: "contabo",
      provider_id: "203474835",
      intent_id: null,
      asset_state: "active",
      ipv4: null,
      service_ends_at: null,
      host_key_fingerprint: null,
      next_reconcile_at: c.now(),
    });
    const ticker = new Ticker({
      store,
      handlers: [],
      holder: "a",
      now: c.now,
      reconcile: () =>
        Promise.reject(
          new IndeterminateProviderError("cannot establish absence"),
        ),
    });
    await ticker.once();
    const actions = store.auditEvents().map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toContain("provider_get:ambiguous");
    expect(actions).not.toContain("provider_get:failed");
  });

  test("classification is by what the error establishes", () => {
    expect(auditOutcomeOf(new RemoteTimeoutError("killed"))).toBe("ambiguous");
    expect(auditOutcomeOf(new ObserverWriteFailed("disk full"))).toBe(
      "ambiguous",
    );
    expect(auditOutcomeOf(new IndeterminateProviderError("?"))).toBe(
      "ambiguous",
    );
    // A refusal really did establish that nothing happened.
    expect(auditOutcomeOf(new Error("provider returned HTTP 400"))).toBe(
      "failed",
    );
  });
});

describe("a real faulted provider seam reaches the audit trail as ambiguous", () => {
  test("adapter.get through the ticker, with the transport failing", async () => {
    const c = clock();
    const store = tempStore(c.now);
    const inst = seed(store);
    store.createAsset({
      id: "asset-real",
      instance_id: inst,
      provider: "contabo",
      provider_id: "203474835",
      intent_id: null,
      asset_state: "active",
      ipv4: null,
      service_ends_at: null,
      host_key_fingerprint: null,
      next_reconcile_at: c.now(),
    });
    // The REAL adapter over a transport that drops the connection - not an
    // injected error class. The classification has to survive the whole path.
    const fetchImpl: FetchLike = (url) =>
      String(url).includes("/auth/")
        ? Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({ access_token: "t", expires_in: 3600 }),
          })
        : Promise.reject(new Error("socket hang up"));
    const adapter = new ContaboAdapter({
      http: new ContaboHttp({
        fetchImpl,
        tokens: new TokenProvider(
          { clientId: "c", clientSecret: "s", apiUser: "u", apiPassword: "p" },
          fetchImpl,
        ),
      }),
      imageId: "image-uuid",
      loginUser: "root",
    });
    const ticker = new Ticker({
      store,
      handlers: [],
      holder: "a",
      now: c.now,
      reconcile: async (asset) => {
        const view = await adapter.get(asset.provider_id!);
        return { assetState: view.assetState };
      },
    });
    await ticker.once();
    const actions = store.auditEvents().map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toContain("provider_get:ambiguous");
    expect(actions).not.toContain("provider_get:failed");
  });
});
