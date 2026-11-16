// The environment of the scratch office the conformance run boots. The run
// starts from an agent shell, whose variables point at the live office (its
// token, its state root, the member's provider homes), so the server gets
// only an allowlist of the parent's variables. The provider homes reach the
// office as office-wide variables, the way a self-hoster sets them on the
// Integrations page.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

// The parent variables a child of the run keeps: who and where the OS user
// is, and the locale. Everything else in an agent shell points at the live
// office.
const ALLOWED = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TZ",
];

function allowlisted(
  processEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(processEnv)) {
    if (value === undefined) continue;
    if (ALLOWED.includes(name) || name.startsWith("LC_")) env[name] = value;
  }
  return env;
}

// The real path of `path`, or of its nearest existing parent with the rest
// appended, so a run dir that does not exist yet still resolves its links.
function realpathOf(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = resolve(absolute, "..");
    if (parent === absolute) return absolute;
    return join(realpathOf(parent), absolute.slice(parent.length + 1));
  }
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
  );
}

// Claude refreshes its sign-in only in the last 5 minutes before expiry.
const CLAUDE_REFRESH_WINDOW_MS = 5 * 60_000;

// The scratch server's process environment: the allowlisted parent variables,
// plus PORT and the state, backup and temp folders inside runDir. The temp
// folder takes what the office writes under TMPDIR (OpenCode's server
// folder included), so it goes with the run dir. Throws when
// runDir resolves (realpath) to the live state root or into it.
export function buildServerEnv(
  processEnv: Record<string, string | undefined>,
  runDir: string,
  port: number,
  liveStateRoot: string = join(homedir(), ".isomux"),
): Record<string, string> {
  const run = realpathOf(runDir);
  if (isWithin(run, realpathOf(liveStateRoot)))
    throw new Error(
      `the run dir ${runDir} is inside the live office state ${liveStateRoot}`,
    );
  return {
    ...allowlisted(processEnv),
    PORT: String(port),
    ISOMUX_HOME: join(run, "state"),
    ISOMUX_BACKUP_DIR: join(run, "backups"),
    TMPDIR: join(run, "tmp"),
  };
}

// The office-wide variables the run writes through the office: the provider
// homes inside runDir (CLAUDE_CONFIG_DIR, CODEX_HOME), so nothing an agent
// writes reaches the live homes.
export function officeVariables(runDir: string): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: join(runDir, "claude"),
    CODEX_HOME: join(runDir, "codex"),
  };
}

export type ClaudeLogin =
  // The credentials file to write into the scratch office's Claude home:
  // claudeAiOauth only, without its refresh token.
  | { kind: "copy"; text: string }
  // The office sign-in expires within the margin: wait waitMs, then refresh
  // it in place with one call on the office's Claude root.
  | { kind: "refresh"; waitMs: number }
  // The office has no Claude sign-in: the Claude column is skipped.
  | { kind: "skip"; reason: string }
  // The credentials file is not in the format Claude writes: the Claude
  // column is red.
  | { kind: "invalid"; reason: string };

// What the run does with the office's Claude sign-in (the text of
// <claude root>/.credentials.json, null when there is no file). No reason
// carries a token value or the account email.
export function claudeLogin(
  credentialsText: string | null,
  now: number,
  marginMs: number,
): ClaudeLogin {
  if (credentialsText === null)
    return { kind: "skip", reason: "the office has no Claude sign-in" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(credentialsText);
  } catch {
    return {
      kind: "invalid",
      reason: "the Claude credentials file is not JSON",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return {
      kind: "invalid",
      reason: "the Claude credentials file is not a JSON object",
    };
  if (!("claudeAiOauth" in parsed))
    return {
      kind: "skip",
      reason: "the office is not signed in to a Claude subscription",
    };
  const oauth = (parsed as { claudeAiOauth: unknown }).claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth))
    return {
      kind: "invalid",
      reason: "claudeAiOauth in the Claude credentials file is not an object",
    };
  const {
    refreshToken: _refreshToken,
    refreshTokenExpiresAt: _refreshTokenExpiresAt,
    ...kept
  } = oauth as Record<string, unknown>;
  if (typeof kept.accessToken !== "string")
    return {
      kind: "invalid",
      reason: "the Claude sign-in has no access token string",
    };
  const expiresAt = kept.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
    return {
      kind: "invalid",
      reason: "the Claude sign-in has no numeric expiresAt",
    };
  if (expiresAt - now >= marginMs)
    return { kind: "copy", text: JSON.stringify({ claudeAiOauth: kept }) };
  return {
    kind: "refresh",
    waitMs: Math.max(0, expiresAt - CLAUDE_REFRESH_WINDOW_MS - now),
  };
}

// The environment of the one call that refreshes the office's Claude sign-in
// in place: the allowlisted parent variables, with CLAUDE_CONFIG_DIR set only
// when the run was given a Claude root.
export function claudeRefreshEnv(
  processEnv: Record<string, string | undefined>,
  claudeRoot: string | null,
): Record<string, string> {
  const env = allowlisted(processEnv);
  if (claudeRoot !== null) env.CLAUDE_CONFIG_DIR = claudeRoot;
  return env;
}

// Codex refreshes a ChatGPT sign-in when its access token expires within 5
// minutes (codex-rs 0.166 login/src/auth/manager.rs, proactive_refresh_reason).
export const CODEX_REFRESH_WINDOW_MS = 5 * 60_000;

export type CodexLogin =
  // The auth.json to write into the scratch office's Codex home: the office
  // sign-in with an empty refresh token and last_refresh set to now.
  | { kind: "copy"; text: string }
  // The access token expires within marginMs plus CODEX_REFRESH_WINDOW_MS:
  // refresh the office sign-in in place, then read it again.
  | { kind: "refresh" }
  // No sign-in, an API key, or no paid ChatGPT plan: the Codex column is
  // skipped.
  | { kind: "skip"; reason: string }
  // auth.json is not in the format Codex writes: the Codex column is red.
  | { kind: "invalid"; reason: string };

// What the run does with the office's Codex sign-in (the text of
// <codex root>/auth.json, null when there is no file). No reason carries a
// token value, the email or the account id.
export function codexLogin(
  authText: string | null,
  now: number,
  marginMs: number,
): CodexLogin {
  if (authText === null)
    return { kind: "skip", reason: "the office has no Codex sign-in" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(authText);
  } catch {
    return { kind: "invalid", reason: "the Codex auth.json is not JSON" };
  }
  if (!isObject(parsed))
    return {
      kind: "invalid",
      reason: "the Codex auth.json is not a JSON object",
    };
  const auth = parsed;
  if (auth.tokens === undefined || auth.tokens === null) {
    if (
      (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) ||
      auth.auth_mode === "apikey"
    )
      return {
        kind: "skip",
        reason: "the office Codex sign-in is an API key, not a ChatGPT plan",
      };
    return {
      kind: "invalid",
      reason: "the Codex auth.json has neither tokens nor an API key",
    };
  }
  if (!isObject(auth.tokens))
    return {
      kind: "invalid",
      reason: "tokens in the Codex auth.json is not an object",
    };
  const tokens = auth.tokens;
  const access = jwtPayload(tokens.access_token);
  if (!access)
    return {
      kind: "invalid",
      reason: "the Codex sign-in has no readable access token",
    };
  const id = jwtPayload(tokens.id_token);
  if (!id)
    return {
      kind: "invalid",
      reason: "the Codex sign-in has no readable id token",
    };
  const exp = access.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp))
    return {
      kind: "invalid",
      reason: "the Codex access token has no numeric exp",
    };
  if (exp * 1000 - now < marginMs + CODEX_REFRESH_WINDOW_MS)
    return { kind: "refresh" };
  const claim = id["https://api.openai.com/auth"];
  const plan = isObject(claim) ? claim.chatgpt_plan_type : undefined;
  if (typeof plan !== "string" || !plan)
    return {
      kind: "skip",
      reason: "the office Codex sign-in has no ChatGPT plan",
    };
  if (plan === "free")
    return {
      kind: "skip",
      reason: "the office Codex sign-in is on the free plan",
    };
  return {
    kind: "copy",
    text: JSON.stringify({
      ...auth,
      last_refresh: new Date(now).toISOString(),
      tokens: { ...tokens, refresh_token: "" },
    }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// The payload of a JWT, or null when the value is not one.
function jwtPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    );
    return isObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

// What the account/rateLimits/read answer of the scratch Codex says about the
// column: a skip (free plan, usage limit reached), a fail (the answer has no
// rateLimits object), or null when the column runs. A null planType or
// ordinaryUsageAllowed is no skip: the token claim in codexLogin stays the
// check.
export function codexPlanSkip(
  limits: unknown,
): { kind: "skip" | "fail"; reason: string } | null {
  if (!isObject(limits) || !isObject(limits.rateLimits))
    return {
      kind: "fail",
      reason: "Codex answered the usage read without rate limits",
    };
  if (limits.rateLimits.planType === "free")
    return {
      kind: "skip",
      reason: "the office Codex sign-in is on the free plan",
    };
  if (limits.ordinaryUsageAllowed === false)
    return {
      kind: "skip",
      reason: "the office Codex sign-in has reached its usage limit",
    };
  return null;
}

// The environment of a Codex app-server the run starts outside the scratch
// office (the refresh on the office's Codex home, the plan read on the
// scratch copy): the allowlisted parent variables and CODEX_HOME.
export function codexEnv(
  processEnv: Record<string, string | undefined>,
  codexHome: string,
): Record<string, string> {
  return { ...allowlisted(processEnv), CODEX_HOME: codexHome };
}
