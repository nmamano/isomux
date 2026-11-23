import { afterAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  claudeProviderId,
  claudeSignInState,
  isClaudeCodeAuthenticated,
  limitedClaudeFamilies,
  claudeFamilyModels,
  runClaudeAuthStatus,
  type ClaudeSignInState,
} from "./claude-install-check.ts";
import { FAMILY_TO_MODEL } from "../../shared/types.ts";

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

  // Which families each cloud limits, by region, is
  // claude-cloud-defaults.test.ts's table; old and opaque pins are there too.
  // The selector only gates (above), so one cloud stands for both.
  const selector = "CLAUDE_CODE_USE_BEDROCK";

  it("lifts a family pinned to the 5.x model the CLI matches", () => {
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

  it("ignores ANTHROPIC_SMALL_FAST_MODEL", () => {
    expect(
      limitedClaudeFamilies({
        [selector]: "1",
        ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-5-5",
      }),
    ).toEqual(["sonnet", "haiku"]);
  });
});

describe("claudeFamilyModels", () => {
  it("overrides no family first-party, whatever the pins", () => {
    expect(claudeFamilyModels({})).toEqual({});
    expect(
      claudeFamilyModels({
        CLAUDE_CODE_USE_VERTEX: "0",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8",
      }),
    ).toEqual({});
  });

  it("reports each family's pin, and omits a pin to FAMILY_TO_MODEL", () => {
    const selector = "CLAUDE_CODE_USE_BEDROCK";
    expect(
      claudeFamilyModels({
        [selector]: "1",
        ANTHROPIC_DEFAULT_OPUS_MODEL: " us.anthropic.claude-opus-4-8 ",
        ANTHROPIC_DEFAULT_FABLE_MODEL: FAMILY_TO_MODEL.fable,
        ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-4-6",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5-5",
      }),
    ).toEqual({
      opus: "us.anthropic.claude-opus-4-8",
      sonnet: "us.anthropic.claude-sonnet-4-6",
    });
    expect(
      claudeFamilyModels({
        [selector]: "1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "  ",
      }),
    ).toEqual({
      sonnet: "claude-sonnet-4-5",
      haiku: "claude-haiku-4-5",
    });
  });
});

describe("Claude sign-in state", () => {
  // Every case keys the probe cache on its own temp CLAUDE_CONFIG_DIR.
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
});

describe("claude auth status result", () => {
  const out = (loggedIn: unknown) => JSON.stringify({ loggedIn });

  function fakeCli(body: string): string {
    const path = join(tempDir(), "claude");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o700);
    return path;
  }

  // Only exit 0 with loggedIn true and exit 1 with loggedIn false count.
  it("reads the exit and the output of a real process", async () => {
    const cases: Array<[string, ClaudeSignInState]> = [
      [`echo '${out(true)}'; exit 0`, "signed_in"],
      [`echo '${out(false)}'; exit 1`, "signed_out"],
      [`echo '${out(false)}'; exit 0`, "unknown"],
      [`echo '${out(true)}'; exit 1`, "unknown"],
      [`echo '${out(false)}'; exit 2`, "unknown"],
      [`echo not json; exit 0`, "unknown"],
      [`exit 1`, "unknown"],
      [`echo null; exit 1`, "unknown"],
      [`echo '${out("false")}'; exit 1`, "unknown"],
      [`echo '${out(false)}'; kill -TERM $$`, "unknown"],
    ];
    for (const [body, expected] of cases)
      expect(await runClaudeAuthStatus({}, fakeCli(body))).toBe(expected);
  });

  // The probe must settle by its deadline whatever the CLI does, or every
  // sign-in check of that environment waits on it (task 8705a06f). Each case
  // races the probe against an in-test timer, so a hang fails as an assertion.
  async function settled(
    result: Promise<ClaudeSignInState>,
  ): Promise<ClaudeSignInState | "still pending"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<"still pending">((resolve) => {
      timer = setTimeout(() => resolve("still pending"), 2_000);
    });
    try {
      return await Promise.race([result, pending]);
    } finally {
      clearTimeout(timer);
    }
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function readPid(file: string): number {
    return Number(readFileSync(file, "utf8").trim());
  }

  it("kills a CLI that ignores SIGTERM at the deadline", async () => {
    const pidFile = join(tempDir(), "pid");
    const cli = fakeCli(
      `trap '' TERM; echo $$ > ${pidFile}; echo '${out(false)}'; exec sleep 30`,
    );
    let pid = 0;
    try {
      const state = await settled(runClaudeAuthStatus({}, cli, 300));
      pid = readPid(pidFile);
      expect(state).toBe("unknown");
      // SIGKILL lands at once; give the reaper a moment.
      const until = Date.now() + 1_000;
      while (alive(pid) && Date.now() < until) await Bun.sleep(20);
      expect(alive(pid)).toBe(false);
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("closes its end of the output at the deadline", async () => {
    const status = join(tempDir(), "status");
    // The child writes after the deadline: into a closed pipe the write fails.
    const cli = fakeCli(
      `( trap '' PIPE; sleep 1; echo late; echo $? > ${status}.new; mv ${status}.new ${status} ) & echo '${out(false)}'; exit 1`,
    );
    expect(await settled(runClaudeAuthStatus({}, cli, 300))).toBe("unknown");
    const until = Date.now() + 2_000;
    while (!existsSync(status) && Date.now() < until) await Bun.sleep(20);
    const code = existsSync(status)
      ? readFileSync(status, "utf8").trim()
      : null;
    expect({ lateWrite: code === "0" ? "delivered" : code }).toEqual({
      lateWrite: "1",
    });
  });

  it("settles at the deadline while a child of the CLI holds its output", async () => {
    const pidFile = join(tempDir(), "pid");
    const cli = fakeCli(
      `sleep 30 & echo $! > ${pidFile}; echo '${out(false)}'; exit 1`,
    );
    let pid = 0;
    try {
      const state = await settled(runClaudeAuthStatus({}, cli, 300));
      pid = readPid(pidFile);
      // The case is only real while the child still holds the pipe.
      expect({ state, holderAlive: alive(pid) }).toEqual({
        state: "unknown",
        holderAlive: true,
      });
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});

// Writes to the login Keychain, so it runs only where the macOS CI job opts in.
describe.skipIf(
  process.platform !== "darwin" || process.env.ISOMUX_TEST_MAC_KEYCHAIN !== "1",
)("Claude sign-in state from the macOS Keychain", () => {
  it("sees a Keychain login that has no credentials file", async () => {
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

// The provider a Claude refusal line names (task 2bd836d5). The cloud flags
// use the CLI's boolean parser, as isClaudeCloudSelected does.
describe("claudeProviderId", () => {
  it("names the cloud the env selects", () => {
    expect(claudeProviderId({ CLAUDE_CODE_USE_BEDROCK: " Yes " })).toBe(
      "bedrock",
    );
    expect(claudeProviderId({ CLAUDE_CODE_USE_VERTEX: "1" })).toBe("vertex");
    expect(claudeProviderId({ CLAUDE_CODE_USE_FOUNDRY: "true" })).toBe(
      "foundry",
    );
    // The cloud selects its own endpoint; ANTHROPIC_BASE_URL is not it.
    expect(
      claudeProviderId({
        CLAUDE_CODE_USE_BEDROCK: "on",
        ANTHROPIC_BASE_URL: "https://gateway.example.com",
      }),
    ).toBe("bedrock");
  });

  it("names Anthropic when nothing else is selected", () => {
    for (const env of [
      {},
      { CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "false" },
      { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      { ANTHROPIC_BASE_URL: "https://API.Anthropic.com/v1/" },
      { ANTHROPIC_BASE_URL: "" },
      { ANTHROPIC_BASE_URL: "not a url" },
    ])
      expect({ env, id: claudeProviderId(env) }).toEqual({
        env,
        id: "anthropic",
      });
  });

  // A proxy refuses in its own words, so the line names the proxy.
  it("names the host of a base URL that is not Anthropic's", () => {
    expect(
      claudeProviderId({
        ANTHROPIC_BASE_URL: "https://llm.gateway.example.com/anthropic",
      }),
    ).toBe("llm.gateway.example.com");
    expect(
      claudeProviderId({ ANTHROPIC_BASE_URL: "https://evilanthropic.com" }),
    ).toBe("evilanthropic.com");
    // Credentials and the port in the URL never reach the chat.
    expect(
      claudeProviderId({
        ANTHROPIC_BASE_URL: "https://user:pw-canary@proxy.example:8443/x",
      }),
    ).toBe("proxy.example");
  });
});
