// session_context carries the Claude families limited in the member's own env
// (office plus personal variables), and goes out again when either is saved.
import { afterEach, beforeEach, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";

const HOST_VARIABLES = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "CLOUD_ML_REGION",
  "VERTEX_REGION_CLAUDE_5_5_SONNET",
  "VERTEX_REGION_CLAUDE_HAIKU_5_5",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
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
  const morgan = await srv.seedOwner("Morgan");
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
  const morganAgent = await spawn("Morgan haiku", morgan.username);
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
  // GET /agents and agents-summary.json report the mode and the model id the
  // agent runs with.
  const reported = async (
    agentId: string,
    field: "permissionMode" | "model",
  ) => {
    const response = await srv.http("/agents", {
      rawSessionId: morgan.rawSessionId,
    });
    const find = (entries: Record<string, string>[]) =>
      entries.find((entry) => entry.id === agentId)?.[field];
    return [
      find(await response.json()),
      find(
        JSON.parse(
          readFileSync(join(srv.stateRoot, "agents-summary.json"), "utf8"),
        ),
      ),
    ];
  };
  const reportedModes = (agentId: string) =>
    reported(agentId, "permissionMode");
  const agentModels = (agentId: string) =>
    srv.agentManager.getAgent(agentId)?.claudeFamilyModels;
  const modelsIn = (message: Record<string, unknown>) =>
    (message.context as { claudeFamilyModels?: object }).claudeFamilyModels;
  const morganSocket = await srv.connectWs(morgan.rawSessionId);
  const memberSocket = await srv.connectWs(member.rawSessionId);
  try {
    const firstContext = await morganSocket.waitFor("session_context");
    expect(limitedIn(firstContext)).toEqual([]);
    expect(modelsIn(firstContext)).toEqual({});
    expect(limitedIn(await memberSocket.waitFor("session_context"))).toEqual(
      [],
    );
    expect(agentModels(memberAgent)).toEqual({});
    expect(await reported(memberAgent, "model")).toEqual([
      "claude-haiku-5-5",
      "claude-haiku-5-5",
    ]);
    expect(agentLimits(morganAgent)).toEqual([]);
    expect(agentLimits(memberAgent)).toEqual([]);
    expect(await reportedModes(memberAgent)).toEqual(["auto", "auto"]);

    morganSocket.messages.length = 0;
    memberSocket.messages.length = 0;
    expect(
      (
        await put("/api/office/env", morgan.rawSessionId, {
          CLAUDE_CODE_USE_VERTEX: "1",
        })
      ).status,
    ).toBe(204);
    const vertexContext = await morganSocket.waitFor("session_context");
    expect(limitedIn(vertexContext)).toEqual(["sonnet", "haiku"]);
    expect(modelsIn(vertexContext)).toEqual({
      sonnet: "claude-sonnet-4-5",
      haiku: "claude-haiku-4-5",
    });
    expect(limitedIn(await memberSocket.waitFor("session_context"))).toEqual([
      "sonnet",
      "haiku",
    ]);
    expect(agentLimits(morganAgent)).toEqual(["sonnet", "haiku"]);
    expect(agentLimits(memberAgent)).toEqual(["sonnet", "haiku"]);
    expect(agentUpdates(morganSocket.messages, memberAgent)).toHaveLength(1);
    // The stored Auto stays; the agent runs it as default.
    expect(srv.agentManager.getAgent(memberAgent)?.permissionMode).toBe("auto");
    expect(await reportedModes(memberAgent)).toEqual(["default", "default"]);
    expect(agentModels(memberAgent)).toEqual({
      sonnet: "claude-sonnet-4-5",
      haiku: "claude-haiku-4-5",
    });
    expect(await reported(memberAgent, "model")).toEqual([
      "claude-haiku-4-5",
      "claude-haiku-4-5",
    ]);

    // A personal 5.5 pin lifts haiku for that member only.
    morganSocket.messages.length = 0;
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
      morganSocket.messages.some(
        (message) => (message as { type?: string }).type === "session_context",
      ),
    ).toBe(false);
    expect(agentLimits(memberAgent)).toEqual(["sonnet"]);
    expect(agentLimits(morganAgent)).toEqual(["sonnet", "haiku"]);
    expect(agentUpdates(morganSocket.messages, memberAgent)).toHaveLength(1);
    expect(agentUpdates(morganSocket.messages, morganAgent)).toEqual([]);
    expect(await reportedModes(memberAgent)).toEqual(["auto", "auto"]);
    expect(await reportedModes(morganAgent)).toEqual(["default", "default"]);
    expect(await reported(memberAgent, "model")).toEqual([
      "claude-haiku-5-5",
      "claude-haiku-5-5",
    ]);
    expect(await reported(morganAgent, "model")).toEqual([
      "claude-haiku-4-5",
      "claude-haiku-4-5",
    ]);
    // A supported office region moves unpinned families to the current models.
    morganSocket.messages.length = 0;
    memberSocket.messages.length = 0;
    expect(
      (
        await put("/api/office/env", morgan.rawSessionId, {
          CLAUDE_CODE_USE_VERTEX: "1",
          CLOUD_ML_REGION: "global",
        })
      ).status,
    ).toBe(204);
    const coveredContext = await morganSocket.waitFor("session_context");
    expect(limitedIn(coveredContext)).toEqual([]);
    expect(modelsIn(coveredContext)).toEqual({});
    expect(agentLimits(morganAgent)).toEqual([]);
    expect(agentModels(morganAgent)).toEqual({});
    expect(await reportedModes(morganAgent)).toEqual(["auto", "auto"]);
    expect(await reported(morganAgent, "model")).toEqual([
      "claude-haiku-5-5",
      "claude-haiku-5-5",
    ]);

    // A member's old-model pin still wins over that office default.
    memberSocket.messages.length = 0;
    expect(
      (
        await put("/api/users/Member/env", member.rawSessionId, {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5@20251001",
        })
      ).status,
    ).toBe(204);
    expect(limitedIn(await memberSocket.waitFor("session_context"))).toEqual([
      "haiku",
    ]);
    expect(agentLimits(memberAgent)).toEqual(["haiku"]);
    expect(agentLimits(morganAgent)).toEqual([]);
    expect(await reportedModes(memberAgent)).toEqual(["default", "default"]);
    expect(await reported(memberAgent, "model")).toEqual([
      "claude-haiku-4-5@20251001",
      "claude-haiku-4-5@20251001",
    ]);
  } finally {
    morganSocket.close();
    memberSocket.close();
  }
});
