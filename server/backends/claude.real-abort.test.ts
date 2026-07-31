// GATED real-process proof that the Claude OS-level kill actually works.
//
// BUG-2 (claude half): ClaudeSession.close() relies on the SDK's AbortController
// ("abortController" query option) to terminate the `claude` subprocess. That is
// an SDK guarantee, version-dependent and unobservable by a mock - so unlike the
// codex kill (our own -pgid SIGTERM->SIGKILL logic, covered by client.test.ts),
// there is nothing in the hermetic suite that can catch an SDK regression where
// abort() stops the async iteration but LEAVES the subprocess alive (the exact
// mid-turn-hang leak this fix targets).
//
// These tests spawn the REAL claude binary, so they are DEFAULT-SKIPPED and only
// run with RUN_REAL_CLAUDE=1. Re-run them after any @anthropic-ai/claude-agent-sdk
// bump to re-prove the OS-level reap in one command:
//   RUN_REAL_CLAUDE=1 bun test server/backends/claude.real-abort.test.ts
//
// The "idle" test is free (no message sent => no API call). The "mid-turn" test
// sends one real prompt (small API cost) and is the complete proof: it reaps a
// child that is ACTIVELY streaming and confirms the abort-induced AbortError is
// swallowed, not surfaced as a spurious error.
import { describe, it, expect } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "child_process";
import { readFileSync } from "fs";

const RUN_REAL = process.env.RUN_REAL_CLAUDE === "1";
const realIt = RUN_REAL ? it : it.skip;

const MY = process.pid;

function myClaudeChildren(): number[] {
  let lines: string[];
  try {
    lines = execSync("ps -eo pid=,ppid=,comm=").toString().trim().split("\n");
  } catch {
    return [];
  }
  const ppidOf = new Map<number, number>();
  const commOf = new Map<number, string>();
  for (const l of lines) {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    ppidOf.set(Number(m[1]), Number(m[2]));
    commOf.set(Number(m[1]), m[3].trim());
  }
  const isDescendant = (pid: number): boolean => {
    let cur = pid;
    for (let i = 0; i < 50; i++) {
      const pp = ppidOf.get(cur);
      if (pp === undefined) return false;
      if (pp === MY) return true;
      cur = pp;
    }
    return false;
  };
  const out: number[] = [];
  for (const [pid, comm] of commOf) {
    if (comm.includes("claude") && isDescendant(pid)) out.push(pid);
  }
  return out;
}

function rssMb(pid: number): number | null {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(
      /VmRSS:\s+(\d+)\s+kB/,
    );
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForClaudeChildren(timeoutMs: number): Promise<number[]> {
  const start = Date.now();
  for (;;) {
    const pids = myClaudeChildren();
    if (pids.length) return pids;
    if (Date.now() - start >= timeoutMs) return [];
    await sleep(100);
  }
}

async function waitGone(pids: number[], timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (pids.every((p) => !alive(p))) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await sleep(100);
  }
}

describe("claude abort() - real OS-level subprocess reap (gated: RUN_REAL_CLAUDE=1)", () => {
  realIt(
    "reaps an idle spawned claude child (no API call)",
    async () => {
      const ac = new AbortController();
      // Empty, never-yielding prompt: the subprocess spawns but no user message
      // is sent, so there is no API call to bill. A plain async iterable whose
      // next() never resolves keeps the prompt stream open (a generator would
      // trip require-yield).
      const emptyPrompt: AsyncIterable<never> = {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise<IteratorResult<never>>(() => {}) };
        },
      };
      const q = query({
        prompt: emptyPrompt,
        options: { abortController: ac, cwd: "/tmp", settingSources: [] },
      });
      const consume = (async () => {
        try {
          for await (const _ of q) void _;
        } catch {
          /* abort surfaces here */
        }
      })();

      const pids = await waitForClaudeChildren(8000);
      expect(pids.length).toBeGreaterThan(0);
      expect(pids.every((p) => alive(p))).toBe(true);

      ac.abort();

      expect(await waitGone(pids, 8000)).toBe(true);
      await Promise.race([consume, sleep(1000)]);
    },
    20000,
  );

  realIt(
    "reaps a MID-TURN claude child and swallows the AbortError (one small API call)",
    async () => {
      const ac = new AbortController();
      let sawStreaming = false;
      let abortSwallowed = false;
      async function* turnPrompt(): AsyncGenerator<unknown> {
        yield {
          type: "user",
          message: {
            role: "user",
            content:
              "Write a long, detailed, multi-paragraph essay (800+ words) about the history of timekeeping. Be thorough.",
          },
          parent_tool_use_id: null,
        };
        await new Promise<void>(() => {});
      }
      const q = query({
        prompt: turnPrompt() as never,
        options: { abortController: ac, cwd: "/tmp", settingSources: [] },
      });
      const consume = (async () => {
        try {
          for await (const msg of q) {
            const t = (msg as { type?: string }).type;
            if (t === "assistant" || t === "stream_event") sawStreaming = true;
          }
        } catch (e) {
          const name = (e as Error)?.name ?? "";
          const m = (e as Error)?.message ?? "";
          if (name === "AbortError" || /abort/i.test(m)) abortSwallowed = true;
          else throw e;
        }
      })();

      const pids = await waitForClaudeChildren(10000);
      expect(pids.length).toBeGreaterThan(0);
      // Wait until the model is actively streaming (mid-turn).
      for (let i = 0; i < 300 && !sawStreaming; i++) await sleep(100);
      expect(sawStreaming).toBe(true);
      const rssBefore = rssMb(pids[0]);
      expect(rssBefore ?? 0).toBeGreaterThan(50); // a real claude child is >50MB

      ac.abort();

      expect(await waitGone(pids, 10000)).toBe(true);
      await Promise.race([consume, sleep(2000)]);
      // The consumer caught an AbortError (rather than a real error) - the
      // production feedSDKMessages swallows it because this.closed is already set.
      expect(abortSwallowed).toBe(true);
    },
    90000,
  );
});
