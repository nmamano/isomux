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
