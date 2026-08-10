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

async function tempStore(): Promise<Store> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-instance-"));
  temps.push(dir);
  return await Store.open(path.join(dir, "cp.db"));
}

afterEach(async () => {
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

async function firstContact(
  store: Store,
  status: OperationStatus,
): Promise<void> {
  await store.enqueue({
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
  test("is written once, with the row, and never again", async () => {
    const store = await tempStore();
    const rec = record();
    await ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    // Even before anything has touched the box. The check-then-act version
    // allowed this window, and a second process could be rewriting the key
    // inside it.
    expect(
      ensureInstance({ store, rec, goal: "live", expiresAt: T2 }),
    ).rejects.toThrow(CeilingIsImmutable);
    expect(
      (await store.getInstance("inst-run-1"))?.access_window_expires_at,
    ).toBe(T1.getTime());
  });

  test("is immutable once first contact SUCCEEDED", async () => {
    const store = await tempStore();
    const rec = record({ expiry: "20260809190000Z" });
    await ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    await firstContact(store, "succeeded");
    expect(
      ensureInstance({ store, rec, goal: "live", expiresAt: T2 }),
    ).rejects.toThrow(CeilingIsImmutable);
    expect(
      (await store.getInstance("inst-run-1"))?.access_window_expires_at,
    ).toBe(T1.getTime());
  });

  test("is immutable after the crash boundary: running, and nothing written down", async () => {
    const store = await tempStore();
    // No `expiry` on the run record and no succeeded operation - the process
    // died between acting on the box and recording it. The box is nonetheless
    // carrying T1 in an authorized_keys option and a systemd timer.
    const rec = record();
    await ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    await firstContact(store, "running");
    expect(
      ensureInstance({ store, rec, goal: "live", expiresAt: T2 }),
    ).rejects.toThrow(CeilingIsImmutable);
    expect(
      (await store.getInstance("inst-run-1"))?.access_window_expires_at,
    ).toBe(T1.getTime());
  });

  test("an ambiguous or failed first contact counts too", async () => {
    for (const status of ["ambiguous", "failed"] as OperationStatus[]) {
      const store = await tempStore();
      const rec = record();
      await ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
      await firstContact(store, status);
      expect(
        ensureInstance({ store, rec, goal: "live", expiresAt: T2 }),
      ).rejects.toThrow(CeilingIsImmutable);
    }
  });

  test("re-running with the SAME window is fine, armed or not", async () => {
    const store = await tempStore();
    const rec = record({ expiry: "20260809190000Z" });
    await ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    await firstContact(store, "running");
    await ensureInstance({ store, rec, goal: "handed_off", expiresAt: T1 });
    // And the goal still moves, because that is not a claim about the box.
    expect((await store.getInstance("inst-run-1"))?.goal).toBe("handed_off");
  });
});

describe("the interleaving the check-then-act version allowed", () => {
  test("two contenders from ONE pre-read cannot end up with two ceilings", async () => {
    const store = await tempStore();
    const rec = record();
    // Both processes look, both see no instance and no first_contact, and
    // neither yields to the other before writing. No pre-read here serialises
    // them: the row's creation is what arbitrates.
    expect(await store.getInstance("inst-run-1")).toBeNull();
    const outcomes: string[] = [];
    for (const when of [T1, T2]) {
      try {
        await ensureInstance({ store, rec, goal: "live", expiresAt: when });
        outcomes.push("wrote");
      } catch (err) {
        outcomes.push(err instanceof CeilingIsImmutable ? "refused" : "other");
      }
    }
    expect(outcomes.filter((o) => o === "wrote")).toHaveLength(1);
    expect(outcomes).toContain("refused");
    // And the ceiling is the winner's, whichever of them won.
    const ceiling = (await store.getInstance("inst-run-1"))
      ?.access_window_expires_at;
    expect(ceiling).toBe(T1.getTime());
  });

  test("a contender that arrives while first_contact is being opened is still refused", async () => {
    const store = await tempStore();
    const rec = record();
    await ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    // The other process opens first_contact and starts rewriting the box. That
    // does NOT bump the instance version, which is exactly why the old code
    // could still be talked into writing T2 here.
    await firstContact(store, "running");
    expect(
      ensureInstance({ store, rec, goal: "live", expiresAt: T2 }),
    ).rejects.toThrow(CeilingIsImmutable);
    expect(
      (await store.getInstance("inst-run-1"))?.access_window_expires_at,
    ).toBe(T1.getTime());
  });
});

describe("the instance and its provider axis are created together", () => {
  test("a failure creating the asset leaves NO half-made instance", async () => {
    const store = await tempStore();
    const rec = record({ instanceId: "203474835" });
    // Force the second insert to fail the way a crash would leave it: the
    // instance row written, the provider axis missing.
    const original = store.createAsset.bind(store);
    store.createAsset = () => {
      throw new Error("died between the two inserts");
    };
    expect(
      ensureInstance({ store, rec, goal: "live", expiresAt: T1 }),
    ).rejects.toThrow(/died between the two inserts/);
    expect(await store.getInstance("inst-run-1")).toBeNull();

    // And a clean retry makes both.
    store.createAsset = original;
    await ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    expect(await store.getInstance("inst-run-1")).not.toBeNull();
    expect((await store.assetForInstance("inst-run-1"))?.provider_id).toBe(
      "203474835",
    );
  });

  test("an instance found without a provider axis is repaired on restart", async () => {
    const store = await tempStore();
    const rec = record();
    // The shape an older build could leave behind: instance, no asset.
    await ensureInstance({
      store,
      rec,
      goal: "live",
      expiresAt: T1,
      createAsset: false,
    });
    expect(await store.assetForInstance("inst-run-1")).toBeNull();
    await ensureInstance({ store, rec, goal: "live", expiresAt: T1 });
    expect((await store.assetForInstance("inst-run-1"))?.provider_id).toBe(
      "203474835",
    );
  });
});
