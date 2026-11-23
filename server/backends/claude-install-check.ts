// Synchronous check for whether the standalone Claude Code CLI is on PATH.
//
// The Claude Agent SDK ships its own native binary (see CLAUDE_NATIVE_BIN in
// server/cwd-utils.ts), so agent runtime does NOT require the user-facing
// `claude` CLI to be installed. The terminal sign-out prefers that CLI when
// it is on PATH and otherwise runs the bundled binary, so
// `isClaudeCodeInstalled()` only picks which command the logout card shows.
//
// Codex doesn't have an equivalent presence check: codex now ships bundled as
// an isomux runtime dep (see server/backends/codex/native-bin.ts), so its
// availability is guaranteed by a successful `bun install`.

import { accessSync, constants, existsSync } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";
import { CLAUDE_NATIVE_BIN } from "../cwd-utils.ts";
import { officeAgentHost } from "../agent-host.ts";
import { hostForEnv, isMemberEnv, refuseMemberEnv } from "../member-hosts.ts";
import {
  FAMILY_TO_MODEL,
  CLAUDE_CLOUD_MODEL_DEFAULTS,
  CLAUDE_BEDROCK_GEO_REGIONS,
  MODEL_FAMILIES,
  type ClaudeFamilyModels,
} from "../../shared/types.ts";

export function isClaudeCodeInstalled(env?: {
  [key: string]: string | undefined;
}): boolean {
  refuseMemberEnv(env, "isClaudeCodeInstalled");
  const effective = env ?? officeAgentHost().baseEnv();
  for (const dir of effective.PATH?.split(delimiter) ?? []) {
    if (!dir) continue;
    try {
      accessSync(join(dir, "claude"), constants.X_OK);
      return true;
    } catch {
      // Keep searching the effective PATH.
    }
  }
  return false;
}

// Cheap probe for "user has already completed claude-code login at some
// point". Used by the login-instructions path so an agent that hits an
// auth-error (or the user types /login on an already-authed agent) shows
// a "/clear to refresh" hint instead of repeating the install/login
// walkthrough at someone who's already done their part.
//
// Presence signals, not a credential validity check. Cloud selection counts
// even when its external credentials have expired, just like an API key.
// Any of these is enough:
//   1. ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_AUTH_TOKEN in
//      the agent's effective env - the SDK documents all three as auth that
//      bypasses the credentials file entirely. Caller passes the agent's
//      resolved env (process.env + office variables + managed personal variables, in
//      override order); defaults to process.env if no env supplied.
//   2. `<CLAUDE_CONFIG_DIR>/.credentials.json` exists, falling back to
//      `~/.claude/.credentials.json` when CLAUDE_CONFIG_DIR is blank.
//   3. Bedrock or Vertex selected in the effective environment.
//
// Symmetric with `isCodexAuthenticated` in codex/native-bin.ts. The CLI
// presence check (`isClaudeCodeInstalled`) is independent: the SDK can
// be fully working off the credentials file even when `claude` itself
// isn't on the systemd-user PATH.
export function isClaudeCodeAuthenticated(env?: {
  [key: string]: string | undefined;
}): boolean {
  refuseMemberEnv(env, "isClaudeCodeAuthenticated");
  const effective = env ?? officeAgentHost().baseEnv();
  if (claudeEnvSignedIn(effective)) return true;
  const configured = effective.CLAUDE_CONFIG_DIR;
  const configDir = configured?.trim()
    ? configured
    : join(homedir(), ".claude");
  return existsSync(join(configDir, ".credentials.json"));
}

function claudeEnvSignedIn(env: { [key: string]: string | undefined }) {
  return Boolean(
    isClaudeCloudSelected(env) ||
    env.ANTHROPIC_API_KEY ||
    env.CLAUDE_CODE_OAUTH_TOKEN ||
    env.ANTHROPIC_AUTH_TOKEN,
  );
}

// Either env: an isolated member's sign-in is in their own home or config
// folder, looked up by their host.
export async function isClaudeCodeAuthenticatedOnHost(env?: {
  [key: string]: string | undefined;
}): Promise<boolean> {
  if (!isMemberEnv(env)) return isClaudeCodeAuthenticated(env);
  if (claudeEnvSignedIn(env!)) return true;
  const host = hostForEnv(env);
  const configured = env!.CLAUDE_CONFIG_DIR;
  const configDir = configured?.trim()
    ? configured
    : join(host.home(), ".claude");
  return host.fs.exists(join(configDir, ".credentials.json"));
}

// Claude Code 2.1.257 (bundled SDK 0.3.257), checked 2026-09-10:
// its env boolean parser trims, lowercases, and accepts 1/true/yes/on.
export function isClaudeCloudSelected(env: {
  [key: string]: string | undefined;
}): boolean {
  return isClaudeCloudProvider(claudeProviderId(env));
}

// Bedrock and Vertex: the clouds that own authentication and access for a
// Claude session. Takes a claudeProviderId.
export function isClaudeCloudProvider(id: string | undefined): boolean {
  return id === "bedrock" || id === "vertex";
}

type CloudEnv = { [key: string]: string | undefined };

// Whether the CLI reads a cloud switch (CLAUDE_CODE_USE_*) as on.
export function cloudFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

// The provider a Claude session talks to, as a refusal line names it: the
// cloud the env selects ("bedrock", "vertex" or "foundry", the CLI's own
// flags), the host name of a non-Anthropic ANTHROPIC_BASE_URL (a proxy
// refuses in its own words), and "anthropic" otherwise.
export function claudeProviderId(env: CloudEnv): string {
  if (cloudFlag(env.CLAUDE_CODE_USE_BEDROCK)) return "bedrock";
  if (cloudFlag(env.CLAUDE_CODE_USE_VERTEX)) return "vertex";
  if (cloudFlag(env.CLAUDE_CODE_USE_FOUNDRY)) return "foundry";
  let host: string;
  try {
    host = new URL(env.ANTHROPIC_BASE_URL ?? "").hostname.toLowerCase();
  } catch {
    return "anthropic";
  }
  return host && host !== "anthropic.com" && !host.endsWith(".anthropic.com")
    ? host
    : "anthropic";
}

// Claude Code 2.1.293, checked 2026-10-10: o8 validates regions without trimming.
function awsRegion(value: string | undefined): string | undefined {
  return value && /^[a-z]{2,}(?:-[a-z0-9]+){0,4}$/i.test(value)
    ? value
    : undefined;
}

// Resolve only the final merged Claude environment. Unknown regions (including
// a region in ~/.aws/config) keep the CLI default; explicit pins always win.
export function withCloudModelDefaults(env: CloudEnv): CloudEnv {
  if (!isClaudeCloudSelected(env)) return env;
  const bedrock = cloudFlag(env.CLAUDE_CODE_USE_BEDROCK);
  // A prefix is an office routing choice, including global. Leave it to the CLI.
  if (bedrock && env.ANTHROPIC_BEDROCK_REGION_PREFIX?.trim()) return env;
  const result = { ...env };
  const geoFor = (region: string | undefined) =>
    Object.entries(CLAUDE_BEDROCK_GEO_REGIONS).find(([, regions]) =>
      (regions as readonly string[]).includes(region ?? ""),
    )?.[0];
  for (const [family, row] of Object.entries(CLAUDE_CLOUD_MODEL_DEFAULTS)) {
    const variable = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`;
    if (env[variable]?.trim()) continue;
    let model: string | undefined;
    if (bedrock) {
      const geo = geoFor(
        awsRegion(env.AWS_REGION) || awsRegion(env.AWS_DEFAULT_REGION),
      );
      // The same Haiku pin also serves background calls. A cross-geo helper
      // region cannot use the primary region's inference profile.
      const helperRegion = awsRegion(env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION);
      if (family === "haiku" && helperRegion && geoFor(helperRegion) !== geo)
        continue;
      model = geo ? (row.bedrock as Record<string, string>)[geo] : undefined;
    } else {
      const region = env[row.vertexRegionVariable] || env.CLOUD_ML_REGION;
      if ((row.vertexRegions as readonly string[]).includes(region ?? ""))
        model = row.vertex;
    }
    if (model) result[variable] = model;
  }
  return result;
}

export function limitedClaudeFamilies(env: CloudEnv): string[] {
  if (!isClaudeCloudSelected(env)) return [];
  const effective = withCloudModelDefaults(env);
  return Object.entries(CLAUDE_CLOUD_MODEL_DEFAULTS)
    .filter(
      ([family, row]) =>
        !(
          effective[
            `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`
          ]?.toLowerCase() ?? ""
        ).includes(row.effortModel),
    )
    .map(([family]) => family);
}

export function claudeFamilyModels(env: CloudEnv): ClaudeFamilyModels {
  const models: ClaudeFamilyModels = {};
  if (!isClaudeCloudSelected(env)) return models;
  const effective = withCloudModelDefaults(env);
  for (const { family } of MODEL_FAMILIES) {
    const fallback =
      family in CLAUDE_CLOUD_MODEL_DEFAULTS
        ? CLAUDE_CLOUD_MODEL_DEFAULTS[
            family as keyof typeof CLAUDE_CLOUD_MODEL_DEFAULTS
          ].cliDefault
        : undefined;
    const model =
      effective[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`]?.trim() ||
      fallback;
    if (model && model !== FAMILY_TO_MODEL[family]) models[family] = model;
  }
  return models;
}

export type ClaudeSignInState = "signed_in" | "signed_out" | "unknown";

type Env = { [key: string]: string | undefined };

export interface ClaudeSignInDeps {
  platform?: NodeJS.Platform;
  now?: () => number;
  runAuthStatus?: (env: Env) => Promise<ClaudeSignInState>;
}

// Claude Code 2.1.280 (bundled SDK 0.3.280), checked 2026-09-26: on macOS the
// login lives in the Keychain, and .credentials.json is only its fallback. So
// on macOS a missing file is settled by asking the bundled CLI (`claude auth
// status`). Linux keeps the file check alone. Claude Code 2.1.322, checked
// 2026-11-23: the CLI sends one request to api.anthropic.com, but does not
// wait for it, and it catches SIGTERM.
const AUTH_STATUS_TIMEOUT_MS = 10_000;
// Topic gating can ask on every message of a signed-out agent. One probe per
// effective environment is in flight at a time, and its answer is reused for
// this long after it settles, so a new sign-in shows within this window.
const AUTH_STATUS_REUSE_MS = 15_000;

interface AuthStatusProbe {
  result: Promise<ClaudeSignInState>;
  settledAt: number | null;
}

const authStatusProbes = new Map<string, AuthStatusProbe>();

// The whole effective env is the key, so two environments that share a config
// directory but differ in anything else never share an answer.
function authStatusKey(env: Env): string {
  return JSON.stringify(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

// `claude auth status` exits 0 with loggedIn true, or 1 with loggedIn false.
// Any other combination, and a process killed by a signal, is "unknown".
function authStatusFromCli(
  exit: { exitCode: number | null; signalCode: string | null },
  stdout: string,
): ClaudeSignInState {
  if (exit.signalCode !== null || exit.exitCode === null) return "unknown";
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch {
    return "unknown";
  }
  const loggedIn =
    status !== null && typeof status === "object"
      ? (status as { loggedIn?: unknown }).loggedIn
      : undefined;
  if (exit.exitCode === 0 && loggedIn === true) return "signed_in";
  if (exit.exitCode === 1 && loggedIn === false) return "signed_out";
  return "unknown";
}

// Settles by timeoutMs. At the deadline the CLI is killed with SIGKILL (it
// catches SIGTERM), and the output is not waited for: a child of the CLI can
// hold it open.
export async function runClaudeAuthStatus(
  env: Env,
  executable = CLAUDE_NATIVE_BIN,
  timeoutMs = AUTH_STATUS_TIMEOUT_MS,
): Promise<ClaudeSignInState> {
  const child = Bun.spawn([executable, "auth", "status"], {
    cwd: homedir(),
    env: Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  const finished = Promise.all([
    (async () => {
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        text += decoder.decode(value, { stream: true });
      }
    })(),
    child.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, null);
  });
  try {
    const done = await Promise.race([finished, deadline]);
    if (done === null) {
      child.kill("SIGKILL");
      reader.cancel().catch(() => {});
      return "unknown";
    }
    return authStatusFromCli(
      {
        exitCode: child.exitCode,
        signalCode: child.signalCode === null ? null : String(child.signalCode),
      },
      done[0],
    );
  } finally {
    clearTimeout(timer);
  }
}

// Never rejects: a probe that fails, times out or prints something unexpected
// is "unknown", which callers must not treat as signed out.
export function claudeSignInState(
  env?: Env,
  deps: ClaudeSignInDeps = {},
): Promise<ClaudeSignInState> {
  if (isMemberEnv(env))
    return isClaudeCodeAuthenticatedOnHost(env).then(
      (signedIn) => (signedIn ? "signed_in" : "signed_out"),
      () => "unknown" as const,
    );
  const effective = env ?? officeAgentHost().baseEnv();
  if (isClaudeCodeAuthenticated(effective)) return Promise.resolve("signed_in");
  if ((deps.platform ?? process.platform) !== "darwin")
    return Promise.resolve("signed_out");
  const now = deps.now ?? Date.now;
  for (const [key, probe] of authStatusProbes) {
    if (
      probe.settledAt !== null &&
      now() - probe.settledAt >= AUTH_STATUS_REUSE_MS
    )
      authStatusProbes.delete(key);
  }
  const key = authStatusKey(effective);
  const current = authStatusProbes.get(key);
  if (current) return current.result;
  const probe: AuthStatusProbe = {
    settledAt: null,
    result: Promise.resolve()
      .then(() => (deps.runAuthStatus ?? runClaudeAuthStatus)(effective))
      .catch((): ClaudeSignInState => "unknown")
      .then((state) => {
        probe.settledAt = now();
        return state;
      }),
  };
  authStatusProbes.set(key, probe);
  return probe.result;
}
