import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "fs";
import { extname, isAbsolute, join, resolve } from "path";
import { homedir } from "os";
import { errMessage } from "../shared/errors.ts";

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
  | { kind: "ok"; path: string; mtime: number }
  | { kind: "stale"; path: string; currentMtime: number }
  | { kind: "io_error"; path: string; message: string };

const MAX_FILE_BYTES = 1_000_000;

// Change signature for the editor watch: mtime alone is not enough — a
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
  if (!existsSync(absPath)) return { kind: "not_found", path: absPath };
  let st;
  try {
    st = statSync(absPath);
  } catch (err) {
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
    return {
      kind: "io_error",
      path: absPath,
      message: errMessage(err),
    };
  }
  return {
    kind: "ok",
    path: absPath,
    content,
    mtime: Math.floor(st.mtimeMs),
    language: detectLanguage(absPath),
    size: st.size,
    sig: fileSig(st),
  };
}

export function saveFile(
  absPath: string,
  content: string,
  expectedMtime: number,
  force: boolean,
): SaveFileResult {
  // Concurrency guard: if the on-disk mtime is newer than what the client
  // opened, refuse (unless `force`). Client surfaces a banner that lets the
  // boss choose Overwrite (force=true) or Reload.
  let currentMtime = 0;
  try {
    const st = statSync(absPath);
    currentMtime = Math.floor(st.mtimeMs);
  } catch {
    // File doesn't exist anymore — treat as stale unless forced.
    if (!force) return { kind: "stale", path: absPath, currentMtime: 0 };
  }
  if (!force && currentMtime > expectedMtime) {
    return { kind: "stale", path: absPath, currentMtime };
  }
  try {
    writeFileSync(absPath, content, "utf8");
    const st = statSync(absPath);
    return { kind: "ok", path: absPath, mtime: Math.floor(st.mtimeMs) };
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
// pairs — independent buffers, last-save-wins.
export interface FileWatcher {
  agentId: string;
  path: string;
  timer: ReturnType<typeof setInterval>;
}

const WATCH_POLL_MS = 1000;

export function watchFile(
  absPath: string,
  agentId: string,
  onChange: (mtime: number) => void,
  // The `sig` of the openFile read this watch backs. Using the read-time
  // signature (not a fresh stat here) closes the read-then-watch gap: a save
  // landing between the read and this install differs from the baseline, so
  // the first poll emits and the client refetches.
  baselineSig: string,
): FileWatcher {
  // mtime polling, NOT fs.watch. Task 30ffe109 found fs.watch unusable under
  // Bun for this: most agent tooling saves via atomic write-to-tmp + rename
  // (Claude Code's Edit/Write do, observed: `x.tmp.<pid>.<hash>` renamed over
  // `x`), which replaces the file's inode. A single-file fs.watch binds to
  // the inode — under Bun a rename-replace fires NO event and the watch is
  // permanently dead afterwards (verified empirically). Watching the parent
  // directory doesn't work either: Bun coalesces the create-tmp/write/rename
  // burst into one early event that fires before the rename lands, so the
  // change is still missed. A 1s stat poll per open tab is cheap (a handful
  // of tabs per browser), catches every save mechanism, and dedupes
  // trivially via the signature comparison.
  let lastSig = baselineSig;
  const timer = setInterval(() => {
    try {
      const st = statSync(absPath);
      const s = fileSig(st);
      if (s === lastSig) return;
      lastSig = s;
      onChange(Math.floor(st.mtimeMs));
    } catch {
      // File missing — deleted, or mid-rename. Silently ignore for v1; if
      // it reappears, the next poll emits.
    }
  }, WATCH_POLL_MS);
  // Don't let watch timers hold the process open on shutdown.
  timer.unref?.();
  return { agentId, path: absPath, timer };
}

export function stopWatch(w: FileWatcher) {
  clearInterval(w.timer);
}
