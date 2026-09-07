import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "fs";
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
  it("preserves the poisoned office import marker and surfaces a safe error", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const roomId = server.agentManager.getRooms()[0].id;
    const officePath = join(server.stateRoot, "office-poison.env");
    const secret1 = "sk-live-abcdef0123456789";
    const secret2 = "sk-live-fedcba9876543210";
    writeFileSync(officePath, `${secret1}\n=${secret2}\n`);
    server.agentManager.setOfficeSettings(null, officePath, null);

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
    expect(lines).toEqual([
      "[managed env migration] could not import office variables; retrying on next boot",
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

  it("ignores stale user envFile values across boot and drops them on the next write", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Legacy User");
    const id = getUserByName(member.username)!.id;
    const usersPath = join(server.stateRoot, "users.json");
    const legacyPath = join(server.stateRoot, "legacy-user.env");
    writeFileSync(legacyPath, "LEGACY_ONLY=ignored\n");
    const records = JSON.parse(readFileSync(usersPath, "utf8"));
    records[id].envFile = legacyPath;
    writeFileSync(usersPath, JSON.stringify(records));

    server = await server.restart();
    expect(getUserByName(member.username)).toBeDefined();
    expect(getUserByName(member.username)).not.toHaveProperty("envFile");
    expect(readManagedUserEnv(id)).toBeNull();
    expect(buildEnvForUserId(id)?.LEGACY_ONLY).toBeUndefined();
    expect(updateUserById(id, { memberPrompt: "Updated" }).ok).toBe(true);
    expect(JSON.parse(readFileSync(usersPath, "utf8"))[id]).not.toHaveProperty(
      "envFile",
    );
    expect(readFileSync(legacyPath, "utf8")).toBe("LEGACY_ONLY=ignored\n");
  });
});
