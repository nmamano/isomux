// Resolution for the bundled @openai/codex CLI launcher and Isomux's
// isolated CODEX_HOME.
//
// The Codex CLI ships as @openai/codex (a JS launcher) plus per-platform
// optional-dependency packages that contain the native binary and a bundled
// ripgrep. We spawn the launcher with `process.execPath` (Bun) rather than
// relying on `node` being on PATH; the launcher's PATH-munging keeps codex's
// internal ripgrep call working without us having to replicate that here.
//
// Isolation: codex subprocesses default to the isomux state root's codex-home
// (`CODEX_HOME=~/.isomux/codex-home/` in production; follows ISOMUX_HOME when
// overridden) when no caller env sets it. That keeps isomux's auth/sessions/plugins out
// of the user's interactive `~/.codex/` - version skew on shared per-user
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
import { join } from "path";
import { STATE_ROOT, IS_DEFAULT_STATE_ROOT } from "../../config.ts";

import { errMessage } from "../../../shared/errors.ts";

const ISOMUX_ROOT = join(import.meta.dir, "..", "..", "..");

export const ISOMUX_CODEX_HOME = join(STATE_ROOT, "codex-home");
const ISOMUX_BIN_DIR = join(STATE_ROOT, "bin");
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
  // Happy-path resolve is silent - users don't need a per-boot
  // confirmation that the bundled launcher resolved. Set
  // ISOMUX_CODEX_LAUNCHER_LOG=1 to emit the one-shot breadcrumb when
  // debugging whether a stray global codex is shadowing the bundled one.
  if (process.env.ISOMUX_CODEX_LAUNCHER_LOG === "1") {
    try {
      console.log(
        `[codex] using bundled launcher: ${resolved} (pinned ${getCodexPinnedVersion()})`,
      );
    } catch {}
  }
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
// through as-is - child_process.spawn skips them.
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
//   1. OPENAI_API_KEY in the agent's effective env - env-var auth bypasses
//      auth.json entirely. Caller passes the agent's resolved env
//      (process.env + office envFile + user envFile, in override order);
//      defaults to process.env if no env supplied.
//   2. auth.json exists in the agent's effective CODEX_HOME (envFile
//      override honored, otherwise the default ISOMUX_CODEX_HOME).
//
// This used to only consult process.env, which created a footgun: a user
// who put OPENAI_API_KEY in their managed environment (the supported way to set
// per-agent secrets - see Settings → You → Individual connections) would still get
// the full sign-in walkthrough on any auth-error, because the helper
// couldn't see their envFile-set key. Threading the merged env in closes
// that gap.
export function isCodexAuthenticated(env?: {
  [key: string]: string | undefined;
}): boolean {
  const effective = env ?? process.env;
  if (effective.OPENAI_API_KEY) return true;
  const codexHome = effective.CODEX_HOME ?? ISOMUX_CODEX_HOME;
  return existsSync(join(codexHome, "auth.json"));
}

// Idempotently materialize the `~/.isomux/bin/codex` wrapper script that
// fronts the bundled launcher with a friendlier path for the [Copy to
// terminal] card. Regenerates when content drifts (e.g. bun path or
// node_modules layout changed across a reinstall) so a stale wrapper from
// a previous install can't outlive the right paths.
export function ensureCodexWrapperScript(): void {
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
  // Default root: keep the byte-for-byte prod line ($HOME-relative, friendly).
  // Override root (ISOMUX_HOME): assign the absolute ISOMUX_CODEX_HOME via a
  // normal shell assignment. We can't reuse the "${CODEX_HOME:-word}" form for
  // an arbitrary absolute path: inside double quotes, a shell-quoted `word`
  // keeps its quotes literally, corrupting the path. An explicit CODEX_HOME in
  // the env still wins in both branches.
  const codexHomeDefaultBlock = IS_DEFAULT_STATE_ROOT
    ? `export CODEX_HOME="\${CODEX_HOME:-$HOME/.isomux/codex-home/}"`
    : `[ -n "\${CODEX_HOME}" ] || CODEX_HOME=${shellSingleQuote(ISOMUX_CODEX_HOME)}\nexport CODEX_HOME`;
  return `#!/bin/sh
# Auto-generated by isomux. Wraps the bundled @openai/codex CLI with the
# isolated CODEX_HOME so the [Copy to terminal] card command stays short.
# An external CODEX_HOME in the env (e.g. envFile billing isolation, see
# internal-docs/isolation-design.md) is honored verbatim.
${codexHomeDefaultBlock}
exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(launcher)} "$@"
`;
}

// Shell-pasteable `codex login` one-liners targeting the isolated CODEX_HOME.
// Routes through the `~/.isomux/bin/codex` wrapper so the cards stay short
// and readable rather than a wall of absolute paths.
//
// Per-user envFile users with a custom CODEX_HOME (e.g.
// `~/.isomux-users/marc/.codex`) need to prefix the wrapper call with their
// own `CODEX_HOME=<path>`; the wrapper's default only kicks in when
// CODEX_HOME is unset.
// The shell command for invoking the codex wrapper. Preserves the friendly
// `~/.isomux/bin/codex` for the default root (prod UX, byte-for-byte); under an
// ISOMUX_HOME override returns the shell-quoted absolute path to the wrapper
// that ensureCodexWrapperScript actually wrote, so terminal cards target the
// live file rather than a stale/absent `~/.isomux/bin/codex`.
export function codexWrapperCommandForShell(): string {
  return IS_DEFAULT_STATE_ROOT
    ? "~/.isomux/bin/codex"
    : shellSingleQuote(ISOMUX_CODEX_WRAPPER_PATH);
}

export function getCodexLoginCommands(): string[] {
  ensureCodexWrapperScript();
  const cmd = codexWrapperCommandForShell();
  return [`${cmd} login --device-auth`];
}

function shellSingleQuote(s: string): string {
  // POSIX single-quote escape: end-quote, escape literal quote, reopen.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
