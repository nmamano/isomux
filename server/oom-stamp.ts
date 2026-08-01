// Biasing the kill, when the box runs out of memory, toward the processes the
// office starts and away from the office itself.
//
// When memory runs out something has to die, and the kernel picks by "badness":
// roughly how much memory a process holds, plus its `oom_score_adj`. That value
// is inherited at fork and survives exec, so an agent and the multi-GB
// `bun run build` it starts both carry the office server's own. The killer
// therefore cannot tell the office apart from the agent that ran out of memory,
// and it may take the server - which loses every agent in the box at once,
// instead of the one that misbehaved.
//
// What this buys is a strong bias, not a guarantee. `oom_score_adj` is one input
// among several: memory footprint still counts, and earlyoom (deploy/oom-protect.sh)
// adds its own name-based preference on top. So the honest claim is that the
// office is much less likely to be the one chosen, and that among the office's
// own processes the heavier ones are much more likely to go first. Nothing here
// promises which descendant dies.
//
// Raising an `oom_score_adj` needs no privilege; only lowering one does (measured
// on an office box, 2026-08-01: a process at 100 could set itself to 300 and was
// refused at 0). So the office can do this for itself, on any install shape,
// without a root helper: it walks its own descendants and stamps them above
// itself. deploy/oom-protect.sh stays responsible for the box-wide half (earlyoom,
// ssh and Tailscale last, swap) and is the only part that needs root.
//
// The Claude SDK owns the spawn - `query()` in server/backends/claude.ts starts
// the `claude` binary internally - so there is no pid to stamp at spawn time.
// Hence a sweep. It re-runs on a timer rather than reacting to a spawn, because
// what actually needs the stamp is not the agent but whatever the agent starts
// later, and nothing tells us about those at all.
//
// Two properties keep the sweep cheap. A stamp is inherited, so a process born
// after its parent was stamped already carries the value and the sweep does
// nothing for it; and the sweep never lowers a value, so it converges and then
// idles.

import { readdirSync, readFileSync, writeFileSync } from "fs";

/**
 * What the office stamps onto the processes it starts.
 *
 * It has to clear 100, the value Ubuntu's user manager forces on a self-hosted
 * office (`/usr/lib/systemd/system/user@.service`), by enough that ordinary
 * differences in memory do not close the gap: measured on an 8 GB box, +100 of
 * `oom_score_adj` moves `oom_score` by ~67 points while a 1.2 GB difference in
 * memory moves it by ~51. At 300 a stamped process sits ~133 points above such
 * an office, so the office would have to grow by roughly 3 GB to draw level. On
 * a hosted box the office is at -500 and the margin is far larger.
 *
 * One value for every descendant, deliberately: with the bias equal, what
 * separates them is how much memory they hold, so the heavier ones are the more
 * likely victims. That is a bias, not an ordering the kernel owes us - earlyoom
 * layers a name-based preference on top of it. Tiering agents against their own
 * children would work against even the bias.
 */
export const AGENT_OOM_SCORE_ADJ = 300;

/**
 * How often to sweep.
 *
 * This is not spawn-time stamping and does not pretend to be: a process born
 * just after a sweep goes up to this long unmarked. What makes that acceptable
 * is inheritance. Only a process whose whole ancestry is newer than the last
 * sweep is unmarked at all - once an agent is stamped, the build it starts is
 * born stamped - and an agent takes seconds to come up in the first place. The
 * cost of being wrong for ten seconds is the pre-existing behaviour, not a new
 * failure.
 *
 * A sweep reads one small file per process on the box, a few milliseconds. It is
 * synchronous from end to end, so two sweeps can never overlap.
 */
export const OOM_SWEEP_INTERVAL_MS = 10_000;

const DEFAULT_PROC_ROOT = "/proc";

/** The two fields of `stat` that identify a process and place it in the tree. */
type ProcInfo = { ppid: number; starttime: string };

export type StampOutcome = "stamped" | "already" | "skipped" | "refused";

export interface OomSweepResult {
  /** Pids raised to the target by this sweep. */
  stamped: number[];
  /** Descendants already at or above the target - the steady state. */
  already: number;
  /** Gone, recycled, or reparented out of our tree between snapshot and write. */
  skipped: number;
  /** Alive, ours, and still not carrying the value we asked for. */
  refused: { pid: number; detail: string }[];
}

/**
 * Read a process's parent and start time from one `stat` read.
 *
 * The pair is what identifies a process: a pid on its own can be recycled, and
 * the start time is what tells the recycled one apart. Everything up to the last
 * `) ` is dropped first because field 2 is the process name, which may contain
 * both spaces and parentheses; after that, stat field N is at index N-3, so the
 * parent pid (field 4) is index 1 and the start time (field 22) is index 19.
 */
function readProcInfo(procRoot: string, pid: number): ProcInfo | null {
  let raw: string;
  try {
    raw = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(") ");
  if (close < 0) return null;
  const fields = raw.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const starttime = fields[19];
  if (!Number.isInteger(ppid) || !starttime) return null;
  return { ppid, starttime };
}

/**
 * Read an `oom_score_adj`, or null if it cannot be read as a number.
 *
 * Null is not zero: an unreadable or empty value means we do not know what the
 * kernel holds, and this whole module exists because a value nobody read back
 * was wrong for a week (task c5b4e89e).
 */
function readAdj(procRoot: string, pid: number): number | null {
  let raw: string;
  try {
    raw = readFileSync(`${procRoot}/${pid}/oom_score_adj`, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * Every descendant of `rootPid`, parents before their own children.
 *
 * Built from a full pass over the process table rather than from
 * `/proc/PID/task/PID/children`, which would only visit our own subtree: the
 * kernel documents that file as unreliable for a task that is running, which is
 * every task here, and it depends on a kernel config option. A pass over ~400
 * `stat` files costs a few milliseconds every ten seconds.
 *
 * The office itself is never in the result. Nor is a process that was reparented
 * away (when its parent dies it is adopted by init and leaves our tree) - it
 * keeps whatever stamp it already had, which is the value it inherited.
 */
export function descendantsOf(
  procRoot: string,
  rootPid: number,
): Map<number, ProcInfo> {
  const table = new Map<number, ProcInfo>();
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return new Map();
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const info = readProcInfo(procRoot, pid);
    if (info) table.set(pid, info);
  }
  const children = new Map<number, number[]>();
  for (const [pid, info] of table) {
    const siblings = children.get(info.ppid);
    if (siblings) siblings.push(pid);
    else children.set(info.ppid, [pid]);
  }
  // Breadth-first, so a parent is stamped before its own children are visited
  // and any child born in between inherits the value instead of needing it.
  // `seen` also stops a corrupt table from looping forever.
  const found = new Map<number, ProcInfo>();
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const pid of children.get(parent) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const info = table.get(pid);
      if (info) found.set(pid, info);
      queue.push(pid);
    }
  }
  return found;
}

export interface StampOptions {
  procRoot: string;
  pid: number;
  /** What the sweep saw when it decided this process was ours. */
  expected: ProcInfo;
  /** Whether a parent pid is still inside our tree. */
  isOurs: (ppid: number) => boolean;
  target: number;
  /**
   * Seam for the one branch a real filesystem cannot produce: a write that is
   * accepted and then not honoured. That is the failure this module's readback
   * exists for, so it is worth being able to test.
   */
  writeAdj?: (path: string, value: number) => void;
}

/**
 * Raise one process's `oom_score_adj`, and believe only what we can read back.
 *
 * Never lowers: a lower value would be refused without privilege anyway, and a
 * process that deliberately made itself a better victim should stay one.
 *
 * The identity check brackets the write on both sides, and the second half comes
 * after the readback rather than before it, for the same reason
 * `stamp_pid` in deploy/oom-protect.sh does it that way: a process that exits
 * between the check and the read hands its pid to a stranger, whose value would
 * otherwise be reported as our success. What remains is the gap between the last
 * check and the write itself, which cannot be closed without a pidfd; it costs
 * an unrelated process of the same user a raised score until it exits, and the
 * next sweep does not repeat it.
 *
 * The target's own identity is authenticated; its parent's is not, and does not
 * need to be. The worry would be a target that was recycled while its recorded
 * parent pid was recycled too, so that ownership still appears to hold. Linux
 * does not produce that: when a parent dies its children are handed to init or
 * to the nearest live subreaper immediately, so an orphan's parent pid changes
 * to a process that is alive at that moment rather than staying pointed at a
 * number that something else later inherits.
 */
export function stampProcess(opts: StampOptions): StampOutcome {
  const { procRoot, pid, expected, isOurs, target } = opts;
  const write = opts.writeAdj ?? defaultWriteAdj;
  const current = readAdj(procRoot, pid);
  if (current === null) return "skipped";
  if (current >= target) return "already";
  const before = readProcInfo(procRoot, pid);
  if (!before || before.starttime !== expected.starttime) return "skipped";
  if (!isOurs(before.ppid)) return "skipped";
  try {
    write(`${procRoot}/${pid}/oom_score_adj`, target);
  } catch {
    // A process that exited mid-write is ordinary churn, not a problem to
    // report; anything else is a refusal we want named.
    if (!readProcInfo(procRoot, pid)) return "skipped";
    return "refused";
  }
  const actual = readAdj(procRoot, pid);
  const after = readProcInfo(procRoot, pid);
  if (!after || after.starttime !== expected.starttime) return "skipped";
  // At or above, not equal: a process that raised itself past the target
  // between our write and our read satisfies what we were asking for, and
  // warning about it would be a false alarm.
  if (actual === null || actual < target) return "refused";
  return "stamped";
}

function defaultWriteAdj(path: string, value: number): void {
  writeFileSync(path, String(value));
}

export interface OomStamperOptions {
  procRoot?: string;
  rootPid?: number;
  target?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  writeAdj?: (path: string, value: number) => void;
}

/**
 * A sweep that can be called repeatedly and only speaks up when something
 * changed. Called every ten seconds forever, so silence in the steady state is
 * part of the contract, not an oversight.
 */
export function createAgentOomStamper(opts: OomStamperOptions = {}): {
  sweep: () => OomSweepResult;
} {
  const procRoot = opts.procRoot ?? DEFAULT_PROC_ROOT;
  const rootPid = opts.rootPid ?? process.pid;
  const target = opts.target ?? AGENT_OOM_SCORE_ADJ;
  const log = opts.log ?? ((m: string) => console.log(m));
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  let announced = false;
  let warned = false;

  return {
    sweep(): OomSweepResult {
      const result: OomSweepResult = {
        stamped: [],
        already: 0,
        skipped: 0,
        refused: [],
      };
      const tree = descendantsOf(procRoot, rootPid);
      const isOurs = (ppid: number) => ppid === rootPid || tree.has(ppid);
      for (const [pid, expected] of tree) {
        const outcome = stampProcess({
          procRoot,
          pid,
          expected,
          isOurs,
          target,
          writeAdj: opts.writeAdj,
        });
        if (outcome === "stamped") result.stamped.push(pid);
        else if (outcome === "already") result.already += 1;
        else if (outcome === "skipped") result.skipped += 1;
        else
          result.refused.push({
            pid,
            detail: `the kernel reports ${readAdj(procRoot, pid) ?? "nothing"}`,
          });
      }
      if (!announced && result.stamped.length > 0) {
        announced = true;
        const own = readAdj(procRoot, rootPid);
        log(
          `[oom] the processes this office starts are biased toward being killed before the office server is, when the box runs out of memory (oom_score_adj=${target}; this server is at ${own ?? "an unknown value"}). It makes a runaway agent or build much more likely to be the one that goes.`,
        );
      }
      if (!warned && result.refused.length > 0) {
        warned = true;
        const { pid, detail } = result.refused[0];
        warn(
          `[oom] could not bias pid ${pid} toward being killed before the office: asked for ${target}, ${detail}. Under memory pressure this box is more likely to kill the office server than it should be. Said once per office run.`,
        );
      }
      return result;
    },
  };
}

/**
 * Start sweeping. Returns a function that stops it.
 *
 * A no-op off Linux: a self-hosted office on a Mac has no `/proc` and no
 * `oom_score_adj`, and the office runs exactly as well without this - it is
 * protection metadata, not part of serving the office (same stance as
 * server/process-name.ts).
 */
export function startAgentOomStamping(
  opts: OomStamperOptions = {},
): () => void {
  if (process.platform !== "linux") return () => {};
  const stamper = createAgentOomStamper(opts);
  const sweep = () => {
    try {
      stamper.sweep();
    } catch (err) {
      console.error("[oom] stamp sweep failed:", err);
    }
  };
  sweep();
  const timer = setInterval(sweep, OOM_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
