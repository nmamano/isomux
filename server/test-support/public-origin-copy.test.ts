// Hosted isomux: the system prompt names the configured public origin for
// humans, while agent-run curl recipes stay on localhost.
//
// "Active" means buildPublicOrigin() resolves the config origin, which requires a
// claimed office AND externalAccess captured at boot. The config path is
// exercised through the real Access route + restart (not by poking module
// state), and a leftover ISOMUX_PUBLIC_ORIGIN from an older install is ignored.

import { describe, it, expect } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { buildSystemPrompt } from "../system-prompt.ts";

const ORIGIN = "https://office.example";
const ENV_ORIGIN = "https://env.example";
const CURL_RECIPE = "curl -s localhost:";

describe("public-origin-derived prompt", () => {
  it("a config origin lands in the prompt once after a restart, curl recipes stay localhost, and a leftover ISOMUX_PUBLIC_ORIGIN is ignored", async () => {
    const prevEnv = process.env.ISOMUX_PUBLIC_ORIGIN;
    process.env.ISOMUX_PUBLIC_ORIGIN = ENV_ORIGIN;
    let server: TestServer | null = null;
    try {
      const srv0 = await startTestServer();
      server = srv0;
      const owner = await srv0.seedOwner("Morgan");
      const access = async (srv: TestServer) =>
        (
          await srv.http("/api/office/access", {
            rawSessionId: owner.rawSessionId,
          })
        ).json() as Promise<{ externalAccess: boolean; publicOrigin: unknown }>;
      // Boot copies nothing from the env into office-config.json.
      expect(await access(srv0)).toMatchObject({
        externalAccess: false,
        publicOrigin: null,
      });
      const r = await srv0.http("/api/office/access", {
        method: "PUT",
        rawSessionId: owner.rawSessionId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalAccess: true, publicOrigin: ORIGIN }),
      });
      expect(r.status).toBe(200);
      server = await srv0.restart();

      const prompt = buildSystemPrompt("A1", "agent-1", "Test Room", "room-1");
      // The origin appears in the one line for humans, never substituted into
      // a recipe.
      expect(prompt.split(ORIGIN).length - 1).toBe(1);
      expect(prompt).toContain(CURL_RECIPE);
      expect(prompt).not.toContain(ENV_ORIGIN);
    } finally {
      await server?.stop();
      if (prevEnv === undefined) delete process.env.ISOMUX_PUBLIC_ORIGIN;
      else process.env.ISOMUX_PUBLIC_ORIGIN = prevEnv;
    }
  });
});
