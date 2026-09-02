import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  environmentSourceKeyForUserId,
  environmentSourceRevisionForUserId,
  buildEnvForUserId,
  setOfficeEnvFileProvider,
  setPersonalProviderActiveProvider,
} from "./env-loader.ts";
import { personalProviderHome } from "./provider-homes.ts";
import { claimUser, updateUserById } from "./users.ts";
import { writeManagedUserEnv } from "./user-env.ts";

afterEach(() => {
  setOfficeEnvFileProvider(() => null);
  setPersonalProviderActiveProvider(() => false);
});

describe("environment source identity", () => {
  it("uses paths, not process state or file contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "isomux-env-identity-"));
    const firstPath = join(root, "first.env");
    const secondPath = join(root, "second.env");
    const priorInvocationId = process.env.INVOCATION_ID;
    try {
      await writeFile(firstPath, "PROVIDER_KEY=first\n");
      await writeFile(secondPath, "PROVIDER_KEY=first\n");
      setOfficeEnvFileProvider(() => firstPath);
      process.env.INVOCATION_ID = "first-start";
      const first = environmentSourceKeyForUserId(null);
      const firstRevision = environmentSourceRevisionForUserId(null);
      process.env.INVOCATION_ID = "second-start";
      expect(environmentSourceKeyForUserId(null)).toBe(first);
      expect(environmentSourceRevisionForUserId(null)).toBe(firstRevision);

      await writeFile(firstPath, "PROVIDER_KEY=rotated\nUNRELATED=value\n");
      expect(environmentSourceKeyForUserId(null)).toBe(first);
      expect(environmentSourceRevisionForUserId(null)).not.toBe(firstRevision);

      setOfficeEnvFileProvider(() => secondPath);
      expect(environmentSourceKeyForUserId(null)).not.toBe(first);
    } finally {
      if (priorInvocationId === undefined) delete process.env.INVOCATION_ID;
      else process.env.INVOCATION_ID = priorInvocationId;
      await rm(root, { recursive: true, force: true });
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
    setOfficeEnvFileProvider(() => null);
    setPersonalProviderActiveProvider(
      (userId, provider) => userId === "01a19e7b" && provider === "codex",
    );
    const env = buildEnvForUserId("01a19e7b");
    expect(env?.CODEX_HOME).toBe(personalProviderHome("01a19e7b", "codex"));
    expect(env?.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

describe("managed user environment", () => {
  it("flows provider keys with user-over-office precedence and stable identity", async () => {
    const user = claimUser("Managed Env Flow User");
    const root = await mkdtemp(join(tmpdir(), "isomux-managed-flow-"));
    const office = join(root, "office.env");
    await writeFile(
      office,
      "OPENAI_API_KEY=office\nANTHROPIC_API_KEY=office\nSHARED=office\n",
    );
    setOfficeEnvFileProvider(() => office);
    setPersonalProviderActiveProvider(
      (id, provider) =>
        id === user.id && (provider === "claude" || provider === "codex"),
    );
    const beforeKey = environmentSourceKeyForUserId(user.id);

    writeManagedUserEnv(user.id, {
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
    expect(env?.OPENAI_API_KEY).toBe("openai");
    expect(env?.ANTHROPIC_API_KEY).toBe("anthropic");
    expect(env?.SHARED).toBe("user");
    expect(env?.CLAUDE_CONFIG_DIR).toBe("/explicit/claude");
    expect(env?.CODEX_HOME).toBe(personalProviderHome(user.id, "codex"));
    expect(firstKey).not.toBe(beforeKey);

    writeManagedUserEnv(user.id, { OPENCODE_API_KEY: "rotated" });
    expect(environmentSourceKeyForUserId(user.id)).toBe(firstKey);
    expect(environmentSourceRevisionForUserId(user.id)).not.toBe(firstRevision);
    await rm(root, { recursive: true, force: true });
  });

  it("keeps a configured custom path exclusive even when managed storage exists", async () => {
    const user = claimUser("Legacy Env Flow User");
    const root = await mkdtemp(join(tmpdir(), "isomux-custom-flow-"));
    const custom = join(root, "custom.env");
    await writeFile(custom, "SOURCE=custom\n");
    expect(updateUserById(user.id, { envFile: custom }).ok).toBe(true);
    writeManagedUserEnv(user.id, { SOURCE: "managed" });

    expect(buildEnvForUserId(user.id)?.SOURCE).toBe("custom");
    await rm(root, { recursive: true, force: true });
  });
});
