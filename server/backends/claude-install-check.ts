// Synchronous check for whether the standalone Claude Code CLI is on PATH.
//
// The Claude Agent SDK ships its own native binary (see CLAUDE_NATIVE_BIN in
// server/cwd-utils.ts), so agent runtime does NOT require the user-facing
// `claude` CLI to be installed. That CLI is only needed for the human auth
// flow: `claude` then `/login` writes credentials the SDK then reads. So
// `isClaudeCodeInstalled() === false` only matters when we're surfacing
// login instructions - it lets us swap "open terminal, run claude, /login"
// (no-op if the binary isn't there) for an install hint first.
//
// Codex doesn't have an equivalent presence check: codex now ships bundled as
// an isomux runtime dep (see server/backends/codex/native-bin.ts), so its
// availability is guaranteed by a successful `bun install`. Memoized so
// repeat callers don't re-spawn `which`.

import { execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

let cached: boolean | null = null;

export function isClaudeCodeInstalled(): boolean {
  if (cached !== null) return cached;
  try {
    execSync("which claude", { stdio: "pipe" });
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}

// Cheap probe for "user has already completed claude-code login at some
// point". Used by the login-instructions path so an agent that hits an
// auth-error (or the user types /login on an already-authed agent) shows
// a "/clear to refresh" hint instead of repeating the install/login
// walkthrough at someone who's already done their part.
//
// Two positive signals, either is enough:
//   1. ANTHROPIC_API_KEY in the agent's effective env - env-var auth
//      bypasses the credentials file entirely. Caller passes the agent's
//      resolved env (process.env + office envFile + user envFile, in
//      override order); defaults to process.env if no env supplied.
//   2. `~/.claude/.credentials.json` exists - the file `claude /login`
//      writes, and what the SDK reads to authenticate.
//
// Symmetric with `isCodexAuthenticated` in codex/native-bin.ts. The CLI
// presence check (`isClaudeCodeInstalled`) is independent: the SDK can
// be fully working off the credentials file even when `claude` itself
// isn't on the systemd-user PATH.
export function isClaudeCodeAuthenticated(env?: {
  [key: string]: string | undefined;
}): boolean {
  const effective = env ?? process.env;
  if (effective.ANTHROPIC_API_KEY) return true;
  return existsSync(join(homedir(), ".claude", ".credentials.json"));
}
