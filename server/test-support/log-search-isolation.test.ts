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
// It asserts the request comes back near the deadline, that the main thread
// kept ticking throughout, and that the child is really gone.
//
// The timing assertion is SELF-CALIBRATING rather than pinned to a magic
// duration: it measures what one match costs on the machine running the test
// and multiplies by the fixture size. A slow CI box fails it only if isolation
// actually broke.
//
// T0-ish: no server and no LLM, but it does spawn real child processes.

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
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

    // A heartbeat on the main thread. If the scan ran in-process, this would
    // stop ticking for the whole duration - the event loop would be inside
    // .exec() with nothing to yield to.
    let beats = 0;
    const heartbeat = setInterval(() => beats++, 20);

    const started = performance.now();
    const outcome = await runSearchInChild("caller:evil", AGENT, CATASTROPHIC, {
      logsDir: LOGS_DIR,
      hardTimeoutMs: 400,
    });
    const elapsed = performance.now() - started;
    clearInterval(heartbeat);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(504);
    expect(outcome.code).toBe("search_timeout");
    // Bounded by the DEADLINE rather than by the work: run to completion this
    // scan takes many times longer. This is the assertion a Worker could NOT
    // have satisfied for this fixture - one chunk of bait entries is a single
    // synchronous burst with no interruption point to be terminated at.
    expect(elapsed).toBeLessThan(inProcessCostMs / 4);
    // ...and the main thread stayed live throughout, which is the other half of
    // the point. Running in-process it would have ticked zero times.
    expect(beats).toBeGreaterThan(2);

    // The work really STOPPED, and stopped BECAUSE OF THE SIGNAL. Admission is
    // released only when the child's exit is observed, so the moment the slot
    // frees is the moment the process died - and timing it is what separates
    // the two explanations. The child would ALSO exit on its own once its
    // cooperative budget expired, so a test that merely waited "long enough"
    // would pass identically with no kill at all. Requiring the slot back in
    // well under SCAN_BUDGET_MS can only be the signal.
    const killedAt = performance.now();
    let freedAfterMs = Infinity;
    while (performance.now() - killedAt < SCAN_BUDGET_MS) {
      const probe = await runSearchInChild(
        "caller:evil",
        AGENT,
        query("q=needle"),
        {
          logsDir: LOGS_DIR,
        },
      );
      if (probe.ok) {
        freedAfterMs = performance.now() - killedAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(freedAfterMs).toBeLessThan(SCAN_BUDGET_MS / 2);
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
