import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildServerEnv,
  claudeLogin,
  claudeRefreshEnv,
  CODEX_REFRESH_WINDOW_MS,
  codexEnv,
  codexLogin,
  codexPlanSkip,
  officeVariables,
} from "./env.ts";

const scratch = mkdtempSync(join(tmpdir(), "conformance-env-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const live = join(scratch, "live");

// The run starts from an agent shell: its token, its office's state and
// backup folders, its member's provider homes and logins, its git
// credential config and telemetry switch all point at the live office.
const agentShell: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/user",
  USER: "user",
  LOGNAME: "user",
  SHELL: "/bin/bash",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm",
  TZ: "Europe/Madrid",
  PORT: "4000",
  ISOMUX_AGENT_TOKEN: "live-agent-token",
  ISOMUX_HOME: live,
  ISOMUX_BACKUP_DIR: join(live, "backups"),
  ISOMUX_TURN: "live-turn",
  CLAUDE_CONFIG_DIR: join(live, "provider-homes", "m1", "claude"),
  CODEX_HOME: join(live, "provider-homes", "m1", "codex"),
  OPENCODE_CONFIG: join(live, "opencode.json"),
  CLAUDE_CODE_OAUTH_TOKEN: "live-oauth",
  OPENAI_API_KEY: "live-openai",
  ANTHROPIC_API_KEY: "live-anthropic",
  DISABLE_TELEMETRY: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
  XDG_CONFIG_HOME: join(live, "xdg"),
};

// The parent variables every child of the run may see.
const ALLOWED = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/user",
  USER: "user",
  LOGNAME: "user",
  SHELL: "/bin/bash",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm",
  TZ: "Europe/Madrid",
};

describe("buildServerEnv", () => {
  mkdirSync(join(live, "sub"), { recursive: true });
  const runDir = join(scratch, "live2");
  mkdirSync(runDir);

  // One whole-object comparison: any parent variable outside the allowlist
  // that reaches the scratch server fails it, including ones not named here.
  it("passes only the allowlisted parent variables, plus the run's port and folders", () => {
    const env = buildServerEnv(
      { ...agentShell, TMPDIR: join(scratch, "agent-tmp") },
      runDir,
      4123,
      live,
    );
    const { ISOMUX_HOME, ISOMUX_BACKUP_DIR, TMPDIR, ...rest } = env;
    expect(rest).toEqual({ ...ALLOWED, PORT: "4123" });
    expect(ISOMUX_HOME.startsWith(`${runDir}/`)).toBe(true);
    expect(ISOMUX_BACKUP_DIR.startsWith(`${runDir}/`)).toBe(true);
    expect(ISOMUX_BACKUP_DIR).not.toBe(ISOMUX_HOME);
    // Every temp folder of the scratch office (OpenCode's server folder
    // included) goes with the run dir, never the agent shell's.
    expect(TMPDIR?.startsWith(`${runDir}/`), String(TMPDIR)).toBe(true);
    expect([ISOMUX_HOME, ISOMUX_BACKUP_DIR]).not.toContain(TMPDIR);
  });

  // Each refusal case first shows that a run dir beside the live root (whose
  // name the live root's path is a prefix of) is accepted, so the throw is
  // about where the run dir resolves.
  it("refuses a run dir that is the live state root or inside it", () => {
    buildServerEnv(agentShell, runDir, 4123, live);
    expect(() => buildServerEnv(agentShell, live, 4123, live)).toThrow();
    expect(() =>
      buildServerEnv(agentShell, join(live, "sub"), 4123, live),
    ).toThrow();
  });

  it("refuses a run dir that resolves into the live root through a link", () => {
    const viaLink = join(scratch, "link-into-live");
    symlinkSync(join(live, "sub"), viaLink);
    buildServerEnv(agentShell, runDir, 4123, live);
    expect(() => buildServerEnv(agentShell, viaLink, 4123, live)).toThrow();
  });

  // A box whose ~/.isomux is a link to another disk.
  it("refuses a run dir inside the live root when the live root is a link", () => {
    const liveLink = join(scratch, "live-link");
    symlinkSync(live, liveLink);
    buildServerEnv(agentShell, runDir, 4123, liveLink);
    expect(() =>
      buildServerEnv(agentShell, join(live, "sub"), 4123, liveLink),
    ).toThrow();
  });
});

describe("officeVariables", () => {
  // Set even when Codex is skipped, so nothing an agent writes reaches the
  // live provider homes.
  it("puts both provider homes in the run dir", () => {
    const runDir = "/tmp/isomux-conformance-x";
    expect(officeVariables(runDir)).toEqual({
      CLAUDE_CONFIG_DIR: join(runDir, "claude"),
      CODEX_HOME: join(runDir, "codex"),
    });
  });
});

describe("claudeLogin", () => {
  const NOW = 1_800_000_000_000;
  const MARGIN = 45 * 60_000;
  const ACCESS = "sk-ant-oat01-access-SECRET1";
  const REFRESH = "sk-ant-ort01-refresh-SECRET2";
  const MCP_REFRESH = "mcp-refresh-SECRET3";
  const SECRETS = [ACCESS, REFRESH, MCP_REFRESH, "SECRET"];

  // The shape Claude writes, plus a field this runner does not know: the
  // copy keeps what Claude may need and drops only the refresh fields.
  const oauth = (expiresAt: unknown, extra: Record<string, unknown> = {}) => ({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt,
    refreshTokenExpiresAt: NOW + 30 * 86_400_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    futureField: { kept: true },
    ...extra,
  });
  const file = (claudeAiOauth: unknown) =>
    JSON.stringify({
      claudeAiOauth,
      mcpOAuth: {
        "some-server|abc": {
          accessToken: "mcp-access",
          refreshToken: MCP_REFRESH,
        },
      },
    });

  // The copy cannot refresh, so it cannot rotate the office's refresh token,
  // and it carries no other service's tokens.
  it("copies the Claude sign-in alone, without its refresh token", () => {
    const login = claudeLogin(file(oauth(NOW + 8 * 3_600_000)), NOW, MARGIN);
    expect(login.kind).toBe("copy");
    const { text } = login as { kind: "copy"; text: string };
    expect(JSON.parse(text)).toEqual({
      claudeAiOauth: {
        accessToken: ACCESS,
        expiresAt: NOW + 8 * 3_600_000,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        futureField: { kept: true },
      },
    });
  });

  // The token must outlive the Claude column's budget. Claude refreshes only
  // in its last 5 minutes, so the run waits until then and refreshes once.
  it("copies at exactly the margin and refreshes one millisecond below it", () => {
    expect(claudeLogin(file(oauth(NOW + MARGIN)), NOW, MARGIN).kind).toBe(
      "copy",
    );
    expect(claudeLogin(file(oauth(NOW + MARGIN - 1)), NOW, MARGIN)).toEqual({
      kind: "refresh",
      waitMs: MARGIN - 1 - 5 * 60_000,
    });
  });

  it("refreshes at once when the token is in its last 5 minutes or expired", () => {
    for (const expiresAt of [NOW + 2 * 60_000, NOW - 3_600_000]) {
      expect(claudeLogin(file(oauth(expiresAt)), NOW, MARGIN)).toEqual({
        kind: "refresh",
        waitMs: 0,
      });
    }
  });

  // No file, or an office signed in another way: Claude is skipped, not red.
  it("skips when there is no file or no Claude sign-in in it", () => {
    expect(claudeLogin(null, NOW, MARGIN).kind).toBe("skip");
    const login = claudeLogin(
      JSON.stringify({
        mcpOAuth: { "s|1": { accessToken: ACCESS, refreshToken: MCP_REFRESH } },
      }),
      NOW,
      MARGIN,
    );
    expect(login.kind).toBe("skip");
    const { reason } = login as { kind: "skip"; reason: string };
    for (const secret of SECRETS) expect(reason).not.toContain(secret);
  });

  // Claude writes this file, so a shape the runner cannot read is format
  // drift: a skip would hide Claude from the nightly with exit 0. A string
  // expiresAt would also make every margin compare false and copy a token
  // whose expiry nobody checked. The reason reaches the nightly output.
  it("is red, with no token in the reason, on a file it cannot read", () => {
    const cases: [string, string][] = [
      [
        "unparsable",
        `{"claudeAiOauth":{"accessToken":"${ACCESS}","refreshToken":"${REFRESH}"`,
      ],
      ["sign-in not an object", JSON.stringify({ claudeAiOauth: ACCESS })],
      [
        "no access token",
        file({ ...oauth(NOW + 8 * 3_600_000), accessToken: undefined }),
      ],
      [
        "access token not a string",
        file(oauth(NOW + 8 * 3_600_000, { accessToken: 42 })),
      ],
      ["no expiry", file({ ...oauth(NOW), expiresAt: undefined })],
      ["expiry not a number", file(oauth(String(NOW + 8 * 3_600_000)))],
    ];
    for (const [name, text] of cases) {
      const login = claudeLogin(text, NOW, MARGIN);
      expect({ name, kind: login.kind }).toEqual({ name, kind: "invalid" });
      const { reason } = login as { kind: "invalid"; reason: string };
      for (const secret of SECRETS) {
        expect({ name, leaked: reason.includes(secret) }).toEqual({
          name,
          leaked: false,
        });
      }
    }
  });
});

describe("claudeRefreshEnv", () => {
  // The refresh writes the office's login. From an agent shell, a parent
  // CLAUDE_CONFIG_DIR is a member's personal home: refreshing it would leave
  // the office login to expire.
  it("passes only the allowlisted parent variables when no Claude root is given", () => {
    expect(claudeRefreshEnv(agentShell, null)).toEqual(ALLOWED);
  });

  it("points Claude at the given root", () => {
    expect(claudeRefreshEnv(agentShell, "/srv/office-claude")).toEqual({
      ...ALLOWED,
      CLAUDE_CONFIG_DIR: "/srv/office-claude",
    });
  });
});

describe("codexLogin", () => {
  const NOW = 1_800_000_000_000;
  const MARGIN = 45 * 60_000;
  const ACCOUNT = "acct-SECRET-account-id";
  const EMAIL = "secret-member@example.com";
  const REFRESH = "rt-SECRET-refresh-token";
  const API_KEY = "sk-proj-SECRET-api-key";

  // A JWT as the token authority issues it; only the payload matters here.
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (payload: unknown) =>
    `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.c2lnbmF0dXJl`;
  const authClaim = (plan?: string) => ({
    ...(plan === undefined ? {} : { chatgpt_plan_type: plan }),
    chatgpt_account_id: ACCOUNT,
  });
  const idToken = (plan?: string) =>
    jwt({
      email: EMAIL,
      exp: NOW / 1000 + 3_600,
      "https://api.openai.com/auth": authClaim(plan),
    });
  // The access token's exp, in seconds, as the authority writes it.
  const accessToken = (expMs: number) =>
    jwt({ exp: expMs / 1000, "https://api.openai.com/auth": authClaim() });
  const LIVE = NOW + 10 * 86_400_000;

  // The shape Codex 0.166 writes, plus fields this runner does not know.
  const auth = (
    tokens: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) => ({
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: new Date(NOW - 3 * 86_400_000).toISOString(),
    futureField: { kept: true },
    tokens: {
      id_token: idToken("plus"),
      access_token: accessToken(LIVE),
      refresh_token: REFRESH,
      account_id: ACCOUNT,
      ...tokens,
    },
    ...extra,
  });
  const text = (value: unknown) => JSON.stringify(value);
  const SECRETS = [ACCOUNT, EMAIL, REFRESH, API_KEY, "SECRET"];
  const expectNoSecret = (name: string, login: { kind: string }) => {
    const reason = (login as { reason?: string }).reason ?? "";
    for (const secret of SECRETS)
      expect({ name, secret, leaked: reason.includes(secret) }).toEqual({
        name,
        secret,
        leaked: false,
      });
  };

  // The copy cannot refresh, so it cannot rotate the office's refresh token
  // (Codex rotates it on each use). A fresh last_refresh keeps Codex from
  // a scheduled refresh when it cannot read the token's expiry.
  it("copies the sign-in with an empty refresh token and last_refresh now, the rest unchanged", () => {
    const office = auth();
    const login = codexLogin(text(office), NOW, MARGIN);
    expect(login.kind).toBe("copy");
    const copy = (login as { kind: "copy"; text: string }).text;
    expect(copy).not.toContain(REFRESH);
    expect(JSON.parse(copy)).toEqual({
      ...office,
      last_refresh: new Date(NOW).toISOString(),
      tokens: { ...office.tokens, refresh_token: "" },
    });
  });

  // The token must outlive the column plus Codex's own 5-minute refresh
  // window, or the scratch Codex tries to refresh with the empty token.
  it("copies at exactly the margin plus Codex's refresh window and refreshes one second below it", () => {
    const edge = NOW + MARGIN + CODEX_REFRESH_WINDOW_MS;
    expect(
      codexLogin(text(auth({ access_token: accessToken(edge) })), NOW, MARGIN)
        .kind,
    ).toBe("copy");
    expect(
      codexLogin(
        text(auth({ access_token: accessToken(edge - 1_000) })),
        NOW,
        MARGIN,
      ),
    ).toEqual({ kind: "refresh" });
    expect(
      codexLogin(
        text(auth({ access_token: accessToken(NOW - 3_600_000) })),
        NOW,
        MARGIN,
      ),
    ).toEqual({ kind: "refresh" });
  });

  // Expiry comes first: a refresh also renews a stale plan claim.
  it("refreshes an expiring sign-in before it reads the plan", () => {
    for (const plan of ["free", undefined])
      expect(
        codexLogin(
          text(
            auth({
              id_token: idToken(plan),
              access_token: accessToken(NOW + 60_000),
            }),
          ),
          NOW,
          MARGIN,
        ),
      ).toEqual({ kind: "refresh" });
  });

  it("copies a sign-in on any paid plan", () => {
    for (const plan of ["plus", "pro", "team"])
      expect({
        plan,
        kind: codexLogin(text(auth({ id_token: idToken(plan) })), NOW, MARGIN)
          .kind,
      }).toEqual({ plan, kind: "copy" });
  });

  // No sign-in, an API key (billed per token) or no paid plan: skipped, not
  // red, each with its own reason.
  it("skips with a distinct reason and no secret when there is no sign-in, an API key, or no paid plan", () => {
    const cases: [string, string | null][] = [
      ["no file", null],
      [
        "API key, tokens null",
        text({ OPENAI_API_KEY: API_KEY, tokens: null, last_refresh: null }),
      ],
      ["API key mode, no tokens", text({ auth_mode: "apikey" })],
      ["free plan", text(auth({ id_token: idToken("free") }))],
      ["no plan claim", text(auth({ id_token: idToken(undefined) }))],
      [
        "no auth claim",
        text(auth({ id_token: jwt({ email: EMAIL, exp: NOW / 1000 }) })),
      ],
    ];
    const reasons = new Map<string, string>();
    for (const [name, file] of cases) {
      const login = codexLogin(file, NOW, MARGIN);
      expect({ name, kind: login.kind }).toEqual({ name, kind: "skip" });
      expectNoSecret(name, login);
      reasons.set(name, (login as { reason: string }).reason);
    }
    // A missing sign-in, an API key and the free plan each tell the reader
    // something else.
    const kinds = ["no file", "API key, tokens null", "free plan"].map((name) =>
      reasons.get(name),
    );
    expect(new Set(kinds).size).toBe(3);
    expect(reasons.get("API key mode, no tokens")).toBe(
      reasons.get("API key, tokens null"),
    );
  });

  // Codex writes this file, so a shape the runner cannot read is format
  // drift: a skip would hide Codex from the nightly with exit 0. The reason
  // reaches the nightly output.
  it("is red, with no secret in the reason, on a file it cannot read", () => {
    const cases: [string, string][] = [
      [
        "unparsable",
        `{"tokens":{"refresh_token":"${REFRESH}","account_id":"${ACCOUNT}"`,
      ],
      ["array", text([REFRESH])],
      ["null", "null"],
      ["number", "42"],
      ["no tokens and no API key", text({ auth_mode: "chatgpt" })],
      [
        "tokens null and no API key",
        text({ OPENAI_API_KEY: null, auth_mode: "chatgpt", tokens: null }),
      ],
      ["tokens a string", text({ ...auth(), tokens: REFRESH })],
      ["no access token", text(auth({ access_token: undefined }))],
      ["access token not a JWT", text(auth({ access_token: REFRESH }))],
      [
        "access token payload not JSON",
        text(auth({ access_token: `a.${ACCOUNT}.c` })),
      ],
      ["access token without exp", text(auth({ access_token: jwt({}) }))],
      [
        "access exp not a number",
        text(auth({ access_token: jwt({ exp: String(LIVE / 1000) }) })),
      ],
      ["no id token", text(auth({ id_token: undefined }))],
      ["id token not a JWT", text(auth({ id_token: EMAIL }))],
    ];
    for (const [name, file] of cases) {
      const login = codexLogin(file, NOW, MARGIN);
      expect({ name, kind: login.kind }).toEqual({ name, kind: "invalid" });
      expectNoSecret(name, login);
    }
  });
});

describe("codexPlanSkip", () => {
  const limits = (
    planType: unknown,
    ordinaryUsageAllowed: unknown,
    extra: Record<string, unknown> = {},
  ) => ({
    ordinaryUsageAllowed,
    rateLimits: {
      limitId: "codex",
      primary: null,
      secondary: null,
      planType,
    },
    rateLimitsByLimitId: null,
    accountId: "acct-1",
    ...extra,
  });

  it("runs the column on a paid plan with ordinary usage allowed", () => {
    expect(codexPlanSkip(limits("plus", true))).toBeNull();
    expect(codexPlanSkip(limits("pro", true))).toBeNull();
  });

  // The backend's answer is live; the token claim can be up to 10 days old.
  it("skips on the free plan and on a reached usage limit, each with its own reason", () => {
    const free = codexPlanSkip(limits("free", true));
    const limit = codexPlanSkip(limits("plus", false));
    expect(free?.kind).toBe("skip");
    expect(limit?.kind).toBe("skip");
    expect(free?.reason).not.toBe(limit?.reason);
    expect(codexPlanSkip(limits("free", false))).toEqual(free);
  });

  // Null means the backend did not say: the token claim stays the check.
  it("does not skip when the backend gives no plan or no usage verdict", () => {
    expect(codexPlanSkip(limits(null, null))).toBeNull();
    expect(codexPlanSkip(limits(undefined, undefined))).toBeNull();
    expect(codexPlanSkip(limits(null, true))).toBeNull();
    expect(codexPlanSkip(limits("plus", null))).toBeNull();
  });

  // An answer without rateLimits is protocol drift: red, not a silent run
  // or a silent skip.
  it("fails on an answer it cannot read", () => {
    for (const answer of [
      null,
      "plus",
      [],
      {},
      { ordinaryUsageAllowed: true, rateLimits: null },
      { ordinaryUsageAllowed: true, rateLimits: "plus" },
      { ordinaryUsageAllowed: true, rateLimits: [] },
    ])
      expect({ answer, kind: codexPlanSkip(answer)?.kind }).toEqual({
        answer,
        kind: "fail",
      });
  });
});

describe("codexEnv", () => {
  // The refresh writes the office's Codex sign-in, and the plan read uses
  // the scratch copy. From an agent shell, a parent CODEX_HOME is a member's
  // personal home and OPENAI_API_KEY would sign Codex in with a billed key.
  it("passes only the allowlisted parent variables and the given Codex home", () => {
    expect(codexEnv(agentShell, "/srv/office-codex")).toEqual({
      ...ALLOWED,
      CODEX_HOME: "/srv/office-codex",
    });
  });
});
