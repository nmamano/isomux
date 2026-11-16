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
  MessagingReadOutcome,
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
      read: () => {
        throw new Error("not a read");
      },
      routes: () => {
        throw new Error("not a list");
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

// An agent reads its route (task 682fd65a).
describe("messaging.read", () => {
  function readRig(result: MessagingReadOutcome) {
    const calls: { agentId: string; routeId: string; limit: unknown }[] = [];
    const handler = messagingHandlers({
      replies: {
        reply: () => {
          throw new Error("not a reply");
        },
        read: (agentId, routeId, limit) => {
          calls.push({ agentId, routeId, limit });
          return result;
        },
        routes: () => {
          throw new Error("not a list");
        },
      },
    })["messaging.read"];
    const run = (identity: Identity, query: string) =>
      Promise.resolve(
        handler({
          identity,
          params: { routeId: "r_00000001" },
          body: undefined,
          rawBody: "",
          query: new URLSearchParams(query),
          req: new Request("http://localhost/"),
        } as RouteHandlerContext),
      ) as Promise<HandlerResult>;
    return { calls, run };
  }
  const messages = [
    { from: "Mom", text: "hi", at: "2027-01-15T08:00:00.000Z" },
    {
      from: "Morgan",
      text: "hello",
      at: "2027-01-15T08:00:01.000Z",
      agent: true as const,
    },
  ];

  it("passes the limit on as given, absent as undefined, and answers 200 with the messages", async () => {
    const t = readRig({ ok: true, messages });
    expect(await t.run(agent, "limit=7")).toEqual({
      kind: "json",
      status: undefined,
      body: { messages },
    });
    await t.run(agent, "");
    expect(t.calls).toEqual([
      { agentId: "agent-a", routeId: "r_00000001", limit: "7" },
      { agentId: "agent-a", routeId: "r_00000001", limit: undefined },
    ]);
  });

  it("a refusal keeps its status and code; a member is 403 and the replies are not asked", async () => {
    const refused = readRig({
      ok: false,
      status: 400,
      code: "messaging_read_unsupported",
      error: "WhatsApp only",
    });
    expect(await refused.run(agent, "")).toMatchObject({
      kind: "error",
      status: 400,
      code: "messaging_read_unsupported",
    });
    const t = readRig({ ok: true, messages });
    expect(await t.run(member, "")).toMatchObject({
      kind: "error",
      status: 403,
    });
    expect(t.calls).toEqual([]);
  });
});

// An agent lists its own routes (task 682fd65a).
describe("messaging.routes", () => {
  function listRig() {
    const calls: string[] = [];
    const handler = messagingHandlers({
      replies: {
        reply: () => {
          throw new Error("not a reply");
        },
        read: () => {
          throw new Error("not a read");
        },
        routes: (agentId) => {
          calls.push(agentId);
          return [{ id: "r_1", app: "whatsapp", name: "Mom" }];
        },
      },
    })["messaging.routes"];
    const run = (identity: Identity) =>
      Promise.resolve(
        handler({
          identity,
          params: {},
          body: undefined,
          rawBody: "",
          query: new URLSearchParams(),
          req: new Request("http://localhost/"),
        } as RouteHandlerContext),
      ) as Promise<HandlerResult>;
    return { calls, run };
  }

  it("answers 200 with the calling agent's routes; a member is 403 and the replies are not asked", async () => {
    const t = listRig();
    expect(await t.run(agent)).toEqual({
      kind: "json",
      status: undefined,
      body: { routes: [{ id: "r_1", app: "whatsapp", name: "Mom" }] },
    });
    expect(await t.run(member)).toMatchObject({ kind: "error", status: 403 });
    expect(t.calls).toEqual(["agent-a"]);
  });
});
