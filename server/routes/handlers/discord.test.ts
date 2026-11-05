// The Discord connect handler (task 7fd44c30, slice 3): each refusal of the
// supervisor goes out with its own code and status, so the card can tell a
// wrong token from "try again"; a body with no token is refused before the
// supervisor. The supervisor is a fake whose answers the test picks; what it
// answers when is pinned in server/discord/supervisor.test.ts.

import { describe, expect, it } from "bun:test";
import { discordHandlers } from "./discord.ts";
import type { RouteHandlerContext } from "../executor.ts";
import { USER_CAPABILITIES, type Identity } from "../../identity/index.ts";
import type { DiscordConnectCode } from "../../../shared/discord.ts";
import type { DiscordConnectResult } from "../../discord/supervisor.ts";
import type { DiscordRoutes } from "../../discord/routes.ts";

const member: Identity = {
  scope: "user",
  userId: "u-alice",
  role: "member",
  capabilities: USER_CAPABILITIES,
};

function rig(result: DiscordConnectResult) {
  const tokens: string[] = [];
  const connect = discordHandlers({
    supervisor: {
      list: () => [],
      connect: async (_userId, token) => {
        tokens.push(token);
        return result;
      },
      disconnect: async () => false,
      guilds: () => null,
    },
    routes: {} as DiscordRoutes,
  })["discord.connect"];
  const run = (body: unknown) =>
    Promise.resolve(
      connect({
        identity: member,
        params: {},
        body,
        rawBody: "",
        query: new URLSearchParams(),
        req: new Request("http://localhost/"),
      } as RouteHandlerContext),
    );
  return { tokens, run };
}

describe("discord.connect", () => {
  it("answers each refusal with its own code and status", async () => {
    const cases: [400 | 409, DiscordConnectCode][] = [
      [400, "token_refused"],
      [400, "not_a_bot"],
      [400, "check_failed"],
      [409, "bot_taken"],
      [409, "bots_max"],
      [409, "disconnected"],
    ];
    for (const [status, code] of cases) {
      const t = rig({ ok: false, status, code, error: "refused" });
      expect(await t.run({ token: "fake-token" })).toMatchObject({
        kind: "error",
        status,
        code,
      });
      expect(t.tokens).toEqual(["fake-token"]);
    }
  });

  it("a body with no token is 400 invalid_request and never reaches the supervisor", async () => {
    for (const body of [
      {},
      { token: "" },
      { token: "  " },
      { token: 5 },
      null,
    ]) {
      const t = rig({
        ok: false,
        status: 400,
        code: "token_refused",
        error: "x",
      });
      expect({ body, res: await t.run(body) }).toMatchObject({
        body,
        res: { kind: "error", status: 400, code: "invalid_request" },
      });
      expect(t.tokens).toEqual([]);
    }
  });
});
