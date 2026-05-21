// Resolution for the bundled @openai/codex CLI launcher and Isomux's
// isolated CODEX_HOME.
//
// The Codex CLI ships as @openai/codex (a JS launcher) plus per-platform
// optional-dependency packages that contain the native binary and a bundled
// ripgrep. We spawn the launcher with `process.execPath` (Bun) rather than
// relying on `node` being on PATH; the launcher's PATH-munging keeps codex's
// internal ripgrep call working without us having to replicate that here.
//
// Isolation: codex subprocesses default to `CODEX_HOME=~/.isomux/codex-home/`
// when no caller env sets it. That keeps isomux's auth/sessions/plugins out
// of the user's interactive `~/.codex/` — version skew on shared per-user
// state is the failure mode this whole bundling effort is closing.
//
// Per-user envFile entries that set CODEX_HOME (e.g.
// `CODEX_HOME=~/.isomux-users/marc/.codex` for billing isolation per
// internal-docs/isolation-design.md) are honored verbatim and override the
// isomux default. The default only kicks in when no env source has set it.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

import { errMessage } from "../../../shared/errors.ts";

const ISOMUX_ROOT = join(import.meta.dir, "..", "..", "..");

export const ISOMUX_CODEX_HOME = join(homedir(), ".isomux", "codex-home");
const ISOMUX_BIN_DIR = join(homedir(), ".isomux", "bin");
const ISOMUX_CODEX_WRAPPER_PATH = join(ISOMUX_BIN_DIR, "codex");

let cachedLauncherPath: string | null = null;
let cachedPinnedVersion: string | null = null;
let ensuredIsomuxCodexHome = false;
let ensuredCodexWrapper = false;

// Codex emits a stderr warning on every spawn when CODEX_HOME points at a
// path that doesn't exist. Create the dir on first use to suppress the noise.
// mkdir is idempotent (recursive:true) and cheap. The cache flag is only set
// after a successful mkdir so a transient failure (permissions, full disk)
// gets retried on the next spawn and surfaces as a real backend error,
// rather than being swallowed and silently disabling Codex going forward.
function ensureIsomuxCodexHomeExists(): void {
  if (ensuredIsomuxCodexHome) return;
  mkdirSync(ISOMUX_CODEX_HOME, { recursive: true, mode: 0o700 });
  ensuredIsomuxCodexHome = true;
}

// Resolve the bundled @openai/codex launcher path. Lazy + cached: module-load
// resolution would crash server boot on a corrupt install, which is the wrong
// failure mode for an optional backend. On miss we throw a targeted error
// the spawn / login-card paths can translate into a user-actionable hint.
export function resolveCodexLauncherPath(): string {
  if (cachedLauncherPath) return cachedLauncherPath;
  let resolved: string;
  try {
    resolved = Bun.resolveSync("@openai/codex/bin/codex.js", ISOMUX_ROOT);
  } catch (err) {
    throw new Error(
      `Bundled @openai/codex launcher could not be resolved (${errMessage(err)}). ` +
        `Run \`bun install\` in the isomux checkout.`,
      { cause: err },
    );
  }
  if (!existsSync(resolved)) {
    throw new Error(
      `Bundled @openai/codex launcher missing at ${resolved}. ` +
        `Run \`bun install\` in the isomux checkout.`,
    );
  }
  cachedLauncherPath = resolved;
  // One-shot breadcrumb to make it easy to confirm from logs that the
  // bundled launcher is being used (rather than a stray global codex). Fires
  // once per server process — subsequent calls hit the cache and don't log.
  try {
    console.log(
      `[codex] using bundled launcher: ${resolved} (pinned ${getCodexPinnedVersion()})`,
    );
  } catch {}
  return resolved;
}

// Pinned codex CLI version, derived from package.json so version-bumps stay
// single-edit (the failure mode this whole task is about eliminating). Cached
// because the package.json doesn't change at runtime.
export function getCodexPinnedVersion(): string {
  if (cachedPinnedVersion) return cachedPinnedVersion;
  const pkgPath = join(ISOMUX_ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const spec = pkg.dependencies?.["@openai/codex"];
  if (!spec) {
    throw new Error(
      "Could not find @openai/codex in package.json dependencies",
    );
  }
  // Strip leading ^/~/= so callers get a bare semver. `bun add` writes
  // an exact pin by default (no ^), but tolerate both forms.
  cachedPinnedVersion = spec.replace(/^[\^~=]/, "");
  return cachedPinnedVersion;
}

// Build the codex spawn env: caller-provided baseEnv overlaid with an
// ISOMUX_CODEX_HOME default if and only if the merged env has no CODEX_HOME.
// Per-user envFile or process env entries that set CODEX_HOME (e.g. for
// per-user billing isolation) are honored verbatim. `undefined` values pass
// through as-is — child_process.spawn skips them.
export function withIsomuxCodexHome(
  baseEnv: { [key: string]: string | undefined } | undefined,
): { [key: string]: string | undefined } {
  const merged = { ...(baseEnv ?? process.env) };
  if (!merged.CODEX_HOME) {
    ensureIsomuxCodexHomeExists();
    merged.CODEX_HOME = ISOMUX_CODEX_HOME;
  }
  return merged;
}

// Cheap probe for "user has already completed codex login at some point".
// Used by the login-instructions path so an agent that hit an auth-error
// before the user logged in (and is still in a dead session afterwards)
// shows a "/clear to refresh" hint instead of repeating the full login
// walkthrough at a user who's already done their part.
//
// Two positive signals, either is enough:
//   1. OPENAI_API_KEY in process.env — env-var auth bypasses auth.json entirely.
//   2. auth.json exists in the default ISOMUX_CODEX_HOME.
//
// Doesn't honor per-user envFile CODEX_HOME overrides (billing isolation):
// those users would see the full walkthrough even after logging in to their
// custom dir. Tolerable — the walkthrough still works for them, and the
// rare-case wrong-message is the cost we pay for not threading per-agent
// env all the way through the login-instructions path.
export function isCodexAuthenticated(): boolean {
  if (process.env.OPENAI_API_KEY) return true;
  return existsSync(join(ISOMUX_CODEX_HOME, "auth.json"));
}

// Idempotently materialize the `~/.isomux/bin/codex` wrapper script that
// fronts the bundled launcher with a friendlier path for the [Copy to
// terminal] card. Regenerates when content drifts (e.g. bun path or
// node_modules layout changed across a reinstall) so a stale wrapper from
// a previous install can't outlive the right paths.
function ensureCodexWrapperScript(): void {
  if (ensuredCodexWrapper) return;
  const expected = buildCodexWrapperScript();
  mkdirSync(ISOMUX_BIN_DIR, { recursive: true, mode: 0o700 });
  let existing: string | null = null;
  try {
    existing = readFileSync(ISOMUX_CODEX_WRAPPER_PATH, "utf8");
  } catch {}
  if (existing !== expected) {
    writeFileSync(ISOMUX_CODEX_WRAPPER_PATH, expected, { mode: 0o700 });
  }
  // Reassert the executable bit unconditionally: writeFileSync's `mode`
  // option only applies on file creation, so a content-unchanged path
  // would skip both write and chmod and inherit any drifted mode (e.g.
  // a user manually chmod-stripped it). Cheap to re-apply.
  chmodSync(ISOMUX_CODEX_WRAPPER_PATH, 0o700);
  ensuredCodexWrapper = true;
}

function buildCodexWrapperScript(): string {
  const launcher = resolveCodexLauncherPath();
  return `#!/bin/sh
# Auto-generated by isomux. Wraps the bundled @openai/codex CLI with the
# isolated CODEX_HOME so the [Copy to terminal] card command stays short.
# An external CODEX_HOME in the env (e.g. envFile billing isolation, see
# internal-docs/isolation-design.md) is honored verbatim.
export CODEX_HOME="\${CODEX_HOME:-$HOME/.isomux/codex-home/}"
exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(launcher)} "$@"
`;
}

// Shell-pasteable `codex login` one-liners targeting the isolated CODEX_HOME.
// Routes through the `~/.isomux/bin/codex` wrapper so the cards stay short
// and readable rather than a wall of absolute paths.
//
// Returns two commands:
//   1. Browser OAuth flow — codex spawns a local server on :1455 and opens
//      the user's browser. Works when a browser on the isomux host can reach
//      that port (i.e. local install, or an SSH tunnel).
//   2. Device-auth flow — codex prints a code + URL to enter on any device.
//      The right call for remote / headless servers (the common self-hoster
//      shape over Tailscale, where the redirect to `localhost:1455` on the
//      browser machine has nowhere to land).
//
// Per-user envFile users with a custom CODEX_HOME (e.g.
// `~/.isomux-users/marc/.codex`) need to prefix the wrapper call with their
// own `CODEX_HOME=<path>`; the wrapper's default only kicks in when
// CODEX_HOME is unset.
export function getCodexLoginCommands(): string[] {
  ensureCodexWrapperScript();
  return [
    "~/.isomux/bin/codex login",
    "~/.isomux/bin/codex login --device-auth",
  ];
}

function shellSingleQuote(s: string): string {
  // POSIX single-quote escape: end-quote, escape literal quote, reopen.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
