// Synchronous check for whether the standalone Claude Code CLI is on PATH.
//
// The Claude Agent SDK ships its own native binary (see CLAUDE_NATIVE_BIN in
// server/cwd-utils.ts), so agent runtime does NOT require the user-facing
// `claude` CLI to be installed. That CLI is only needed for the human auth
// flow: `claude` then `/login` writes credentials the SDK then reads. So
// `isClaudeCodeInstalled() === false` only matters when we're surfacing
// login instructions — it lets us swap "open terminal, run claude, /login"
// (no-op if the binary isn't there) for an install hint first.
//
// Codex doesn't have an equivalent presence check: codex now ships bundled as
// an isomux runtime dep (see server/backends/codex/native-bin.ts), so its
// availability is guaranteed by a successful `bun install`. Memoized so
// repeat callers don't re-spawn `which`.

import { execSync } from "child_process";

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
