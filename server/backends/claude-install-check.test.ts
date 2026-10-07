import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  authStatusFromCli,
  claudeSignInState,
  isClaudeCodeAuthenticated,
  isClaudeCodeInstalled,
  limitedClaudeFamilies,
  resetClaudeSignInProbesForTest,
  runClaudeAuthStatus,
  type ClaudeSignInState,
} from "./claude-install-check.ts";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "isomux-claude-probe-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("Claude Code effective-environment probes", () => {
  for (const selector of [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ]) {
    it(`recognizes enabled ${selector} without local login`, () => {
      const env = { CLAUDE_CONFIG_DIR: tempDir(), ANTHROPIC_API_KEY: "" };
      for (const value of ["1", "true", "yes", "on", " TRUE ", "On"])
        expect(isClaudeCodeAuthenticated({ ...env, [selector]: value })).toBe(
          true,
        );
      for (const value of ["", "0", "false", "off", "no", "enabled"])
        expect(isClaudeCodeAuthenticated({ ...env, [selector]: value })).toBe(
          false,
        );
    });
  }

  for (const token of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) {
    it(`counts ${token} as a login without a credentials file`, () => {
      const env = { CLAUDE_CONFIG_DIR: tempDir(), ANTHROPIC_API_KEY: "" };
      expect(isClaudeCodeAuthenticated({ ...env, [token]: "token" })).toBe(
        true,
      );
      expect(isClaudeCodeAuthenticated({ ...env, [token]: "" })).toBe(false);
    });
  }

  it("resolves credentials from the effective CLAUDE_CONFIG_DIR", () => {
    const signedIn = tempDir();
    const signedOut = tempDir();
    writeFileSync(join(signedIn, ".credentials.json"), "{}");

    expect(isClaudeCodeAuthenticated({ CLAUDE_CONFIG_DIR: signedIn })).toBe(
      true,
    );
    expect(isClaudeCodeAuthenticated({ CLAUDE_CONFIG_DIR: signedOut })).toBe(
      false,
    );
  });

  it("resolves an executable from the effective PATH without which", () => {
    const installed = tempDir();
    const absent = tempDir();
    const executable = join(installed, "claude");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);

    expect(isClaudeCodeInstalled({ PATH: installed })).toBe(true);
    expect(isClaudeCodeInstalled({ PATH: absent })).toBe(false);
  });
});

describe("limitedClaudeFamilies", () => {
  it("limits no family first-party, whatever the pins", () => {
    expect(limitedClaudeFamilies({})).toEqual([]);
    expect(
      limitedClaudeFamilies({
        CLAUDE_CODE_USE_BEDROCK: "0",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
      }),
    ).toEqual([]);
  });

  for (const selector of [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ]) {
    it(`limits sonnet and haiku on ${selector}, and no other family`, () => {
      expect(limitedClaudeFamilies({ [selector]: " TRUE " })).toEqual([
        "sonnet",
        "haiku",
      ]);
    });

    it(`lifts a family pinned to the 5.x model the CLI matches on ${selector}`, () => {
      expect(
        limitedClaudeFamilies({
          [selector]: "1",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-5-5",
        }),
      ).toEqual(["sonnet"]);
      expect(
        limitedClaudeFamilies({
          [selector]: "1",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "CLAUDE-HAIKU-5-5@20261001",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
        }),
      ).toEqual([]);
      expect(
        limitedClaudeFamilies({
          [selector]: "1",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-5-5-v1:0",
        }),
      ).toEqual(["haiku"]);
    });

    it(`keeps a family limited for an older or opaque pin on ${selector}`, () => {
      expect(
        limitedClaudeFamilies({
          [selector]: "1",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5@20251001",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
        }),
      ).toEqual(["sonnet", "haiku"]);
      expect(
        limitedClaudeFamilies({
          [selector]: "1",
          ANTHROPIC_DEFAULT_HAIKU_MODEL:
            "arn:aws:bedrock:us-east-1:1:application-inference-profile/x",
        }),
      ).toEqual(["sonnet", "haiku"]);
    });

    it(`ignores ANTHROPIC_SMALL_FAST_MODEL on ${selector}`, () => {
      expect(
        limitedClaudeFamilies({
          [selector]: "1",
          ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-5-5",
        }),
      ).toEqual(["sonnet", "haiku"]);
    });
  }
});

describe("Claude sign-in state", () => {
  beforeEach(() => resetClaudeSignInProbesForTest());

  function probe(answers: Array<ClaudeSignInState | Error>) {
    const calls: Array<{ [key: string]: string | undefined }> = [];
    let clock = 0;
    return {
      calls,
      advance(ms: number) {
        clock += ms;
      },
      deps: {
        platform: "darwin" as const,
        now: () => clock,
        runAuthStatus: async (env: { [key: string]: string | undefined }) => {
          calls.push(env);
          const answer = answers.shift() ?? "unknown";
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    };
  }

  it("keeps Linux on the credentials file and never asks the CLI", async () => {
    const p = probe(["signed_in"]);
    const env = { CLAUDE_CONFIG_DIR: tempDir() };
    expect(await claudeSignInState(env, { ...p.deps, platform: "linux" })).toBe(
      "signed_out",
    );
    expect(p.calls).toHaveLength(0);
  });

  it("does not ask the CLI when the credentials file exists", async () => {
    const p = probe(["signed_out"]);
    const dir = tempDir();
    writeFileSync(join(dir, ".credentials.json"), "{}");
    expect(await claudeSignInState({ CLAUDE_CONFIG_DIR: dir }, p.deps)).toBe(
      "signed_in",
    );
    expect(p.calls).toHaveLength(0);
  });

  it("on macOS without the file, reports what the CLI says, and a failure as unknown", async () => {
    for (const answer of [
      "signed_in",
      "signed_out",
      "unknown",
      new Error("spawn failed"),
    ] as const) {
      resetClaudeSignInProbesForTest();
      const p = probe([answer]);
      const env = { CLAUDE_CONFIG_DIR: tempDir() };
      expect(await claudeSignInState(env, p.deps)).toBe(
        answer instanceof Error ? "unknown" : answer,
      );
      expect(p.calls).toEqual([env]);
    }
  });

  it("shares one probe per environment and asks again after the reuse window", async () => {
    const p = probe(["signed_out", "signed_in"]);
    const env = { CLAUDE_CONFIG_DIR: tempDir() };
    const [first, second] = await Promise.all([
      claudeSignInState(env, p.deps),
      claudeSignInState({ ...env }, p.deps),
    ]);
    expect([first, second]).toEqual(["signed_out", "signed_out"]);
    p.advance(14_000);
    expect(await claudeSignInState(env, p.deps)).toBe("signed_out");
    expect(p.calls).toHaveLength(1);
    p.advance(1_000);
    expect(await claudeSignInState(env, p.deps)).toBe("signed_in");
    expect(p.calls).toHaveLength(2);
  });

  it("does not share an answer between environments that share a config dir", async () => {
    const p = probe(["signed_in", "signed_out"]);
    const dir = tempDir();
    expect(
      await claudeSignInState({ CLAUDE_CONFIG_DIR: dir, USER: "a" }, p.deps),
    ).toBe("signed_in");
    expect(
      await claudeSignInState({ CLAUDE_CONFIG_DIR: dir, USER: "b" }, p.deps),
    ).toBe("signed_out");
    expect(p.calls).toHaveLength(2);
  });

  it("asks the bundled CLI, which reports an empty config dir as signed out", async () => {
    const env = {
      CLAUDE_CONFIG_DIR: tempDir(),
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    };
    expect(await claudeSignInState(env, { platform: "darwin" })).toBe(
      "signed_out",
    );
  });
});

describe("claude auth status result", () => {
  const out = (loggedIn: unknown) => JSON.stringify({ loggedIn });

  it("trusts only exit 0 with loggedIn true and exit 1 with loggedIn false", () => {
    const exited = (exitCode: number) => ({ exitCode, signalCode: null });
    expect(authStatusFromCli(exited(0), out(true))).toBe("signed_in");
    expect(authStatusFromCli(exited(1), out(false))).toBe("signed_out");
    for (const [exit, stdout] of [
      [exited(0), out(false)],
      [exited(1), out(true)],
      [exited(2), out(false)],
      [exited(143), out(false)],
      [exited(0), "not json"],
      [exited(1), ""],
      [exited(1), "null"],
      [exited(1), out("false")],
      [{ exitCode: null, signalCode: "SIGTERM" }, out(false)],
      [{ exitCode: 1, signalCode: "SIGKILL" }, out(false)],
    ] as const)
      expect(authStatusFromCli(exit, stdout)).toBe("unknown");
  });

  function fakeCli(body: string): string {
    const path = join(tempDir(), "claude");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o700);
    return path;
  }

  it("reads the exit and the output of a real process", async () => {
    const cases: Array<[string, ClaudeSignInState]> = [
      [`echo '${out(true)}'; exit 0`, "signed_in"],
      [`echo '${out(false)}'; exit 1`, "signed_out"],
      [`echo '${out(false)}'; exit 2`, "unknown"],
      [`echo '${out(false)}'; kill -TERM $$`, "unknown"],
    ];
    for (const [body, expected] of cases)
      expect(await runClaudeAuthStatus({}, fakeCli(body))).toBe(expected);
  });

  it("reports a probe killed by its timeout as unknown", async () => {
    const cli = fakeCli(`echo '${out(false)}'; exec sleep 5`);
    expect(await runClaudeAuthStatus({}, cli, 200)).toBe("unknown");
  });
});

// Writes to the login Keychain, so it runs only where the macOS CI job opts in.
describe.skipIf(
  process.platform !== "darwin" || process.env.ISOMUX_TEST_MAC_KEYCHAIN !== "1",
)("Claude sign-in state from the macOS Keychain", () => {
  it("sees a Keychain login that has no credentials file", async () => {
    resetClaudeSignInProbesForTest();
    const dir = tempDir();
    const service = `Claude Code-credentials-${new Bun.CryptoHasher("sha256")
      .update(dir)
      .digest("hex")
      .slice(0, 8)}`;
    const account = process.env.USER!;
    const secret = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-isomux-test",
        refreshToken: "sk-ant-ort01-isomux-test",
        expiresAt: 4102444800000,
        scopes: ["user:inference", "user:profile"],
      },
    });
    const add = Bun.spawnSync([
      "security",
      "add-generic-password",
      "-U",
      "-a",
      account,
      "-s",
      service,
      "-w",
      secret,
    ]);
    expect(add.exitCode).toBe(0);
    try {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
      expect(isClaudeCodeAuthenticated(env)).toBe(false);
      expect(await claudeSignInState(env)).toBe("signed_in");
    } finally {
      Bun.spawnSync([
        "security",
        "delete-generic-password",
        "-a",
        account,
        "-s",
        service,
      ]);
    }
  }, 30_000);
});
