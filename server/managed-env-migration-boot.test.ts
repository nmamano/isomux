import { afterEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { getUserByName, updateUserById } from "./users.ts";
import {
  managedOfficeEnvPath,
  managedUserEnvPath,
  readManagedUserEnv,
} from "./user-env.ts";
import { buildEnvForUserId } from "./env-loader.ts";
import { startTestServer, type TestServer } from "./test-support/harness.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  rmSync(dirname(managedOfficeEnvPath()), { recursive: true, force: true });
  rmSync(dirname(managedUserEnvPath("cleanup")), {
    recursive: true,
    force: true,
  });
});

describe("managed env migration at real boot", () => {
  it("continues past poisoned office and user files and imports other users", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const badKey = await server.seedMember("Bad Key User");
    const badValue = await server.seedMember("Bad Value User");
    const valid = await server.seedMember("Valid User");
    const badKeyId = getUserByName(badKey.username)!.id;
    const roomId = server.agentManager.getRooms()[0].id;
    expect(
      await server.agentManager.spawn(
        "Persisted Pending Import Agent",
        server.stateRoot,
        "default",
        0,
        undefined,
        roomId,
        undefined,
        undefined,
        undefined,
        badKey.username,
        "claude",
        undefined,
        badKeyId,
      ),
    ).not.toBeNull();
    const officePath = join(server.stateRoot, "office-poison.env");
    const badKeyPath = join(server.stateRoot, "bad-key.env");
    const badValuePath = join(server.stateRoot, "bad-value.env");
    const validPath = join(server.stateRoot, "valid.env");
    const secret1 = "sk-live-abcdef0123456789";
    const secret2 = "sk-live-fedcba9876543210";
    writeFileSync(officePath, `${secret1}\n=${secret2}\n`);
    writeFileSync(badKeyPath, "MY-VAR=user-secret\n");
    writeFileSync(badValuePath, 'KEY="user\\nsecret"\n');
    writeFileSync(validPath, "GH_TOKEN=valid-user\n");
    server.agentManager.setOfficeSettings(null, officePath, null);
    expect(updateUserById(badKeyId, { envFile: badKeyPath }).ok).toBe(true);
    expect(
      updateUserById(getUserByName(badValue.username)!.id, {
        envFile: badValuePath,
      }).ok,
    ).toBe(true);
    const validId = getUserByName(valid.username)!.id;
    expect(updateUserById(validId, { envFile: validPath }).ok).toBe(true);

    const lines: string[] = [];
    const prior = console.error;
    console.error = (...args: unknown[]) =>
      lines.push(args.map(String).join(" "));
    try {
      server = await server.restart();
    } finally {
      console.error = prior;
    }

    expect(server.agentManager.getOfficeSettings().envFile).toBe(officePath);
    expect(getUserByName(badKey.username)!.envFile).toBe(badKeyPath);
    expect(getUserByName(badValue.username)!.envFile).toBe(badValuePath);
    expect(getUserByName(valid.username)!.envFile).toBeNull();
    expect(readManagedUserEnv(validId)).toEqual({ GH_TOKEN: "valid-user" });
    expect(lines).toEqual([
      "[managed env migration] could not import office variables; retrying on next boot",
      '[managed env migration] could not import user "Bad Key User"; retrying on next boot',
      '[managed env migration] could not import user "Bad Value User"; retrying on next boot',
    ]);
    expect(lines.join("\n")).not.toContain("secret");

    const response = await server.http("/api/agents", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Pending Import Agent",
        cwd: server.stateRoot,
        roomId,
        desk: 1,
        permissionMode: "default",
      }),
    });
    const visibleError = await response.text();
    expect(response.status).toBe(500);
    expect(visibleError).toContain(
      `The env file ${officePath} could not be imported into managed variables: fix it so it parses (one NAME=value per line) or delete it, then restart isomux.`,
    );
    expect(lines.join("\n")).not.toContain(secret1);
    expect(lines.join("\n")).not.toContain(secret2);
    expect(visibleError).not.toContain(secret1);
    expect(visibleError).not.toContain(secret2);
  });

  it("retries an invalid import across boots and completes a valid import once", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const invalid = await server.seedMember("Invalid Import User");
    const valid = await server.seedMember("Valid Import User");
    const invalidPath = join(server.stateRoot, "invalid.env");
    const validPath = join(server.stateRoot, "valid.env");
    writeFileSync(invalidPath, "MY-VAR=1\n");
    writeFileSync(validPath, "GH_TOKEN=valid-token\n");
    const invalidId = getUserByName(invalid.username)!.id;
    const validId = getUserByName(valid.username)!.id;
    expect(updateUserById(invalidId, { envFile: invalidPath }).ok).toBe(true);
    expect(updateUserById(validId, { envFile: validPath }).ok).toBe(true);

    server = await server.restart();
    expect(getUserByName(invalid.username)!.envFile).toBe(invalidPath);
    expect(getUserByName(valid.username)!.envFile).toBeNull();
    expect(() => buildEnvForUserId(invalidId)).toThrow(invalidPath);
    expect(buildEnvForUserId(validId)?.GH_TOKEN).toBe("valid-token");

    server = await server.restart();
    expect(getUserByName(invalid.username)!.envFile).toBe(invalidPath);
    expect(getUserByName(valid.username)!.envFile).toBeNull();
    expect(() => buildEnvForUserId(invalidId)).toThrow(invalidPath);
    expect(buildEnvForUserId(validId)?.GH_TOKEN).toBe("valid-token");
  });
});
