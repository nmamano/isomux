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

// Refuses a bun test run on the live state root. bun loads bunfig.toml, and
// with it the test preload (server/test-support/preload.ts), only from the
// directory it runs in, so `bun test` from a subfolder would write test data
// into the office. No signal names a bun test run directly: bun test sets
// NODE_ENV=test unless it is set, and Bun.main is the test file. Not caught:
// an exported NODE_ENV and an explicit path without a test-file name. It also
// refuses a bun subprocess a test starts without env: bun gives that child the
// environment the test process started with, which has NODE_ENV=test but not
// the preload's ISOMUX_HOME.
function refuseUnisolatedTestRun(
  env: NodeJS.ProcessEnv,
  main: string | undefined,
): void {
  const underBunTest =
    env.NODE_ENV === "test" ||
    (main !== undefined && /[._](test|spec)\.[cm]?[jt]sx?$/.test(main));
  if (
    !underBunTest ||
    !IS_DEFAULT_STATE_ROOT ||
    env.ISOMUX_TEST_PRELOAD === "1"
  ) {
    return;
  }
  throw new Error(
    `Refusing to run tests against the live state root ${STATE_ROOT}. ` +
      "Run `bun test` from the repository root, and pass `env: process.env` to a bun subprocess a test starts.",
  );
}

refuseUnisolatedTestRun(
  process.env,
  typeof Bun !== "undefined" ? Bun.main : undefined,
);

// The admin socket (server/admin-socket.ts). ISOMUX_ADMIN_SOCKET moves it out
// of the state root, for example into a directory a recovery container shares
// (deploy/kubernetes). Defaults to <state root>/admin.sock.
export function resolveAdminSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  stateRoot: string = STATE_ROOT,
): string {
  const override = env.ISOMUX_ADMIN_SOCKET?.trim();
  return override ? resolve(override) : join(stateRoot, "admin.sock");
}

export const ADMIN_SOCKET_PATH = resolveAdminSocketPath();
