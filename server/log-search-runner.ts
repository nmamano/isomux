// Parent side of the process-isolated log search: concurrency admission, the
// hard wall-clock deadline, and child-process lifecycle. See
// log-search-child.ts for why the scan runs in a separate PROCESS rather than a
// Worker thread (short version: a Worker cannot be stopped mid-scan, a process
// can - both measured).
//
// TWO budgets, and unlike the Worker design they are now both real:
//   - SCAN_BUDGET_MS is the COOPERATIVE budget, checked between entries inside
//     the scan. It ends an ordinary slow scan and returns a clean PARTIAL result
//     with `timedOut: true`, so the caller still gets the recent hits. This is
//     the path a slow search should normally take.
//   - HARD_TIMEOUT_MS is the enforced ceiling. On expiry the child is SIGKILLed,
//     which genuinely stops it (measured: 3ms, even for a non-yielding loop that
//     no amount of Worker terminate() could touch). So the 504 means the work
//     HAS stopped, not merely that we gave up waiting.
//
// HARD_TIMEOUT_MS is larger than SCAN_BUDGET_MS because the gap between two
// cooperative checks is one match, and a single match was measured at ~0.9s -
// the cooperative budget can legitimately overshoot by that much before the scan
// gets to notice. Anything beyond that is pathological and gets the signal.
//
// ADMISSION is keyed on the CALLER, not the target: the point is to stop one
// caller spawning scans in a loop, and a per-target cap would let one caller
// consume the whole office by aiming at three different agents. It is acquired
// AFTER authorization (the handler is only reached post-authorize), so a caller
// who cannot see an agent never occupies capacity and a 429 cannot be used to
// probe office load. Each admission is an identified RECORD rather than a bare
// counter bump, so a late release can never decrement somebody else's slot.

import { join } from "path";
import { fileURLToPath } from "url";
import { STATE_ROOT } from "./config.ts";
import type { LogQuery, SearchResult } from "./log-search.ts";
import type { SearchChildRequest } from "./log-search-child.ts";

export const SCAN_BUDGET_MS = 5_000;
export const HARD_TIMEOUT_MS = 8_000;
export const MAX_SEARCHES_PER_CALLER = 1;
export const MAX_SEARCHES_OFFICE_WIDE = 3;

const CHILD_PATH = fileURLToPath(
  new URL("./log-search-child.ts", import.meta.url),
);

// Spawning goes through this thunk so `proc`'s type carries the piped-stdio
// narrowing (`ReturnType<typeof Bun.spawn>` widens stdin/stdout back to the
// generic union, which would lose `.write()` / the readable stream).
const spawnChild = () =>
  Bun.spawn([process.execPath, "run", CHILD_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    // Straight to the server journal: a child that fails to start is an
    // operator problem, and there is no second stream to drain on the kill path.
    stderr: "inherit",
  });

export type SearchOutcome =
  | { ok: true; result: SearchResult }
  | { ok: false; status: 429 | 500 | 504; code: string; message: string };

// --- Admission ---------------------------------------------------------------
// An admission is a RECORD, not a counter bump. The counters alone were unsafe:
// a release that arrives late (a child exiting after the bookkeeping was reset,
// which is routine in tests) would decrement whatever generation happened to be
// current, silently handing out capacity beyond the cap. Each record carries the
// epoch it was granted in, and a release from a stale epoch is ignored.

interface Admission {
  callerKey: string;
  epoch: number;
  released: boolean;
}

const perCaller = new Map<string, number>();
let officeWide = 0;
let epoch = 0;

function admit(
  callerKey: string,
): { ok: true; admission: Admission } | { ok: false; outcome: SearchOutcome } {
  if (officeWide >= MAX_SEARCHES_OFFICE_WIDE) {
    return {
      ok: false,
      outcome: {
        ok: false,
        status: 429,
        code: "search_busy",
        message:
          "too many log searches in flight office-wide; retry in a moment",
      },
    };
  }
  if ((perCaller.get(callerKey) ?? 0) >= MAX_SEARCHES_PER_CALLER) {
    return {
      ok: false,
      outcome: {
        ok: false,
        status: 429,
        code: "search_busy",
        message:
          "a log search is already running for you; wait for it to finish",
      },
    };
  }
  perCaller.set(callerKey, (perCaller.get(callerKey) ?? 0) + 1);
  officeWide++;
  return { ok: true, admission: { callerKey, epoch, released: false } };
}

// Idempotent, and inert for an admission from a previous epoch.
function release(adm: Admission): void {
  if (adm.released || adm.epoch !== epoch) return;
  adm.released = true;
  const n = (perCaller.get(adm.callerKey) ?? 1) - 1;
  if (n <= 0) perCaller.delete(adm.callerKey);
  else perCaller.set(adm.callerKey, n);
  officeWide = Math.max(0, officeWide - 1);
}

// TEST-ONLY. Admission state is process-global and a timed-out scan holds its
// slot until its child exits, so one test file's leftovers would otherwise
// starve another's searches with a 429 it never asked for - `bun test` shares a
// process across files. Bumping the epoch is what makes this safe: children
// still running from the previous generation release into a dead epoch and
// cannot corrupt the new one. Same convention as _testResetTokens. Not called
// by any production path.
export function _testResetSearchAdmission(): void {
  epoch++;
  perCaller.clear();
  officeWide = 0;
}

// --- Running a scan ----------------------------------------------------------

// Run one scan in a child process. Resolves with the result, a 504 when the
// hard deadline fired (and the child was killed), or a 429 when the caller is
// over its concurrency cap.
export function runSearchInChild(
  callerKey: string,
  agentId: string,
  query: LogQuery,
  // `logsDir` and `hardTimeoutMs` are TEST SEAMS, not deployment configuration.
  // Production passes neither: the office reads its own log tree and waits the
  // full budget. Tests point at a fixture tree and shorten the wait so proving
  // the deadline does not cost eight seconds of suite time.
  opts: { logsDir?: string; hardTimeoutMs?: number } = {},
): Promise<SearchOutcome> {
  const admitted = admit(callerKey);
  if (!admitted.ok) return Promise.resolve(admitted.outcome);
  const admission = admitted.admission;

  return new Promise<SearchOutcome>((resolve) => {
    let proc: ReturnType<typeof spawnChild>;
    try {
      proc = spawnChild();
    } catch (err) {
      // Nothing was spawned, so there is no process to wait on.
      release(admission);
      console.error("[log-search] child spawn failed:", err);
      resolve({
        ok: false,
        status: 500,
        code: "search_unavailable",
        message: "log search could not be started",
      });
      return;
    }

    // ATTACHED BEFORE ANYTHING CAN FINISH. Registering the exit handler after
    // kill/write would race: a child that exits in between emits its only exit
    // signal with nobody listening, and the slot leaks for the process
    // lifetime. release() is idempotent, so arming it this early is free.
    void proc.exited.then(() => release(admission));

    let settled = false;
    let killed = false;
    const settle = (outcome: SearchOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      killed = true;
      // A real stop, not a request to stop. The admission slot is still held
      // until `exited` fires, so a caller retrying into repeated timeouts
      // cannot accumulate live children past the cap.
      proc.kill("SIGKILL");
      settle({
        ok: false,
        status: 504,
        code: "search_timeout",
        message:
          "the search did not finish in time; narrow it with session=, before/after, or a simpler pattern",
      });
    }, opts.hardTimeoutMs ?? HARD_TIMEOUT_MS);

    // Bounded by construction: the child writes one envelope whose size is
    // capped by `limit` and the per-snippet cap.
    void new Response(proc.stdout)
      .text()
      .then((out) => {
        if (killed) return; // already answered with the 504
        let data:
          | { ok: true; result: SearchResult }
          | { ok: false; error: string };
        try {
          data = JSON.parse(out);
        } catch {
          console.error("[log-search] child produced unreadable output");
          settle({
            ok: false,
            status: 500,
            code: "search_failed",
            message: "the search failed",
          });
          return;
        }
        if (data.ok) {
          settle({ ok: true, result: data.result });
        } else {
          console.error("[log-search] scan failed:", data.error);
          settle({
            ok: false,
            status: 500,
            code: "search_failed",
            message: "the search failed",
          });
        }
      })
      .catch((err: unknown) => {
        if (killed) return;
        console.error("[log-search] could not read child output:", err);
        settle({
          ok: false,
          status: 500,
          code: "search_failed",
          message: "the search failed",
        });
      });

    const req: SearchChildRequest = {
      logsDir: opts.logsDir ?? join(STATE_ROOT, "logs"),
      agentId,
      query,
      budgetMs: SCAN_BUDGET_MS,
    };
    // A throw here would otherwise leave the promise pending until the hard
    // deadline while holding the caller's slot. Settle it immediately; the
    // already-armed exit handler still frees the admission.
    try {
      // The write can fail either way round - synchronously, or as a rejected
      // promise if the child died before the pipe was drained (EPIPE). Both are
      // handled: the sync throw by this catch, the async one by the swallow
      // below, so a dead child can never surface as an unhandled rejection.
      // The outcome is already covered by the exit handler and the deadline.
      void Promise.resolve(proc.stdin.write(JSON.stringify(req))).catch(
        () => {},
      );
      void Promise.resolve(proc.stdin.end()).catch(() => {});
    } catch (err) {
      console.error(
        "[log-search] could not hand the request to the child:",
        err,
      );
      proc.kill("SIGKILL");
      settle({
        ok: false,
        status: 500,
        code: "search_failed",
        message: "the search failed",
      });
    }
  });
}
