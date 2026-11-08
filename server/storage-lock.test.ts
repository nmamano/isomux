// The storage lock (task 3f8db20b): one holder at a time among the automatic
// cleanup and the manual prune and compress applies. A manual apply while it
// is held answers 409 storage_busy and deletes nothing; a dry run is not
// locked.
//
// Seam: createStorageOps for the real lock, and createStorageRoutes over
// recording planners and appliers, so no file is touched.

import { describe, it, expect } from "bun:test";
import {
  createStorageOps,
  createStorageRoutes,
  type StorageOps,
} from "./office-storage-routes.ts";
import { StorageBusyError } from "./routes/handlers/storage.ts";
import type { RouteHandlerContext } from "./routes/executor.ts";
import type { PrunePlan } from "./storage-prune.ts";
import type { CompressPlan } from "./storage-compress.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("exclusive", () => {
  it("refuses a second holder without running it, and frees the lock after a holder resolves or rejects", async () => {
    const ops = createStorageOps(() => {});
    expect(ops.isBusy()).toBe(false);
    const release = deferred();
    const first = ops.exclusive(() => release.promise);
    expect(ops.isBusy()).toBe(true);

    let ran = false;
    let err: unknown = null;
    try {
      await ops.exclusive(async () => {
        ran = true;
      });
    } catch (e) {
      err = e;
    }
    expect(ran).toBe(false);
    expect(err).toBeInstanceOf(StorageBusyError);

    release.resolve();
    await first;
    expect(ops.isBusy()).toBe(false);

    await expect(
      ops.exclusive(() => Promise.reject(new Error("step failed"))),
    ).rejects.toThrow("step failed");
    expect(ops.isBusy()).toBe(false);
    expect(await ops.exclusive(async () => 42)).toBe(42);
  });
});

describe("the manual routes", () => {
  function routesOver(real: StorageOps) {
    const calls: string[] = [];
    const busyDuringApply: boolean[] = [];
    const ops: StorageOps = {
      ...real,
      planPrune: (target, policy) => {
        calls.push(`planPrune:${target}`);
        return {
          target,
          policy,
          candidates: [],
          bytes: 0,
          skipped: [],
        } satisfies PrunePlan;
      },
      applyPrune: () => {
        calls.push("applyPrune");
        busyDuringApply.push(real.isBusy());
        return { deleted: 0, bytes: 0, refused: [] };
      },
      planCompress: (olderThanDays) => {
        calls.push("planCompress");
        return {
          olderThanDays,
          candidates: [],
          bytes: 0,
          skipped: [],
        } satisfies CompressPlan;
      },
      applyCompress: async () => {
        calls.push("applyCompress");
        busyDuringApply.push(real.isBusy());
        return { compressed: 0, bytesBefore: 0, bytesAfter: 0, refused: [] };
      },
    };
    const routes = createStorageRoutes(ops, {
      getRetention: () => {
        throw new Error("unused");
      },
      setRetention: () => {
        throw new Error("unused");
      },
    });
    const call = async (opId: string, body: unknown) =>
      (await routes[opId]!({
        body,
        identity: { scope: "user", role: "owner" },
      } as unknown as RouteHandlerContext)) as {
        kind: string;
        status?: number;
        code?: string;
      };
    return { calls, busyDuringApply, call };
  }

  const PRUNE = {
    target: "transcripts",
    olderThanDays: 30,
    keepPerAgent: 2,
  };
  const COMPRESS = { olderThanDays: 30 };

  it("an apply while the lock is held is a 409 storage_busy and applies nothing; a dry run still answers", async () => {
    const real = createStorageOps(() => {});
    const { calls, call } = routesOver(real);
    const release = deferred();
    const holder = real.exclusive(() => release.promise);

    for (const [opId, body] of [
      ["storage.prune", { ...PRUNE, apply: true }],
      ["storage.compress", { ...COMPRESS, apply: true }],
    ] as const) {
      const r = await call(opId, body);
      expect({ opId, status: r.status, code: r.code }).toEqual({
        opId,
        status: 409,
        code: "storage_busy",
      });
    }
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual([]);

    for (const [opId, body] of [
      ["storage.prune", PRUNE],
      ["storage.compress", COMPRESS],
    ] as const) {
      const r = await call(opId, body);
      expect({ opId, kind: r.kind, status: r.status ?? 200 }).toEqual({
        opId,
        kind: "json",
        status: 200,
      });
    }
    expect(calls).toContain("planPrune:transcripts");
    expect(calls).toContain("planCompress");

    release.resolve();
    await holder;
  });

  it("an apply holds the lock while it runs and frees it after", async () => {
    const real = createStorageOps(() => {});
    const { busyDuringApply, call } = routesOver(real);
    for (const [opId, body] of [
      ["storage.prune", { ...PRUNE, apply: true }],
      ["storage.compress", { ...COMPRESS, apply: true }],
    ] as const) {
      const r = await call(opId, body);
      expect({ opId, status: r.status ?? 200 }).toEqual({ opId, status: 200 });
      expect(real.isBusy()).toBe(false);
    }
    expect(busyDuringApply).toEqual([true, true]);
  });
});
