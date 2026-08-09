// The access-window ceiling, and the crash boundary that makes it hard.
//
// The easy case - first contact succeeded - is not the one that matters. The one
// that matters is the process that rewrote the key on the box and died before it
// could write that down: the operation is merely running, the run record has no
// expiry, and the box is already carrying an instant we cannot change.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CeilingIsImmutable, ensureInstance } from "./instance.ts";
import { Store, type OperationStatus } from "./store.ts";
import type { RunRecord } from "./run-record.ts";

const temps: string[] = [];

function tempStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-instance-"));
  temps.push(dir);
  return new Store(path.join(dir, "cp.db"));
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-1",
    state: "reachable",
    host: "cp1.test.isomux.app",
    instanceId: "203474835",
    ipv4: "169.58.97.2",
    loginUser: "root",
    privateKeyPath: "/tmp/key",
    publicKeyPath: "/tmp/key.pub",
    algorithm: "ssh-ed25519",
    blob: "AAAATEST",
    knownHostsFile: "/tmp/kh",
    ...overrides,
  };
}

function firstContact(store: Store, status: OperationStatus): void {
  store.enqueue({
    id: `op-fc-${status}`,
    instance_id: "inst-run-1",
    kind: "first_contact",
    status,
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
  });
}

const T1 = new Date("2026-08-09T19:00:00Z");
const T2 = new Date("2026-08-09T23:00:00Z");

describe("the ceiling", () => {
  test("is written once, with the row, and never again", () => {
    const store = tempStore();
    const rec = record();
    ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    // Even before anything has touched the box. The check-then-act version
    // allowed this window, and a second process could be rewriting the key
    // inside it.
    expect(() =>
      ensureInstance({ store, rec, goal: "live", expiresAt: T2 }),
    ).toThrow(CeilingIsImmutable);
    expect(store.getInstance("inst-run-1")?.access_window_expires_at).toBe(
      T1.getTime(),
    );
  });

  test("is immutable once first contact SUCCEEDED", () => {
    const store = tempStore();
    const rec = record({ expiry: "20260809190000Z" });
    ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    firstContact(store, "succeeded");
    expect(() =>
      ensureInstance({ store, rec, goal: "live", expiresAt: T2 }),
    ).toThrow(CeilingIsImmutable);
    expect(store.getInstance("inst-run-1")?.access_window_expires_at).toBe(
      T1.getTime(),
    );
  });

  test("is immutable after the crash boundary: running, and nothing written down", () => {
    const store = tempStore();
    // No `expiry` on the run record and no succeeded operation - the process
    // died between acting on the box and recording it. The box is nonetheless
    // carrying T1 in an authorized_keys option and a systemd timer.
    const rec = record();
    ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    firstContact(store, "running");
    expect(() =>
      ensureInstance({ store, rec, goal: "live", expiresAt: T2 }),
    ).toThrow(CeilingIsImmutable);
    expect(store.getInstance("inst-run-1")?.access_window_expires_at).toBe(
      T1.getTime(),
    );
  });

  test("an ambiguous or failed first contact counts too", () => {
    for (const status of ["ambiguous", "failed"] as OperationStatus[]) {
      const store = tempStore();
      const rec = record();
      ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
      firstContact(store, status);
      expect(() =>
        ensureInstance({ store, rec, goal: "live", expiresAt: T2 }),
      ).toThrow(CeilingIsImmutable);
    }
  });

  test("re-running with the SAME window is fine, armed or not", () => {
    const store = tempStore();
    const rec = record({ expiry: "20260809190000Z" });
    ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    firstContact(store, "running");
    expect(() =>
      ensureInstance({ store, rec, goal: "handed_off", expiresAt: T1 }),
    ).not.toThrow();
    // And the goal still moves, because that is not a claim about the box.
    expect(store.getInstance("inst-run-1")?.goal).toBe("handed_off");
  });
});

describe("the interleaving the check-then-act version allowed", () => {
  test("two contenders from ONE pre-read cannot end up with two ceilings", () => {
    const store = tempStore();
    const rec = record();
    // Both processes look, both see no instance and no first_contact, and
    // neither yields to the other before writing. No pre-read here serialises
    // them: the row's creation is what arbitrates.
    expect(store.getInstance("inst-run-1")).toBeNull();
    const outcomes = [T1, T2].map((when) => {
      try {
        ensureInstance({ store, rec, goal: "live", expiresAt: when });
        return "wrote";
      } catch (err) {
        return err instanceof CeilingIsImmutable ? "refused" : "other";
      }
    });
    expect(outcomes.filter((o) => o === "wrote")).toHaveLength(1);
    expect(outcomes).toContain("refused");
    // And the ceiling is the winner's, whichever of them won.
    const ceiling = store.getInstance("inst-run-1")?.access_window_expires_at;
    expect(ceiling).toBe(T1.getTime());
  });

  test("a contender that arrives while first_contact is being opened is still refused", () => {
    const store = tempStore();
    const rec = record();
    ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    // The other process opens first_contact and starts rewriting the box. That
    // does NOT bump the instance version, which is exactly why the old code
    // could still be talked into writing T2 here.
    firstContact(store, "running");
    expect(() =>
      ensureInstance({ store, rec, goal: "live", expiresAt: T2 }),
    ).toThrow(CeilingIsImmutable);
    expect(store.getInstance("inst-run-1")?.access_window_expires_at).toBe(
      T1.getTime(),
    );
  });
});

describe("the instance and its provider axis are created together", () => {
  test("a failure creating the asset leaves NO half-made instance", () => {
    const store = tempStore();
    const rec = record({ instanceId: "203474835" });
    // Force the second insert to fail the way a crash would leave it: the
    // instance row written, the provider axis missing.
    const original = store.createAsset.bind(store);
    store.createAsset = () => {
      throw new Error("died between the two inserts");
    };
    expect(() =>
      ensureInstance({ store, rec, goal: "live", expiresAt: T1 }),
    ).toThrow(/died between the two inserts/);
    expect(store.getInstance("inst-run-1")).toBeNull();

    // And a clean retry makes both.
    store.createAsset = original;
    ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    expect(store.getInstance("inst-run-1")).not.toBeNull();
    expect(store.assetForInstance("inst-run-1")?.provider_id).toBe("203474835");
  });

  test("an instance found without a provider axis is repaired on restart", () => {
    const store = tempStore();
    const rec = record();
    // The shape an older build could leave behind: instance, no asset.
    ensureInstance({
      store,
      rec,
      goal: "live",
      expiresAt: T1,
      createAsset: false,
    });
    expect(store.assetForInstance("inst-run-1")).toBeNull();
    ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    expect(store.assetForInstance("inst-run-1")?.provider_id).toBe("203474835");
  });
});
