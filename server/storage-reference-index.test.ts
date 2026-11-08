// The attachment reference index of the automatic cleanup (task 3f8db20b):
// an async scan reads every transcript once, and lookup() gives the live
// answer, re-reading only what changed since the scan. The attachments plan
// and its apply take the lookup through PruneDeps.referencedAttachments.
//
// Seam: scanReferencedAttachments over a temp fixture tree, and planPrune /
// applyPrune with injected deps. Nothing here reads the real ~/.isomux.

import { describe, it, expect, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeStateDir } from "./test-support/temp-state.ts";
import {
  applyPrune,
  planPrune,
  scanReferencedAttachments,
  type PruneDeps,
  type PrunePolicy,
} from "./storage-prune.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) removeStateDir(dirs.pop()!);
});

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const POLICY: PrunePolicy = { olderThanDays: 30, keepPerAgent: 0 };

function logsDir(): string {
  const d = mkdtempSync(join(tmpdir(), "isomux-refindex-"));
  dirs.push(d);
  return join(d, "logs");
}

function line(...filenames: string[]): string {
  return (
    JSON.stringify({
      id: "1",
      kind: "user_message",
      attachments: filenames.map((filename) => ({ filename })),
    }) + "\n"
  );
}

function writeAt(path: string, content: string | Uint8Array, mtimeMs: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

const OLD = NOW - 200 * DAY_MS;

function deps(logs: string, over: Partial<PruneDeps> = {}): PruneDeps {
  return {
    logsDir: logs,
    tokenLogsDir: join(logs, "..", "token-logs"),
    terminalRecordingsDir: join(logs, "..", "terminal-recordings"),
    liveTerminalRecordingIds: new Set<string>(),
    now: NOW,
    activeSessionIds: new Set<string>(),
    killedAgentIds: new Set<string>(),
    loadSessionsMap: () => ({}),
    queuedAttachments: () => new Set<string>(),
    ...over,
  };
}

const sorted = (s: Set<string>) => [...s].sort();

describe("lookup after the scan", () => {
  it("reads plain and compressed transcripts", async () => {
    const logs = logsDir();
    const a = join(logs, "agent-a");
    writeAt(join(a, "s1.jsonl"), line("a.png"), OLD);
    writeAt(join(a, "s2.jsonl.gz"), Bun.gzipSync(line("b.png")), OLD);
    const index = await scanReferencedAttachments(logs);
    expect(sorted(index.lookup(a))).toEqual(["a.png", "b.png"]);
  });

  it("follows an append, a new transcript and a removed one", async () => {
    const logs = logsDir();
    const a = join(logs, "agent-a");
    writeAt(join(a, "s1.jsonl"), line("a.png"), OLD);
    writeAt(join(a, "s2.jsonl"), line("b.png"), OLD);
    const index = await scanReferencedAttachments(logs);

    writeAt(join(a, "s1.jsonl"), line("a.png") + line("c.png"), OLD + DAY_MS);
    writeAt(join(a, "s3.jsonl"), line("d.png"), OLD);
    rmSync(join(a, "s2.jsonl"));
    expect(sorted(index.lookup(a))).toEqual(["a.png", "c.png", "d.png"]);
  });

  // The change key is size AND mtime: a rewrite of the same length is still
  // a change.
  it("sees a same-size rewrite by its mtime", async () => {
    const logs = logsDir();
    const a = join(logs, "agent-a");
    writeAt(join(a, "s1.jsonl"), line("x.png"), OLD);
    const index = await scanReferencedAttachments(logs);
    writeAt(join(a, "s1.jsonl"), line("y.png"), OLD + DAY_MS);
    expect(sorted(index.lookup(a))).toEqual(["y.png"]);
  });

  it("sees a rewrite that changes only the size", async () => {
    const logs = logsDir();
    const a = join(logs, "agent-a");
    writeAt(join(a, "s1.jsonl"), line("x.png"), OLD);
    const index = await scanReferencedAttachments(logs);
    writeAt(join(a, "s1.jsonl"), line("x.png", "longer.png"), OLD);
    expect(sorted(index.lookup(a))).toEqual(["longer.png", "x.png"]);
  });

  // What keeps the lookup off the event loop: a transcript that did not
  // change is answered from the scan, never read again.
  it("does not read a transcript again when it did not change", async () => {
    const logs = logsDir();
    const a = join(logs, "agent-a");
    const file = join(a, "s1.jsonl");
    writeAt(file, line("a.png"), OLD);
    const index = await scanReferencedAttachments(logs);
    chmodSync(file, 0o000);
    try {
      expect(sorted(index.lookup(a))).toEqual(["a.png"]);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("throws for an agent whose transcript cannot be read, and answers for the others", async () => {
    const logs = logsDir();
    const a = join(logs, "agent-a");
    const b = join(logs, "agent-b");
    writeAt(join(a, "s1.jsonl"), line("a.png"), OLD);
    writeAt(join(b, "s1.jsonl"), line("b.png"), OLD);
    // Corrupt at scan time.
    writeAt(join(b, "bad.jsonl.gz"), "not gzip", OLD);
    const index = await scanReferencedAttachments(logs);
    expect(() => index.lookup(b)).toThrow();
    expect(sorted(index.lookup(a))).toEqual(["a.png"]);
    // Corrupt after the scan.
    writeAt(join(a, "late.jsonl.gz"), "not gzip either", OLD);
    expect(() => index.lookup(a)).toThrow();
  });
});

describe("the attachments plan and apply with the lookup", () => {
  function fixture() {
    const logs = logsDir();
    const a = join(logs, "agent-a");
    writeAt(join(a, "s1.jsonl"), line("kept.png"), OLD);
    writeAt(join(a, "files", "kept.png"), "k".repeat(100), OLD);
    writeAt(join(a, "files", "orphan.png"), "o".repeat(50), OLD);
    const b = join(logs, "agent-b");
    writeAt(join(b, "s1.jsonl.gz"), Bun.gzipSync(line("b-kept.png")), OLD);
    writeAt(join(b, "files", "b-kept.png"), "k".repeat(10), OLD);
    writeAt(join(b, "files", "b-orphan.png"), "o".repeat(5), OLD);
    return { logs, a, b };
  }

  it("plans the same candidates as today's synchronous reader", async () => {
    const { logs } = fixture();
    const index = await scanReferencedAttachments(logs);
    const today = planPrune("attachments", POLICY, deps(logs));
    const indexed = planPrune(
      "attachments",
      POLICY,
      deps(logs, { referencedAttachments: index.lookup }),
    );
    expect(today.candidates.map((c) => c.path).sort()).toEqual([
      join("agent-a", "files", "orphan.png"),
      join("agent-b", "files", "b-orphan.png"),
    ]);
    expect(indexed.candidates).toEqual(today.candidates);
    expect(indexed.skipped).toEqual(today.skipped);
  });

  it("the plan asks the given lookup, and a lookup that throws spares the agent's files", () => {
    const { logs, a } = fixture();
    const seen: string[] = [];
    const plan = planPrune(
      "attachments",
      POLICY,
      deps(logs, {
        referencedAttachments: (agentDir) => {
          seen.push(agentDir);
          if (agentDir === a) throw new Error("unreadable");
          // Claims every file of agent-b is referenced.
          return new Set(["b-kept.png", "b-orphan.png"]);
        },
      }),
    );
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped.find((s) => s.reason === "referenced")?.count).toBe(4);
  });

  // applyPrune plans again; it must ask the same lookup, or a timer apply
  // reads every transcript synchronously.
  it("the apply plans again with the given lookup", () => {
    const { logs, a } = fixture();
    const plan = planPrune("attachments", POLICY, deps(logs));
    expect(plan.candidates).toHaveLength(2);
    const result = applyPrune(
      plan,
      deps(logs, {
        referencedAttachments: () => new Set(["orphan.png", "b-orphan.png"]),
      }),
    );
    expect(result.deleted).toBe(0);
    expect(existsSync(join(a, "files", "orphan.png"))).toBe(true);

    const index = applyPrune(plan, deps(logs));
    expect(index.deleted).toBe(2);
    expect(existsSync(join(a, "files", "orphan.png"))).toBe(false);
  });
});

// The scan yields between files. The gauge is a turn probe: a setImmediate
// callback that schedules itself again runs once per event-loop turn, so its
// count is the number of turns the scan gave away, whatever the machine's
// speed. A timer is no gauge here: it fires only when 1 ms has passed, so a
// faster machine counts fewer ticks for the same yields (task 84f1182f).
// The bar is one turn per two files: a scan that yields per file gives at
// least one per file, one that yields only per agent gives about 4, and one
// that blocks throughout gives none.
const STALL_FILES = 48;
it("the scan gives the event loop a turn at least once per two files", async () => {
  const logs = logsDir();
  for (let agent = 0; agent < 4; agent++) {
    for (let i = 0; i < STALL_FILES / 4; i++) {
      writeAt(
        join(logs, `agent-${agent}`, `s${i}.jsonl`),
        line(`f${agent}-${i}.png`),
        OLD,
      );
    }
  }
  let turns = 0;
  let stop = false;
  const probe = () => {
    if (stop) return;
    turns++;
    setImmediate(probe);
  };
  setImmediate(probe);
  let index;
  let scanTurns = 0;
  // finally: a scan that throws must not leave the probe running.
  try {
    index = await scanReferencedAttachments(logs);
    scanTurns = turns;
    // Enabling condition: the probe is alive, so a low count is the scan's.
    await new Promise<void>((r) => setImmediate(r));
  } finally {
    stop = true;
  }
  expect(turns).toBeGreaterThan(scanTurns);

  expect(index.lookup(join(logs, "agent-3")).has("f3-11.png")).toBe(true);
  expect(scanTurns).toBeGreaterThanOrEqual(STALL_FILES / 2);
});
