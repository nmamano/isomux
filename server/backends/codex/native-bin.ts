// Isomux's isolated CODEX_HOME, the codex wrapper script and the sign-in
// checks. The bundled launcher's path is in server/engine-binaries.ts.
//
// Isolation: codex subprocesses default to the isomux state root's codex-home
// (`CODEX_HOME=~/.isomux/codex-home/` in production; follows ISOMUX_HOME when
// overridden) when no caller env sets it. That keeps isomux's auth/sessions/plugins out
// of the user's interactive `~/.codex/` - version skew on shared per-user
// state is the failure mode this whole bundling effort is closing.
//
// Managed personal variables that set CODEX_HOME (e.g.
// `CODEX_HOME=~/.isomux-users/marc/.codex` for billing isolation per
// internal-docs/isolation-design.md) are honored verbatim and override the
// isomux default. The default only kicks in when no env source has set it.

import {
  hostForEnv,
  isMemberEnv,
  refuseMemberEnv,
} from "../../member-hosts.ts";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { AGENT_ROOT, AGENT_ROOT_IS_DEFAULT } from "../../split/roots.ts";

import { officeAgentHost } from "../../agent-host.ts";
import { stableBunPath } from "../../stable-bun-path.ts";
import { resolveCodexLauncherPath } from "../../engine-binaries.ts";

// Agent space: in split mode these stay at the old state root (design
// section 3.1.2), so the paths the wrapper and sessions hold do not change.
export const ISOMUX_CODEX_HOME = join(AGENT_ROOT, "codex-home");
const ISOMUX_BIN_DIR = join(AGENT_ROOT, "bin");
const ISOMUX_CODEX_WRAPPER_PATH = join(ISOMUX_BIN_DIR, "codex");

let ensuredIsomuxCodexHome = false;
let ensuredCodexWrapper = false;

// Codex emits a stderr warning on every spawn when CODEX_HOME points at a
// path that doesn't exist. Create the dir on first use to suppress the noise.
// mkdir is idempotent (recursive:true) and cheap. The cache flag is only set
// after a successful mkdir so a transient failure (permissions, full disk)
// gets retried on the next spawn and surfaces as a real backend error,
// rather than being swallowed and silently disabling Codex going forward.
// The flag skips the mkdir only while the dir exists, so a dir deleted
// after the first call is created again.
function ensureIsomuxCodexHomeExists(): void {
  if (ensuredIsomuxCodexHome && existsSync(ISOMUX_CODEX_HOME)) return;
  mkdirSync(ISOMUX_CODEX_HOME, { recursive: true, mode: 0o700 });
  ensuredIsomuxCodexHome = true;
}

// Build the codex spawn env: caller-provided baseEnv overlaid with an
// ISOMUX_CODEX_HOME default if and only if the merged env has no CODEX_HOME.
// Managed personal variables or process env entries that set CODEX_HOME (e.g. for
// per-user billing isolation) are honored verbatim. `undefined` values pass
// through as-is - child_process.spawn skips them.
export function withIsomuxCodexHome(
  baseEnv: { [key: string]: string | undefined } | undefined,
): { [key: string]: string | undefined } {
  const host = hostForEnv(baseEnv);
  const merged = { ...(baseEnv ?? host.baseEnv()) };
  if (!merged.CODEX_HOME) {
    // The runner host creates it as the agent user (client.ts start()).
    if (host.kind === "local") ensureIsomuxCodexHomeExists();
    merged.CODEX_HOME = ISOMUX_CODEX_HOME;
  }
  return merged;
}

// Cheap probe for "user has already completed codex login at some point".
// Used by the signed-out check before a turn, and by a typed /login, which
// then shows a "/clear to refresh" hint instead of repeating the full login
// walkthrough at a user who's already done their part.
//
// Two positive signals, either is enough:
//   1. OPENAI_API_KEY in the agent's effective env - without a stored
//      sign-in, the app-server client signs in with it over JSON-RPC
//      (codexEnvApiKeyWins). Caller passes the agent's resolved env
//      (process.env + office variables + managed personal variables, in override order);
//      defaults to process.env if no env supplied.
//   2. auth.json exists in the agent's effective CODEX_HOME (a managed
//      override is honored, otherwise the default ISOMUX_CODEX_HOME).
//
// This used to only consult process.env, which created a footgun: a user
// who put OPENAI_API_KEY in their managed environment (the supported way to set
// per-agent secrets - see the Integrations page) would still get
// the full sign-in walkthrough on any auth-error, because the helper
// couldn't see their managed key. Threading the merged env in closes
// that gap.
export function isCodexAuthenticated(env?: {
  [key: string]: string | undefined;
}): boolean {
  refuseMemberEnv(env, "isCodexAuthenticated");
  const effective = env ?? officeAgentHost().baseEnv();
  if (effective.OPENAI_API_KEY) return true;
  const codexHome = effective.CODEX_HOME || ISOMUX_CODEX_HOME;
  return existsSync(join(codexHome, "auth.json"));
}

// Either env: an isolated member's auth.json is looked up by their host.
export async function isCodexAuthenticatedOnHost(env?: {
  [key: string]: string | undefined;
}): Promise<boolean> {
  if (!isMemberEnv(env)) return isCodexAuthenticated(env);
  if (env!.OPENAI_API_KEY) return true;
  const codexHome = env!.CODEX_HOME || ISOMUX_CODEX_HOME;
  return hostForEnv(env).fs.exists(join(codexHome, "auth.json"));
}

// Whether a Codex app-server on `env` signs in with OPENAI_API_KEY: only
// when its CODEX_HOME holds no stored sign-in, so a subscription is never
// billed as API use (task 23c1992a). Any auth.json counts. The agent host
// checks, as in split mode the server cannot read agent space.
// After a rejection, it tells a wrong key from a dead stored sign-in.
export async function codexEnvApiKeyWins(env?: {
  [key: string]: string | undefined;
}): Promise<boolean> {
  const effective = env ?? officeAgentHost().baseEnv();
  if (!effective.OPENAI_API_KEY) return false;
  const codexHome = effective.CODEX_HOME || ISOMUX_CODEX_HOME;
  return !(await hostForEnv(env).fs.exists(join(codexHome, "auth.json")));
}

// Idempotently materialize the `~/.isomux/bin/codex` wrapper script that
// fronts the bundled launcher with a short path for a terminal sign-in or
// sign-out. Each Codex agent start calls it. Regenerates when content drifts (e.g. bun path or
// node_modules layout changed across a reinstall) so a stale wrapper from
// a previous install can't outlive the right paths. The flag skips the
// work only while the file exists, so a deleted wrapper is written again.
export function ensureCodexWrapperScript(): void {
  if (ensuredCodexWrapper && existsSync(ISOMUX_CODEX_WRAPPER_PATH)) return;
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
  const codexHomeDefaultBlock = AGENT_ROOT_IS_DEFAULT
    ? `export CODEX_HOME="\${CODEX_HOME:-$HOME/.isomux/codex-home/}"`
    : `[ -n "\${CODEX_HOME}" ] || CODEX_HOME=${shellSingleQuote(ISOMUX_CODEX_HOME)}\nexport CODEX_HOME`;
  return `#!/bin/sh
# Auto-generated by isomux. Wraps the bundled @openai/codex CLI with the
# isolated CODEX_HOME so the [Copy to terminal] card command stays short.
# An external CODEX_HOME in the env (e.g. managed personal variables for billing isolation, see
# internal-docs/isolation-design.md) is honored verbatim.
${codexHomeDefaultBlock}
exec ${shellSingleQuote(stableBunPath())} ${shellSingleQuote(launcher)} "$@"
`;
}

// Members with a custom CODEX_HOME (e.g.
// `~/.isomux-users/marc/.codex`) need to prefix the wrapper call with their
// own `CODEX_HOME=<path>`; the wrapper's default only kicks in when
// CODEX_HOME is unset.
// The shell command for invoking the codex wrapper. Preserves the friendly
// `~/.isomux/bin/codex` for the default root (prod UX, byte-for-byte); under an
// ISOMUX_HOME override returns the shell-quoted absolute path to the wrapper
// that ensureCodexWrapperScript actually wrote, so terminal cards target the
// live file rather than a stale/absent `~/.isomux/bin/codex`.
export function codexWrapperCommandForShell(): string {
  return AGENT_ROOT_IS_DEFAULT
    ? "~/.isomux/bin/codex"
    : shellSingleQuote(ISOMUX_CODEX_WRAPPER_PATH);
}

function shellSingleQuote(s: string): string {
  // POSIX single-quote escape: end-quote, escape literal quote, reopen.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
