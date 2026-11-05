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
    whatsapp: fakeApp("whatsapp", calls),
    discord: fakeApp("discord", calls),
    routeApp: (agentId, routeId) => {
      calls.push(`routeApp ${agentId} ${routeId}`);
      return own[`${agentId} ${routeId}`] ?? null;
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
