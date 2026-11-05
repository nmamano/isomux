// Discord routes (opIds discord.* and discordRoutes.*, task 7fd44c30) through
// the real route table and server: a member's own empty lists, a connect
// refused on its body before any call to Discord, and a route or bot that is
// not the member's. Who may call them is pinned in routes-table.test.ts; the
// rules in server/discord/routes.test.ts and supervisor.test.ts.
//
// Seam: startTestServer(). No bot is stored at boot, so no child starts and
// nothing reaches Discord.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function api(
  srv: TestServer,
  path: string,
  rawSessionId: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers:
      init.body !== undefined ? { "Content-Type": "application/json" } : {},
    rawSessionId,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

describe("discord routes", () => {
  it("a member's bots and routes start empty; a connect with no token is refused before any call; another bot or route is not found", async () => {
    const srv = (server = await startTestServer());
    await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    for (const path of ["/api/discord", "/api/discord/routes"])
      expect(await api(srv, path, mia.rawSessionId)).toEqual({
        status: 200,
        body: [],
      });

    for (const body of [{}, { token: "" }, { token: 5 }])
      expect({
        body,
        status: (
          await api(srv, "/api/discord/bots", mia.rawSessionId, {
            method: "POST",
            body,
          })
        ).status,
      }).toEqual({ body, status: 400 });
    expect(existsSync(join(srv.stateRoot, "discord"))).toBe(false);

    const bot = "1100000000000000001";
    expect(
      (await api(srv, `/api/discord/bots/${bot}/guilds`, mia.rawSessionId))
        .status,
    ).toBe(404);
    expect(
      (
        await api(srv, `/api/discord/bots/${bot}`, mia.rawSessionId, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    const created = await api(srv, "/api/discord/routes", mia.rawSessionId, {
      method: "POST",
      body: {
        botId: bot,
        guildId: "1200000000000000001",
        scope: "channel",
        targetId: "1300000000000000002",
        name: "general",
        agentId: "agent-x",
      },
    });
    expect([400, 404]).toContain(created.status);
    for (const method of ["PATCH", "DELETE"])
      expect({
        method,
        status: (
          await api(srv, "/api/discord/routes/r-none", mia.rawSessionId, {
            method,
            ...(method === "PATCH" ? { body: { name: "x" } } : {}),
          })
        ).status,
      }).toEqual({ method, status: 404 });
    expect(
      (await api(srv, "/api/discord/routes", mia.rawSessionId)).body,
    ).toEqual([]);
  });
});
