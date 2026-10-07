// session_context carries the Claude families limited in the member's own env
// (office plus personal variables), and goes out again when either is saved.
import { afterEach, beforeEach, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";

const HOST_VARIABLES = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];
const saved: Record<string, string | undefined> = {};
let server: TestServer | null = null;

beforeEach(() => {
  for (const name of HOST_VARIABLES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  await server?.stop();
  server = null;
  for (const name of HOST_VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

it("sends each member and each agent the families limited in its own env, again after a save", async () => {
  const srv = (server = await startTestServer());
  const boss = await srv.seedOwner("Boss");
  const member = await srv.seedMember("Member");
  const room = srv.agentManager.getRooms()[0];
  const spawn = async (name: string, username: string) => {
    const info = await srv.agentManager.spawn(
      name,
      srv.stateRoot,
      "auto",
      undefined,
      undefined,
      room.id,
      undefined,
      "haiku",
      undefined,
      username,
      "claude",
    );
    if (!info) throw new Error(`spawn ${name} returned null`);
    return info.id;
  };
  const bossAgent = await spawn("Boss haiku", boss.username);
  const memberAgent = await spawn("Member haiku", member.username);
  const agentLimits = (agentId: string) =>
    srv.agentManager.getAgent(agentId)?.limitedClaudeFamilies;
  const agentUpdates = (messages: unknown[], agentId: string) =>
    messages.filter((message) => {
      const event = message as {
        type?: string;
        agentId?: string;
        changes?: { limitedClaudeFamilies?: string[] };
      };
      return (
        event.type === "agent_updated" &&
        event.agentId === agentId &&
        event.changes?.limitedClaudeFamilies !== undefined
      );
    });
  const put = (path: string, cookie: string, values: Record<string, string>) =>
    srv.http(path, {
      method: "PUT",
      rawSessionId: cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    });
  const limitedIn = (message: Record<string, unknown>) =>
    (message.context as { limitedClaudeFamilies?: string[] })
      .limitedClaudeFamilies;
  const bossSocket = await srv.connectWs(boss.rawSessionId);
  const memberSocket = await srv.connectWs(member.rawSessionId);
  try {
    expect(limitedIn(await bossSocket.waitFor("session_context"))).toEqual([]);
    expect(limitedIn(await memberSocket.waitFor("session_context"))).toEqual(
      [],
    );
    expect(agentLimits(bossAgent)).toEqual([]);
    expect(agentLimits(memberAgent)).toEqual([]);

    bossSocket.messages.length = 0;
    memberSocket.messages.length = 0;
    expect(
      (
        await put("/api/office/env", boss.rawSessionId, {
          CLAUDE_CODE_USE_VERTEX: "1",
        })
      ).status,
    ).toBe(204);
    expect(limitedIn(await bossSocket.waitFor("session_context"))).toEqual([
      "sonnet",
      "haiku",
    ]);
    expect(limitedIn(await memberSocket.waitFor("session_context"))).toEqual([
      "sonnet",
      "haiku",
    ]);
    expect(agentLimits(bossAgent)).toEqual(["sonnet", "haiku"]);
    expect(agentLimits(memberAgent)).toEqual(["sonnet", "haiku"]);
    expect(agentUpdates(bossSocket.messages, memberAgent)).toHaveLength(1);
    // The stored Auto stays; the agent runs it as default.
    expect(srv.agentManager.getAgent(memberAgent)?.permissionMode).toBe("auto");

    // A personal 5.5 pin lifts haiku for that member only.
    bossSocket.messages.length = 0;
    memberSocket.messages.length = 0;
    expect(
      (
        await put("/api/users/Member/env", member.rawSessionId, {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5-5",
        })
      ).status,
    ).toBe(204);
    expect(limitedIn(await memberSocket.waitFor("session_context"))).toEqual([
      "sonnet",
    ]);
    expect(
      bossSocket.messages.some(
        (message) => (message as { type?: string }).type === "session_context",
      ),
    ).toBe(false);
    expect(agentLimits(memberAgent)).toEqual(["sonnet"]);
    expect(agentLimits(bossAgent)).toEqual(["sonnet", "haiku"]);
    expect(agentUpdates(bossSocket.messages, memberAgent)).toHaveLength(1);
    expect(agentUpdates(bossSocket.messages, bossAgent)).toEqual([]);
  } finally {
    bossSocket.close();
    memberSocket.close();
  }
});
