// Talking to flyctl without letting a credential out.
//
// Every rule here exists because of the two incidents behind the loop's secrets
// ruling:
//
//   NOTHING IS EXPANDED BY A SHELL. The API token is read inside this process
//   and handed to the child as an environment variable. It never appears in
//   argv - which the process table shows to every user on the box - and never
//   in a command line somebody might paste into a report.
//
//   THE CHILD'S OUTPUT IS CAPTURED, AND CAPTURED IS NOT PRINTED. flyctl's own
//   stdout and stderr are held in memory for scanning and are never forwarded.
//   That is a stronger rule than "scan and forward if clean", and deliberately
//   so: an exact-value scan cannot see a fragment, a re-encoding or a
//   truncation, so safety comes from not emitting the bytes at all rather than
//   from a scanner being complete.
//
// What callers may print is in `Outcome`: fixed names, booleans and an exit
// code. Diagnosing a flyctl failure means re-running it with a PUBLIC canary
// value, never with a real one.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The app this slice is allowed to touch. Every call carries it. */
export const APP = "isomux-provisioner";

export const FLYCTL = path.join(os.homedir(), ".fly", "bin", "flyctl");

const SECRETS_DIR = path.join(os.homedir(), "nil", "secrets");
export const FLY_TOKEN_FILE = path.join(SECRETS_DIR, "fly.token");
export const MINT_ENV_FILE = path.join(SECRETS_DIR, "control-plane-mint.env");

export interface SpawnResult {
  code: number;
  /** Held for scanning. NEVER printed, and never put in an error message. */
  stdout: string;
  stderr: string;
}

export type Spawn = (
  argv: string[],
  env: Record<string, string>,
  stdin: string,
) => Promise<SpawnResult>;

export const realSpawn: Spawn = async (argv, env, stdin) => {
  const child = Bun.spawn(argv, {
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
};

/** What a bounded child answers: its exit code, or nothing plus the reason. */
export interface BoundedResult {
  /** Null whenever the run did not end cleanly - the deadline fired, or the
   * leader exited while processes it started were still alive. */
  code: number | null;
  timedOut: boolean;
  /** The leader is gone and its process group was not. Abnormal by
   * construction: something it started outlived it. */
  groupSurvived: boolean;
  /**
   * The child's ORIGINAL PROCESS GROUP is proved empty - and that is the exact
   * claim, not "every descendant is gone".
   *
   * A process that calls `setsid` leaves the group and is outside both the kill
   * and this proof, so the guarantee rests on a stated assumption: the children
   * this program runs - flyctl and the probe - do not daemonise or start new
   * sessions (true of both as of 2026-08-12; a future flyctl that daemonised
   * would break it, and a non-escapable boundary would need a cgroup rather
   * than a group). False is the state nobody may build on: something the probe
   * could not account for may still be acting.
   */
  groupEmpty: boolean;
  /** Captured for scanning and parsing. NEVER emitted, and not to be parsed
   * unless `code` is 0 - an unclean run's output is a fragment. */
  stdout: string;
  stderr: string;
}

export type BoundedSpawn = (
  argv: string[],
  env: Record<string, string>,
  stdin: string,
  deadlineMs: number,
  graceMs?: number,
  /** Injected so the EPERM and unknown-error paths have direct tests. */
  probe?: GroupProbe,
) => Promise<BoundedResult>;

/** How long a terminated group gets to leave on its own before SIGKILL. */
export const KILL_GRACE_MS = 20_000;
/** How long the group is watched for emptiness after a KILL, and how often. */
const QUIESCE_TIMEOUT_MS = 5_000;
const QUIESCE_POLL_MS = 50;
/** How long a finished run's pipes may take to end before they are cancelled.
 * A descendant that left the group could hold them open indefinitely. */
const DRAIN_GRACE_MS = 2_000;

/**
 * What a `kill(-pgid, 0)` probe means, as a pure decision.
 *
 * ONLY ESRCH PROVES ABSENCE. Every other outcome is a process that exists or a
 * question this program cannot answer, and both must read as ALIVE:
 *
 *   ESRCH   no process in the group. The only "empty".
 *   EPERM   a process IS there and we may not signal it - the exact opposite of
 *           empty, and the error an earlier version reported as quiescent.
 *   EINVAL  the signal or the id was rejected; nothing was learned.
 *   other   nothing was learned either.
 *
 * Failing closed here is what keeps a recovery from starting on the strength of
 * a probe that failed (reviewer finding, 2026-08-12).
 */
export type GroupState = "empty" | "alive";

export function classifyGroupProbe(err: unknown): GroupState {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ESRCH" ? "empty" : "alive";
}

/** The real probe. Signal 0 asks whether the group exists without touching it. */
export type GroupProbe = (pgid: number) => GroupState;

export const realGroupProbe: GroupProbe = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return "alive";
  } catch (err) {
    return classifyGroupProbe(err);
  }
};

/**
 * One stream, its OWN decoder, drained until end or cancellation.
 *
 * The decoder is per stream and not shared. A streaming `TextDecoder` holds the
 * tail of a partial multi-byte sequence, so one shared between stdout and
 * stderr lets a split character from one stream absorb bytes from the other -
 * corrupting exactly the JSON listing and probe verdict this program parses
 * (reviewer finding, 2026-08-12). The final `decode()` with no argument flushes
 * whatever the stream ended mid-character with.
 */
export function streamSink(stream: ReadableStream<Uint8Array>): {
  drain: Promise<void>;
  text: () => string;
  cancel: () => void;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let captured = "";
  const drain = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) captured += decoder.decode(value, { stream: true });
      }
    } catch {
      // A cancelled reader ends here, which is the point.
    }
    captured += decoder.decode();
  })();
  return {
    drain,
    text: () => captured,
    cancel: () => {
      void reader.cancel().catch(() => {});
    },
  };
}

/**
 * A child with a DEADLINE, whose whole PROCESS GROUP is terminated and proved
 * gone before the answer comes back.
 *
 * `realSpawn` waits forever, which is the right shape for nothing this program
 * does after a credential exists: a flyctl that never exits would hold a run
 * open with a staged secret and a live credential and nothing to escalate to,
 * because the program would never return (reviewer finding, 2026-08-11).
 *
 * THE UNIT OF LIFETIME IS THE GROUP, NOT THE CHILD. Killing a leader does not
 * kill what it started, and a surviving descendant can still hold credentials
 * and keep talking to a provider after this program has decided the world
 * stopped changing and begun a recovery - which is the one thing the recovery
 * assumes is untrue. So the child is spawned DETACHED, which measured
 * 2026-08-12 on this box puts it in a new process group whose id is its own pid
 * (a plain spawn shares ours, and signalling that would hit the office's own
 * processes). Termination signals the GROUP, and the answer is withheld until
 * `kill(-pgid, 0)` says nothing is left in it.
 *
 * A LEADER THAT EXITS CLEANLY WHILE ITS GROUP LIVES IS NOT A SUCCESS. It is
 * reported as `groupSurvived`, and the group is terminated the same way: an
 * exit code says what the leader thought, not what its children are still
 * doing.
 *
 * The output is captured for scanning and parsing, and never emitted. Draining
 * concurrently matters even where nothing reads the bytes: a child that fills a
 * pipe buffer nobody empties blocks on write, and a blocked child looks exactly
 * like a slow one. But end-of-stream is NEVER waited on unboundedly - an
 * inherited pipe can outlive the group entirely - so the readers are cancelled
 * after a short grace. Measured 2026-08-11: with a child that traps SIGTERM and
 * leaves a `sleep` holding the pipe, waiting for EOF never returned.
 */
export const realBoundedSpawn: BoundedSpawn = async (
  argv,
  env,
  stdin,
  deadlineMs,
  graceMs = KILL_GRACE_MS,
  probe = realGroupProbe,
) => {
  const child = Bun.spawn(argv, {
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    // Its own process group, so termination can reach everything it starts and
    // can reach NOTHING of ours.
    detached: true,
  });
  const pgid = child.pid;
  const sinks = [streamSink(child.stdout), streamSink(child.stderr)];
  const drained = Promise.all(sinks.map((sink) => sink.drain));

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const alive = () => probe(pgid) === "alive";
  const letGo = async (): Promise<void> => {
    // Bounded either way: end of stream if every writer is gone, otherwise
    // cancelled. Nothing here waits on a writer this program does not own.
    await Promise.race([drained, sleep(DRAIN_GRACE_MS)]);
    for (const sink of sinks) sink.cancel();
  };
  const answer = (over: Partial<BoundedResult>): BoundedResult => ({
    code: null,
    timedOut: false,
    groupSurvived: false,
    groupEmpty: false,
    stdout: sinks[0].text(),
    stderr: sinks[1].text(),
    ...over,
  });

  /** Poll until the group is empty, or say it is not. */
  const waitEmpty = async (): Promise<boolean> => {
    for (
      let waited = 0;
      waited < QUIESCE_TIMEOUT_MS;
      waited += QUIESCE_POLL_MS
    ) {
      if (!alive()) return true;
      await sleep(QUIESCE_POLL_MS);
    }
    return !alive();
  };

  const terminateGroup = async (): Promise<boolean> => {
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      // Already gone, or not ours to signal; the probe below decides either way.
    }
    for (let waited = 0; waited < graceMs; waited += QUIESCE_POLL_MS) {
      if (!alive()) break;
      await sleep(QUIESCE_POLL_MS);
    }
    if (alive()) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Same. A kill this program could not deliver is exactly why the wait
        // below is bounded.
      }
    }
    // THE REAP, BOUNDED. Awaiting the leader stops it being a zombie, but a
    // leader that a failed SIGKILL left running would make that await
    // unbounded - which is the thing this whole primitive exists to remove.
    await Promise.race([child.exited, sleep(QUIESCE_TIMEOUT_MS)]);
    return waitEmpty();
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });

  try {
    const first = await Promise.race([
      child.exited.then((code) => ({ code }) as const),
      deadline,
    ]);

    if (first !== "deadline") {
      if (!alive()) {
        await letGo();
        return answer({ code: first.code, groupEmpty: true });
      }
      // The leader is gone and its group is not: whatever it started is still
      // running, and its exit code says nothing about that.
      const empty = await terminateGroup();
      await letGo();
      return answer({ groupSurvived: true, groupEmpty: empty });
    }

    const empty = await terminateGroup();
    await letGo();
    return answer({ timedOut: true, groupEmpty: empty });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A secret file's contents, read here and returned to a caller that must not
 * print it.
 *
 * A missing file is a refusal with a fixed sentence: the path is ours and
 * naming it helps, but nothing derived from the contents is ever quoted.
 */
export function readSecretFile(file: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`missing or unreadable: ${file}`);
  }
  const value = raw.trim();
  if (value.length === 0) throw new Error(`empty: ${file}`);
  return value;
}

/**
 * The seam credential's file, checked against the shape it was promised to
 * have, by the process that is about to use it.
 *
 * "Somebody ran grep on it once" is not enforcement: the file can change, and
 * the consumer is the only place where the check happens at the moment it
 * matters. So every property is re-established here, and every one of them is
 * a REFUSAL rather than a warning:
 *
 *   regularFile  the file is OPENED ONCE with O_NOFOLLOW, and the checks and
 *                the read all go through that one descriptor. A symlink cannot
 *                be opened at all; more importantly, a path that is swapped
 *                between the check and the read cannot be reached, because
 *                after the open there is no path left to swap - only a file.
 *   mode600      the exact mode, not "no group or world bits". 0400 would pass
 *                a bitmask test and has to fail, so the permission is compared
 *                rather than sampled. Read from the DESCRIPTOR, not the path.
 *   shapeOk      the file's bytes are EXACTLY
 *                CONTROL_PLANE_MINT_TOKEN='<40 lowercase hex>' with at most the
 *                usual final newline. Not "one line after trimming": a leading
 *                space, a trailing space or a blank line are bytes nobody ruled
 *                and this is the seam where a promised shape is enforced, so
 *                everything outside the ruled line is refused.
 *
 * The token comes back only when all four hold, and it is EMPTY otherwise, so a
 * caller that ignores the booleans still cannot use a file that failed them.
 * Nothing derived from the contents is ever reported: the answer is booleans.
 */
export interface MintFileChecks {
  present: boolean;
  regularFile: boolean;
  mode600: boolean;
  shapeOk: boolean;
}

export const MINT_TOKEN_NAME = "CONTROL_PLANE_MINT_TOKEN";
/** The whole file, not a line of it. `\n?$` allows the usual final newline. */
const MINT_FILE_EXACTLY = /^CONTROL_PLANE_MINT_TOKEN='([0-9a-f]{40})'\n?$/;

export function inspectMintFile(file: string = MINT_ENV_FILE): {
  checks: MintFileChecks;
  token: string;
} {
  const failed = (checks: Partial<MintFileChecks>) => ({
    checks: {
      present: false,
      regularFile: false,
      mode600: false,
      shapeOk: false,
      ...checks,
    },
    token: "",
  });

  let handle: number;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    // A symlink fails here with ELOOP, which is the refusal. Absent is the only
    // case that is not "something is there and it is not a file we may read".
    const code = (err as NodeJS.ErrnoException).code;
    return failed({ present: code !== "ENOENT" });
  }
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) return failed({ present: true });
    const mode600 = (stat.mode & 0o7777) === 0o600;
    const contents = fs.readFileSync(handle, "utf8");
    const match = MINT_FILE_EXACTLY.exec(contents);
    const checks = {
      present: true,
      regularFile: true,
      mode600,
      shapeOk: match !== null,
    };
    if (!mode600 || !match) return { checks, token: "" };
    return { checks, token: match[1] };
  } catch {
    return failed({ present: true, regularFile: true });
  } finally {
    try {
      fs.closeSync(handle);
    } catch {
      // Nothing depends on the close succeeding; the answer is already formed.
    }
  }
}

/** True only when every check held. The one thing callers should branch on. */
export function mintFileUsable(checks: MintFileChecks): boolean {
  return (
    checks.present && checks.regularFile && checks.mode600 && checks.shapeOk
  );
}
