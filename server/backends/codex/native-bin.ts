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

import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { errMessage } from "../../../shared/errors.ts";

const ISOMUX_ROOT = join(import.meta.dir, "..", "..", "..");

export const ISOMUX_CODEX_HOME = join(homedir(), ".isomux", "codex-home");

let cachedLauncherPath: string | null = null;
let cachedPinnedVersion: string | null = null;
let ensuredIsomuxCodexHome = false;

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

// Shell-pasteable `codex login` one-liner targeting the isolated CODEX_HOME.
//
// Runs the launcher via process.execPath (the same Bun used to spawn codex
// at runtime). We deliberately do NOT rely on the launcher's `#!/usr/bin/env
// node` shebang — bun-only installs without `node` on PATH would fail the
// card. Both runtime spawn and the login card resolve to the same execpath
// + launcher pair. Single-quotes escape any embedded quotes in either path.
// $HOME is left unquoted so the user's shell expands it.
//
// Per-user envFile users with a custom CODEX_HOME (e.g.
// `~/.isomux-users/marc/.codex`) need to substitute their own path here; the
// card emits the universal isomux default. Auth dir mismatch is recoverable
// — they can rerun the login with the right CODEX_HOME.
export function getCodexLoginCommand(): string {
  const launcher = resolveCodexLauncherPath();
  return `CODEX_HOME="$HOME/.isomux/codex-home/" ${shellSingleQuote(process.execPath)} ${shellSingleQuote(launcher)} login`;
}

function shellSingleQuote(s: string): string {
  // POSIX single-quote escape: end-quote, escape literal quote, reopen.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
