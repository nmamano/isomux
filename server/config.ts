// Single source of truth for the isomux state root: the directory that holds
// agents.json, users.json, sessions, logs, cronjobs, backups, the codex-home /
// bin runtime dirs, and the rest of isomux's persisted footprint.
//
// Production resolves to ~/.isomux exactly as before - byte-for-byte. Tests
// redirect the entire tree by setting ISOMUX_HOME to a temp dir BEFORE importing
// any server module, so a test run never touches real user state.
//
// Seam discipline:
//   - resolveStateRoot(env) is the pure, unit-testable resolver. Call it in
//     tests to assert resolution logic without mutating process.env.
//   - STATE_ROOT is resolved ONCE at module import and is intentionally
//     process-scoped. Do NOT mutate process.env.ISOMUX_HOME after importing
//     this module and expect STATE_ROOT to change - it won't. Per-test root
//     isolation is achieved by setting ISOMUX_HOME before the server is
//     imported (one root per test process), not by re-resolving at runtime.

import { homedir } from "os";
import { join, resolve } from "path";

// Resolve the isomux state root from an environment.
//   - ISOMUX_HOME (trimmed, non-empty) wins, normalized to an absolute path.
//   - Otherwise defaults to ~/.isomux.
export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ISOMUX_HOME?.trim();
  return override ? resolve(override) : join(homedir(), ".isomux");
}

// The active state root, resolved once at import. See seam discipline above.
export const STATE_ROOT = resolveStateRoot();

// True when the active root is the production default (~/.isomux). Lets callers
// preserve byte-for-byte production output - the user-facing `~/.isomux/...`
// literals in terminal cards and the generated codex wrapper - while still
// targeting the active root under an ISOMUX_HOME override.
export const IS_DEFAULT_STATE_ROOT = STATE_ROOT === join(homedir(), ".isomux");
