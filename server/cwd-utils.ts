import { resolve, join } from "path";
import { homedir } from "os";
import { STATE_ROOT } from "./config.ts";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
} from "fs";
import { errMessage, errCode } from "../shared/errors.ts";

// Path to the Claude CLI native binary that ships with the Agent SDK.
// The SDK's auto-resolver tries the musl variant first on Linux, which fails
// on glibc systems (ENOENT on /lib/ld-musl-*.so.1 when execve runs the binary).
// We resolve explicitly and pass it as pathToClaudeCodeExecutable so every
// libc gets the right binary.
function resolveClaudeNativeBinary(): string {
  const anthropicDir = join(
    import.meta.dir,
    "..",
    "node_modules",
    "@anthropic-ai",
  );
  const binName = process.platform === "win32" ? "claude.exe" : "claude";
  if (process.platform === "linux") {
    const muslArch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const isMusl = existsSync(`/lib/ld-musl-${muslArch}.so.1`);
    const variants = isMusl
      ? [`linux-${process.arch}-musl`, `linux-${process.arch}`]
      : [`linux-${process.arch}`, `linux-${process.arch}-musl`];
    for (const v of variants) {
      const p = join(anthropicDir, `claude-agent-sdk-${v}`, binName);
      if (existsSync(p)) return p;
    }
  }
  return join(
    anthropicDir,
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    binName,
  );
}

export const CLAUDE_NATIVE_BIN = resolveClaudeNativeBinary();

// Resolve ~ in paths
export function resolveCwd(cwd: string): string {
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  if (cwd === "~") return homedir();
  return resolve(cwd);
}

// Inverse of resolveCwd's home expansion: abbreviate the user's home dir prefix
// back to `~` for display (e.g. the resume picker, to save horizontal space).
// Only the exact home dir or a home-rooted path is abbreviated; unrelated paths
// pass through untouched. Display-only - never feed the result back into a path
// API without resolveCwd-ing it first.
export function tildifyCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

// Directory where Claude CLI stores per-project session JSONLs.
// Sanitization observed: any non-alphanumeric, non-hyphen char becomes "-".
// Ex: /home/nil/nilmamano.com -> -home-nil-nilmamano-com
//
// Honors CLAUDE_CONFIG_DIR (the same env var the Claude SDK reads) so that
// per-user envFile setups pointing at a non-default config dir resolve to the
// same projects/ tree the spawned subprocess uses. Falls back to ~/.claude
// when env is unset or omitted - preserves today's behavior for default users.
export function claudeProjectDir(
  cwd: string,
  env?: { [key: string]: string | undefined },
): string {
  const configDir = env?.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
}

export function claudeSessionFileExists(
  cwd: string,
  sessionId: string,
  env?: { [key: string]: string | undefined },
): boolean {
  return existsSync(join(claudeProjectDir(cwd, env), `${sessionId}.jsonl`));
}

// Bytes read from the END of a Claude session .jsonl. Entries are one JSON
// object per line and we only need the last one; 256 KB is far past any
// realistic final entry, and the window deliberately cuts earlier lines in
// half because we never look at them.
const CLAUDE_SESSION_TAIL_BYTES = 256 * 1024;

// Best-effort: is this session's last transcript entry marked as interrupted by
// a shutdown? The Claude CLI stamps `interruptedByShutdown` when a SIGTERM cuts
// a turn short, on the same entry whose tool result claims the USER rejected the
// running tool. That hardcoded wording is indistinguishable from a real denial
// to the resumed agent, so a true answer here lets the wake-up
// message say categorically that no human rejected anything.
//
// Deliberately NON-LOAD-BEARING: any doubt at all - missing file, unreadable
// tail, unparseable line, marker absent - returns false, and the caller falls
// back to hedged wording that is true either way. This never guesses true.
export function claudeSessionInterruptedByShutdown(
  cwd: string,
  sessionId: string,
  env?: { [key: string]: string | undefined },
): boolean {
  const path = join(claudeProjectDir(cwd, env), `${sessionId}.jsonl`);
  let tail: string;
  try {
    const { size } = statSync(path);
    const window = Math.min(size, CLAUDE_SESSION_TAIL_BYTES);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(window);
      const n = readSync(fd, buf, 0, window, size - window);
      tail = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { interruptedByShutdown?: unknown };
      return parsed?.interruptedByShutdown === true;
    } catch {
      // The last non-empty line isn't valid JSON: either a mid-write capture
      // or a line longer than the window. Indeterminate, so stay hedged.
      return false;
    }
  }
  return false;
}

// Directory where Codex stores live (resumable) thread rollouts. Codex's
// app-server reads from here when servicing thread/resume. The archived
// counterpart at `${CODEX_HOME}/archived_sessions/` is NOT searched - once
// a thread is archived, the user has to go through an explicit picker.
//
// CODEX_HOME resolution: honor env.CODEX_HOME if the caller supplied it (per-
// user envFile billing isolation, per internal-docs/isolation-design.md),
// otherwise fall back to isomux's isolated home `~/.isomux/codex-home/`.
// Callers pass the same env they pass to the spawn (typically from
// `buildEnvFor(...)`, which already merges process.env), so this resolves to
// the same dir the subprocess writes to. Unlike `withIsomuxCodexHome`, this
// does NOT independently consult `process.env` - it only needs CODEX_HOME,
// not the rest of the env, so there's nothing to inherit wholesale.
export function codexSessionsDir(env?: {
  [key: string]: string | undefined;
}): string {
  const codexHome = env?.CODEX_HOME || join(STATE_ROOT, "codex-home");
  return join(codexHome, "sessions");
}

// Cap on directories visited while looking for a Codex rollout file. If we
// hit this without finding the thread, we deliberately return TRUE so the
// caller proceeds with thread/resume - letting Codex itself surface whatever
// the real story is - rather than silently fresh-starting what might be a
// real old session. False negatives are worse than a slow startup.
const CODEX_ROLLOUT_SCAN_DIR_CAP = 50000;

// Cap on lines read while checking whether a rollout file has any
// non-session_meta history. Real rollouts grow large; the header is line 1.
// We only need to find the first non-meta line.
const CODEX_ROLLOUT_HEADER_SCAN_LINES = 16;

// Canonical 8-4-4-4-12 hex UUID. Codex thread ids are UUIDv7; tightening
// to canonical shape matches what we actually issue and keeps malformed
// input from getting our friendly preflight error instead of Codex's own
// (more accurate) invalid-id surfacing.
const CODEX_THREAD_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Returns true if a Codex rollout file exists for `threadId` under
// `${CODEX_HOME}/sessions/` (not archived_sessions). Existence-only - a
// header-only rollout still counts as "exists". Used by strict resume paths
// where we want Codex itself to surface the precise failure (header-only,
// corrupt, etc.) rather than have Isomux pre-empt with a generic message.
export function codexRolloutFileExists(
  threadId: string,
  env?: { [key: string]: string | undefined },
): boolean {
  return findCodexRolloutPath(threadId, env) !== null;
}

// "Durable" means the rollout file is present under `${CODEX_HOME}/sessions/`
// AND contains at least one non-session_meta line. A file that contains only
// the session_meta header is not resumable by Codex's app-server
// (stored_thread_to_initial_history requires actual history items), so it maps
// to `empty` rather than `missing`.
//
// Errors during the filesystem walk or line scan are treated as
// "indeterminate, assume durable" - same rationale as the dir cap above.
//
// Backend-facing storage fact used by both silent auto-resume and strict
// resume preflights. The empty-string sentinel means the directory scan hit
// its cap, so preserve the existing "assume durable" rule here instead of
// making callers invent a fourth policy state.
export function inspectCodexStoredSession(
  threadId: string,
  env?: { [key: string]: string | undefined },
): "missing" | "empty" | "durable" {
  const path = findCodexRolloutPath(threadId, env);
  if (path === null) return "missing";
  if (path === "") return "durable";
  return rolloutFileHasNonMetaLine(path) ? "durable" : "empty";
}

// Returns the path to the rollout file for `threadId`, or null if not found.
// Returns the empty string sentinel if the dir cap was hit (caller treats
// this as "indeterminate, assume durable").
function findCodexRolloutPath(
  threadId: string,
  env?: { [key: string]: string | undefined },
): string | null {
  if (!CODEX_THREAD_ID_PATTERN.test(threadId)) return null;
  const sessionsDir = codexSessionsDir(env);
  if (!existsSync(sessionsDir)) return null;
  const filenameSuffix = `-${threadId}.jsonl`;
  let dirsVisited = 0;
  const stack: string[] = [sessionsDir];
  while (stack.length > 0) {
    if (dirsVisited >= CODEX_ROLLOUT_SCAN_DIR_CAP) {
      return ""; // indeterminate sentinel
    }
    const dir = stack.pop()!;
    dirsVisited++;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (
        e.isFile() &&
        e.name.startsWith("rollout-") &&
        e.name.endsWith(filenameSuffix)
      ) {
        return full;
      }
    }
  }
  return null;
}

// Read the rollout file's head and return true if any line within the budget
// parses to a JSON object whose `type` is not "session_meta". Real rollouts
// on Codex 0.130 can have a meta line of tens of KB (it embeds the full
// base_instructions), so we read a generous 128 KB head; if a single line
// exceeds that, return true (indeterminate, let Codex resolve).
//
// Trailing-newline handling: a file written as `<meta>\n<resp>` (no final
// newline - common during mid-write or when the head window cuts off) must
// not be misclassified as non-durable just because we conservatively dropped
// the last segment. We try to parse the final segment; if it's valid JSON we
// use it like any other line, and if parsing fails for that segment alone we
// treat it as indeterminate (assume durable).
function rolloutFileHasNonMetaLine(path: string): boolean {
  const HEAD_BYTES = 128 * 1024;
  let buf;
  try {
    const fd = openSync(path, "r");
    try {
      const tmp = Buffer.alloc(HEAD_BYTES);
      const n = readSync(fd, tmp, 0, HEAD_BYTES, 0);
      buf = tmp.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return true;
  }
  const segments = buf.split("\n");
  const trailingNewline = buf.endsWith("\n");
  let scanned = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    // A trailing newline produces a final empty split artifact, not a real
    // line - skip without spending budget.
    if (isLast && trailingNewline && !segment.length) continue;
    if (scanned >= CODEX_ROLLOUT_HEADER_SCAN_LINES) return true;
    if (!segment.length) continue;
    scanned++;
    let parsed: { type?: unknown } | null = null;
    try {
      parsed = JSON.parse(segment) as { type?: unknown };
    } catch {
      // For the final segment of a file that doesn't end with a newline,
      // parse failure means a mid-write capture or a line past our window -
      // both indeterminate, so assume durable. Mid-file parse errors are
      // unexpected but recoverable: skip and keep scanning.
      if (isLast && !trailingNewline) return true;
      continue;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.type &&
      parsed.type !== "session_meta"
    ) {
      return true;
    }
  }
  return false;
}

// Move a single Claude CLI session's files from one cwd's project dir to
// another. The Claude CLI derives its session storage path from cwd, so
// changing the cwd a session runs in without moving its files orphans it on the
// next respawn (e.g. server restart) - resume can't find it.
//
// Scoped to ONE session by design: under per-session cwd, an agent's other
// sessions keep their own recorded cwd and must stay where they are. (The
// previous move-all behavior matched the old agent-level cwd model, where every
// session implicitly shared the agent's single cwd.)
//
// `env` selects which CLAUDE_CONFIG_DIR projects/ tree to read from and write
// to. Callers must pass the env that corresponds to the agent's *current*
// identity - if `username` and `cwd` ever change in the same edit, the move must
// run with the OLD username's env, before the username mutation commits.
//
// Returns a structured result so the caller can keep session metadata honest:
//   - { ok: true, moved: false }  → nothing to move (no source, or same dir)
//   - { ok: true, moved: true }   → moved successfully
//   - { ok: false, moved, error } → source existed but a rename failed; `moved`
//     says whether a partial move happened (so the caller can reverse it). A
//     failed move must NOT be followed by stamping the session's new cwd -
//     Claude wouldn't find the .jsonl there.
export function moveClaudeSessionFile(
  sessionId: string,
  oldCwd: string,
  newCwd: string,
  env?: { [key: string]: string | undefined },
): { ok: boolean; moved: boolean; error?: string } {
  const oldDir = claudeProjectDir(oldCwd, env);
  const newDir = claudeProjectDir(newCwd, env);
  if (oldDir === newDir || !existsSync(oldDir))
    return { ok: true, moved: false };
  const oldJsonl = join(oldDir, `${sessionId}.jsonl`);
  const newJsonl = join(newDir, `${sessionId}.jsonl`);
  // Claude CLI also writes a sibling <sessionId>/ dir (tool-results cache, etc.)
  const oldSib = join(oldDir, sessionId);
  const newSib = join(newDir, sessionId);
  const moveJsonl = existsSync(oldJsonl) && !existsSync(newJsonl);
  const moveSib = existsSync(oldSib) && !existsSync(newSib);
  if (!moveJsonl && !moveSib) return { ok: true, moved: false };
  mkdirSync(newDir, { recursive: true });
  let moved = false;
  if (moveJsonl) {
    try {
      renameSync(oldJsonl, newJsonl);
      moved = true;
    } catch (err) {
      console.error(
        `[cwd-change] Failed to move ${oldJsonl} -> ${newJsonl}:`,
        err,
      );
      return { ok: false, moved, error: errMessage(err) };
    }
  }
  if (moveSib) {
    try {
      renameSync(oldSib, newSib);
      moved = true;
    } catch (err) {
      console.error(`[cwd-change] Failed to move ${oldSib} -> ${newSib}:`, err);
      return { ok: false, moved, error: errMessage(err) };
    }
  }
  return { ok: true, moved };
}

// Resolve and verify a cwd. Throws if the directory does not exist or is not a directory.
export function validateCwd(cwd: string): string {
  const resolved = resolveCwd(cwd);
  let stat;
  try {
    stat = statSync(resolved);
  } catch (err) {
    if (errCode(err) === "ENOENT")
      throw new Error(`Directory does not exist: ${resolved}`, { cause: err });
    throw new Error(`Cannot access ${resolved}: ${errMessage(err)}`, {
      cause: err,
    });
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return resolved;
}

// Produce a human-readable hint for why the Claude CLI subprocess may have died,
// to go alongside the SDK's generic "process exited with code 1". Returns null if
// no specific cause is identifiable.
//
// `env` lets the hint resolve session paths against the same CLAUDE_CONFIG_DIR
// the spawn used. Error-path callers must wrap their env build in try/catch and
// pass `undefined` on failure - a broken envFile must not mask the original
// backend error this function is annotating.
export function diagnoseProcessExit(
  cwd: string,
  sessionId: string | null,
  env?: { [key: string]: string | undefined },
): string | null {
  try {
    validateCwd(cwd);
  } catch {
    return `Likely cause: cwd \`${cwd}\` no longer exists. Click the agent name in the log view header to point it at a valid directory.`;
  }
  if (sessionId && !claudeSessionFileExists(cwd, sessionId, env)) {
    return (
      `Likely cause: session \`${sessionId.slice(0, 8)}…\` was not found in \`${claudeProjectDir(cwd, env)}\`. ` +
      `This usually happens after cwd was moved/renamed - the Claude CLI locates session files by a path derived from cwd. ` +
      `Use /resume to pick another session, or move the session .jsonl into the new project dir.`
    );
  }
  return null;
}
