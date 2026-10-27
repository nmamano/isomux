import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildServerEnv,
  claudeLogin,
  claudeRefreshEnv,
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
    const env = buildServerEnv(agentShell, runDir, 4123, live);
    const { ISOMUX_HOME, ISOMUX_BACKUP_DIR, ...rest } = env;
    expect(rest).toEqual({ ...ALLOWED, PORT: "4123" });
    expect(ISOMUX_HOME.startsWith(`${runDir}/`)).toBe(true);
    expect(ISOMUX_BACKUP_DIR.startsWith(`${runDir}/`)).toBe(true);
    expect(ISOMUX_BACKUP_DIR).not.toBe(ISOMUX_HOME);
  });

  // Each refusal case first shows that a run dir beside the live root (whose
  // name the live root's path is a prefix of) is accepted, so the throw is
  // about where the run dir resolves.
  it("refuses a run dir that is the live state root or inside it", () => {
    expect(() => buildServerEnv(agentShell, runDir, 4123, live)).not.toThrow();
    expect(() => buildServerEnv(agentShell, live, 4123, live)).toThrow();
    expect(() =>
      buildServerEnv(agentShell, join(live, "sub"), 4123, live),
    ).toThrow();
  });

  it("refuses a run dir that resolves into the live root through a link", () => {
    const viaLink = join(scratch, "link-into-live");
    symlinkSync(join(live, "sub"), viaLink);
    expect(() => buildServerEnv(agentShell, runDir, 4123, live)).not.toThrow();
    expect(() => buildServerEnv(agentShell, viaLink, 4123, live)).toThrow();
  });

  // A box whose ~/.isomux is a link to another disk.
  it("refuses a run dir inside the live root when the live root is a link", () => {
    const liveLink = join(scratch, "live-link");
    symlinkSync(live, liveLink);
    expect(() =>
      buildServerEnv(agentShell, runDir, 4123, liveLink),
    ).not.toThrow();
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
