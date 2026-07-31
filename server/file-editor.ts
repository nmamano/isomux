import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "fs";
import { extname, isAbsolute, join, resolve } from "path";
import { homedir } from "os";
import { errMessage } from "../shared/errors.ts";
import { STATE_ROOT } from "./config.ts";

export type ResolvePathResult =
  | { kind: "ok"; path: string }
  | { kind: "bad_path"; attempted: string };

export type OpenFileResult =
  | {
      kind: "ok";
      path: string;
      content: string;
      mtime: number;
      language: string;
      size: number;
      // Server-issued revision for this path (see the revision registry
      // below). Goes on the wire; the client compares revisions instead of
      // timestamps, closing the same-millisecond mtime blind spot.
      rev: number;
      // Change signature of the stat this read was served from. Server-side
      // only (never on the wire): passed to watchFile as the poll baseline so
      // a save landing between the read and the watch install still emits on
      // the first poll (the read-then-watch gap).
      sig: string;
    }
  | { kind: "not_found"; path: string }
  | { kind: "not_file"; path: string }
  | { kind: "binary"; path: string }
  | { kind: "too_large"; path: string; size: number }
  | { kind: "io_error"; path: string; message: string };

export type SaveFileResult =
  | { kind: "ok"; path: string; mtime: number; rev: number }
  | { kind: "stale"; path: string; currentMtime: number; currentRev: number }
  // The file no longer exists on disk. Distinct from "stale" so the client can
  // offer save-to-recreate instead of a dead-end "changed on disk" banner.
  | { kind: "deleted"; path: string }
  | { kind: "io_error"; path: string; message: string };

const MAX_FILE_BYTES = 1_000_000;

// Change signature for the editor watch: mtime alone is not enough - a
// rename-replace that lands within the same millisecond as the previous
// state would compare equal. The inode catches replaces, size catches
// same-ms in-place rewrites of different length.
function fileSig(st: {
  mtimeMs: number;
  ino: number | bigint;
  size: number;
}): string {
  return `${st.mtimeMs}:${st.ino}:${st.size}`;
}

// --- Revision registry ------------------------------------------------------
// Per-path monotonic revision counters, keyed by absolute path. The client-
// visible mtime cannot detect every disk change (a replace landing within the
// same millisecond compares equal), but the server-side signature - which
// includes the inode - can, as long as this process was up. So the server
// issues a revision number with every open/save, bumps it whenever it observes
// a signature change (open, save, or a watch poll), and the client compares
// revisions instead of timestamps.
//
// Scope and caveats:
// - Per-process registry, but revision VALUES must never collide across a
//   restart: a fresh process re-issuing a rev a previous process already
//   handed out would let the guard miss exactly the conflicts it exists to
//   catch (e.g. a tab holding rev N from before the restart silently matching
//   an unrelated rev N after it). Non-reuse is guaranteed by STATE, not
//   timing: every rev is `generation * REV_BLOCK + counter`, where the
//   generation is reserved by read-increment-persist on a state file (see
//   reserveGeneration) - successive processes never share a generation, so no
//   value is ever issued twice. (The reservation has no inter-process lock:
//   it relies on isomux's one-server-per-state-root, serially-restarted
//   lifecycle - systemd stops the old process before the new one boots. Two
//   servers racing one state root is unsupported everywhere in this
//   codebase.) The flip side: a client rev held across a restart always
//   MISMATCHES, which is a benign false "changed" signal (conflict banner /
//   refused save), never a missed change.
// - Unbounded map, deliberately: one small entry per distinct path ever opened
//   in an editor; a handful in practice.
// - `MISSING_SIG` marks a path observed deleted, so a later recreation is a
//   signature change (one more bump) even if the recreated stat matched the
//   pre-deletion one (e.g. the file renamed away and back).
const MISSING_SIG = "missing";
const revisions = new Map<string, { sig: string; rev: number }>();

// Rev-space partitioning: each process generation owns a block of 2^33 rev
// values; the per-process counter indexes into the block. Budgets (within the
// 2^53 float-safe integer range): 2^33 ≈ 8.6e9 issued revs per process
// lifetime (revs are only issued on observed signature changes - poll- and
// request-driven, nowhere near exhaustion), and 2^20 - 1 ≈ 1M generations
// (restarts). Sequential generations live far below the 2^19.. random
// fallback range (see reserveGeneration), so the two can't meet for ~500k
// restarts.
const REV_BLOCK = 2 ** 33;
// Sequential generations live in [1, 2^19); the degraded fallback draws from
// [2^19, 2^20), so the two ranges can never meet. Values at/above 2^20 are
// out of budget and treated as corrupt.
const GENERATION_SEQ_MAX = 2 ** 19;
const GENERATION_FILE = join(STATE_ROOT, "editor-rev-generation");

let revBase: number | null = null;
let revCounter = 0;

// A generation OUTSIDE the sequential range, for the two degraded cases where
// the persisted state can't be trusted or advanced: it can never collide with
// any sequential generation, and collides with another degraded draw only
// with ~2^-19 probability per process pair (documented best-effort; the
// healthy path is state-guaranteed).
function degradedGeneration(): number {
  return GENERATION_SEQ_MAX + Math.floor(Math.random() * GENERATION_SEQ_MAX);
}

// Crash-safe persist: write-tmp + fsync + atomic rename (+ best-effort
// directory fsync), so the generation file is always either the old complete
// value or the new complete value - never empty or truncated by our own
// writer. Ordering note: this completes BEFORE reserveGeneration returns,
// i.e. before any rev of the new generation is issued; a crash landing
// between the rename and first use merely skips a generation.
function persistGeneration(gen: number): void {
  mkdirSync(STATE_ROOT, { recursive: true });
  const tmp = GENERATION_FILE + ".tmp";
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, String(gen));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, GENERATION_FILE);
  try {
    const dirFd = openSync(STATE_ROOT, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is best-effort (not permitted on all platforms).
  }
}

// Reserve this process's revision generation. Runs lazily on the first issued
// rev (module import stays side-effect-free). Three cases:
// - File ABSENT (ENOENT): a true first boot - sequential from 1 is safe.
// - File VALID: claim prev+1, persist it, use it.
// - File PRESENT BUT INVALID (unreadable, non-numeric, out of range - i.e.
//   external corruption or manual interference; our own writes are atomic and
//   can't tear): the previous maximum is UNKNOWN, so low generations may
//   still be live in some tab. NEVER restart the sequence - take a degraded
//   high-range generation, and repair the file with it so later boots resume
//   sequentially above it.
// - Persist FAILURE (unwritable state dir): the reservation isn't durable, so
//   the next boot would reuse it - take a degraded generation instead.
function reserveGeneration(): number {
  let prev: number | null = null; // null = present but invalid
  let absent = false;
  try {
    const raw = readFileSync(GENERATION_FILE, "utf8").trim();
    // Strict whole-string parse: anything but a plain in-range decimal is
    // corruption, not a value to build on.
    if (/^\d{1,15}$/.test(raw)) {
      const n = Number.parseInt(raw, 10);
      // Upper bound keeps gen = n+1 <= 2^20 - 1, so every issued rev
      // (gen * 2^33 + counter, counter < 2^33) stays float-safe (< 2^53).
      if (n > 0 && n < GENERATION_SEQ_MAX * 2 - 1) prev = n;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") absent = true;
  }
  if (prev === null && !absent) {
    const gen = degradedGeneration();
    try {
      persistGeneration(gen);
    } catch {
      // Repair failed; the draw is still high-range, still safe to use.
    }
    return gen;
  }
  const gen = (prev ?? 0) + 1;
  try {
    persistGeneration(gen);
    return gen;
  } catch {
    return degradedGeneration();
  }
}

// Issue a globally-unique revision value: unique within the process by the
// monotonic counter, unique across processes by the reserved generation.
function issueRev(): number {
  if (revBase === null) revBase = reserveGeneration() * REV_BLOCK;
  return revBase + ++revCounter;
}

// Record the currently-observed signature for a path and return its revision,
// bumping it only when the signature actually changed. Every observation point
// (openFile, saveFile, the watch poll) funnels through here, so concurrent
// watchers and saves converge on one counter without double-bumping. A bump
// takes a fresh issueRev(), so per-path revs are strictly increasing within a
// process and never reused across processes.
function noteSig(absPath: string, sig: string): number {
  const e = revisions.get(absPath);
  if (!e) {
    const rev = issueRev();
    revisions.set(absPath, { sig, rev });
    return rev;
  }
  if (e.sig !== sig) {
    e.sig = sig;
    e.rev = issueRev();
  }
  return e.rev;
}

// Record that a path was observed missing. Only meaningful for a path we have
// prior knowledge of - a never-observed path is skipped so existence probes of
// typo'd paths don't grow the registry. EVERY code path that observes ENOENT
// (openFile, saveFile, the watch poll's confirmed deletion) must call this
// before acting: it is what guarantees a later recreation bumps the rev even
// when the recreated signature matches the pre-delete one.
function noteMissing(absPath: string): void {
  const e = revisions.get(absPath);
  if (!e) return;
  if (e.sig !== MISSING_SIG) {
    e.sig = MISSING_SIG;
    e.rev = issueRev();
  }
}

// Resolve a user-supplied editor path against the agent's cwd. Mirrors
// resolveDiffCwd in isomux-diff.ts but yields a file path (not a directory).
// Existence/type checks happen later in openFile.
export function resolveEditorPath(
  rawPath: string | undefined,
  agentCwd: string,
): ResolvePathResult {
  const trimmed = rawPath?.trim();
  if (!trimmed) return { kind: "bad_path", attempted: trimmed ?? "" };
  const expanded = trimmed.startsWith("~")
    ? join(homedir(), trimmed.slice(1).replace(/^[/\\]/, ""))
    : trimmed;
  const abs = isAbsolute(expanded) ? expanded : resolve(agentCwd, expanded);
  return { kind: "ok", path: abs };
}

function detectLanguage(absPath: string): string {
  const ext = extname(absPath).toLowerCase();
  switch (ext) {
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".ts":
    case ".tsx":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
    case ".markdown":
    case ".mdx":
      return "markdown";
    case ".css":
    case ".scss":
    case ".less":
      return "css";
    case ".html":
    case ".htm":
      return "html";
    case ".py":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    default:
      return "plaintext";
  }
}

// Probe the first 8 KB for null bytes. Mirrors the binary check used for
// untracked diffs in isomux-diff.ts.
function isBinary(absPath: string, size: number): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(absPath, "r");
    const probeSize = Math.min(8192, size);
    const probe = Buffer.alloc(probeSize);
    const read = readSync(fd, probe, 0, probeSize, 0);
    for (let i = 0; i < read; i++) if (probe[i] === 0) return true;
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null)
      try {
        closeSync(fd);
      } catch {}
  }
}

export function openFile(absPath: string): OpenFileResult {
  // Existence is derived from statSync's ENOENT (no separate existsSync
  // probe, which would leave a delete-between-checks race returning io_error
  // and skipping the missing-sentinel invalidation).
  let st;
  try {
    st = statSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      // A previously-observed path that is now gone: invalidate its revision
      // so a recreation bumps even with a matching signature (this is the
      // reconnect-reopen-404 path, where no watch is armed to observe it).
      noteMissing(absPath);
      return { kind: "not_found", path: absPath };
    }
    return {
      kind: "io_error",
      path: absPath,
      message: errMessage(err),
    };
  }
  if (!st.isFile()) return { kind: "not_file", path: absPath };
  if (st.size > MAX_FILE_BYTES)
    return { kind: "too_large", path: absPath, size: st.size };
  if (isBinary(absPath, st.size)) return { kind: "binary", path: absPath };
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch (err) {
    // The stat-to-read race: a deletion landing here must classify the same
    // way as one landing before the stat.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      noteMissing(absPath);
      return { kind: "not_found", path: absPath };
    }
    return {
      kind: "io_error",
      path: absPath,
      message: errMessage(err),
    };
  }
  const sig = fileSig(st);
  return {
    kind: "ok",
    path: absPath,
    content,
    mtime: Math.floor(st.mtimeMs),
    language: detectLanguage(absPath),
    size: st.size,
    rev: noteSig(absPath, sig),
    sig,
  };
}

export function saveFile(
  absPath: string,
  content: string,
  expectedMtime: number,
  // The revision the client opened/last saved. When present, the concurrency
  // guard compares revisions (signature-backed - catches rollbacks and
  // same-millisecond replaces the mtime guard misses); when absent (an older
  // client), it falls back to the legacy mtime comparison.
  expectedRev: number | undefined,
  force: boolean,
): SaveFileResult {
  // Concurrency guard: if the disk changed since what the client opened,
  // refuse (unless `force`). Client surfaces a banner that lets the boss
  // choose Overwrite (force=true) or Reload.
  let st: ReturnType<typeof statSync> | null = null;
  try {
    st = statSync(absPath);
  } catch (err) {
    // ENOENT: the file doesn't exist anymore - deleted on disk. Distinct
    // result so the client shows a deletion banner (save-to-recreate) rather
    // than the wrong "changed on disk" message. force writes through,
    // recreating the file. Any other stat failure is a real IO problem and
    // must not masquerade as a deletion.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT")
      return { kind: "io_error", path: absPath, message: errMessage(err) };
    // Invalidate the registry BEFORE returning or writing: the watch may not
    // have reached its two-poll deletion confirmation yet, and without this a
    // forced recreation whose signature matches the pre-delete one would
    // return the old rev (no bump).
    noteMissing(absPath);
    if (!force) return { kind: "deleted", path: absPath };
  }
  if (st && !force) {
    const currentMtime = Math.floor(st.mtimeMs);
    const currentRev = noteSig(absPath, fileSig(st));
    if (expectedRev !== undefined) {
      if (currentRev !== expectedRev)
        return { kind: "stale", path: absPath, currentMtime, currentRev };
    } else if (currentMtime > expectedMtime) {
      return { kind: "stale", path: absPath, currentMtime, currentRev };
    }
  }
  try {
    writeFileSync(absPath, content, "utf8");
    const st2 = statSync(absPath);
    return {
      kind: "ok",
      path: absPath,
      mtime: Math.floor(st2.mtimeMs),
      // Record our own write as the current signature. Watch polls (ours and
      // other tabs') see the same signature and don't bump again, so the rev
      // returned here matches the rev their change events carry.
      rev: noteSig(absPath, fileSig(st2)),
    };
  } catch (err) {
    return {
      kind: "io_error",
      path: absPath,
      message: errMessage(err),
    };
  }
}

// Lightweight per-WS file watcher registry. Each WS owns a Map<canonicalKey,
// Watcher>; on disconnect the caller iterates and closes them all. Distinct
// keys for the same path can exist across WSes and across (agentId, path)
// pairs - independent buffers, last-save-wins.
export interface FileWatcher {
  agentId: string;
  path: string;
  timer: ReturnType<typeof setInterval>;
}

const WATCH_POLL_MS = 1000;

// How many CONSECUTIVE polls must see the path missing before the watch
// declares it deleted. Atomic rename-replace (how agent tooling saves) never
// leaves the path observably absent, but rarer save styles (unlink + recreate)
// briefly do - requiring a second confirming poll keeps a poll landing inside
// that window from raising a false "file was deleted" banner, at the cost of
// one extra poll interval of latency on a real deletion.
const DELETE_CONFIRM_POLLS = 2;

export type WatchFileEvent =
  | { kind: "change"; mtime: number; rev: number }
  | { kind: "deleted" };

export function watchFile(
  absPath: string,
  agentId: string,
  onEvent: (ev: WatchFileEvent) => void,
  // The `sig` of the openFile read this watch backs. Using the read-time
  // signature (not a fresh stat here) closes the read-then-watch gap: a save
  // landing between the read and this install differs from the baseline, so
  // the first poll emits and the client refetches.
  baselineSig: string,
  // Test-only override of the poll interval.
  opts?: { pollMs?: number },
): FileWatcher {
  // mtime polling, NOT fs.watch. Task 30ffe109 found fs.watch unusable under
  // Bun for this: most agent tooling saves via atomic write-to-tmp + rename
  // (Claude Code's Edit/Write do, observed: `x.tmp.<pid>.<hash>` renamed over
  // `x`), which replaces the file's inode. A single-file fs.watch binds to
  // the inode - under Bun a rename-replace fires NO event and the watch is
  // permanently dead afterwards (verified empirically). Watching the parent
  // directory doesn't work either: Bun coalesces the create-tmp/write/rename
  // burst into one early event that fires before the rename lands, so the
  // change is still missed. A 1s stat poll per open tab is cheap (a handful
  // of tabs per browser), catches every save mechanism, and dedupes
  // trivially via the signature comparison.
  let lastSig = baselineSig;
  let missedPolls = 0;
  const timer = setInterval(() => {
    let st;
    try {
      st = statSync(absPath);
    } catch (err) {
      // Only a confirmed-absent path counts as deleted; other stat failures
      // (permissions flapping, transient IO) stay silently ignored as before.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return;
      missedPolls++;
      // `===` fires the deletion event exactly once; further misses keep
      // counting past the threshold without re-emitting.
      if (missedPolls === DELETE_CONFIRM_POLLS) {
        // Mark the registry so a later recreation is a signature change (one
        // more rev bump) even if the recreated stat matches the old one, and
        // move lastSig so the reappearance poll emits a change event.
        noteMissing(absPath);
        lastSig = MISSING_SIG;
        onEvent({ kind: "deleted" });
      }
      return;
    }
    missedPolls = 0;
    const s = fileSig(st);
    if (s === lastSig) return;
    lastSig = s;
    onEvent({
      kind: "change",
      mtime: Math.floor(st.mtimeMs),
      rev: noteSig(absPath, s),
    });
  }, opts?.pollMs ?? WATCH_POLL_MS);
  // Don't let watch timers hold the process open on shutdown.
  timer.unref?.();
  return { agentId, path: absPath, timer };
}

export function stopWatch(w: FileWatcher) {
  clearInterval(w.timer);
}
