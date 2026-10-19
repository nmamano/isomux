// The account key a subscription usage reading is shared under (task
// 967a09d1). Two sessions get the same key exactly when they talk to the same
// provider account: the same provider, the same config directory, and the
// same values for the variables that select an account without that
// directory. Nothing else in the env may split or merge them, and the key is
// held in memory next to readings, so it must not carry a secret in clear.

import { describe, expect, it } from "bun:test";
import { usageAccountKey } from "./usage-account.ts";
import { effectiveProviderDirectory } from "./provider-account-manager.ts";

const CLAUDE_AUTH_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BASE_URL",
];
const CODEX_AUTH_VARS = ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"];

const PROVIDERS = [
  {
    provider: "claude" as const,
    dirVar: "CLAUDE_CONFIG_DIR",
    own: CLAUDE_AUTH_VARS,
    other: CODEX_AUTH_VARS,
  },
  {
    provider: "codex" as const,
    dirVar: "CODEX_HOME",
    own: CODEX_AUTH_VARS,
    other: CLAUDE_AUTH_VARS,
  },
];

describe("usageAccountKey", () => {
  for (const { provider, dirVar, own, other } of PROVIDERS) {
    const base = { [dirVar]: "/srv/accounts/one", PATH: "/usr/bin" };

    it(`${provider}: the agent token and unrelated variables do not split an account`, () => {
      const key = usageAccountKey(provider, base);
      expect(key).not.toBeNull();
      expect(
        usageAccountKey(provider, {
          ...base,
          ISOMUX_AGENT_TOKEN: "agent-token-a",
          PATH: "/opt/bin",
          HTTPS_PROXY: "http://127.0.0.1:1",
          ...Object.fromEntries(other.map((name) => [name, "x"])),
        }),
      ).toBe(key);
    });

    it(`${provider}: a different config directory is a different account`, () => {
      expect(usageAccountKey(provider, base)).not.toBe(
        usageAccountKey(provider, { ...base, [dirVar]: "/srv/accounts/two" }),
      );
    });

    it(`${provider}: the directory is compared resolved, with the engine default when unset`, () => {
      expect(
        usageAccountKey(provider, {
          ...base,
          [dirVar]: "/srv/accounts/x/../one/",
        }),
      ).toBe(usageAccountKey(provider, base));
      expect(usageAccountKey(provider, {})).toBe(
        usageAccountKey(provider, {
          [dirVar]: effectiveProviderDirectory(provider, {}),
        }),
      );
    });

    for (const name of own) {
      it(`${provider}: ${name} selects the account`, () => {
        const unset = usageAccountKey(provider, base);
        const one = usageAccountKey(provider, { ...base, [name]: "value-1" });
        const two = usageAccountKey(provider, { ...base, [name]: "value-2" });
        expect(one).not.toBe(unset);
        expect(two).not.toBe(one);
      });
    }

    it(`${provider}: the key does not carry an auth value in clear`, () => {
      const secret = "sk-secret-0123456789abcdef";
      for (const name of own) {
        const key = usageAccountKey(provider, { ...base, [name]: secret })!;
        expect(key.includes(secret)).toBe(false);
        expect(key.includes(secret.slice(0, 12))).toBe(false);
      }
    });
  }

  it("the same directory under two engines is two accounts", () => {
    const env = { CLAUDE_CONFIG_DIR: "/srv/same", CODEX_HOME: "/srv/same" };
    const claude = usageAccountKey("claude", env);
    const codex = usageAccountKey("codex", env);
    expect(claude).not.toBeNull();
    expect(codex).not.toBeNull();
    expect(claude).not.toBe(codex);
  });

  it("an engine without shared readings has no key", () => {
    expect(usageAccountKey("opencode", { PATH: "/usr/bin" })).toBeNull();
  });
});
