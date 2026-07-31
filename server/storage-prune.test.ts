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
  mkdirSync,
  writeFileSync,
  existsSync,
  utimesSync,
  chmodSync,
  symlinkSync,
  realpathSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeStateDir } from "./test-support/temp-state.ts";
import {
  planPrune,
  applyPrune,
  resolveCandidatePath,
  parentInsideLogsRoot,
  noSymlinkParents,
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
    now: NOW,
    activeSessionIds: new Set<string>(),
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

  it("never traverses a symlinked agent dir", () => {
    const { logs, outside } = logsWithOutsideVictim();
    writeAged(join(outside, "stolen.jsonl"), "x".repeat(10), 400);
    symlinkSync(outside, join(logs, "agent-evil"));
    const d = deps(logs);
    expect(
      planPrune("transcripts", { ...POLICY, keepPerAgent: 0 }, d).candidates,
    ).toEqual([]);
    expect(existsSync(join(outside, "stolen.jsonl"))).toBe(true);
  });

  it("ignores directories under logs that are not agent dirs", () => {
    const logs = join(tempDir(), "logs");
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

describe("parentInsideLogsRoot", () => {
  it("accepts a real parent under the logs root", () => {
    const logs = join(tempDir(), "logs");
    writeAged(join(logs, "agent-a", "s1.jsonl"), "x", 1);
    expect(
      parentInsideLogsRoot(
        realpathSync(logs),
        join(logs, "agent-a", "s1.jsonl"),
      ),
    ).toBe(true);
  });

  it("rejects a parent that resolves outside the logs root", () => {
    const { logs, outside } = logsWithOutsideVictim();
    symlinkSync(outside, join(logs, "agent-a", "files"));
    // The path is lexically inside logs/, but its parent really is not. This is
    // the check that has to fire if a symlink appears after the plan is made.
    expect(
      parentInsideLogsRoot(
        realpathSync(logs),
        join(logs, "agent-a", "files", "victim.txt"),
      ),
    ).toBe(false);
  });

  it("rejects a parent that does not exist", () => {
    const logs = join(tempDir(), "logs");
    mkdirSync(logs, { recursive: true });
    expect(
      parentInsideLogsRoot(realpathSync(logs), join(logs, "gone", "x.jsonl")),
    ).toBe(false);
  });
});

describe("noSymlinkParents", () => {
  it("accepts a candidate whose parents are all real directories", () => {
    const logs = join(tempDir(), "logs");
    writeAged(join(logs, "agent-a", "files", "x.png"), "x", 1);
    expect(noSymlinkParents(realpathSync(logs), "agent-a/files/x.png")).toBe(
      true,
    );
  });

  it("rejects a symlinked parent that still resolves INSIDE the logs root", () => {
    const logs = join(tempDir(), "logs");
    writeAged(join(logs, "agent-b", "files", "x.png"), "x", 1);
    mkdirSync(join(logs, "agent-a"), { recursive: true });
    // agent-a/files -> agent-b/files. realpath containment PASSES (the target
    // is under logs/), but the file belongs to an agent whose transcripts were
    // never consulted for reachability, so it must still be refused.
    symlinkSync(join(logs, "agent-b", "files"), join(logs, "agent-a", "files"));
    const root = realpathSync(logs);
    expect(
      parentInsideLogsRoot(root, join(logs, "agent-a", "files", "x.png")),
    ).toBe(true);
    expect(noSymlinkParents(root, "agent-a/files/x.png")).toBe(false);
  });

  it("rejects a missing parent and an empty path", () => {
    const logs = join(tempDir(), "logs");
    mkdirSync(logs, { recursive: true });
    const root = realpathSync(logs);
    expect(noSymlinkParents(root, "agent-a/files/x.png")).toBe(false);
    expect(noSymlinkParents(root, "")).toBe(false);
  });
});

describe("resolveCandidatePath", () => {
  it("resolves a relative candidate under the logs root", () => {
    expect(resolveCandidatePath("/logs", "agent-a/s.jsonl")).toBe(
      "/logs/agent-a/s.jsonl",
    );
  });

  it("rejects absolute paths, traversal, and the root itself", () => {
    expect(resolveCandidatePath("/logs", "/etc/passwd")).toBeNull();
    expect(resolveCandidatePath("/logs", "../secrets.txt")).toBeNull();
    expect(
      resolveCandidatePath("/logs", "agent-a/../../etc/passwd"),
    ).toBeNull();
    expect(resolveCandidatePath("/logs", "")).toBeNull();
    expect(resolveCandidatePath("/logs", ".")).toBeNull();
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

  it("never proposes the active session, even when it is the oldest", () => {
    const logs = fourOldSessions();
    const plan = planPrune(
      "transcripts",
      POLICY,
      deps(logs, { activeSessionIds: new Set(["oldest"]) }),
    );
    expect(sessionIds(plan)).toEqual(["third"]);
    expect(skipCount(plan, "active-session")).toBe(1);
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

  it("protects a parent shared by sibling forks", () => {
    const logs = fourOldSessions();
    const plan = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 0 },
      deps(logs, {
        loadSessionsMap: () => ({
          newest: { forkedFrom: "oldest" },
          second: { forkedFrom: "oldest" },
        }),
      }),
    );
    expect(sessionIds(plan)).toEqual(["newest", "second", "third"]);
    expect(skipCount(plan, "fork-ancestor")).toBe(1);
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

  it("protects an ancestor even when its descendant is itself prunable", () => {
    const logs = fourOldSessions();
    const plan = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 0 },
      deps(logs, {
        loadSessionsMap: () => ({ third: { forkedFrom: "oldest" } }),
      }),
    );
    expect(sessionIds(plan)).not.toContain("oldest");
    expect(sessionIds(plan)).toContain("third");
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
  it("proposes orphans and spares anything a surviving transcript references", () => {
    const plan = planPrune("attachments", POLICY, deps(agentWithAttachments()));
    expect(plan.candidates.map((c) => c.path)).toEqual([
      "agent-a/files/orphan.png",
    ]);
    expect(plan.bytes).toBe(50);
    expect(skipCount(plan, "referenced")).toBe(1);
  });

  it("spares an orphan that is younger than the cutoff", () => {
    const logs = join(tempDir(), "logs");
    writeAged(join(logs, "agent-a", "files", "fresh.png"), "f".repeat(10), 2);
    const plan = planPrune("attachments", POLICY, deps(logs));
    expect(plan.candidates).toEqual([]);
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

  it("sees a reference in any session, not just the newest", () => {
    const logs = agentWithAttachments();
    // A second, older transcript is the only one naming orphan.png.
    writeAged(
      join(logs, "agent-a", "older.jsonl"),
      JSON.stringify({
        id: "1",
        attachments: [{ filename: "orphan.png" }],
      }) + "\n",
      300,
    );
    const plan = planPrune("attachments", POLICY, deps(logs));
    expect(plan.candidates).toEqual([]);
    expect(skipCount(plan, "referenced")).toBe(2);
  });

  it("spares every attachment of an agent whose transcript cannot be read", () => {
    const logs = agentWithAttachments();
    chmodSync(join(logs, "agent-a", "live.jsonl"), 0o000);
    try {
      const plan = planPrune("attachments", POLICY, deps(logs));
      // Unreadable history means unknown reachability: refuse the whole agent
      // rather than guess that nothing points at these files.
      expect(plan.candidates).toEqual([]);
      expect(skipCount(plan, "referenced")).toBe(2);
    } finally {
      chmodSync(join(logs, "agent-a", "live.jsonl"), 0o644);
    }
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

  it("proposes NOTHING when the queue state is unknown", () => {
    const logs = agentWithAttachments();
    // null is not an empty set: an unreadable durable queue means we cannot
    // know what is still owed, and unknown must never be collapsed into
    // "nothing is owed" on a path that deletes files.
    const plan = planPrune(
      "attachments",
      POLICY,
      deps(logs, { queuedAttachments: () => null }),
    );
    expect(plan.candidates).toEqual([]);
    expect(plan.bytes).toBe(0);
    // Reported under its own reason, not as "referenced" - a dry run has to say
    // WHICH unknown stopped it.
    expect(skipCount(plan, "queue-state-unknown")).toBe(2);
    expect(skipCount(plan, "referenced")).toBe(0);
  });

  it("still prunes when the queue is genuinely empty, not unknown", () => {
    const logs = agentWithAttachments();
    const plan = planPrune(
      "attachments",
      POLICY,
      deps(logs, { queuedAttachments: () => new Set<string>() }),
    );
    expect(plan.candidates.map((c) => c.path)).toEqual([
      "agent-a/files/orphan.png",
    ]);
    expect(skipCount(plan, "queue-state-unknown")).toBe(0);
  });

  it("deletes nothing on apply while the queue state is unknown", () => {
    const logs = agentWithAttachments();
    const known = deps(logs);
    const plan = planPrune("attachments", POLICY, known);
    expect(plan.candidates).toHaveLength(1);
    // The queue file becomes unreadable between plan and apply: the re-plan
    // approves nothing, so the stale plan cannot delete.
    const result = applyPrune(
      plan,
      deps(logs, { queuedAttachments: () => null }),
    );
    expect(result.deleted).toBe(0);
    expect(existsSync(join(logs, "agent-a", "files", "orphan.png"))).toBe(true);
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

  it("does not recurse into subdirectories of files/", () => {
    const logs = join(tempDir(), "logs");
    writeAged(
      join(logs, "agent-a", "files", "nested", "deep.png"),
      "x".repeat(100),
      200,
    );
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

  it("aborts on an absolute candidate path", () => {
    const logs = fourOldSessions();
    const d = deps(logs);
    const plan = planPrune("transcripts", POLICY, d);
    plan.candidates[0].path = join(logs, "agent-a", "oldest.jsonl");
    const result = applyPrune(plan, d);
    expect(result.aborted).toBeTruthy();
    expect(result.deleted).toBe(0);
  });

  it("refuses a file that became ineligible after the plan was made", () => {
    const logs = fourOldSessions();
    const plan = planPrune("transcripts", POLICY, deps(logs));
    // The agent resumed "oldest" between plan and apply.
    const result = applyPrune(
      plan,
      deps(logs, { activeSessionIds: new Set(["oldest"]) }),
    );
    expect(existsSync(join(logs, "agent-a", "oldest.jsonl"))).toBe(true);
    // The refusal names WHY the fresh pass excluded it, not a generic
    // "no-longer-eligible" - this is the audit trail for a delete.
    expect(result.refused).toContainEqual({
      path: "agent-a/oldest.jsonl",
      reason: "became-active-session",
    });
    expect(result.deleted).toBe(1);
  });

  it("names the specific fresh-pass reason on each refusal", () => {
    const logs = fourOldSessions();
    const plan = planPrune(
      "transcripts",
      { olderThanDays: 30, keepPerAgent: 0 },
      deps(logs),
    );
    expect(plan.candidates).toHaveLength(4);
    // Between plan and apply: one session went live, one became a fork parent,
    // and the retention floor rose to keep the two newest.
    const result = applyPrune(plan, {
      ...deps(logs, {
        activeSessionIds: new Set(["oldest"]),
        loadSessionsMap: () => ({ newest: { forkedFrom: "third" } }),
      }),
    });
    const byPath = Object.fromEntries(
      result.refused.map((r) => [r.path, r.reason]),
    );
    expect(byPath["agent-a/oldest.jsonl"]).toBe("became-active-session");
    expect(byPath["agent-a/third.jsonl"]).toBe("became-fork-ancestor");
    expect(result.deleted).toBe(2);
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

  it("is a no-op for an empty plan", () => {
    const logs = fourOldSessions();
    const d = deps(logs);
    const plan = planPrune(
      "transcripts",
      { olderThanDays: 10_000, keepPerAgent: 2 },
      d,
    );
    expect(plan.candidates).toEqual([]);
    expect(applyPrune(plan, d)).toEqual({
      deleted: 0,
      bytes: 0,
      refused: [],
    });
    expect(existsSync(join(logs, "agent-a", "oldest.jsonl"))).toBe(true);
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
