import { resolve, join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, renameSync, statSync } from "fs";
import { listAgentSessions } from "./persistence.ts";

// Path to the Claude CLI native binary that ships with the Agent SDK.
// The SDK's auto-resolver tries the musl variant first on Linux, which fails
// on glibc systems (ENOENT on /lib/ld-musl-*.so.1 when execve runs the binary).
// We resolve explicitly and pass it as pathToClaudeCodeExecutable so every
// libc gets the right binary.
function resolveClaudeNativeBinary(): string {
  const anthropicDir = join(import.meta.dir, "..", "node_modules", "@anthropic-ai");
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
  return join(anthropicDir, `claude-agent-sdk-${process.platform}-${process.arch}`, binName);
}

export const CLAUDE_NATIVE_BIN = resolveClaudeNativeBinary();

// Resolve ~ in paths
export function resolveCwd(cwd: string): string {
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  if (cwd === "~") return homedir();
  return resolve(cwd);
}

// Directory where Claude CLI stores per-project session JSONLs.
// Sanitization observed: any non-alphanumeric, non-hyphen char becomes "-".
// Ex: /home/nil/nilmamano.com -> -home-nil-nilmamano-com
export function claudeProjectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
}

export function claudeSessionFileExists(cwd: string, sessionId: string): boolean {
  return existsSync(join(claudeProjectDir(cwd), `${sessionId}.jsonl`));
}

// Move an agent's Claude CLI session files from one cwd's project dir to another.
// The Claude CLI derives its session storage path from cwd, so changing an agent's cwd
// without moving these files orphans every session on the next respawn (e.g. server restart).
export function moveClaudeSessionFiles(agentId: string, oldCwd: string, newCwd: string) {
  const oldDir = claudeProjectDir(oldCwd);
  const newDir = claudeProjectDir(newCwd);
  if (oldDir === newDir || !existsSync(oldDir)) return;
  const sessions = listAgentSessions(agentId);
  if (sessions.length === 0) return;
  mkdirSync(newDir, { recursive: true });
  for (const { sessionId } of sessions) {
    const oldJsonl = join(oldDir, `${sessionId}.jsonl`);
    const newJsonl = join(newDir, `${sessionId}.jsonl`);
    if (existsSync(oldJsonl) && !existsSync(newJsonl)) {
      try { renameSync(oldJsonl, newJsonl); } catch (err) {
        console.error(`[cwd-change] Failed to move ${oldJsonl} -> ${newJsonl}:`, err);
      }
    }
    // Claude CLI also writes a sibling <sessionId>/ dir (tool-results cache, etc.)
    const oldSib = join(oldDir, sessionId);
    const newSib = join(newDir, sessionId);
    if (existsSync(oldSib) && !existsSync(newSib)) {
      try { renameSync(oldSib, newSib); } catch (err) {
        console.error(`[cwd-change] Failed to move ${oldSib} -> ${newSib}:`, err);
      }
    }
  }
}

// Resolve and verify a cwd. Throws if the directory does not exist or is not a directory.
export function validateCwd(cwd: string): string {
  const resolved = resolveCwd(cwd);
  let stat;
  try {
    stat = statSync(resolved);
  } catch (err: any) {
    if (err.code === "ENOENT") throw new Error(`Directory does not exist: ${resolved}`);
    throw new Error(`Cannot access ${resolved}: ${err.message}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return resolved;
}

// Produce a human-readable hint for why the Claude CLI subprocess may have died,
// to go alongside the SDK's generic "process exited with code 1". Returns null if
// no specific cause is identifiable.
export function diagnoseProcessExit(cwd: string, sessionId: string | null): string | null {
  try {
    validateCwd(cwd);
  } catch {
    return `Likely cause: cwd \`${cwd}\` no longer exists. Click the agent name in the log view header to point it at a valid directory.`;
  }
  if (sessionId && !claudeSessionFileExists(cwd, sessionId)) {
    return (
      `Likely cause: session \`${sessionId.slice(0, 8)}…\` was not found in \`${claudeProjectDir(cwd)}\`. ` +
      `This usually happens after cwd was moved/renamed — the Claude CLI locates session files by a path derived from cwd. ` +
      `Use /resume to pick another session, or move the session .jsonl into the new project dir.`
    );
  }
  return null;
}
