// The automatic log cleanup's run (task 3f8db20b): when it is due, what it
// calls in which order, what it records, and what stops it. The storage ops
// are a recording fake; the planners and appliers themselves are covered by
// storage-prune.test.ts and storage-compress.test.ts.
//
// Seam: createLogRetention(deps), every input injected. Zero filesystem.

import { describe, it, expect } from "bun:test";
import {
  createLogRetention,
  RETENTION_INTERVAL_MS,
  RETENTION_KEEP_PER_AGENT,
  type LogRetentionDeps,
  type LogRetentionOutcome,
  type LogRetentionSettings,
  type LogRetentionState,
} from "./storage-retention.ts";
import { StorageBusyError } from "./routes/handlers/storage.ts";
import type { CompressPlan, CompressResult } from "./storage-compress.ts";
import type {
  PrunePlan,
  PrunePolicy,
  PruneResult,
  PruneSkipReason,
  PruneTarget,
  ReferenceIndex,
} from "./storage-prune.ts";
import type { PruneOpts } from "./office-storage-routes.ts";

const NOW = 1_800_000_000_000;

interface Call {
  op: string;
  target?: PruneTarget;
  policy?: PrunePolicy;
  days?: number;
  opts?: PruneOpts;
  plan?: unknown;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

interface FakeOpts {
  settings?: LogRetentionSettings;
  state?: LogRetentionState;
  now?: number;
  restored?: boolean;
  // Skip reasons the attachments plan carries.
  attachmentSkips?: PruneSkipReason[];
  // A step that throws: "planPrune:attachments", "applyCompress", ...
  throwAt?: string;
  // Awaited inside applyCompress, to hold a run open.
  holdCompress?: Promise<void>;
}

function fake(o: FakeOpts = {}) {
  const calls: Call[] = [];
  const writes: LogRetentionState[] = [];
  let settings: LogRetentionSettings = o.settings ?? {
    compressAfterDays: 7,
    deleteAfterDays: null,
  };
  let state: LogRetentionState = o.state ?? {
    lastRunAt: null,
    lastRun: null,
    lastError: null,
  };
  let held = false;
  const lookup = (_agentDir: string) => new Set<string>(["from-index.png"]);
  const index: ReferenceIndex = { lookup };
  const boom = (step: string) => {
    if (o.throwAt === step) throw new Error(`${step} failed`);
  };
  const pruneResults: Record<string, PruneResult> = {
    transcripts: { deleted: 4, bytes: 4000, refused: [] },
    attachments: { deleted: 6, bytes: 60_000, refused: [] },
  };
  const deps: LogRetentionDeps = {
    ops: {
      planPrune: (target, policy, opts) => {
        calls.push({ op: "planPrune", target, policy, opts });
        boom(`planPrune:${target}`);
        const skipped =
          target === "attachments"
            ? (o.attachmentSkips ?? []).map((reason) => ({
                reason,
                count: 1,
                bytes: 1,
              }))
            : [];
        return {
          target,
          policy,
          candidates: [],
          bytes: 0,
          skipped,
        } satisfies PrunePlan;
      },
      applyPrune: (plan, opts) => {
        calls.push({ op: "applyPrune", target: plan.target, opts, plan });
        boom(`applyPrune:${plan.target}`);
        return pruneResults[plan.target]!;
      },
      planCompress: (days) => {
        calls.push({ op: "planCompress", days });
        boom("planCompress");
        return {
          olderThanDays: days,
          candidates: [],
          bytes: 0,
          skipped: [],
        } satisfies CompressPlan;
      },
      applyCompress: async (plan) => {
        calls.push({ op: "applyCompress", plan });
        if (o.holdCompress) await o.holdCompress;
        boom("applyCompress");
        return {
          compressed: 3,
          bytesBefore: 3000,
          bytesAfter: 800,
          refused: [],
        } satisfies CompressResult;
      },
      exclusive: async <T>(fn: () => Promise<T>): Promise<T> => {
        if (held) throw new StorageBusyError();
        held = true;
        try {
          return await fn();
        } finally {
          held = false;
        }
      },
    },
    logsDir: "/nonexistent/logs",
    now: () => o.now ?? NOW,
    loadSettings: () => settings,
    readState: () => state,
    writeState: (s) => {
      writes.push(structuredClone(s));
      state = s;
    },
    isRestored: () => o.restored ?? true,
    scanReferences: async () => {
      calls.push({ op: "scan" });
      return index;
    },
  };
  return {
    deps,
    calls,
    writes,
    lookup,
    ops: () => calls.map((c) => (c.target ? `${c.op}:${c.target}` : c.op)),
    setSettings: (s: LogRetentionSettings) => (settings = s),
    isHeld: () => held,
  };
}

const DELETE_ON: LogRetentionSettings = {
  compressAfterDays: 7,
  deleteAfterDays: 30,
};

describe("when a run is due", () => {
  it("does nothing until the agents are restored", async () => {
    const f = fake({ restored: false });
    expect(await createLogRetention(f.deps).runIfDue()).toBe("not-restored");
    expect(f.calls).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
  });

  it("runs on first start, then once per interval, and again when the last run is in the future", async () => {
    const cases: [number | null, LogRetentionOutcome][] = [
      [null, "ran"],
      [NOW - RETENTION_INTERVAL_MS + 1, "not-due"],
      [NOW - RETENTION_INTERVAL_MS, "ran"],
      // The clock moved back, or the state came from another box: waiting
      // until the clock catches up would stop the cleanup for that long.
      [NOW + 60 * 60 * 1000, "ran"],
    ];
    for (const [lastRunAt, outcome] of cases) {
      const f = fake({
        state: { lastRunAt, lastRun: null, lastError: null },
      });
      const got = await createLogRetention(f.deps).runIfDue();
      expect({ lastRunAt, got }).toEqual({ lastRunAt, got: outcome });
      if (outcome === "not-due") {
        expect(f.calls).toHaveLength(0);
        expect(f.writes).toHaveLength(0);
      } else {
        expect(f.writes.at(-1)!.lastRunAt).toBe(NOW);
      }
    }
  });
});

describe("what a run does", () => {
  it("with deletes off, only compresses at the compress age, and clears an earlier error", async () => {
    const f = fake({
      settings: { compressAfterDays: 9, deleteAfterDays: null },
      state: { lastRunAt: null, lastRun: null, lastError: "old failure" },
    });
    expect(await createLogRetention(f.deps).runIfDue()).toBe("ran");
    expect(f.ops()).toEqual(["planCompress", "applyCompress"]);
    expect(f.calls[0]!.days).toBe(9);
    expect(f.writes.at(-1)).toEqual({
      lastRunAt: NOW,
      lastRun: {
        compressed: 3,
        compressBytesSaved: 2200,
        transcriptsDeleted: 0,
        filesDeleted: 0,
        bytesDeleted: 0,
      },
      lastError: null,
    });
  });

  it("with a delete age, prunes transcripts, then unreferenced files, then compresses, and adds up what it freed", async () => {
    const f = fake({ settings: DELETE_ON });
    expect(await createLogRetention(f.deps).runIfDue()).toBe("ran");
    // The scan may run anywhere before the attachments plan.
    const ops = f.ops().filter((op) => op !== "scan");
    expect(ops).toEqual([
      "planPrune:transcripts",
      "applyPrune:transcripts",
      "planPrune:attachments",
      "applyPrune:attachments",
      "planCompress",
      "applyCompress",
    ]);
    expect(f.ops().indexOf("scan")).toBeGreaterThanOrEqual(0);
    expect(f.ops().indexOf("scan")).toBeLessThan(
      f.ops().indexOf("planPrune:attachments"),
    );

    const transcripts = f.calls.find(
      (c) => c.op === "planPrune" && c.target === "transcripts",
    )!;
    expect(transcripts.policy).toEqual({
      olderThanDays: 30,
      keepPerAgent: RETENTION_KEEP_PER_AGENT,
    });
    // keepPerAgent 0: the attachments prune ignores it, and the stamp this
    // apply leaves must cover an open attachments ask, which has 0.
    expect(
      f.calls.find((c) => c.op === "planPrune" && c.target === "attachments")!
        .policy,
    ).toEqual({ olderThanDays: 30, keepPerAgent: 0 });
    expect(f.calls.find((c) => c.op === "planCompress")!.days).toBe(7);

    // Each apply gets the plan its planner returned, not a copy it built.
    for (const target of ["transcripts", "attachments"] as const) {
      const apply = f.calls.find(
        (c) => c.op === "applyPrune" && c.target === target,
      )!;
      expect((apply.plan as PrunePlan).target).toBe(target);
      expect((apply.plan as PrunePlan).policy.olderThanDays).toBe(30);
    }

    expect(f.writes.at(-1)).toEqual({
      lastRunAt: NOW,
      lastRun: {
        compressed: 3,
        compressBytesSaved: 2200,
        transcriptsDeleted: 4,
        filesDeleted: 6,
        bytesDeleted: 64_000,
      },
      lastError: null,
    });
  });

  // applyPrune plans again: an apply that fell back to the synchronous reader
  // would read every transcript on the event loop with no visible failure.
  it("gives the scan's lookup to the attachments plan AND its apply", async () => {
    const f = fake({ settings: DELETE_ON });
    await createLogRetention(f.deps).runIfDue();
    for (const op of ["planPrune", "applyPrune"]) {
      const call = f.calls.find(
        (c) => c.op === op && c.target === "attachments",
      )!;
      expect({
        op,
        same: call.opts?.referencedAttachments === f.lookup,
      }).toEqual({ op, same: true });
    }
  });

  it("reads the settings once, at the start of the run", async () => {
    const f = fake({ settings: DELETE_ON });
    const origApply = f.deps.ops.applyPrune;
    f.deps.ops.applyPrune = (plan, opts) => {
      // A save while the run is under way.
      f.setSettings({ compressAfterDays: 21, deleteAfterDays: null });
      return origApply(plan, opts);
    };
    await createLogRetention(f.deps).runIfDue();
    expect(f.ops()).toContain("applyPrune:attachments");
    expect(f.calls.find((c) => c.op === "planCompress")!.days).toBe(7);
  });
});

describe("what stops a run", () => {
  // Same fail-closed rule as the manual route: unknown is not empty. The
  // compress is lossless and does not depend on the queue, so it still runs.
  it("does not apply the attachments prune while the queue state is unknown, records why, and still compresses", async () => {
    const f = fake({
      settings: DELETE_ON,
      attachmentSkips: ["queue-state-unknown"],
    });
    expect(await createLogRetention(f.deps).runIfDue()).toBe("ran");
    expect(f.ops()).toContain("planPrune:attachments");
    expect(f.ops()).not.toContain("applyPrune:attachments");
    expect(f.ops()).toContain("applyCompress");
    const last = f.writes.at(-1)!;
    // One try a day: an unreadable queue file must not cause hourly scans.
    expect(last.lastRunAt).toBe(NOW);
    expect(typeof last.lastError).toBe("string");
    expect(last.lastError!.length).toBeGreaterThan(0);
    expect(last.lastRun!.transcriptsDeleted).toBe(4);
    expect(last.lastRun!.filesDeleted).toBe(0);
    expect(last.lastRun!.compressed).toBe(3);
  });

  it("a step that throws ends the run with its error and keeps what the earlier steps did", async () => {
    for (const throwAt of [
      "planPrune:attachments",
      "applyPrune:attachments",
      "applyCompress",
    ]) {
      const f = fake({ settings: DELETE_ON, throwAt });
      const outcome = await createLogRetention(f.deps).runIfDue();
      expect({ throwAt, outcome }).toEqual({ throwAt, outcome: "ran" });
      const last = f.writes.at(-1)!;
      expect({ throwAt, lastRunAt: last.lastRunAt }).toEqual({
        throwAt,
        lastRunAt: NOW,
      });
      expect({ throwAt, hasError: (last.lastError ?? "").length > 0 }).toEqual({
        throwAt,
        hasError: true,
      });
      expect({ throwAt, kept: last.lastRun?.transcriptsDeleted }).toEqual({
        throwAt,
        kept: 4,
      });
      // The lock is free again for the manual routes.
      expect(f.isHeld()).toBe(false);
    }
  });

  it("a held storage lock gives busy, calls nothing and leaves lastRunAt unwritten, so the next check tries again", async () => {
    const f = fake({ settings: DELETE_ON });
    const release = deferred();
    const manual = f.deps.ops.exclusive(() => release.promise);
    const retention = createLogRetention(f.deps);
    expect(await retention.runIfDue()).toBe("busy");
    expect(f.calls).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
    release.resolve();
    await manual;
    expect(await retention.runIfDue()).toBe("ran");
  });

  it("holds the lock and reports running for the whole run; a second check meanwhile is busy", async () => {
    const hold = deferred();
    const f = fake({ settings: DELETE_ON, holdCompress: hold.promise });
    const retention = createLogRetention(f.deps);
    expect(retention.isRunning()).toBe(false);
    const first = retention.runIfDue();
    // Let the run reach applyCompress.
    for (let i = 0; i < 50 && !f.ops().includes("applyCompress"); i++)
      await Bun.sleep(1);
    expect(f.ops()).toContain("applyCompress");
    expect(retention.isRunning()).toBe(true);
    expect(f.isHeld()).toBe(true);
    const callsBefore = f.calls.length;
    expect(await retention.runIfDue()).toBe("busy");
    expect(f.calls.length).toBe(callsBefore);
    hold.resolve();
    expect(await first).toBe("ran");
    expect(retention.isRunning()).toBe(false);
    expect(f.isHeld()).toBe(false);
  });
});
