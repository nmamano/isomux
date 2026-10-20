import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
import { dirname } from "path";
import {
  environmentSourceKeyForUserId,
  environmentSourceRevisionForUserId,
  buildEnvForUserId,
  envSourceForUserId,
  setOfficeEnvFileProvider,
  setPersonalProviderActiveProvider,
  setSecretEnvironmentProvider,
} from "./env-loader.ts";
import {
  isPersonalProviderActive,
  personalProviderHome,
} from "./provider-homes.ts";
import { claimUser } from "./users.ts";
import {
  managedOfficeEnvPath,
  managedUserEnvPath,
  writeManagedOfficeEnv,
  writeManagedUserEnv,
} from "./user-env.ts";

afterEach(() => {
  setOfficeEnvFileProvider(() => null);
  setPersonalProviderActiveProvider(isPersonalProviderActive);
  // The managed env files are process-wide state; a later test file must not
  // inherit the values these tests wrote.
  rmSync(dirname(managedOfficeEnvPath()), { recursive: true, force: true });
  rmSync(dirname(managedUserEnvPath("any")), { recursive: true, force: true });
});

describe("environment source identity", () => {
  it("uses the managed path, not process state or file contents", () => {
    const priorInvocationId = process.env.INVOCATION_ID;
    try {
      writeManagedOfficeEnv({ PROVIDER_KEY: "first" });
      process.env.INVOCATION_ID = "first-start";
      const first = environmentSourceKeyForUserId(null);
      const firstRevision = environmentSourceRevisionForUserId(null);
      process.env.INVOCATION_ID = "second-start";
      expect(environmentSourceKeyForUserId(null)).toBe(first);
      expect(environmentSourceRevisionForUserId(null)).toBe(firstRevision);

      writeManagedOfficeEnv({ PROVIDER_KEY: "rotated", UNRELATED: "value" });
      expect(environmentSourceKeyForUserId(null)).toBe(first);
      expect(environmentSourceRevisionForUserId(null)).not.toBe(firstRevision);
    } finally {
      if (priorInvocationId === undefined) delete process.env.INVOCATION_ID;
      else process.env.INVOCATION_ID = priorInvocationId;
    }
  });
});

describe("activated personal provider environment", () => {
  it("reaches a user with no office or user env file", () => {
    setOfficeEnvFileProvider(() => null);
    setPersonalProviderActiveProvider(
      (userId, provider) => userId === "01a19e7b" && provider === "claude",
    );
    const env = buildEnvForUserId("01a19e7b");
    expect(env?.CLAUDE_CONFIG_DIR).toBe(
      personalProviderHome("01a19e7b", "claude"),
    );
  });

  it("can activate Codex independently with no env files", () => {
    const priorClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    try {
      delete process.env.CLAUDE_CONFIG_DIR;
      setOfficeEnvFileProvider(() => null);
      setPersonalProviderActiveProvider(
        (userId, provider) => userId === "01a19e7b" && provider === "codex",
      );
      const env = buildEnvForUserId("01a19e7b");
      expect(env?.CODEX_HOME).toBe(personalProviderHome("01a19e7b", "codex"));
      expect(env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    } finally {
      if (priorClaudeConfigDir === undefined)
        delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = priorClaudeConfigDir;
    }
  });
});

describe("managed user environment", () => {
  it("inherits office Bedrock and lets personal variables disable or replace it", () => {
    const user = claimUser("Cloud Env User");
    writeManagedOfficeEnv({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-4-6",
    });
    expect(buildEnvForUserId(user.id)).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-4-6",
    });
    writeManagedUserEnv(user.id, {
      CLAUDE_CODE_USE_BEDROCK: "0",
      CLAUDE_CODE_USE_VERTEX: "1",
    });
    expect(buildEnvForUserId(user.id)).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "0",
      CLAUDE_CODE_USE_VERTEX: "1",
    });
  });

  it("flows provider keys with user-over-office precedence and stable identity", async () => {
    const user = claimUser("Managed Env Flow User");
    writeManagedOfficeEnv({
      OPENAI_API_KEY: "office",
      ANTHROPIC_API_KEY: "office",
      SHARED: "office",
    });
    setPersonalProviderActiveProvider(
      (id, provider) =>
        id === user.id && (provider === "claude" || provider === "codex"),
    );
    const beforeKey = environmentSourceKeyForUserId(user.id);

    writeManagedUserEnv(user.id, {
      GH_TOKEN: "user",
      OPENCODE_API_KEY: "zen",
      OPENAI_API_KEY: "openai",
      ANTHROPIC_API_KEY: "anthropic",
      CLAUDE_CONFIG_DIR: "/explicit/claude",
      SHARED: "user",
    });
    const firstKey = environmentSourceKeyForUserId(user.id);
    const firstRevision = environmentSourceRevisionForUserId(user.id);
    const env = buildEnvForUserId(user.id);

    expect(env?.OPENCODE_API_KEY).toBe("zen");
    expect(env?.GH_TOKEN).toBe("user");
    expect(env?.OPENAI_API_KEY).toBe("openai");
    expect(env?.ANTHROPIC_API_KEY).toBe("anthropic");
    expect(env?.SHARED).toBe("user");
    expect(env?.CLAUDE_CONFIG_DIR).toBe("/explicit/claude");
    expect(env?.CODEX_HOME).toBe(personalProviderHome(user.id, "codex"));
    expect(firstKey).not.toBe(beforeKey);

    writeManagedUserEnv(user.id, { OPENCODE_API_KEY: "rotated" });
    expect(environmentSourceKeyForUserId(user.id)).toBe(firstKey);
    expect(environmentSourceRevisionForUserId(user.id)).not.toBe(firstRevision);
  });

  it("merges managed office and user values over process values", () => {
    const user = claimUser("Managed Precedence User");
    const prior = process.env.GH_TOKEN;
    try {
      process.env.GH_TOKEN = "process";
      setOfficeEnvFileProvider(() => null);
      writeManagedOfficeEnv({ GH_TOKEN: "office", OFFICE_ONLY: "office" });
      expect(buildEnvForUserId(null)?.GH_TOKEN).toBe("office");

      writeManagedUserEnv(user.id, { GH_TOKEN: "user" });
      const env = buildEnvForUserId(user.id);
      expect(env?.GH_TOKEN).toBe("user");
      expect(env?.OFFICE_ONLY).toBe("office");
    } finally {
      if (prior === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prior;
    }
  });
});

// Where the Codex card says a member's agents get OPENAI_API_KEY: the last
// layer of buildEnvForUserId's merge that defines it (task a704657a).
describe("envSourceForUserId", () => {
  const KEY = "OPENAI_API_KEY";
  const secrets = (
    office: Record<string, string>,
    member: Record<string, Record<string, string>>,
  ) =>
    setSecretEnvironmentProvider((userId) => ({
      office,
      member: (userId && member[userId]) || {},
      fixed: {},
      gitCredentials: [],
      revision: "test",
    }));
  // The agents' value, as the spawn sees it: no merge in scope means the
  // agent host's own env.
  const agentValue = (userId: string | null) =>
    (buildEnvForUserId(userId) ?? process.env)[KEY];

  const withProcessKey = (value: string | undefined, run: () => void) => {
    const prior = process.env[KEY];
    const restoreSecrets = setSecretEnvironmentProvider(() => null);
    try {
      if (value === undefined) delete process.env[KEY];
      else process.env[KEY] = value;
      run();
    } finally {
      setSecretEnvironmentProvider(restoreSecrets);
      if (prior === undefined) delete process.env[KEY];
      else process.env[KEY] = prior;
    }
  };

  it("names the last layer that defines the key, per member", () => {
    const user = claimUser("Key Source User");
    const other = claimUser("Key Source Other");
    withProcessKey(undefined, () => {
      expect(envSourceForUserId(user.id, KEY)).toBeNull();

      process.env[KEY] = "from-process";
      expect(envSourceForUserId(user.id, KEY)).toBe("server");

      writeManagedOfficeEnv({ [KEY]: "office-variable" });
      expect(envSourceForUserId(user.id, KEY)).toBe("office_variable");

      secrets({ [KEY]: "office-secret" }, {});
      expect(envSourceForUserId(user.id, KEY)).toBe("office_secret");

      writeManagedUserEnv(user.id, { [KEY]: "member-variable" });
      expect(envSourceForUserId(user.id, KEY)).toBe("member_variable");

      secrets({ [KEY]: "office-secret" }, { [user.id]: { [KEY]: "member" } });
      expect(envSourceForUserId(user.id, KEY)).toBe("member_secret");

      // The member layers are the member's own: another member and an
      // unowned context still get the office secret.
      expect(envSourceForUserId(other.id, KEY)).toBe("office_secret");
      expect(envSourceForUserId(null, KEY)).toBe("office_secret");
      // Another name has its own source.
      expect(
        envSourceForUserId(user.id, "NOT_SET_ANYWHERE_A704657A"),
      ).toBeNull();
    });
  });

  it("says no key when a later layer empties it, as the agents get it", () => {
    const user = claimUser("Key Source Empty User");
    withProcessKey("from-process", () => {
      writeManagedOfficeEnv({ [KEY]: "office-variable" });
      writeManagedUserEnv(user.id, { [KEY]: "" });
      expect(agentValue(user.id)).toBe("");
      expect(envSourceForUserId(user.id, KEY)).toBeNull();
      expect(envSourceForUserId(null, KEY)).toBe("office_variable");

      // A secret over the empty variable sets it again.
      secrets({}, { [user.id]: { [KEY]: "member-secret" } });
      expect(agentValue(user.id)).toBe("member-secret");
      expect(envSourceForUserId(user.id, KEY)).toBe("member_secret");
    });
  });

  it("agrees with the merge on whether the agents have the key", () => {
    const user = claimUser("Key Source Agree User");
    const cases: Array<() => void> = [
      () => {},
      () => {
        process.env[KEY] = "from-process";
      },
      () => writeManagedOfficeEnv({ [KEY]: "" }),
      () => secrets({ [KEY]: "office-secret" }, {}),
      () => writeManagedUserEnv(user.id, { [KEY]: "" }),
      () => secrets({ [KEY]: "office-secret" }, { [user.id]: { [KEY]: "m" } }),
    ];
    withProcessKey(undefined, () => {
      for (const step of cases) {
        step();
        for (const id of [user.id, null]) {
          const value = agentValue(id);
          expect(envSourceForUserId(id, KEY) !== null).toBe(Boolean(value));
        }
      }
    });
  });

  it("fails like the merge while an office env file waits for import", () => {
    setOfficeEnvFileProvider(() => "/tmp/pending-import.env");
    let mergeError: unknown;
    try {
      buildEnvForUserId(null);
    } catch (err) {
      mergeError = err;
    }
    expect(mergeError).toBeInstanceOf(Error);
    expect(() => envSourceForUserId(null, KEY)).toThrow(
      (mergeError as Error).message,
    );
  });
});
