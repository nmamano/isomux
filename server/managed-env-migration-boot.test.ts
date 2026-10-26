import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "fs";
import { dirname, join } from "path";

import { managedOfficeEnvPath } from "./user-env.ts";
import { startTestServer, type TestServer } from "./test-support/harness.ts";
import { removeStateDir } from "./test-support/temp-state.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
  removeStateDir(dirname(managedOfficeEnvPath()));
});

describe("managed env migration at real boot", () => {
  it("preserves the poisoned office import marker and surfaces a safe error", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
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
    // One line from the migration, and no value in it.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("[managed env migration]");

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
    // The spawn refusal names the file to fix, never its values.
    expect(visibleError).toContain(officePath);
    expect(lines.join("\n")).not.toContain(secret1);
    expect(lines.join("\n")).not.toContain(secret2);
    expect(visibleError).not.toContain(secret1);
    expect(visibleError).not.toContain(secret2);
  });
});
