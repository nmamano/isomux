// Lossless compression of old transcripts, on request (task e9776386).
//
// The plan spares the active session of a live agent and every session newer
// than the cutoff; apply plans again and compresses only what both plans name.
// Nothing is lost, so there is no keep-newest floor and no fork-ancestor rule.
// Every root is injected; fixtures live under the OS temp dir.

import { describe, it, expect, afterEach } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeStateDir } from "./test-support/temp-state.ts";
import {
  applyCompress,
  planCompress,
  type CompressDeps,
} from "./storage-compress.ts";
import { readTranscriptSync, resolveTranscript } from "./transcript-files.ts";
import { STATE_ROOT } from "./config.ts";
import { appendLogOrThrow, loadLog } from "./persistence.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) removeStateDir(dirs.pop()!);
});

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function logsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "isomux-compress-"));
  dirs.push(root);
  const logs = join(root, "logs");
  mkdirSync(logs);
  return logs;
}

// A transcript whose mtime is `ageDays` before NOW, on a whole second.
function writeAged(path: string, content: string, ageDays: number): number {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  const seconds = Math.floor((NOW - ageDays * DAY_MS) / 1000);
  utimesSync(path, seconds, seconds);
  return seconds * 1000;
}

function deps(logs: string, active: string[] = []): CompressDeps {
  return { logsDir: logs, now: NOW, activeSessionIds: new Set(active) };
}

const line = (id: string) => JSON.stringify({ id, content: "y".repeat(400) });
const body = (n: number) =>
  Array.from({ length: n }, (_, i) => line(`e${i}`)).join("\n") + "\n";

const skipped = (
  plan: ReturnType<typeof planCompress>,
  reason: "too-recent" | "active-session",
) => plan.skipped.find((s) => s.reason === reason)?.count ?? 0;

describe("planCompress", () => {
  it("names old plain transcripts and spares the active and the recent", () => {
    const logs = logsDir();
    const a = join(logs, "agent-a");
    writeAged(join(a, "old.jsonl"), body(3), 40);
    writeAged(join(a, "live.jsonl"), body(3), 40);
    writeAged(join(a, "fresh.jsonl"), body(3), 2);
    writeAged(join(a, "packed.jsonl.gz"), "already", 40);
    writeAged(join(a, "sessions.json"), "{}", 40);
    writeAged(join(logs, "agent-b", "other.jsonl"), body(2), 90);

    const plan = planCompress(30, deps(logs, ["live"]));

    expect(plan.candidates.map((c) => c.path).sort()).toEqual([
      "agent-a/old.jsonl",
      "agent-b/other.jsonl",
    ]);
    const old = plan.candidates.find((c) => c.sessionId === "old")!;
    expect(old.agentId).toBe("agent-a");
    expect(old.bytes).toBe(Buffer.byteLength(body(3)));
    expect(plan.bytes).toBe(
      Buffer.byteLength(body(3)) + Buffer.byteLength(body(2)),
    );
    expect(skipped(plan, "active-session")).toBe(1);
    expect(skipped(plan, "too-recent")).toBe(1);
    // Planning is read-only.
    expect(existsSync(join(a, "old.jsonl"))).toBe(true);
  });
});

describe("applyCompress", () => {
  it("compresses each planned transcript losslessly and keeps both mtimes", async () => {
    const logs = logsDir();
    const a = join(logs, "agent-a");
    const mtime = writeAged(join(a, "old.jsonl"), body(20), 40);
    writeAged(join(a, "older.jsonl"), body(10), 50);
    // The agent directory's mtime stands in for a killed agent's kill time
    // (agent-manager legacyKilledAtFromDisk), so a compress must not move it.
    const dirSeconds = Math.floor((NOW - 60 * DAY_MS) / 1000);
    utimesSync(a, dirSeconds, dirSeconds);
    const d = deps(logs);
    const plan = planCompress(30, d);

    const result = await applyCompress(plan, d);

    expect(result.compressed).toBe(2);
    expect(result.refused).toEqual([]);
    expect(result.aborted).toBeUndefined();
    expect(result.bytesBefore).toBe(
      Buffer.byteLength(body(20)) + Buffer.byteLength(body(10)),
    );
    expect(result.bytesAfter).toBe(
      statSync(join(a, "old.jsonl.gz")).size +
        statSync(join(a, "older.jsonl.gz")).size,
    );
    expect(readdirSync(a).sort()).toEqual(["old.jsonl.gz", "older.jsonl.gz"]);
    expect(readTranscriptSync(resolveTranscript(a, "old")!)).toBe(body(20));
    expect(statSync(join(a, "old.jsonl.gz")).mtimeMs).toBe(mtime);
    expect(statSync(a).mtimeMs).toBe(dirSeconds * 1000);
  });

  it("refuses a transcript that grew, or whose session became active, since the plan", async () => {
    const logs = logsDir();
    const a = join(logs, "agent-a");
    writeAged(join(a, "grew.jsonl"), body(3), 40);
    writeAged(join(a, "resumed.jsonl"), body(3), 40);
    const plan = planCompress(30, deps(logs));
    appendFileSync(join(a, "grew.jsonl"), line("late") + "\n");

    const result = await applyCompress(plan, deps(logs, ["resumed"]));

    expect(result.compressed).toBe(0);
    expect(
      Object.fromEntries(result.refused.map((r) => [r.path, r.reason])),
    ).toEqual({
      "agent-a/grew.jsonl": "modified-since-plan",
      "agent-a/resumed.jsonl": "not-in-fresh-plan",
    });
    expect(readdirSync(a).sort()).toEqual(["grew.jsonl", "resumed.jsonl"]);
  });

  it("settles a crash leftover on the .jsonl's content", async () => {
    const logs = logsDir();
    const a = join(logs, "agent-a");
    writeAged(join(a, "both.jsonl"), body(3), 40);
    writeAged(join(a, "both.jsonl.gz"), "stale", 40);
    const d = deps(logs);
    const plan = planCompress(30, d);
    expect(plan.candidates.map((c) => c.sessionId)).toEqual(["both"]);

    expect((await applyCompress(plan, d)).compressed).toBe(1);

    expect(readdirSync(a)).toEqual(["both.jsonl.gz"]);
    expect(readTranscriptSync(resolveTranscript(a, "both")!)).toBe(body(3));
  });
});

// Gzip runs at about 40 MB/s on this box (measured 2026-10-21), so compressing
// an office's old transcripts can take tens of seconds. The server must keep
// serving meanwhile, and an entry an agent appends while its old session is
// being compressed must survive.
describe("applyCompress while the office runs", () => {
  const AGENT = "agent-compress-live";
  const logs = join(STATE_ROOT, "logs");
  afterEach(() => removeStateDir(join(logs, AGENT)));

  it("keeps serving, and keeps every entry appended meanwhile", async () => {
    const sid = "resumed";
    const seconds = Math.floor((Date.now() - 40 * DAY_MS) / 1000);
    const path = join(logs, AGENT, `${sid}.jsonl`);
    mkdirSync(join(logs, AGENT), { recursive: true });
    writeFileSync(path, body(5000));
    utimesSync(path, seconds, seconds);
    const d: CompressDeps = {
      logsDir: logs,
      now: Date.now(),
      activeSessionIds: new Set(),
    };
    const plan = planCompress(30, d);
    expect(plan.candidates.map((c) => c.sessionId)).toEqual([sid]);

    // An agent resumes the old session and writes to it on every turn of the
    // event loop until the compress is done.
    const appended: string[] = [];
    let done = false;
    const pump = () => {
      if (done) return;
      const id = `late-${appended.length}`;
      appendLogOrThrow(AGENT, sid, {
        id,
        agentId: AGENT,
        timestamp: Date.now(),
        kind: "text",
        content: "written during the compress",
      });
      appended.push(id);
      setImmediate(pump);
    };
    const pending = applyCompress(plan, d);
    setImmediate(pump);
    await pending;
    done = true;

    expect(appended.length).toBeGreaterThan(0);
    const ids = new Set(loadLog(AGENT, sid).map((e) => e.id));
    expect(appended.filter((id) => !ids.has(id))).toEqual([]);
    expect(ids.has("e0")).toBe(true);
  });
});
