// The messaging reply handler (task 7fd44c30, slice 2): only an agent
// replies; the body's text, channelId and replyTo reach the replies as sent;
// a post answers 200 with Discord's message id, a draft 202 with its ask, a
// refusal its status and code. The replies are a fake whose answers the test
// picks.

import { describe, expect, it } from "bun:test";
import { messagingHandlers } from "./messaging.ts";
import type { HandlerResult, RouteHandlerContext } from "../executor.ts";
import {
  AGENT_CAPABILITIES,
  USER_CAPABILITIES,
  type Identity,
} from "../../identity/index.ts";
import type {
  MessagingReplyBody,
  MessagingReplyResult,
} from "../../messaging/replies.ts";

const agent: Identity = {
  scope: "agent",
  userId: "u-alice",
  agentId: "agent-a",
  role: "member",
  capabilities: AGENT_CAPABILITIES,
};
const member: Identity = {
  scope: "user",
  userId: "u-alice",
  role: "member",
  capabilities: USER_CAPABILITIES,
};

function rig(result: MessagingReplyResult) {
  const calls: {
    agentId: string;
    routeId: string;
    body: MessagingReplyBody;
  }[] = [];
  const handler = messagingHandlers({
    replies: {
      reply: async (agentId, routeId, body) => {
        calls.push({ agentId, routeId, body });
        return result;
      },
    },
  })["messaging.reply"];
  const run = (identity: Identity, body: unknown) =>
    Promise.resolve(
      handler({
        identity,
        params: { routeId: "d_00000001" },
        body,
        rawBody: "",
        query: new URLSearchParams(),
        req: new Request("http://localhost/"),
      } as RouteHandlerContext),
    ) as Promise<HandlerResult>;
  return { calls, run };
}

describe("messaging.reply", () => {
  it("passes the text, channelId and replyTo on, and a post answers 200 with the message id", async () => {
    const t = rig({ ok: true, sent: true, messageId: "1800000000000000001" });
    const body = {
      text: "hi",
      channelId: "1300000000000000002",
      replyTo: "1700000000000000001",
      other: "dropped",
    };
    expect(await t.run(agent, body)).toEqual({
      kind: "json",
      status: undefined,
      body: { status: "sent", messageId: "1800000000000000001" },
    });
    expect(t.calls).toEqual([
      {
        agentId: "agent-a",
        routeId: "d_00000001",
        body: {
          text: "hi",
          channelId: "1300000000000000002",
          replyTo: "1700000000000000001",
        },
      },
    ]);
  });

  it("a WhatsApp post has no message id; a draft is 202 with its ask; a refusal keeps its status and code", async () => {
    expect(
      await rig({ ok: true, sent: true }).run(agent, { text: "hi" }),
    ).toMatchObject({ body: { status: "sent" } });
    expect(
      (
        (await rig({ ok: true, sent: true }).run(agent, { text: "hi" })) as {
          body: Record<string, unknown>;
        }
      ).body,
    ).not.toHaveProperty("messageId");
    expect(
      await rig({ ok: true, askId: "ask-1" }).run(agent, { text: "hi" }),
    ).toEqual({
      kind: "json",
      status: 202,
      body: { askId: "ask-1", status: "waiting_for_member" },
    });
    expect(
      await rig({
        ok: false,
        status: 400,
        code: "messaging_channel_required",
        error: "name the channel",
      }).run(agent, { text: "hi" }),
    ).toMatchObject({
      kind: "error",
      status: 400,
      code: "messaging_channel_required",
    });
  });

  it("a member is 403 and the replies are not asked", async () => {
    const t = rig({ ok: true, sent: true });
    expect(await t.run(member, { text: "hi" })).toMatchObject({
      kind: "error",
      status: 403,
    });
    expect(t.calls).toEqual([]);
  });
});
