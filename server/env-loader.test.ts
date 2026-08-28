import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  environmentSourceKeyForUserId,
  setOfficeEnvFileProvider,
} from "./env-loader.ts";

afterEach(() => setOfficeEnvFileProvider(() => null));

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
      process.env.INVOCATION_ID = "second-start";
      expect(environmentSourceKeyForUserId(null)).toBe(first);

      await writeFile(firstPath, "PROVIDER_KEY=rotated\nUNRELATED=value\n");
      expect(environmentSourceKeyForUserId(null)).toBe(first);

      setOfficeEnvFileProvider(() => secondPath);
      expect(environmentSourceKeyForUserId(null)).not.toBe(first);
    } finally {
      if (priorInvocationId === undefined) delete process.env.INVOCATION_ID;
      else process.env.INVOCATION_ID = priorInvocationId;
      await rm(root, { recursive: true, force: true });
    }
  });
});
