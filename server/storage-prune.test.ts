// T0/T1 - the transcript/attachment pruner's safety matrix (task 2366ccb0).
//
// The whole point of this module is what it REFUSES to delete, so most of these
// tests assert survival, not removal. Every root is injected; the fixtures live
// under the OS temp dir and cleanup goes through the temp-state guard.
//
// Candidate paths are RELATIVE to the logs dir throughout - that is the wire
// contract, and it is what makes the apply-time fence structural.

import { describe, it, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  renameSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  utimesSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeStateDir } from "./test-support/temp-state.ts";
import {
  planPrune,
  applyPrune,
  type PruneDeps,
  type PrunePolicy,
  type PruneSkipReason,
} from "./storage-prune.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "isomux-prune-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) removeStateDir(dirs.pop()!);
});

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const POLICY: PrunePolicy = { olderThanDays: 30, keepPerAgent: 2 };

// Write a file and backdate its mtime by `ageDays`.
function writeAged(path: string, content: string, ageDays: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  const seconds = (NOW - ageDays * DAY_MS) / 1000;
  utimesSync(path, seconds, seconds);
}

function deps(logsDir: string, overrides: Partial<PruneDeps> = {}): PruneDeps {
  return {
    logsDir,
    tokenLogsDir: join(logsDir, "..", "token-logs"),
    terminalRecordingsDir: join(logsDir, "..", "terminal-recordings"),
    liveTerminalRecordingIds: new Set<string>(),
    now: NOW,
    activeSessionIds: new Set<string>(),
    killedAgentIds: new Set<string>(),
    loadSessionsMap: () => ({}),
    queuedAttachments: () => new Set<string>(),
    ...overrides,
  };
}

function skipCount(
  plan: { skipped: { reason: PruneSkipReason; count: number }[] },
  reason: PruneSkipReason,
): number {
  return plan.skipped.find((s) => s.reason === reason)?.count ?? 0;
}

// Four sessions for one agent, all old enough to prune on age alone.
function fourOldSessions(): string {
  const logs = join(tempDir(), "logs");
  writeAged(join(logs, "agent-a", "newest.jsonl"), "n".repeat(10), 100);
  writeAged(join(logs, "agent-a", "second.jsonl"), "s".repeat(20), 200);
  writeAged(join(logs, "agent-a", "third.jsonl"), "t".repeat(30), 300);
  writeAged(join(logs, "agent-a", "oldest.jsonl"), "o".repeat(40), 400);
  return logs;
}

const sessionIds = (plan: { candidates: { sessionId?: string }[] }) =>
  plan.candidates.map((c) => c.sessionId).sort();

// A logs tree plus a sibling directory that must never be touched.
function logsWithOutsideVictim(): { logs: string; outside: string } {
  const root = tempDir();
  const logs = join(root, "logs");
  const outside = join(root, "outside");
  mkdirSync(join(logs, "agent-a"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeAged(join(outside, "victim.txt"), "do not delete me", 400);
  return { logs, outside };
}

describe("symlink containment", () => {
  it("never lists - or deletes - through a symlinked files/ dir", () => {
    const { logs, outside } = logsWithOutsideVictim();
    // The attack: agent-a is a real dir, but its files/ points out of the tree.
    // A purely lexical fence accepts "agent-a/files/victim.txt" because the
    // string resolves under logs/.
    symlinkSync(outside, join(logs, "agent-a", "files"));
    const d = deps(logs);
    const plan = planPrune("attachments", POLICY, d);
    expect(plan.candidates).toEqual([]);
    applyPrune(plan, d);
    expect(existsSync(join(outside, "victim.txt"))).toBe(true);
  });

  it("plans transcripts only from real agent- directories", () => {
    const { logs, outside } = logsWithOutsideVictim();
    writeAged(join(outside, "stolen.jsonl"), "x".repeat(10), 400);
    symlinkSync(outside, join(logs, "agent-evil"));
    writeAged(join(logs, "scratch", "notes.jsonl"), "x".repeat(10), 400);
    writeAged(join(logs, "agent-a", "s1.jsonl"), "x".repeat(10), 400);
    const plan = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 0 },
      deps(logs),
    );
    expect(plan.candidates.map((c) => c.path)).toEqual(["agent-a/s1.jsonl"]);
  });
});

describe("planPrune (transcripts)", () => {
  it("selects only transcripts past the age cutoff, with relative paths", () => {
    const logs = join(tempDir(), "logs");
    writeAged(join(logs, "agent-a", "old.jsonl"), "x".repeat(10), 90);
    writeAged(join(logs, "agent-a", "fresh.jsonl"), "x".repeat(20), 5);
    const plan = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 0 },
      deps(logs),
    );
    expect(plan.candidates.map((c) => c.path)).toEqual(["agent-a/old.jsonl"]);
    expect(plan.bytes).toBe(10);
    expect(skipCount(plan, "too-recent")).toBe(1);
  });

  it("keeps the K newest sessions per agent regardless of age", () => {
    const plan = planPrune("transcripts", POLICY, deps(fourOldSessions()));
    expect(sessionIds(plan)).toEqual(["oldest", "third"]);
    expect(skipCount(plan, "keep-newest")).toBe(2);
  });

  it("never proposes a session another session was forked from", () => {
    const logs = fourOldSessions();
    // "third" is the parent of "newest" - loadLogWithAncestors reads it to
    // assemble the fork's transcript, so it must survive forever.
    const plan = planPrune(
      "transcripts",
      POLICY,
      deps(logs, {
        loadSessionsMap: () => ({ newest: { forkedFrom: "third" } }),
      }),
    );
    expect(sessionIds(plan)).toEqual(["oldest"]);
    expect(skipCount(plan, "fork-ancestor")).toBe(1);
  });

  it("protects a whole grandparent chain, not just the immediate parent", () => {
    const logs = fourOldSessions();
    // newest <- second <- third <- oldest. Every ancestor is load-bearing for
    // assembling `newest`, so the whole chain above the leaf is spared; the
    // leaf itself is nobody's ancestor and stays prunable.
    const plan = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 0 },
      deps(logs, {
        loadSessionsMap: () => ({
          newest: { forkedFrom: "second" },
          second: { forkedFrom: "third" },
          third: { forkedFrom: "oldest" },
        }),
      }),
    );
    expect(sessionIds(plan)).toEqual(["newest"]);
    expect(skipCount(plan, "fork-ancestor")).toBe(3);
  });

  it("terminates on a cyclic sessions map instead of looping", () => {
    const logs = fourOldSessions();
    // A corrupt map claiming a cycle: the rule is set-membership, not a walk,
    // so there is no chain to loop on - every named parent is simply spared.
    const plan = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 0 },
      deps(logs, {
        loadSessionsMap: () => ({
          third: { forkedFrom: "oldest" },
          oldest: { forkedFrom: "third" },
        }),
      }),
    );
    expect(sessionIds(plan)).toEqual(["newest", "second"]);
    expect(skipCount(plan, "fork-ancestor")).toBe(2);
  });

  it("ignores sessions.json and anything that is not a .jsonl", () => {
    const logs = join(tempDir(), "logs");
    writeAged(join(logs, "agent-a", "old.jsonl"), "x".repeat(10), 90);
    writeAged(join(logs, "agent-a", "sessions.json"), "x".repeat(500), 90);
    const plan = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 0 },
      deps(logs),
    );
    expect(plan.candidates.map((c) => c.path)).toEqual(["agent-a/old.jsonl"]);
  });

  it("applies keepPerAgent per agent, not across the office", () => {
    const logs = join(tempDir(), "logs");
    for (const agent of ["agent-a", "agent-b"]) {
      writeAged(join(logs, agent, "s1.jsonl"), "x".repeat(10), 100);
      writeAged(join(logs, agent, "s2.jsonl"), "x".repeat(10), 200);
    }
    const plan = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 1 },
      deps(logs),
    );
    expect(plan.candidates).toHaveLength(2);
    expect(new Set(plan.candidates.map((c) => c.agentId))).toEqual(
      new Set(["agent-a", "agent-b"]),
    );
  });

  // Task 9643a66a: spawning agents kill finished workers, so a killed agent's
  // newest sessions are no longer spared on recency alone. Every other guard
  // still holds for it.
  it("drops only the recency floor for a killed agent", () => {
    const logs = fourOldSessions();
    writeAged(join(logs, "agent-a", "fresh.jsonl"), "f", 1);
    const plan = planPrune(
      "transcripts",
      POLICY,
      deps(logs, {
        killedAgentIds: new Set(["agent-a"]),
        activeSessionIds: new Set(["second"]),
        loadSessionsMap: () => ({ newest: { forkedFrom: "third" } }),
      }),
    );
    expect(sessionIds(plan)).toEqual(["newest", "oldest"]);
    expect(skipCount(plan, "active-session")).toBe(1);
    expect(skipCount(plan, "fork-ancestor")).toBe(1);
    expect(skipCount(plan, "too-recent")).toBe(1);
    expect(skipCount(plan, "keep-newest")).toBe(0);
  });

  it("returns an empty plan when the logs dir does not exist", () => {
    const plan = planPrune(
      "transcripts",
      POLICY,
      deps(join(tempDir(), "no-logs")),
    );
    expect(plan.candidates).toEqual([]);
    expect(plan.bytes).toBe(0);
  });
});

// An agent whose surviving transcript references exactly one of its two
// attachments. Both files are old enough for any age policy.
function agentWithAttachments(): string {
  const logs = join(tempDir(), "logs");
  writeAged(
    join(logs, "agent-a", "live.jsonl"),
    JSON.stringify({
      id: "1",
      kind: "user_message",
      attachments: [{ filename: "kept.png", originalName: "photo.png" }],
    }) + "\n",
    200,
  );
  writeAged(join(logs, "agent-a", "files", "kept.png"), "k".repeat(100), 200);
  writeAged(join(logs, "agent-a", "files", "orphan.png"), "o".repeat(50), 200);
  return logs;
}

describe("planPrune (attachments)", () => {
  it("proposes old orphans only: never a referenced, recent or nested file", () => {
    const logs = agentWithAttachments();
    writeAged(join(logs, "agent-a", "files", "fresh.png"), "f".repeat(10), 2);
    writeAged(
      join(logs, "agent-a", "files", "nested", "deep.png"),
      "x".repeat(100),
      200,
    );
    const plan = planPrune("attachments", POLICY, deps(logs));
    expect(plan.candidates.map((c) => c.path)).toEqual([
      "agent-a/files/orphan.png",
    ]);
    expect(plan.bytes).toBe(50);
    expect(skipCount(plan, "referenced")).toBe(1);
    expect(skipCount(plan, "too-recent")).toBe(1);
  });

  it("frees an attachment once the transcript referencing it is gone", () => {
    const logs = agentWithAttachments();
    const d = deps(logs);
    // Before: kept.png is referenced.
    expect(planPrune("attachments", POLICY, d).candidates).toHaveLength(1);
    // Prune the transcript that referenced it, then re-plan.
    const t = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 0 },
      d,
    );
    expect(applyPrune(t, d).deleted).toBe(1);
    const after = planPrune("attachments", POLICY, d);
    expect(after.candidates.map((c) => c.path).sort()).toEqual([
      "agent-a/files/kept.png",
      "agent-a/files/orphan.png",
    ]);
  });

  it("unions queued references with transcript references, and frees them when the queue clears", () => {
    const logs = agentWithAttachments();
    // kept.png is referenced by a transcript; orphan.png is referenced ONLY by
    // a message still sitting in the queue for a busy agent. Deleting the
    // latter would destroy the attachment before it is ever delivered - the
    // queue is durable and a stuck queue is unbounded in time, so crossing the
    // age cutoff proves nothing about whether the file is still owed.
    const withQueue = deps(logs, {
      queuedAttachments: (agentId) =>
        agentId === "agent-a" ? new Set(["orphan.png"]) : new Set(),
    });
    const spared = planPrune("attachments", POLICY, withQueue);
    expect(spared.candidates).toEqual([]);
    // Both sources counted: the union is preserved, not replaced.
    expect(skipCount(spared, "referenced")).toBe(2);
    // And an apply against those deps deletes neither.
    expect(applyPrune(spared, withQueue).deleted).toBe(0);
    expect(existsSync(join(logs, "agent-a", "files", "orphan.png"))).toBe(true);

    // Once the queue flushes (or the message is cancelled), it is eligible -
    // and kept.png stays spared on its transcript reference alone.
    const after = planPrune("attachments", POLICY, deps(logs));
    expect(after.candidates.map((c) => c.path)).toEqual([
      "agent-a/files/orphan.png",
    ]);
    expect(skipCount(after, "referenced")).toBe(1);
  });

  it("applies the queue protection per agent, not office-wide", () => {
    const logs = agentWithAttachments();
    writeAged(
      join(logs, "agent-b", "files", "orphan.png"),
      "b".repeat(20),
      200,
    );
    // A queued reference held by agent-a must not protect agent-b's file of the
    // same name - attachments are per-agent.
    const plan = planPrune(
      "attachments",
      POLICY,
      deps(logs, {
        queuedAttachments: (agentId) =>
          agentId === "agent-a" ? new Set(["orphan.png"]) : new Set(),
      }),
    );
    expect(plan.candidates.map((c) => c.path)).toEqual([
      "agent-b/files/orphan.png",
    ]);
  });

  it("reads references out of pretty-printed transcripts too", () => {
    const logs = join(tempDir(), "logs");
    writeAged(
      join(logs, "agent-a", "s1.jsonl"),
      JSON.stringify({ attachments: [{ filename: "kept.png" }] }, null, 2),
      200,
    );
    writeAged(join(logs, "agent-a", "files", "kept.png"), "k".repeat(10), 200);
    const plan = planPrune("attachments", POLICY, deps(logs));
    expect(plan.candidates).toEqual([]);
  });
});

describe("applyPrune", () => {
  it("deletes exactly the planned files and leaves the rest", () => {
    const logs = fourOldSessions();
    const d = deps(logs);
    const plan = planPrune("transcripts", POLICY, d);
    const result = applyPrune(plan, d);
    expect(result.deleted).toBe(2);
    expect(result.bytes).toBe(70);
    expect(result.refused).toEqual([]);
    expect(result.aborted).toBeUndefined();
    expect(existsSync(join(logs, "agent-a", "oldest.jsonl"))).toBe(false);
    expect(existsSync(join(logs, "agent-a", "third.jsonl"))).toBe(false);
    expect(existsSync(join(logs, "agent-a", "newest.jsonl"))).toBe(true);
    expect(existsSync(join(logs, "agent-a", "second.jsonl"))).toBe(true);
  });

  it("aborts the WHOLE run when any candidate escapes the logs root", () => {
    const logs = fourOldSessions();
    const d = deps(logs);
    const plan = planPrune("transcripts", POLICY, d);
    plan.candidates.push({
      path: "../../secrets.txt",
      bytes: 10,
      agentId: "agent-a",
      ageDays: 400,
      mtimeMs: NOW - 400 * DAY_MS,
    });
    const result = applyPrune(plan, d);
    expect(result.aborted).toContain("escapes the logs root");
    expect(result.deleted).toBe(0);
    // The well-formed candidates are NOT deleted either: a plan with a bad row
    // is a plan we refuse to act on at all.
    expect(existsSync(join(logs, "agent-a", "oldest.jsonl"))).toBe(true);
    expect(existsSync(join(logs, "agent-a", "third.jsonl"))).toBe(true);
  });

  it("re-plans at apply and names the fresh-pass reason on each refusal", () => {
    const logs = fourOldSessions();
    const plan = planPrune(
      "transcripts",
      POLICY,
      deps(logs, { killedAgentIds: new Set(["agent-a"]) }),
    );
    expect(plan.candidates).toHaveLength(4);
    // Between plan and apply: the agent was revived (its floor is back), one
    // session went live and one became a fork parent. The refusal names WHY
    // the fresh pass excluded each file: this is the audit trail for a delete.
    const result = applyPrune(
      plan,
      deps(logs, {
        activeSessionIds: new Set(["oldest"]),
        loadSessionsMap: () => ({ newest: { forkedFrom: "third" } }),
      }),
    );
    expect(
      Object.fromEntries(result.refused.map((r) => [r.path, r.reason])),
    ).toEqual({
      "agent-a/newest.jsonl": "became-keep-newest",
      "agent-a/second.jsonl": "became-keep-newest",
      "agent-a/third.jsonl": "became-fork-ancestor",
      "agent-a/oldest.jsonl": "became-active-session",
    });
    expect(result.deleted).toBe(0);
    for (const name of ["newest", "second", "third", "oldest"])
      expect(existsSync(join(logs, "agent-a", `${name}.jsonl`))).toBe(true);
  });

  // The last checks before unlink cover the window after apply's own fresh
  // plan. loadSessionsMap runs inside that plan after the files are listed, so
  // a swap made there lands in the window.
  it("refuses a delete whose parent became a symlink after the fresh plan", () => {
    const swaps: Record<string, (root: string) => string> = {
      // The logs root now points at a decoy outside it.
      "logs root": (root) => {
        renameSync(join(root, "logs"), join(root, "real-logs"));
        writeAged(join(root, "decoy", "agent-a", "old.jsonl"), "decoy", 400);
        symlinkSync(join(root, "decoy"), join(root, "logs"));
        return join(root, "decoy", "agent-a", "old.jsonl");
      },
      // The agent dir now points at another directory INSIDE the logs root,
      // whose transcripts were never consulted.
      "agent dir": (root) => {
        const logs = join(root, "logs");
        renameSync(join(logs, "agent-a"), join(logs, "agent-z"));
        symlinkSync(join(logs, "agent-z"), join(logs, "agent-a"));
        return join(logs, "agent-z", "old.jsonl");
      },
    };
    for (const [label, swap] of Object.entries(swaps)) {
      const root = tempDir();
      const logs = join(root, "logs");
      writeAged(join(logs, "agent-a", "old.jsonl"), "old", 400);
      let calls = 0;
      let victim = "";
      const d = deps(logs, {
        loadSessionsMap: () => {
          if (++calls === 2) victim = swap(root);
          return {};
        },
      });
      const plan = planPrune(
        "transcripts",
        { olderThanDays: 30, keepPerAgent: 0 },
        d,
      );
      const result = applyPrune(plan, d);
      expect([label, calls, result.refused]).toEqual([
        label,
        2,
        [{ path: "agent-a/old.jsonl", reason: "parent-escapes-logs-dir" }],
      ]);
      expect([label, existsSync(victim)]).toEqual([label, true]);
    }
  });

  it("reports a candidate whose file simply vanished as missing", () => {
    const logs = fourOldSessions();
    const d = deps(logs);
    const plan = planPrune("transcripts", POLICY, d);
    plan.candidates.push({
      path: "agent-a/never-existed.jsonl",
      bytes: 1,
      agentId: "agent-a",
      sessionId: "never-existed",
      ageDays: 400,
      mtimeMs: NOW - 400 * DAY_MS,
    });
    const result = applyPrune(plan, d);
    expect(result.refused).toContainEqual({
      path: "agent-a/never-existed.jsonl",
      reason: "missing",
    });
  });

  it("refuses a file whose mtime moved since the plan", () => {
    const logs = fourOldSessions();
    const d = deps(logs);
    const plan = planPrune("transcripts", POLICY, d);
    const target = plan.candidates[0];
    target.mtimeMs = target.mtimeMs - 1;
    const result = applyPrune(plan, d);
    expect(existsSync(join(logs, target.path))).toBe(true);
    expect(result.refused).toContainEqual({
      path: target.path,
      reason: "modified-since-plan",
    });
  });

  it("deletes orphaned attachments and leaves referenced ones", () => {
    const logs = agentWithAttachments();
    const d = deps(logs);
    const result = applyPrune(planPrune("attachments", POLICY, d), d);
    expect(result.deleted).toBe(1);
    expect(existsSync(join(logs, "agent-a", "files", "orphan.png"))).toBe(
      false,
    );
    expect(existsSync(join(logs, "agent-a", "files", "kept.png"))).toBe(true);
  });
});

describe("token-log prune target", () => {
  it("selects old token files independently of credentials and ignores junk, directories and symlinks", () => {
    const root = tempDir();
    const dir = join(root, "token-logs");
    const old = "0123456789abcdef.jsonl";
    writeAged(join(dir, old), "orphan log", 40);
    writeAged(join(dir, "abcdef0123456789.jsonl"), "active log", 1);
    writeAged(join(dir, "junk.jsonl"), "junk", 40);
    mkdirSync(join(dir, "1111111111111111.jsonl"));
    const outside = join(tempDir(), "outside.jsonl");
    writeAged(outside, "outside", 50);
    symlinkSync(outside, join(dir, "2222222222222222.jsonl"));
    const d = deps(join(root, "logs"));
    const plan = planPrune("token-logs", POLICY, d);
    expect(plan.candidates.map((c) => c.path)).toEqual([old]);
    expect(plan.bytes).toBe(10);
    expect(skipCount(plan, "too-recent")).toBe(1);
    expect(existsSync(join(dir, old))).toBe(true);
    expect(applyPrune(plan, d)).toMatchObject({
      deleted: 1,
      bytes: 10,
      refused: [],
    });
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(dir, "junk.jsonl"))).toBe(true);
  });

  // A corrupt log is renamed to <id>.jsonl.corrupt-<ms> and nothing reads it
  // again, so it is prunable by the same age rule as a live log (task 8cd9de95).
  // Age comes from mtime, not from the timestamp in the name.
  it("treats a quarantined token log like a live one and leaves near-miss names alone", () => {
    const root = tempDir();
    const dir = join(root, "token-logs");
    const oldQuarantine = `0123456789abcdef.jsonl.corrupt-${NOW}`;
    const youngQuarantine = `abcdef0123456789.jsonl.corrupt-${NOW - DAY_MS}`;
    writeAged(join(dir, oldQuarantine), "quarantined", 40);
    writeAged(join(dir, youngQuarantine), "fresh", 1);
    const nearMisses = [
      "0123456789abcdef.jsonl.corrupt-",
      "0123456789abcdef.jsonl.corrupt-12x",
      "0123456789abcdef.jsonl.corrupt-123.tmp",
      "0123456789abcdef.json.corrupt-123",
      "x0123456789abcdef.jsonl.corrupt-123",
      "api-tokens.json.corrupt-123",
    ];
    for (const name of nearMisses) writeAged(join(dir, name), "keep", 40);
    mkdirSync(join(dir, "1111111111111111.jsonl.corrupt-123"));
    const outside = join(tempDir(), "outside");
    writeAged(outside, "outside", 50);
    symlinkSync(outside, join(dir, "2222222222222222.jsonl.corrupt-123"));
    const d = deps(join(root, "logs"));

    const plan = planPrune("token-logs", POLICY, d);
    expect(plan.candidates.map((c) => c.path)).toEqual([oldQuarantine]);
    expect(plan.bytes).toBe("quarantined".length);
    expect(plan.skipped).toEqual([
      { reason: "too-recent", count: 1, bytes: "fresh".length },
    ]);
    expect(applyPrune(plan, d)).toMatchObject({
      deleted: 1,
      bytes: "quarantined".length,
      refused: [],
    });
    expect(existsSync(join(dir, oldQuarantine))).toBe(false);
    expect(existsSync(join(dir, youngQuarantine))).toBe(true);
    for (const name of nearMisses)
      expect(existsSync(join(dir, name))).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it("refuses path escapes, modified files and a symlinked target root", () => {
    const root = tempDir();
    const dir = join(root, "token-logs");
    const name = "0123456789abcdef.jsonl";
    writeAged(join(dir, name), "original", 60);
    const d = deps(join(root, "logs"));
    const plan = planPrune("token-logs", POLICY, d);
    for (const path of [
      "../outside.jsonl",
      "/outside.jsonl",
      "nested/../../outside.jsonl",
    ]) {
      const escaped = {
        ...plan,
        candidates: [{ ...plan.candidates[0], path }],
      };
      expect(applyPrune(escaped, d).aborted).toBeDefined();
    }
    writeAged(join(dir, name), "changed", 50);
    expect(applyPrune(plan, d).refused).toEqual([
      { path: name, reason: "modified-since-plan" },
    ]);
    renameSync(dir, join(root, "moved"));
    symlinkSync(join(root, "moved"), dir);
    expect(planPrune("token-logs", POLICY, d).candidates).toEqual([]);
    expect(applyPrune(plan, d).deleted).toBe(0);
    expect(existsSync(join(root, "moved", name))).toBe(true);
  });
});

// Compressed transcripts (task e9776386): a <sid>.jsonl.gz is the same session
// in another form. Prune must rank, delete and read it like a .jsonl - above
// all, an attachment that only a compressed transcript names is not an orphan.
describe("compressed transcripts", () => {
  const gz = (text: string) => Bun.gzipSync(text);

  function writeAgedBytes(path: string, bytes: Uint8Array, ageDays: number) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
    const seconds = (NOW - ageDays * DAY_MS) / 1000;
    utimesSync(path, seconds, seconds);
  }

  it("ranks a compressed session with the rest and deletes it", () => {
    const logs = join(tempDir(), "logs");
    // The newest session is compressed: keepPerAgent 1 must spare IT, so the
    // plain one is the candidate.
    writeAgedBytes(join(logs, "agent-a", "newest.jsonl.gz"), gz("n\n"), 100);
    writeAged(join(logs, "agent-a", "older.jsonl"), "o".repeat(40), 200);
    writeAgedBytes(join(logs, "agent-b", "packed.jsonl.gz"), gz("p\n"), 300);
    const d = deps(logs);

    const plan = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 1 },
      d,
    );
    expect(sessionIds(plan)).toEqual(["older"]);

    const all = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 0 },
      d,
    );
    expect(sessionIds(all)).toEqual(["newest", "older", "packed"]);
    expect(applyPrune(all, d).deleted).toBe(3);
    expect(existsSync(join(logs, "agent-a", "newest.jsonl.gz"))).toBe(false);
    expect(existsSync(join(logs, "agent-b", "packed.jsonl.gz"))).toBe(false);
  });

  it("deletes both files of a session a crash left in both forms", () => {
    const logs = join(tempDir(), "logs");
    writeAged(join(logs, "agent-a", "both.jsonl"), "b".repeat(10), 200);
    writeAgedBytes(join(logs, "agent-a", "both.jsonl.gz"), gz("b\n"), 200);
    const d = deps(logs);
    const plan = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 0 },
      d,
    );
    expect(sessionIds(plan)).toEqual(["both"]);
    applyPrune(plan, d);
    expect(existsSync(join(logs, "agent-a", "both.jsonl"))).toBe(false);
    expect(existsSync(join(logs, "agent-a", "both.jsonl.gz"))).toBe(false);
  });

  it("spares an attachment that only a compressed transcript names", () => {
    const logs = agentWithAttachments();
    writeAgedBytes(
      join(logs, "agent-a", "older.jsonl.gz"),
      gz(
        JSON.stringify({ id: "1", attachments: [{ filename: "orphan.png" }] }) +
          "\n",
      ),
      300,
    );
    const plan = planPrune("attachments", POLICY, deps(logs));
    expect(plan.candidates).toEqual([]);
    expect(skipCount(plan, "referenced")).toBe(2);
  });

  it("spares every attachment of an agent whose compressed transcript is corrupt", () => {
    const logs = agentWithAttachments();
    writeAgedBytes(
      join(logs, "agent-a", "broken.jsonl.gz"),
      new TextEncoder().encode("not gzip"),
      300,
    );
    const plan = planPrune("attachments", POLICY, deps(logs));
    expect(plan.candidates).toEqual([]);
    expect(skipCount(plan, "referenced")).toBe(2);
  });
});
