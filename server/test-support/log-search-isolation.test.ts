// Process isolation for the log-search scan (server/log-search-runner.ts).
//
// This file exists to prove ONE claim, because the whole regex feature rests on
// it: a caller-supplied pattern cannot burn the box, and the 504 the endpoint
// returns is TRUE - the work really has stopped.
//
// Three pieces of ReDoS folklore were measured and found false in this runtime
// (Bun 1.3.11). The design and these tests are shaped around the measurements:
//
//   1. "A catastrophic pattern spends 2^n steps in one exec() that never
//      returns." False here: a single match is bounded around 0.9s and does NOT
//      grow with input size (n=30 and n=50,000 both land near 0.9s). What runs
//      away is the AGGREGATE - twenty such matches measured 17.8s of solid CPU,
//      and a session holds thousands of entries. The danger needs no exotic
//      pattern, just an ordinary expensive one over a real log.
//   2. "worker.terminate() kills the thread." False, and this is why the scan
//      is NOT in a Worker. Termination is only observed when the worker returns
//      to its event loop. Two workers doing IDENTICAL work: the one awaiting
//      between matches died 311ms after terminate(); the one running the same
//      loop with no await never died at all and held a core at 100%. Our scan
//      awaits between stream CHUNKS, so one chunk of log lines is an unbounded
//      synchronous burst - precisely the non-terminable shape.
//   3. "So a timeout is unachievable in JS." False: SIGKILL on a CHILD PROCESS
//      stopped that same non-yielding spinner in 3ms (exit 137). Startup cost
//      for the child measured ~34ms, which is nothing against an endpoint
//      capped at 3 concurrent runs.
//
// THE LOAD-BEARING TEST is therefore the deadline one, and its fixture is
// deliberately NON-YIELDING: many bait entries inside a single stream chunk, so
// the scan runs one uninterrupted synchronous burst with no interruption point
// to notice a cancellation. That is the case a Worker provably could not stop.
// It waits for scan entry, proves a parent macrotask runs before the outcome,
// triggers the deadline, and observes the child's SIGKILL and slot release.
//
// The timing assertion is SELF-CALIBRATING rather than pinned to a magic
// duration: it measures what one match costs on the machine running the test
// and multiplies by the fixture size. A slow CI box fails it only if isolation
// actually broke.
//
// T0-ish: no server and no LLM, but it does spawn real child processes.

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { parseLogQuery, type LogQuery } from "../log-search.ts";
import {
  MAX_SEARCHES_OFFICE_WIDE,
  MAX_SEARCHES_PER_CALLER,
  SCAN_BUDGET_MS,
  runSearchInChild,
} from "../log-search-runner.ts";
import type { LogEntry } from "../../shared/types.ts";

const LOGS_DIR = join(STATE_ROOT, "logs");
const AGENT = "agent-isolation-fixture";

// The bait for expensive backtracking. The trailing "!" is the whole point: it
// makes /(a+)+$/ FAIL, and only a failing match backtracks. Without it the
// anchor matches on the first try and the pattern is harmless - exactly the
// mistake that would make this test pass for the wrong reason.
const BAIT = "a".repeat(64) + "!";
const BAIT_PATTERN = /(a+)+$/i;

// Enough bait entries that the scan's TOTAL cost is far beyond any deadline,
// AND few enough that they all land in one stream chunk - so the scan is a
// single uninterrupted synchronous burst. Both properties matter: the first
// makes it expensive, the second makes it non-terminable by anything short of
// a signal.
const BAIT_ENTRIES = 24;

beforeAll(() => {
  mkdirSync(join(LOGS_DIR, AGENT), { recursive: true });
  const entries: LogEntry[] = [
    {
      id: "w1",
      agentId: AGENT,
      kind: "user_message",
      content: "a findable needle in the haystack",
      timestamp: 1_000,
    },
    ...Array.from({ length: BAIT_ENTRIES }, (_, i) => ({
      id: `bait-${i}`,
      agentId: AGENT,
      kind: "text" as const,
      content: BAIT,
      timestamp: 2_000 + i,
    })),
  ];
  writeFileSync(
    join(LOGS_DIR, AGENT, "w.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  writeFileSync(
    join(LOGS_DIR, AGENT, "sessions.json"),
    JSON.stringify({ w: { topic: "Isolation fixture", lastModified: 2_000 } }),
  );
});

function query(qs: string): LogQuery {
  const parsed = parseLogQuery(new URLSearchParams(qs));
  if ("code" in parsed) throw new Error(`bad fixture query: ${parsed.code}`);
  return parsed;
}

const CATASTROPHIC = query(
  `q=${encodeURIComponent("(a+)+$")}&regex=1&tier=full`,
);

// Admission slots outlive the request that opened them: a scan that hits its
// deadline keeps its slot until its child process is observed to exit. With
// SIGKILL that is milliseconds rather than seconds, but it is not instant, so a
// test starting in that window would see a 429 it never asked for. Rather than
// sprinkle sleeps, each test begins from a PROVEN-idle office: every office-wide
// slot must be simultaneously grantable.
async function waitForOfficeIdle(): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const probes = await Promise.all(
      Array.from({ length: MAX_SEARCHES_OFFICE_WIDE }, (_, i) =>
        runSearchInChild(`probe:${i}`, AGENT, query("q=needle"), {
          logsDir: LOGS_DIR,
        }),
      ),
    );
    if (probes.every((p) => p.ok)) return;
    if (Date.now() > deadline) {
      throw new Error("office admission never drained");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("log search: process isolation", () => {
  beforeEach(waitForOfficeIdle, 40_000);

  it("returns a normal result through the child process", async () => {
    const outcome = await runSearchInChild(
      "caller:normal",
      AGENT,
      query("q=needle"),
      {
        logsDir: LOGS_DIR,
      },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.results.map((r) => r.entryId)).toEqual(["w1"]);
    expect(outcome.result.totalMatches).toBe(1);
  });

  it("SIGKILLs a non-yielding scan at the deadline, so the 504 is true", async () => {
    // Calibrate against THIS machine: what does one bait match cost here?
    const calStart = performance.now();
    BAIT_PATTERN.test(BAIT);
    const oneMatchMs = performance.now() - calStart;
    // Sanity-check the fixture is actually expensive. If a future engine makes
    // this pattern cheap, the test below would pass vacuously - fail loudly
    // instead so someone re-picks the bait rather than trusting a green run.
    expect(oneMatchMs).toBeGreaterThan(20);
    const inProcessCostMs = oneMatchMs * BAIT_ENTRIES;

    const marker = join(LOGS_DIR, AGENT, "scan-entered");
    const preload = join(LOGS_DIR, AGENT, "scan-preload.ts");
    rmSync(marker, { force: true });
    // This runs in the real child. A marker before the first bait exec proves
    // the deadline cannot win merely because the child has not started yet.
    writeFileSync(preload, `
      import { writeFileSync } from "fs";
      const exec = RegExp.prototype.exec;
      RegExp.prototype.exec = function (text) {
        if (this.source === ${JSON.stringify(BAIT_PATTERN.source)} && text === ${JSON.stringify(BAIT)}) {
          writeFileSync(${JSON.stringify(marker)}, "entered");
          RegExp.prototype.exec = exec;
        }
        return exec.call(this, text);
      };
    `);
    let child: Bun.Subprocess<"pipe", "pipe", "inherit"> | undefined;
    let triggerDeadline: (() => void) | undefined;
    let settled = false;
    const pending = runSearchInChild("caller:evil", AGENT, CATASTROPHIC, {
      logsDir: LOGS_DIR,
      spawnChild: (childPath) => {
        child = Bun.spawn([process.execPath, "run", "--preload", preload, childPath], {
          stdin: "pipe", stdout: "pipe", stderr: "inherit",
        });
        return child;
      },
      scheduleDeadline: (callback) => {
        triggerDeadline = callback;
        // A cleanup watchdog, not the deadline used to prove the behavior.
        return setTimeout(callback, 15_000);
      },
    }).then((outcome) => {
      settled = true;
      return outcome;
    });
    try {
      const setupDeadline = performance.now() + 10_000;
      while (!existsSync(marker) && !settled && performance.now() < setupDeadline) {
        await Bun.sleep(10);
      }
      expect(existsSync(marker)).toBe(true);
      // A parent macrotask after scan entry must run before the outcome.
      // An in-process scan finishes its synchronous burst before this task.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(child!.exitCode).toBeNull();
      expect(triggerDeadline).toBeDefined();
      const started = performance.now();
      triggerDeadline!();
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.status).toBe(504);
      expect(outcome.code).toBe("search_timeout");
      expect(performance.now() - started).toBeLessThan(inProcessCostMs / 4);
      await child!.exited;
      expect(child!.signalCode).toBe("SIGKILL");
      const probe = await runSearchInChild("caller:evil", AGENT, query("q=needle"), {
        logsDir: LOGS_DIR,
      });
      expect(probe.ok).toBe(true);
    } finally {
      triggerDeadline?.();
      child?.kill("SIGKILL");
      await child?.exited;
      await pending;
    }
  }, 30_000);

  it("holds the caller's slot after a deadline until the child actually exits", async () => {
    // The 504 is sent as soon as the deadline fires, but admission is released
    // only when the child's exit is OBSERVED. Releasing on kill() instead would
    // let a caller retrying into repeated deadlines hold more live children
    // than the cap allows, in the window between signal and reap.
    const timedOut = await runSearchInChild(
      "caller:retry",
      AGENT,
      CATASTROPHIC,
      {
        logsDir: LOGS_DIR,
        hardTimeoutMs: 200,
      },
    );
    expect(timedOut.ok).toBe(false);

    // Immediately after the 504: still occupied, because the child's exit has
    // not been observed yet. (Releasing on the kill REQUEST rather than on the
    // observed exit is the unsafe behavior this test exists to reject.)
    const immediate = await runSearchInChild(
      "caller:retry",
      AGENT,
      query("q=needle"),
      { logsDir: LOGS_DIR },
    );
    expect(immediate.ok).toBe(false);
    if (!immediate.ok) expect(immediate.code).toBe("search_busy");

    // ...and the slot IS freed once the child exits. A slot held forever would
    // be just as broken as one released too early. With SIGKILL that is
    // milliseconds, not the seconds a Worker needed to reach a yield point.
    const deadline = Date.now() + SCAN_BUDGET_MS + 10_000;
    let eventually = immediate;
    while (!eventually.ok && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      eventually = await runSearchInChild(
        "caller:retry",
        AGENT,
        query("q=needle"),
        { logsDir: LOGS_DIR },
      );
    }
    expect(eventually.ok).toBe(true);
  }, 30_000);

  it("caps concurrent searches per caller", async () => {
    expect(MAX_SEARCHES_PER_CALLER).toBe(1);
    // Hold a slot open with a scan that cannot finish quickly...
    const held = runSearchInChild("caller:hog", AGENT, CATASTROPHIC, {
      logsDir: LOGS_DIR,
      hardTimeoutMs: 600,
    });
    const second = await runSearchInChild(
      "caller:hog",
      AGENT,
      query("q=needle"),
      {
        logsDir: LOGS_DIR,
      },
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(429);
      expect(second.code).toBe("search_busy");
    }
    await held;
  }, 30_000);

  it("caps concurrent searches office-wide across different callers", async () => {
    const held = Array.from({ length: MAX_SEARCHES_OFFICE_WIDE }, (_, i) =>
      runSearchInChild(`caller:office-${i}`, AGENT, CATASTROPHIC, {
        logsDir: LOGS_DIR,
        hardTimeoutMs: 600,
      }),
    );
    // A fresh caller, with its own per-caller budget untouched, is still turned
    // away because the office-wide ceiling is full.
    const overflow = await runSearchInChild(
      "caller:office-overflow",
      AGENT,
      query("q=needle"),
      { logsDir: LOGS_DIR },
    );
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.code).toBe("search_busy");
    await Promise.all(held);
  }, 30_000);
});
