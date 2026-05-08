import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch as fsWatch, writeFileSync, type FSWatcher } from "fs";
import { extname, isAbsolute, join, resolve } from "path";
import { homedir } from "os";

export type ResolvePathResult =
  | { kind: "ok"; path: string }
  | { kind: "bad_path"; attempted: string };

export type OpenFileResult =
  | { kind: "ok"; path: string; content: string; mtime: number; language: string; size: number }
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

// Resolve a user-supplied editor path against the agent's cwd. Mirrors
// resolveDiffCwd in isomux-diff.ts but yields a file path (not a directory).
// Existence/type checks happen later in openFile.
export function resolveEditorPath(rawPath: string | undefined, agentCwd: string): ResolvePathResult {
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
    case ".js": case ".jsx": case ".mjs": case ".cjs":
    case ".ts": case ".tsx":
      return "javascript";
    case ".json":
      return "json";
    case ".md": case ".markdown":
      return "markdown";
    case ".css": case ".scss": case ".less":
      return "css";
    case ".html": case ".htm":
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
    if (fd !== null) try { closeSync(fd); } catch {}
  }
}

export function openFile(absPath: string): OpenFileResult {
  if (!existsSync(absPath)) return { kind: "not_found", path: absPath };
  let st;
  try {
    st = statSync(absPath);
  } catch (err: any) {
    return { kind: "io_error", path: absPath, message: err?.message ?? String(err) };
  }
  if (!st.isFile()) return { kind: "not_file", path: absPath };
  if (st.size > MAX_FILE_BYTES) return { kind: "too_large", path: absPath, size: st.size };
  if (isBinary(absPath, st.size)) return { kind: "binary", path: absPath };
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch (err: any) {
    return { kind: "io_error", path: absPath, message: err?.message ?? String(err) };
  }
  return {
    kind: "ok",
    path: absPath,
    content,
    mtime: Math.floor(st.mtimeMs),
    language: detectLanguage(absPath),
    size: st.size,
  };
}

export function saveFile(absPath: string, content: string, expectedMtime: number, force: boolean): SaveFileResult {
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
  } catch (err: any) {
    return { kind: "io_error", path: absPath, message: err?.message ?? String(err) };
  }
}

// Lightweight per-WS file watcher registry. Each WS owns a Map<canonicalKey,
// Watcher>; on disconnect the caller iterates and closes them all. Distinct
// keys for the same path can exist across WSes and across (agentId, path)
// pairs — independent buffers, last-save-wins.
export interface FileWatcher {
  agentId: string;
  path: string;
  watcher: FSWatcher;
}

export function watchFile(
  absPath: string,
  agentId: string,
  onChange: (mtime: number) => void,
): FileWatcher | null {
  try {
    const watcher = fsWatch(absPath, { persistent: false }, () => {
      // fs.watch can fire 2+ events per save (e.g., editors that write via
      // rename). The client treats `editor_external_change` idempotently —
      // a clean-buffer auto-reload is a no-op when content is unchanged,
      // and the dirty-buffer banner is set to the same value — so we accept
      // the duplicate emits rather than debouncing.
      try {
        const st = statSync(absPath);
        onChange(Math.floor(st.mtimeMs));
      } catch {
        // File was deleted — silently ignore for v1.
      }
    });
    return { agentId, path: absPath, watcher };
  } catch {
    return null;
  }
}

export function stopWatch(w: FileWatcher) {
  try { w.watcher.close(); } catch {}
}
