// The reply route's dispatch by app (task 7fd44c30, slice 2): a route that is
// not the caller's is the same 404 in either app, before any field check; a
// WhatsApp row refuses Discord's fields; each app gets its own replies and
// its own drafts' answers. The apps are fakes that record their calls; what
// each app does is in server/whatsapp/replies.test.ts and
// server/discord/replies.test.ts.

import { describe, expect, it } from "bun:test";
import type { AskEntry } from "../../shared/types.ts";
import {
  createMessagingReplies,
  type MessagingAppReplies,
  type MessagingReadOutcome,
  type MessagingReplyBody,
} from "./replies.ts";

function fakeApp(name: string, calls: string[]): MessagingAppReplies {
  return {
    reply: async (agentId, routeId, body: MessagingReplyBody) => {
      calls.push(`${name}.reply ${agentId} ${routeId} ${JSON.stringify(body)}`);
      return { ok: true, sent: true };
    },
    answer: async (entry) => {
      calls.push(`${name}.answer ${entry.id}`);
      return { kind: "deliver", outcome: "replied", text: name };
    },
  };
}

function harness() {
  const calls: string[] = [];
  // Routes by caller: agent-a owns d_1 (Discord) and r_1 (WhatsApp).
  const own: Record<string, "whatsapp" | "discord"> = {
    "agent-a d_1": "discord",
    "agent-a r_1": "whatsapp",
  };
  const replies = createMessagingReplies({
    whatsapp: {
      ...fakeApp("whatsapp", calls),
      read: (agentId, routeId, limit): MessagingReadOutcome => {
        calls.push(`whatsapp.read ${agentId} ${routeId} ${String(limit)}`);
        return { ok: true, messages: [] };
      },
    },
    discord: fakeApp("discord", calls),
    routeApp: (agentId, routeId) => {
      calls.push(`routeApp ${agentId} ${routeId}`);
      return own[`${agentId} ${routeId}`] ?? null;
    },
    routesOf: {
      whatsapp: (agentId) => {
        calls.push(`whatsapp.routesOf ${agentId}`);
        return agentId === "agent-a"
          ? [
              { id: "r_1", name: "Mom" },
              { id: "r_2", name: "Family" },
            ]
          : [];
      },
      discord: (agentId) => {
        calls.push(`discord.routesOf ${agentId}`);
        return agentId === "agent-a" ? [{ id: "d_1", name: "general" }] : [];
      },
    },
  });
  return { calls, replies };
}

const entry = (app: string): AskEntry =>
  ({
    id: `ask-${app}`,
    agentId: "agent-a",
    memberUserId: "u-alice",
    prompt: "draft",
    messaging: { app, routeId: "x", text: "hi" },
  }) as AskEntry;

describe("messaging replies: the dispatch", () => {
  it("a route that is not the caller's is one 404 for every agent and body, and no app is asked", async () => {
    const { calls, replies } = harness();
    const results = [];
    for (const [agentId, routeId, body] of [
      ["agent-a", "d_9", { text: "hi" }],
      ["agent-b", "d_1", { text: "hi" }],
      ["agent-b", "r_1", { text: 5, channelId: "x" }],
      ["agent-b", "r_1", { text: "hi", channelId: "1300000000000000002" }],
    ] as const)
      results.push(await replies.reply(agentId, routeId, body));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]).toMatchObject({
      ok: false,
      status: 404,
      code: "not_found",
    });
    expect(calls.filter((c) => !c.startsWith("routeApp"))).toEqual([]);
  });

  it("each app gets its own route's replies with the body as sent", async () => {
    const { calls, replies } = harness();
    const discordBody = {
      text: "hi",
      channelId: "1300000000000000002",
      replyTo: "1700000000000000001",
    };
    expect((await replies.reply("agent-a", "d_1", discordBody)).ok).toBe(true);
    expect((await replies.reply("agent-a", "r_1", { text: "yo" })).ok).toBe(
      true,
    );
    expect(calls.filter((c) => !c.startsWith("routeApp"))).toEqual([
      `discord.reply agent-a d_1 ${JSON.stringify(discordBody)}`,
      `whatsapp.reply agent-a r_1 ${JSON.stringify({ text: "yo" })}`,
    ]);
  });

  it("a WhatsApp row with a channelId or a replyTo is 400 and WhatsApp is not asked", async () => {
    const { calls, replies } = harness();
    for (const body of [
      { text: "hi", channelId: "1300000000000000002" },
      { text: "hi", replyTo: "1700000000000000001" },
    ]) {
      const r = await replies.reply("agent-a", "r_1", body);
      expect({ body, status: r.ok ? 200 : r.status }).toEqual({
        body,
        status: 400,
      });
    }
    expect(calls.filter((c) => c.startsWith("whatsapp"))).toEqual([]);
  });

  it("a draft's answer goes to its own app; a draft of an app this release does not know never reaches Discord", async () => {
    const { calls, replies } = harness();
    expect(
      await replies.answer(entry("discord"), {
        dismissed: false,
        text: "Send",
      }),
    ).toMatchObject({ text: "discord" });
    expect(
      await replies.answer(entry("whatsapp"), {
        dismissed: false,
        text: "Send",
      }),
    ).toMatchObject({ text: "whatsapp" });
    await replies.answer(entry("telegram"), { dismissed: false, text: "Send" });
    expect(calls.filter((c) => c.includes(".answer"))).toEqual([
      "discord.answer ask-discord",
      "whatsapp.answer ask-whatsapp",
      "whatsapp.answer ask-telegram",
    ]);
  });
});

// An agent reads its route (task 682fd65a): WhatsApp only.
describe("messaging replies: read", () => {
  it("a route that is not the caller's is the reply's 404, and no app is asked", async () => {
    const { calls, replies } = harness();
    const reply404 = await replies.reply("agent-b", "r_1", { text: "hi" });
    for (const [agentId, routeId] of [
      ["agent-b", "r_1"],
      ["agent-b", "d_1"],
      ["agent-a", "r_9"],
    ])
      expect({
        agentId,
        routeId,
        r: replies.read(agentId, routeId, "5"),
      }).toEqual({ agentId, routeId, r: reply404 as never });
    expect(calls.filter((c) => !c.startsWith("routeApp"))).toEqual([]);
  });

  it("a WhatsApp row is read with the limit as given; a Discord route is 400 and Discord is not asked", () => {
    const { calls, replies } = harness();
    expect(replies.read("agent-a", "r_1", "7")).toEqual({
      ok: true,
      messages: [],
    });
    replies.read("agent-a", "r_1", undefined);
    const discord = replies.read("agent-a", "d_1", "7");
    expect(discord.ok === false && [discord.status, discord.code]).toEqual([
      400,
      "messaging_read_unsupported",
    ]);
    expect(calls.filter((c) => !c.startsWith("routeApp"))).toEqual([
      "whatsapp.read agent-a r_1 7",
      "whatsapp.read agent-a r_1 undefined",
    ]);
  });
});

// An agent lists its own routes (task 682fd65a).
describe("messaging replies: routes", () => {
  it("each app's routes to the agent, WhatsApp first, tagged with the app; none is an empty list", () => {
    const { calls, replies } = harness();
    expect(replies.routes("agent-a")).toEqual([
      { id: "r_1", app: "whatsapp", name: "Mom" },
      { id: "r_2", app: "whatsapp", name: "Family" },
      { id: "d_1", app: "discord", name: "general" },
    ]);
    expect(replies.routes("agent-b")).toEqual([]);
    expect(calls).toEqual([
      "whatsapp.routesOf agent-a",
      "discord.routesOf agent-a",
      "whatsapp.routesOf agent-b",
      "discord.routesOf agent-b",
    ]);
  });
});
