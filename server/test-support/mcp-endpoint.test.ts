// The /mcp endpoint (server/mcp-endpoint.ts) through the real HTTP server and
// the official MCP client: who may connect, the four tools, the refusals that
// keep an outside model from answering a prompt or running a command, and the
// reply wait. Each tool is a REST route underneath, so projection must match
// what REST answers for the same token.

import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getUserByName } from "../users.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import type { ApiTokenCreateRes } from "../../shared/contract-shapes.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await server?.stop();
  server = null;
});

async function spawn(
  srv: TestServer,
  name: string,
  roomId: string,
  owner?: { username: string; userId: string },
): Promise<AgentInfo> {
  const agent = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    owner?.username,
    "claude",
    undefined,
    owner?.userId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

async function mintToken(srv: TestServer, session: string, name = "Claude") {
  const response = await srv.http("/api/me/api-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, expiresInDays: 30 }),
    rawSessionId: session,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as ApiTokenCreateRes;
}

function bearer(
  srv: TestServer,
  token: string,
  path: string,
  init: RequestInit = {},
) {
  return fetch(`${srv.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

async function connect(
  srv: TestServer,
  token: string,
  headers: Record<string, string> = {},
): Promise<Client> {
  const client = new Client({ name: "mcp-endpoint-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${srv.baseUrl}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}`, ...headers },
      },
    }),
  );
  clients.push(client);
  return client;
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

function toolText(result: ToolResult): string {
  return (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

// A successful tool returns its object as structuredContent, or as JSON text.
function toolJson<T>(result: ToolResult): T {
  expect({ isError: !!result.isError, text: toolText(result) }).toMatchObject({
    isError: false,
  });
  if (result.structuredContent !== undefined)
    return result.structuredContent as T;
  return JSON.parse(toolText(result)) as T;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

interface LogEntry {
  direction: "to_agent" | "from_agent";
  sequence: number;
  id: string;
  text: string;
  targetAgentId?: string;
}

async function tokenLog(srv: TestServer, token: string): Promise<LogEntry[]> {
  const response = await bearer(srv, token, "/api/me/api-token-inbox/drain", {
    method: "POST",
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { entries: LogEntry[] }).entries;
}

async function waitUntil(pred: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await Bun.sleep(10);
  }
}

function agentOf(srv: TestServer, id: string): AgentInfo {
  const agent = srv.agentManager.getAllAgents().find((a) => a.id === id);
  if (!agent) throw new Error(`agent ${id} not found`);
  return agent;
}

function sentTexts(srv: TestServer, agentId: string): string[] {
  return srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));
}

function userMessages(srv: TestServer, agentId: string): string[] {
  return srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "user_message")
    .map((e) => e.content);
}

async function ownerOffice(srv: TestServer) {
  const owner = await srv.seedOwner("Morgan");
  const userId = getUserByName(owner.username)!.id;
  const room = srv.agentManager.getRooms()[0].id;
  return { owner, userId, room };
}

describe("/mcp authentication", () => {
  it("takes a personal API token only, ignores a foreign Origin, and marks only the two reads read-only", async () => {
    const srv = await startTestServer();
    server = srv;
    const { owner, userId, room } = await ownerOffice(srv);
    const agent = await spawn(srv, "Worker", room, {
      username: owner.username,
      userId,
    });
    const minted = await mintToken(srv, owner.rawSessionId);
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    });
    const post = (headers: Record<string, string>, useCookie = false) =>
      useCookie
        ? srv.http("/mcp", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...headers,
            },
            body: initialize,
            rawSessionId: owner.rawSessionId,
          })
        : fetch(`${srv.baseUrl}/mcp`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...headers,
            },
            body: initialize,
          });

    const anonymous = await post({});
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toStartWith("Bearer");
    expect((await anonymous.json()).error.code).toBe("unauthenticated");

    // The member's own browser session does not open /mcp: the cookie is
    // never read there.
    const cookieOnly = await post({}, true);
    expect(cookieOnly.status).toBe(401);
    expect((await cookieOnly.json()).error.code).toBe("unauthenticated");

    const agentToken = await post({
      Authorization: `Bearer ${mintAgentToken(agent.id, userId)}`,
    });
    expect(agentToken.status).toBe(403);
    expect((await agentToken.json()).error.code).toBe("forbidden");

    // Stateless: no SSE stream to open.
    const get = await bearer(srv, minted.token, "/mcp", {
      headers: { Accept: "text/event-stream" },
    });
    expect(get.status).toBe(405);

    // Claude's servers may send their own Origin. A bearer is not an
    // ambient credential, so it must not matter.
    const client = await connect(srv, minted.token, {
      Origin: "https://claude.ai",
    });

    // The four tools; clients auto-approve the ones marked read-only.
    const { tools } = await client.listTools();
    const readOnly = Object.fromEntries(
      tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint === true]),
    );
    expect(readOnly).toEqual({
      list_agents: true,
      read_conversation: true,
      send_message: false,
      read_replies: false,
    });
  });
});

describe("/mcp tools", () => {
  it("sends as the token, reads the chat, and waits for the agent's reply", async () => {
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({ session: { manualSend: true } }),
    });
    server = srv;
    const { owner, userId, room } = await ownerOffice(srv);
    const agent = await spawn(srv, "Worker", room, {
      username: owner.username,
      userId,
    });
    const minted = await mintToken(srv, owner.rawSessionId);
    const client = await connect(srv, minted.token);

    const listed = toolJson<
      Array<{ id: string; name: string; pendingPrompt: string | null }>
    >(await call(client, "list_agents", {}));
    expect(listed.find((row) => row.id === agent.id)).toMatchObject({
      name: "Worker",
      pendingPrompt: null,
    });

    const sent = toolJson<{ messageId: string; sequence: number }>(
      await call(client, "send_message", {
        agentId: agent.id,
        text: "what blocks the release?",
      }),
    );
    await waitUntil(
      () => sentTexts(srv, agent.id).length > 0,
      "the backend received the message",
    );
    // The agent sees the member's API-token label, so it knows where to
    // reply.
    expect(sentTexts(srv, agent.id)[0]).toContain(
      `(${minted.apiToken.id}))] what blocks the release?`,
    );
    // `sequence` is the send's own entry in the token log: the cursor the
    // model hands to read_replies.
    const log = await tokenLog(srv, minted.token);
    expect(log).toMatchObject([
      {
        direction: "to_agent",
        id: sent.messageId,
        sequence: sent.sequence,
        targetAgentId: agent.id,
      },
    ]);
    srv.fakeBackend
      .sessionForAgent(agent.id)!
      .push({ kind: "assistant_text", text: "checking the board" });
    const readChat = async (limit: number) =>
      toolJson<{ entries: Array<{ kind: string; content: string }> }>(
        await call(client, "read_conversation", { agentId: agent.id, limit }),
      ).entries;
    await waitUntil(
      () =>
        srv.agentManager
          .getAgentLogs(agent.id)
          .some((e) => e.content === "checking the board"),
      "the reply is in the log",
    );
    // `limit` keeps the newest entries, oldest first.
    const newest = await readChat(1);
    expect(newest).toHaveLength(1);
    expect(newest[0].content).toBe("checking the board");
    const two = await readChat(2);
    expect(two).toHaveLength(2);
    expect(two[0].kind).toBe("user_message");
    expect(two[0].content).toContain("what blocks the release?");
    expect(two[1].content).toBe("checking the board");

    // The REST send reports the same field. The agent is busy, so this one
    // waits in its queue; the token log takes it all the same.
    const restSend = await bearer(
      srv,
      minted.token,
      `/api/agents/${agent.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "and the ETA?" }),
      },
    );
    expect(restSend.status).toBe(200);
    expect((await restSend.json()).sequence).toBe(sent.sequence + 1);

    // read_replies returns as soon as the agent writes to the inbox, well
    // before its wait ends.
    const replyAt = Date.now();
    const waiting = call(client, "read_replies", {
      after: sent.sequence + 1,
      waitSeconds: 25,
    });
    await Bun.sleep(300);
    const reply = await bearer(
      srv,
      mintAgentToken(agent.id, userId),
      `/api/api-token-inboxes/${minted.apiToken.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "nothing blocks it" }),
      },
    );
    expect(reply.status).toBe(200);
    const replies = toolJson<{
      entries: LogEntry[];
      latestSequence: number;
    }>(await waiting);
    const elapsed = Date.now() - replyAt;
    expect(replies.entries).toMatchObject([
      { direction: "from_agent", text: "nothing blocks it" },
    ]);
    expect(replies.entries[0].sequence).toBeGreaterThan(sent.sequence + 1);
    expect(replies.latestSequence).toBe(replies.entries[0].sequence);
    expect(elapsed).toBeLessThan(5_000);

    // Nothing new after the cursor: the tool waits out its wait, then
    // returns no entries.
    const quietAt = Date.now();
    const quiet = toolJson<{ entries: LogEntry[]; latestSequence: number }>(
      await call(client, "read_replies", {
        after: replies.latestSequence,
        waitSeconds: 0.2,
      }),
    );
    expect(quiet.entries).toEqual([]);
    expect(quiet.latestSequence).toBe(replies.latestSequence);
    expect(Date.now() - quietAt).toBeGreaterThanOrEqual(150);

    srv.fakeBackend.sessionForAgent(agent.id)?.releaseSends();
  });
});

describe("/mcp send_message refusals", () => {
  function parkingBackend(): FakeBackend {
    return new FakeBackend({
      storedSessionState: "durable",
      session: {
        onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
      },
    });
  }

  it("never answers a permission prompt, while a REST token send still does", async () => {
    const srv = await startTestServer({ fakeBackend: parkingBackend() });
    server = srv;
    const { owner, userId, room } = await ownerOffice(srv);
    const agent = await spawn(srv, "Worker", room, {
      username: owner.username,
      userId,
    });
    // The turn stays open (the backend never ends it), so do not await it.
    void srv.agentManager.sendMessage(
      agent.id,
      "run something",
      owner.username,
    );
    await waitUntil(
      () => agentOf(srv, agent.id).state === "thinking",
      "turn running",
    );
    srv.fakeBackend.sessionForAgent(agent.id)!.push({
      kind: "approval_request",
      approvalId: "ap-1",
      toolName: "Bash",
      input: { command: "rm -rf build" },
    });
    await waitUntil(
      () => agentOf(srv, agent.id).pendingPrompt === "permission",
      "parked on a permission prompt",
    );
    const approvals = () =>
      srv.fakeBackend.sessions
        .filter((s) => s.opts.agentId === agent.id)
        .flatMap((s) => s.approvals);
    const minted = await mintToken(srv, owner.rawSessionId);
    const client = await connect(srv, minted.token);

    // list_agents shows the model why a send will be refused.
    expect(
      toolJson<Array<{ id: string; pendingPrompt: string | null }>>(
        await call(client, "list_agents", {}),
      ).find((row) => row.id === agent.id),
    ).toMatchObject({ pendingPrompt: "permission" });

    const userMessagesBefore = userMessages(srv, agent.id);
    const refused = await call(client, "send_message", {
      agentId: agent.id,
      text: "1",
    });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toContain("awaits_member_answer");
    expect(agentOf(srv, agent.id).pendingPrompt).toBe("permission");
    expect(approvals()).toEqual([]);
    expect(userMessages(srv, agent.id)).toEqual(userMessagesBefore);
    expect(await tokenLog(srv, minted.token)).toEqual([]);

    // Control: the same parked state, the same token, through REST. The
    // message IS the answer there (docs/developer-api.md).
    const rest = await bearer(
      srv,
      minted.token,
      `/api/agents/${agent.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "1" }),
      },
    );
    expect(rest.status).toBe(200);
    await waitUntil(() => approvals().length === 1, "REST send answered");
    expect(agentOf(srv, agent.id).pendingPrompt).toBe(null);
  });

  it("never picks from or cancels a choice card", async () => {
    const srv = await startTestServer();
    server = srv;
    const { owner, userId, room } = await ownerOffice(srv);
    const agent = await spawn(srv, "Worker", room, {
      username: owner.username,
      userId,
    });
    await srv.agentManager.sendMessage(agent.id, "/model", owner.username);
    expect(agentOf(srv, agent.id).pendingPrompt).toBe("model");
    const cards = srv.agentManager.getPendingInteractions();
    expect(cards).toHaveLength(1);
    const minted = await mintToken(srv, owner.rawSessionId);
    const client = await connect(srv, minted.token);

    // A number would pick; any other text would cancel the card.
    for (const text of ["1", "never mind"]) {
      const refused = await call(client, "send_message", {
        agentId: agent.id,
        text,
      });
      expect(refused.isError).toBe(true);
      expect(toolText(refused)).toContain("awaits_member_answer");
    }
    expect(agentOf(srv, agent.id).pendingPrompt).toBe("model");
    expect(srv.agentManager.getPendingInteractions()).toEqual(cards);
    expect(await tokenLog(srv, minted.token)).toEqual([]);
  });

  it("does not run a slash command", async () => {
    const srv = await startTestServer();
    server = srv;
    const { owner, userId, room } = await ownerOffice(srv);
    const agent = await spawn(srv, "Worker", room, {
      username: owner.username,
      userId,
    });
    await srv.agentManager.sendMessage(agent.id, "hello", owner.username);
    await waitUntil(
      () => srv.agentManager.getCurrentSessionId(agent.id) !== null,
      "the agent has a session",
    );
    const sessionBefore = srv.agentManager.getCurrentSessionId(agent.id);
    const sentBefore = sentTexts(srv, agent.id);
    const minted = await mintToken(srv, owner.rawSessionId);
    const client = await connect(srv, minted.token);

    const refused = await call(client, "send_message", {
      agentId: agent.id,
      text: "/clear",
    });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toContain("command_not_allowed");
    expect(srv.agentManager.getCurrentSessionId(agent.id)).toBe(sessionBefore);
    expect(sentTexts(srv, agent.id)).toEqual(sentBefore);
    expect(await tokenLog(srv, minted.token)).toEqual([]);
  });
});

describe("/mcp room projection", () => {
  it("reaches only the agents REST lets the token reach", async () => {
    const srv = await startTestServer();
    server = srv;
    const { owner } = await ownerOffice(srv);
    const member = await srv.seedMember("Mia");
    const open = srv.agentManager.createRoom("Open");
    const closed = srv.agentManager.createRoom("Closed");
    const grant = await srv.http(`/api/users/${member.username}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRooms: [open] }),
      rawSessionId: owner.rawSessionId,
    });
    expect(grant.status).toBe(200);
    const visible = await spawn(srv, "Visible", open);
    const hidden = await spawn(srv, "Hidden", closed);
    const minted = await mintToken(srv, member.rawSessionId);
    const client = await connect(srv, minted.token);

    const ids = toolJson<Array<{ id: string }>>(
      await call(client, "list_agents", {}),
    ).map((row) => row.id);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(hidden.id);

    // The tool reports what REST answers the same token for the same agent.
    const restSend = await bearer(
      srv,
      minted.token,
      `/api/agents/${hidden.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      },
    );
    expect(restSend.status).toBeGreaterThanOrEqual(400);
    const restSendCode = (await restSend.json()).error.code as string;
    const send = await call(client, "send_message", {
      agentId: hidden.id,
      text: "hi",
    });
    expect(send.isError).toBe(true);
    expect(toolText(send)).toContain(restSendCode);
    expect(sentTexts(srv, hidden.id)).toEqual([]);

    const restRead = await bearer(
      srv,
      minted.token,
      `/api/agents/${hidden.id}/sessions`,
    );
    expect(restRead.status).toBeGreaterThanOrEqual(400);
    const restReadCode = (await restRead.json()).error.code as string;
    const read = await call(client, "read_conversation", {
      agentId: hidden.id,
    });
    expect(read.isError).toBe(true);
    expect(toolText(read)).toContain(restReadCode);
  });
});
