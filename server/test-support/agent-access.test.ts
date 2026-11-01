// The access slider (task e77304b1) through the real HTTP server: the member's
// agents.setAccess route, the pack as limits on the agent's token, the tasks
// an agent below Standard may change, and /mcp for its token. The agent below
// Standard has no shell, so /mcp is its only way into the office; REST with
// its token shows what the executor enforces under every tool.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getUserByName } from "../users.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { API_ROUTES } from "../routes/table.ts";
import { routeAllowedByLimits } from "../../shared/api-token-limits.ts";
import {
  ATTACHMENT_NOT_ALLOWED,
  FOLDER_NOT_ALLOWED,
} from "../../shared/agent-access.ts";
import { AGENT_SENDER_LIMITED } from "../../shared/identity.ts";
import type { AgentInfo, TaskItem } from "../../shared/types.ts";
import { SpawnAccessRefusedError, type SpawnAccess } from "../agent-manager.ts";

let server: TestServer | null = null;
const clients: Client[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

// Each agent gets its own folder outside the office state: the folder rules
// refuse a folder that holds the state or another agent's folder.
function freshFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-access-"));
  folders.push(dir);
  return dir;
}

interface Office {
  srv: TestServer;
  session: string;
  username: string;
  userId: string;
  room: string;
}

async function office(fakeBackend?: FakeBackend): Promise<Office> {
  const srv = await startTestServer(fakeBackend ? { fakeBackend } : {});
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  return {
    srv,
    session: owner.rawSessionId,
    username: owner.username,
    userId: getUserByName(owner.username)!.id,
    room: srv.agentManager.getRooms()[0].id,
  };
}

async function spawn(
  o: Office,
  name: string,
  agentType: AgentInfo["agentType"] = "claude",
  roomId = o.room,
): Promise<AgentInfo> {
  const agent = await o.srv.agentManager.spawn(
    name,
    freshFolder(),
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    o.username,
    agentType,
    undefined,
    o.userId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

interface Res {
  status: number;
  body: unknown;
}

async function asMember(
  o: Office,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await o.srv.http(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    rawSessionId: o.session,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function asToken(
  o: Office,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await fetch(`${o.srv.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const errCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } } | null)?.error?.code;

function setAccess(o: Office, agentId: string, body: unknown): Promise<Res> {
  return asMember(o, "PUT", `/api/agents/${agentId}/access`, body);
}

function tokenOf(agentId: string): string {
  const token = getAgentTokenRaw(agentId);
  if (!token) throw new Error(`no live token for ${agentId}`);
  return token;
}

function agentOf(srv: TestServer, id: string): AgentInfo {
  const agent = srv.agentManager.getAllAgents().find((a) => a.id === id);
  if (!agent) throw new Error(`agent ${id} not found`);
  return agent;
}

// The slider fields of an agent as the wire shows them.
function sliderOf(agent: AgentInfo) {
  return {
    access: agent.access,
    pack: agent.pack,
    privileged: agent.privileged ?? false,
  };
}

async function waitUntil(pred: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await Bun.sleep(10);
  }
}

const TASKS_READ = { areas: { tasks: "read" } } as const;

describe("agents.setAccess", () => {
  it("moves an agent to a stop with a pack: the wire, the token and a restart follow", async () => {
    const o = await office();
    const agent = await spawn(o, "Triage");
    const before = tokenOf(agent.id);

    const moved = await setAccess(o, agent.id, {
      access: "folder",
      pack: TASKS_READ,
    });
    expect(moved.status).toBe(200);
    const wire = (moved.body as { agent: AgentInfo }).agent;
    expect(sliderOf(wire)).toEqual({
      access: "folder",
      pack: TASKS_READ,
      privileged: false,
    });
    expect(sliderOf(agentOf(o.srv, agent.id))).toEqual(sliderOf(wire));

    // The move rotates the token: the old one no longer opens anything.
    expect((await asToken(o, before, "GET", "/api/tasks")).status).toBe(401);
    // The new token carries the pack: tasks read passes, a task write does
    // not.
    const after = tokenOf(agent.id);
    expect(after).not.toBe(before);
    expect((await asToken(o, after, "GET", "/api/tasks")).status).toBe(200);
    const write = await asToken(o, after, "POST", "/api/tasks", {
      title: "not in the pack",
    });
    expect({ status: write.status, code: errCode(write.body) }).toEqual({
      status: 403,
      code: "forbidden",
    });

    // A cold boot reads the stop and the pack back, and mints the boot token
    // with the pack.
    const srv2 = await o.srv.restart();
    server = srv2;
    const o2 = { ...o, srv: srv2 };
    expect(sliderOf(agentOf(srv2, agent.id))).toEqual({
      access: "folder",
      pack: TASKS_READ,
      privileged: false,
    });
    const booted = tokenOf(agent.id);
    expect((await asToken(o2, booted, "GET", "/api/tasks")).status).toBe(200);
    expect(
      (await asToken(o2, booted, "POST", "/api/tasks", { title: "x" })).status,
    ).toBe(403);
  });

  it("kill and revive keep the stop and the pack", async () => {
    const o = await office();
    const agent = await spawn(o, "Triage");
    expect(
      (await setAccess(o, agent.id, { access: "office", pack: TASKS_READ }))
        .status,
    ).toBe(200);
    expect(
      (await asMember(o, "DELETE", `/api/agents/${agent.id}`)).status,
    ).toBe(204);
    const revived = await asMember(
      o,
      "POST",
      `/api/agents/${agent.id}/revive`,
      {
        roomId: o.room,
      },
    );
    expect(revived.status).toBe(200);
    expect(sliderOf(agentOf(o.srv, agent.id))).toEqual({
      access: "office",
      pack: TASKS_READ,
      privileged: false,
    });
    const token = tokenOf(agent.id);
    expect((await asToken(o, token, "GET", "/api/tasks")).status).toBe(200);
    expect(
      (await asToken(o, token, "POST", "/api/tasks", { title: "x" })).status,
    ).toBe(403);
  });

  it("refuses a body that does not fit its stop, and changes nothing", async () => {
    const o = await office();
    const agent = await spawn(o, "Triage");
    const before = tokenOf(agent.id);
    for (const body of [
      { access: "office" },
      { access: "standard", pack: TASKS_READ },
      { access: "chat", pack: TASKS_READ },
      {
        access: "web",
        pack: { areas: { agents: "write" }, repliesOnly: true },
      },
      { access: "folder", pack: { rooms: [o.room] } },
      { access: "root" },
      { privileged: true },
    ]) {
      const res = await setAccess(o, agent.id, body);
      expect({ body, status: res.status, code: errCode(res.body) }).toEqual({
        body,
        status: 422,
        code: "invalid_request",
      });
    }
    expect(sliderOf(agentOf(o.srv, agent.id)).access ?? "standard").toBe(
      "standard",
    );
    expect(tokenOf(agent.id)).toBe(before);
  });

  it("setPrivileged on an agent below Standard is a 409 either way; the slider moves it up", async () => {
    const o = await office();
    const agent = await spawn(o, "Triage");
    expect(
      (await setAccess(o, agent.id, { access: "folder", pack: TASKS_READ }))
        .status,
    ).toBe(200);
    const token = tokenOf(agent.id);
    for (const privileged of [false, true]) {
      const res = await asMember(
        o,
        "PUT",
        `/api/agents/${agent.id}/privileged`,
        {
          privileged,
        },
      );
      expect({ privileged, status: res.status }).toEqual({
        privileged,
        status: 409,
      });
    }
    expect(sliderOf(agentOf(o.srv, agent.id)).access).toBe("folder");
    expect(tokenOf(agent.id)).toBe(token);

    const up = await setAccess(o, agent.id, { access: "privileged" });
    expect(up.status).toBe(200);
    expect(sliderOf((up.body as { agent: AgentInfo }).agent)).toEqual({
      access: "privileged",
      pack: undefined,
      privileged: true,
    });
    // At Privileged, setPrivileged is the switch it always was.
    const down = await asMember(
      o,
      "PUT",
      `/api/agents/${agent.id}/privileged`,
      {
        privileged: false,
      },
    );
    expect(down.status).toBe(200);
    expect(sliderOf(agentOf(o.srv, agent.id))).toEqual({
      access: "standard",
      pack: undefined,
      privileged: false,
    });
  });

  it("only a Claude agent goes below Standard for now, and an agent below Standard cannot change engine", async () => {
    const o = await office();
    for (const agentType of ["codex", "opencode"] as const) {
      const agent = await spawn(o, `On ${agentType}`, agentType);
      const before = tokenOf(agent.id);
      const res = await setAccess(o, agent.id, {
        access: "office",
        pack: TASKS_READ,
      });
      expect({ agentType, status: res.status }).toEqual({
        agentType,
        status: 422,
      });
      expect(sliderOf(agentOf(o.srv, agent.id)).access ?? "standard").toBe(
        "standard",
      );
      expect(tokenOf(agent.id)).toBe(before);
    }

    const claude = await spawn(o, "On claude");
    expect(
      (await setAccess(o, claude.id, { access: "office", pack: TASKS_READ }))
        .status,
    ).toBe(200);
    for (const agentType of ["codex", "opencode"]) {
      const res = await asMember(o, "PATCH", `/api/agents/${claude.id}`, {
        agentType,
      });
      expect({ agentType, status: res.status }).toEqual({
        agentType,
        status: 422,
      });
      expect(agentOf(o.srv, claude.id).agentType).toBe("claude");
    }
    // Back at Standard, the same switch goes through.
    expect((await setAccess(o, claude.id, { access: "standard" })).status).toBe(
      200,
    );
    const switched = await asMember(o, "PATCH", `/api/agents/${claude.id}`, {
      agentType: "codex",
    });
    expect(switched.status).toBe(200);
    expect(agentOf(o.srv, claude.id).agentType).toBe("codex");
  });

  it("a move down ends the running turn and rebuilds the session on the new token; a move up rebuilds it too", async () => {
    const o = await office(new FakeBackend({ session: { manualSend: true } }));
    const agent = await spawn(o, "Worker");
    const sessions = () =>
      o.srv.fakeBackend.sessions.filter((s) => s.opts.agentId === agent.id);

    void o.srv.agentManager
      .sendMessage(agent.id, "long job", "tester")
      .catch(() => {});
    await waitUntil(
      () =>
        sessions().length === 1 &&
        sessions()[0].sent.some((m) => m.text.includes("long job")) &&
        agentOf(o.srv, agent.id).state === "thinking",
      "turn running",
    );
    const running = sessions()[0];

    const down = await setAccess(o, agent.id, {
      access: "folder",
      pack: TASKS_READ,
    });
    expect(down.status).toBe(200);
    // By the time the route answers, the Standard session is gone and its
    // turn is over.
    expect(running.closed || running.abortCount > 0).toBe(true);
    expect(sessions()).toHaveLength(2);
    expect(sessions()[1].opts.env?.ISOMUX_AGENT_TOKEN).toBe(tokenOf(agent.id));
    await waitUntil(
      () => agentOf(o.srv, agent.id).state !== "thinking",
      "the turn ended",
    );

    // Up: no turn to end, but the session is rebuilt for the new tools.
    const up = await setAccess(o, agent.id, { access: "standard" });
    expect(up.status).toBe(200);
    expect(sessions()).toHaveLength(3);
    expect(sessions()[1].closed).toBe(true);
    expect(sessions()[2].opts.env?.ISOMUX_AGENT_TOKEN).toBe(tokenOf(agent.id));
  });
});

describe("the pack limits the agent's token", () => {
  it("at Chat the token opens no area", async () => {
    const o = await office();
    const agent = await spawn(o, "Chatter");
    expect((await setAccess(o, agent.id, { access: "chat" })).status).toBe(200);
    expect(sliderOf(agentOf(o.srv, agent.id))).toEqual({
      access: "chat",
      pack: undefined,
      privileged: false,
    });
    const token = tokenOf(agent.id);
    for (const path of ["/api/tasks", "/agents", "/api/asks"]) {
      const res = await asToken(o, token, "GET", path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    // The agent reference is "always": the refusals above are the pack's.
    expect(
      (await asToken(o, token, "GET", "/api/agent-reference")).status,
    ).toBe(200);
  });

  it("the pack's rooms limit what the token sees", async () => {
    const o = await office();
    const other = o.srv.agentManager.createRoom("Other");
    const inHome = await spawn(o, "Home peer");
    const inOther = await spawn(o, "Other peer", "claude", other);
    const agent = await spawn(o, "Triage");
    expect(
      (
        await setAccess(o, agent.id, {
          access: "office",
          pack: { areas: { agents: "read" }, rooms: [other] },
        })
      ).status,
    ).toBe(200);
    const listed = await asToken(o, tokenOf(agent.id), "GET", "/agents");
    expect(listed.status).toBe(200);
    const ids = (listed.body as AgentInfo[]).map((a) => a.id);
    expect(ids).toContain(inOther.id);
    expect(ids).not.toContain(inHome.id);
  });

  it("asks write opens the agent's own asks, never a member's answer", async () => {
    const o = await office();
    const agent = await spawn(o, "Triage");
    const pack = { areas: { asks: "write" } } as const;
    expect(
      (await setAccess(o, agent.id, { access: "office", pack })).status,
    ).toBe(200);
    const token = tokenOf(agent.id);
    const opened = await asToken(
      o,
      token,
      "POST",
      `/api/agents/${agent.id}/asks`,
      {
        prompt: "Archive this email?",
        options: ["Yes", "No"],
      },
    );
    expect(opened.status).toBe(201);
    const askId = (opened.body as { id: string }).id;

    // The pack grants asks write, so a refusal of the reply is the
    // member-only guard, not the pack.
    const reply = API_ROUTES.find((r) => r.opId === "asks.reply")!;
    expect(routeAllowedByLimits(pack, reply.tokenArea)).toBe(true);
    const answered = await asToken(
      o,
      token,
      "POST",
      `/api/asks/${askId}/reply`,
      {
        text: "Yes",
      },
    );
    expect(answered.status).toBe(403);
    // The ask is still open for the member.
    const open = await asMember(o, "GET", "/api/asks");
    expect((open.body as Array<{ id: string }>).map((a) => a.id)).toContain(
      askId,
    );
  });
});

// The task wire carries the marker as `limited: true`.
const limitedOf = (task: TaskItem) =>
  (task as unknown as Record<string, unknown>).limited === true;

describe("tasks of an agent below Standard", () => {
  it("are marked, and it updates, claims and completes only the tasks it created", async () => {
    const o = await office();
    const agent = await spawn(o, "Triage");
    const standard = await spawn(o, "Peer");
    expect(
      (
        await setAccess(o, agent.id, {
          access: "office",
          pack: { areas: { tasks: "write" } },
        })
      ).status,
    ).toBe(200);
    const token = tokenOf(agent.id);

    const mine = await asToken(o, token, "POST", "/api/tasks", {
      title: "Sort the inbox",
    });
    expect(mine.status).toBe(201);
    const task = mine.body as TaskItem;
    expect(limitedOf(task)).toBe(true);
    // The list and a read show the marker too.
    const listed = (await asMember(o, "GET", "/api/tasks")).body as TaskItem[];
    expect(limitedOf(listed.find((t) => t.id === task.id)!)).toBe(true);
    expect(
      limitedOf(
        (await asMember(o, "GET", `/api/tasks/${task.id}`)).body as TaskItem,
      ),
    ).toBe(true);

    // A body cannot set or clear the marker.
    const peerTask = await asToken(
      o,
      tokenOf(standard.id),
      "POST",
      "/api/tasks",
      {
        title: "A peer's task",
        limited: true,
      },
    );
    expect(peerTask.status).toBe(201);
    expect(limitedOf(peerTask.body as TaskItem)).toBe(false);
    const memberTask = await asMember(o, "POST", "/api/tasks", {
      title: "The member's task",
    });
    expect(memberTask.status).toBe(201);

    // Its own task: update, claim, complete.
    const updated = await asToken(o, token, "PATCH", `/api/tasks/${task.id}`, {
      version: task.version,
      description: "by sender",
    });
    expect(updated.status).toBe(200);
    expect(limitedOf(updated.body as TaskItem)).toBe(true);
    expect(
      (await asToken(o, token, "POST", `/api/tasks/${task.id}/claim`, {}))
        .status,
    ).toBe(200);
    expect(
      (await asToken(o, token, "POST", `/api/tasks/${task.id}/done`)).status,
    ).toBe(200);

    // Anyone else's task: refused, and unchanged.
    for (const other of [peerTask.body, memberTask.body] as TaskItem[]) {
      const attempts = [
        await asToken(o, token, "PATCH", `/api/tasks/${other.id}`, {
          version: other.version,
          title: "taken over",
        }),
        await asToken(o, token, "POST", `/api/tasks/${other.id}/claim`, {}),
        await asToken(o, token, "POST", `/api/tasks/${other.id}/done`),
      ];
      expect(attempts.map((r) => r.status)).toEqual([403, 403, 403]);
      const now = (await asMember(o, "GET", `/api/tasks/${other.id}`))
        .body as TaskItem;
      expect(now.version).toBe(other.version);
    }
  });
});

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

async function connect(o: Office, token: string): Promise<Client> {
  const client = new Client({ name: "agent-access-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${o.srv.baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

async function mcpStatus(o: Office, token: string): Promise<number> {
  const res = await fetch(`${o.srv.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    }),
  });
  await res.body?.cancel();
  return res.status;
}

function toolJson<T>(result: ToolResult): T {
  const text = (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  expect({ isError: !!result.isError, text }).toMatchObject({ isError: false });
  if (result.structuredContent !== undefined)
    return result.structuredContent as T;
  return JSON.parse(text) as T;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

describe("/mcp for an agent below Standard", () => {
  it("takes the token at office, folder and web only, and lists the tools its pack grants", async () => {
    const o = await office();
    const agent = await spawn(o, "Triage");

    // Standard, Privileged and Chat tokens are refused.
    expect(await mcpStatus(o, tokenOf(agent.id))).toBe(403);
    expect(
      (await setAccess(o, agent.id, { access: "privileged" })).status,
    ).toBe(200);
    expect(await mcpStatus(o, tokenOf(agent.id))).toBe(403);
    expect((await setAccess(o, agent.id, { access: "chat" })).status).toBe(200);
    expect(await mcpStatus(o, tokenOf(agent.id))).toBe(403);

    const TASK_READ_TOOLS = ["get_task", "list_tasks"];
    const TASK_WRITE_TOOLS = [
      "claim_task",
      "complete_task",
      "create_task",
      "update_task",
    ];
    const ASK_TOOLS = ["delete_ask", "edit_ask", "list_my_asks", "open_ask"];
    const cases: Array<[string, Record<string, string>, string[]]> = [
      ["no areas", {}, []],
      ["tasks read", { tasks: "read" }, TASK_READ_TOOLS],
      [
        "tasks write",
        { tasks: "write" },
        [...TASK_READ_TOOLS, ...TASK_WRITE_TOOLS],
      ],
      ["asks read", { asks: "read" }, []],
      ["asks write", { asks: "write" }, ASK_TOOLS],
      ["agents read", { agents: "read" }, ["list_agents"]],
      ["agents write", { agents: "write" }, ["list_agents", "send_message"]],
      [
        "agents and logs read",
        { agents: "read", logs: "read" },
        ["list_agents", "read_conversation"],
      ],
    ];
    for (const access of ["office", "folder", "web"] as const) {
      for (const [label, areas, expected] of cases) {
        const res = await setAccess(o, agent.id, {
          access,
          pack: { areas },
        });
        expect({ access, label, status: res.status }).toEqual({
          access,
          label,
          status: 200,
        });
        const { tools } = await (
          await connect(o, tokenOf(agent.id))
        ).listTools();
        // read_replies is an API token's inbox: never an agent's.
        expect({
          access,
          label,
          tools: tools.map((t) => t.name).sort(),
        }).toEqual({ access, label, tools: [...expected].sort() });
      }
    }
  });

  it("creates a marked task, refuses another's, opens an ask the member sees, and sends a message as itself", async () => {
    const o = await office();
    const agent = await spawn(o, "Triage");
    const peer = await spawn(o, "Peer");
    expect(
      (
        await setAccess(o, agent.id, {
          access: "office",
          pack: { areas: { tasks: "write", asks: "write", agents: "write" } },
        })
      ).status,
    ).toBe(200);
    const client = await connect(o, tokenOf(agent.id));

    const created = toolJson<TaskItem>(
      await call(client, "create_task", { title: "Reply to the vendor" }),
    );
    expect(limitedOf(created)).toBe(true);
    expect(created.createdByAgentId).toBe(agent.id);
    const listed = toolJson<TaskItem[]>(await call(client, "list_tasks", {}));
    expect(listed.map((t) => t.id)).toContain(created.id);
    const done = toolJson<TaskItem>(
      await call(client, "complete_task", { id: created.id }),
    );
    expect(done.status).not.toBe(created.status);

    const memberTask = (
      await asMember(o, "POST", "/api/tasks", { title: "The member's task" })
    ).body as TaskItem;
    const refused = await call(client, "update_task", {
      id: memberTask.id,
      version: memberTask.version,
      title: "taken over",
    });
    expect(refused.isError).toBe(true);
    expect(
      (
        (await asMember(o, "GET", `/api/tasks/${memberTask.id}`))
          .body as TaskItem
      ).title,
    ).toBe("The member's task");

    const ask = toolJson<{ id: string }>(
      await call(client, "open_ask", {
        prompt: "Archive this email?",
        options: ["Yes", "No"],
      }),
    );
    const memberAsks = (await asMember(o, "GET", "/api/asks")).body as Array<{
      id: string;
      agentId: string;
    }>;
    expect(memberAsks.find((a) => a.id === ask.id)?.agentId).toBe(agent.id);
    const mine = toolJson<Array<{ id: string }>>(
      await call(client, "list_my_asks", {}),
    );
    expect(mine.map((a) => a.id)).toEqual([ask.id]);
    const deleted = await call(client, "delete_ask", { askId: ask.id });
    expect(deleted.isError ?? false).toBe(false);
    expect(
      (
        (await asMember(o, "GET", "/api/asks")).body as Array<{ id: string }>
      ).some((a) => a.id === ask.id),
    ).toBe(false);

    // A message goes out as the agent, so the peer replies to its chat.
    toolJson(
      await call(client, "send_message", { agentId: peer.id, text: "ping" }),
    );
    await waitUntil(
      () =>
        o.srv.fakeBackend.sessions
          .filter((s) => s.opts.agentId === peer.id)
          .some((s) => s.sent.some((m) => m.text.includes("ping"))),
      "the peer received the message",
    );
    const received = o.srv.fakeBackend.sessions
      .filter((s) => s.opts.agentId === peer.id)
      .flatMap((s) => s.sent.map((m) => m.text))
      .find((text) => text.includes("ping"))!;
    expect(received).toContain(`(agent id: ${agent.id}`);
  });
});

const FOLDER_REFUSED = { status: 422, code: FOLDER_NOT_ALLOWED };
const outcome = (res: Res) => ({ status: res.status, code: errCode(res.body) });
const messageOf = (res: Res) =>
  (res.body as { error?: { message?: string } } | null)?.error?.message ?? "";

function subdir(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function spawnIn(
  o: Office,
  name: string,
  cwd: string,
): Promise<AgentInfo> {
  const agent = await o.srv.agentManager.spawn(
    name,
    cwd,
    "default",
    undefined,
    undefined,
    o.room,
    undefined,
    undefined,
    undefined,
    o.username,
    "claude",
    undefined,
    o.userId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

describe("the folder rules at Folder and Web", () => {
  it("refuse a folder that holds or sits in the office state, is the home, or overlaps another agent's folder", async () => {
    const o = await office();
    const shared = freshFolder();
    const peer = await spawnIn(o, "Peer", subdir(shared, "peer"));
    const cases: Array<[string, string]> = [
      ["the state root", o.srv.stateRoot],
      ["inside the state root", subdir(o.srv.stateRoot, "inside-state")],
      ["the home", homedir()],
      ["another agent's folder", peer.cwd],
      ["a folder that holds another agent's", shared],
      ["inside another agent's folder", subdir(peer.cwd, "deeper")],
    ];
    for (const [label, cwd] of cases) {
      const agent = await spawnIn(o, `Triage ${label}`, cwd);
      for (const access of ["folder", "web"] as const) {
        const res = await setAccess(o, agent.id, { access, pack: TASKS_READ });
        expect({ label, access, ...outcome(res) }).toEqual({
          label,
          access,
          ...FOLDER_REFUSED,
        });
        // The refusal names the agent it is about.
        expect(messageOf(res)).toContain(agent.name);
      }
      expect(sliderOf(agentOf(o.srv, agent.id)).access ?? "standard").toBe(
        "standard",
      );
      // Office has no file tools, so the rules do not apply there.
      expect(
        (await setAccess(o, agent.id, { access: "office", pack: TASKS_READ }))
          .status,
      ).toBe(200);
    }
    // A provider home: a folder agent could read the engine's sign-in there.
    const codexHome = subdir(freshFolder(), "codex-home");
    const inCodexHome = await spawnIn(
      o,
      "In a Codex home",
      subdir(codexHome, "x"),
    );
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const res = await setAccess(o, inCodexHome.id, {
        access: "folder",
        pack: TASKS_READ,
      });
      expect(outcome(res)).toEqual(FOLDER_REFUSED);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
    // A folder of its own passes.
    const own = await spawn(o, "Own folder");
    expect(
      (await setAccess(o, own.id, { access: "web", pack: TASKS_READ })).status,
    ).toBe(200);
  });

  it("hold after the move: no agent, spawn or schedule may overlap the folder, and the agent may not move its folder onto one", async () => {
    const o = await office();
    const triage = await spawn(o, "Triage");
    expect(
      (await setAccess(o, triage.id, { access: "folder", pack: TASKS_READ }))
        .status,
    ).toBe(200);
    const inside = subdir(triage.cwd, "sub");

    // A new agent in or around the folder.
    for (const cwd of [triage.cwd, inside]) {
      const res = await asMember(o, "POST", "/api/agents", {
        name: "Newcomer",
        cwd,
        roomId: o.room,
        agentType: "claude",
      });
      expect({ cwd, ...outcome(res) }).toEqual({ cwd, ...FOLDER_REFUSED });
      expect(messageOf(res)).toContain(triage.name);
    }
    // Another agent moved into it.
    const other = await spawn(o, "Other");
    const moved = await asMember(o, "PATCH", `/api/agents/${other.id}`, {
      cwd: inside,
    });
    expect(outcome(moved)).toEqual(FOLDER_REFUSED);
    expect(agentOf(o.srv, other.id).cwd).toBe(other.cwd);
    // A schedule in it.
    const job = await asMember(o, "POST", "/api/cronjobs", {
      name: "Nightly",
      schedule: { type: "interval", minutes: 60 },
      prompt: "do the thing",
      cwd: inside,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
    });
    expect(outcome(job)).toEqual(FOLDER_REFUSED);
    // The agent's own folder moved onto the state root, or onto another
    // agent's folder.
    for (const cwd of [o.srv.stateRoot, other.cwd]) {
      const res = await asMember(o, "PATCH", `/api/agents/${triage.id}`, {
        cwd,
      });
      expect({ cwd, ...outcome(res) }).toEqual({ cwd, ...FOLDER_REFUSED });
    }
    expect(agentOf(o.srv, triage.id).cwd).toBe(triage.cwd);

    // An app: it runs code with a shell in its folder.
    const app = await asMember(o, "POST", "/api/apps", {
      name: "inside-app",
      command: "bun run serve.ts",
      cwd: inside,
    });
    expect(outcome(app)).toEqual(FOLDER_REFUSED);
    const okApp = await asMember(o, "POST", "/api/apps", {
      name: "outside-app",
      command: "bun run serve.ts",
      cwd: freshFolder(),
    });
    expect(okApp.status).toBe(201);
    const movedApp = await asMember(o, "PATCH", "/api/apps/outside-app", {
      cwd: inside,
    });
    expect(outcome(movedApp)).toEqual(FOLDER_REFUSED);
    // Nor may the agent take a folder an app works in.
    const appFolder = freshFolder();
    expect(
      (
        await asMember(o, "POST", "/api/apps", {
          name: "kept-app",
          command: "bun run serve.ts",
          cwd: appFolder,
        })
      ).status,
    ).toBe(201);
    const nextToApp = await spawnIn(o, "Next to the app", appFolder);
    expect(
      outcome(
        await setAccess(o, nextToApp.id, {
          access: "folder",
          pack: TASKS_READ,
        }),
      ),
    ).toEqual(FOLDER_REFUSED);

    // Controls: the same requests elsewhere pass.
    const elsewhere = freshFolder();
    const fine = await asMember(o, "POST", "/api/agents", {
      name: "Elsewhere",
      cwd: elsewhere,
      roomId: o.room,
      agentType: "claude",
    });
    expect(fine.status).toBeLessThan(300);
    expect(
      (
        await asMember(o, "PATCH", `/api/agents/${triage.id}`, {
          cwd: freshFolder(),
        })
      ).status,
    ).toBe(200);
  });
});

describe("attachments for an agent below Standard", () => {
  const spec = (originalName: string, mediaType: string) => ({
    filename: `a1b2c3-${originalName}`,
    originalName,
    mediaType,
    size: 3,
  });

  it("at Chat and Office a file other than an image is refused, from a member and from an agent", async () => {
    const o = await office();
    const peer = await spawn(o, "Peer");
    for (const access of ["chat", "office"] as const) {
      const agent = await spawn(o, `At ${access}`);
      expect(
        (
          await setAccess(
            o,
            agent.id,
            access === "chat" ? { access } : { access, pack: TASKS_READ },
          )
        ).status,
      ).toBe(200);
      const path = `/api/agents/${agent.id}/messages`;
      const md = {
        text: "read this",
        attachments: [spec("notes.md", "text/markdown")],
      };
      const fromMember = await asMember(o, "POST", path, md);
      expect({ access, ...outcome(fromMember) }).toEqual({
        access,
        status: 422,
        code: ATTACHMENT_NOT_ALLOWED,
      });
      const fromAgent = await asToken(o, tokenOf(peer.id), "POST", path, md);
      expect({ access, ...outcome(fromAgent) }).toEqual({
        access,
        status: 422,
        code: ATTACHMENT_NOT_ALLOWED,
      });
      // An image goes through.
      const png = await asMember(o, "POST", path, {
        text: "look",
        attachments: [spec("shot.png", "image/png")],
      });
      expect({ access, status: png.status }).toEqual({ access, status: 200 });
    }
    // At Folder any file goes through (it is copied into the folder).
    const folderAgent = await spawn(o, "At folder");
    expect(
      (
        await setAccess(o, folderAgent.id, {
          access: "folder",
          pack: TASKS_READ,
        })
      ).status,
    ).toBe(200);
    const res = await asMember(
      o,
      "POST",
      `/api/agents/${folderAgent.id}/messages`,
      {
        text: "read this",
        attachments: [spec("notes.md", "text/markdown")],
      },
    );
    expect(res.status).toBe(200);
  });
});

describe("the prompt of an agent below Standard", () => {
  it("leaves out the token and the reference pages, and keeps the trust rules", async () => {
    const o = await office();
    const standard = await spawn(o, "Standard");
    const limited = await spawn(o, "Limited");
    expect(
      (await setAccess(o, limited.id, { access: "folder", pack: TASKS_READ }))
        .status,
    ).toBe(200);
    const promptOf = async (agentId: string) => {
      const res = await asMember(
        o,
        "GET",
        `/api/agents/${agentId}/system-prompt`,
      );
      expect(res.status).toBe(200);
      return (res.body as { prompt: string }).prompt;
    };
    const below = await promptOf(limited.id);
    const above = await promptOf(standard.id);
    // The control: a Standard prompt teaches the token and the pages.
    expect(above).toContain("ISOMUX_AGENT_TOKEN");
    expect(above).toContain("/api/agent-reference");
    expect(below).not.toContain("ISOMUX_AGENT_TOKEN");
    expect(below).not.toContain("/api/agent-reference");
    expect(below).not.toContain("curl");
    // The label markers a receiver must read stay.
    expect(below).toContain(`\`${AGENT_SENDER_LIMITED}\``);

    // The preview takes the stop of the form.
    const preview = async (body: Record<string, unknown>) => {
      const res = await asMember(
        o,
        "POST",
        "/api/agents/system-prompt-preview",
        {
          roomId: o.room,
          name: "Draft",
          agentType: "claude",
          instructions: "",
          privileged: false,
          ...body,
        },
      );
      expect(res.status).toBe(200);
      return (res.body as { prompt: string }).prompt;
    };
    expect(await preview({})).toContain("ISOMUX_AGENT_TOKEN");
    expect(await preview({ access: "office" })).not.toContain(
      "ISOMUX_AGENT_TOKEN",
    );
    expect(await preview({ access: "standard" })).toContain(
      "ISOMUX_AGENT_TOKEN",
    );
  });
});

describe("a spawn below Standard", () => {
  const ASKS_ONLY = { areas: { asks: "write" } } as const;

  it("is refused before the agent exists", async () => {
    const o = await office();
    const before = o.srv.agentManager.getAllAgents().length;
    const cases: Array<[string, Record<string, unknown>, number, string?]> = [
      [
        "the home folder at folder",
        { cwd: "~", access: "folder", pack: TASKS_READ },
        422,
        FOLDER_NOT_ALLOWED,
      ],
      [
        "the office state at web",
        { cwd: o.srv.stateRoot, access: "web", pack: TASKS_READ },
        422,
        FOLDER_NOT_ALLOWED,
      ],
      [
        "codex at office",
        {
          cwd: freshFolder(),
          agentType: "codex",
          modelFamily: "gpt-5.5",
          access: "office",
          pack: ASKS_ONLY,
        },
        422,
        "engine_below_standard",
      ],
      [
        "codex at chat",
        {
          cwd: freshFolder(),
          agentType: "codex",
          modelFamily: "gpt-5.5",
          access: "chat",
        },
        422,
        "engine_below_standard",
      ],
      // Privileged keeps its own user-only route.
      ["privileged", { cwd: freshFolder(), access: "privileged" }, 400],
      ["office without a pack", { cwd: freshFolder(), access: "office" }, 400],
      [
        "a pack at chat",
        { cwd: freshFolder(), access: "chat", pack: ASKS_ONLY },
        400,
      ],
      ["a pack with no stop", { cwd: freshFolder(), pack: ASKS_ONLY }, 400],
      ["an unknown stop", { cwd: freshFolder(), access: "admin" }, 400],
    ];
    for (const [label, fields, status, code] of cases) {
      const res = await asMember(o, "POST", "/api/agents", {
        name: label,
        roomId: o.room,
        agentType: "claude",
        ...fields,
      });
      expect({ label, ...outcome(res) }).toMatchObject({
        label,
        status,
        ...(code ? { code } : {}),
      });
      expect({
        label,
        made: o.srv.agentManager.getAllAgents().some((a) => a.name === label),
      }).toEqual({ label, made: false });
    }
    expect(o.srv.agentManager.getAllAgents().length).toBe(before);
    // Nothing was left in the office either: each name is still free.
    for (const [label] of cases) {
      const res = await asMember(o, "POST", "/api/agents", {
        name: label,
        cwd: freshFolder(),
        roomId: o.room,
        agentType: "claude",
      });
      expect({ label, status: res.status }).toEqual({ label, status: 201 });
    }
  });

  it("starts the agent at its stop: the first token carries the pack, and the first session the stop", async () => {
    const o = await office();
    const res = await asMember(o, "POST", "/api/agents", {
      name: "Inbox",
      cwd: freshFolder(),
      roomId: o.room,
      agentType: "claude",
      access: "office",
      pack: ASKS_ONLY,
    });
    expect(res.status).toBe(201);
    const inbox = (res.body as { agent: AgentInfo }).agent;
    expect(sliderOf(agentOf(o.srv, inbox.id))).toEqual({
      access: "office",
      pack: ASKS_ONLY,
      privileged: false,
    });
    const { tools } = await (await connect(o, tokenOf(inbox.id))).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "delete_ask",
      "edit_ask",
      "list_my_asks",
      "open_ask",
    ]);

    const filed = await asMember(o, "POST", "/api/agents", {
      name: "Filer",
      cwd: freshFolder(),
      roomId: o.room,
      agentType: "claude",
      access: "folder",
      pack: TASKS_READ,
    });
    expect(filed.status).toBe(201);
    const filer = (filed.body as { agent: AgentInfo }).agent;
    void o.srv.agentManager.sendMessage(filer.id, "hello", o.username);
    await waitUntil(
      () => o.srv.fakeBackend.sessionForAgent(filer.id) !== undefined,
      "the first session of the folder agent",
    );
    expect(o.srv.fakeBackend.sessionForAgent(filer.id)!.opts.access).toBe(
      "folder",
    );

    // Standard by name is the default.
    const plain = await asMember(o, "POST", "/api/agents", {
      name: "Plain",
      cwd: freshFolder(),
      roomId: o.room,
      agentType: "claude",
      access: "standard",
    });
    expect(plain.status).toBe(201);
    const plainId = (plain.body as { agent: AgentInfo }).agent.id;
    expect(await mcpStatus(o, tokenOf(plainId))).toBe(403);
  });

  // spawn checks the new agent and adds it to the office with no await in
  // between: two spawns started together see each other.
  it("checks and joins in one step, so two spawns into one folder cannot both pass", async () => {
    const o = await office();
    const dir = freshFolder();
    let checks = 0;
    let sawItself = false;
    const access = (): SpawnAccess => ({
      grant: { access: "folder", pack: TASKS_READ },
      refusal: (name, cwd) => {
        checks++;
        const agents = o.srv.agentManager.getAllAgents();
        if (agents.some((a) => a.name === name)) sawItself = true;
        return agents.some((a) => a.cwd === cwd)
          ? { refused: "folder_not_allowed", message: `${name} overlaps` }
          : null;
      },
    });
    const start = (name: string) =>
      o.srv.agentManager.spawn(
        name,
        dir,
        "default",
        undefined,
        undefined,
        o.room,
        undefined,
        undefined,
        undefined,
        o.username,
        "claude",
        undefined,
        o.userId,
        undefined,
        access(),
      );
    const results = await Promise.allSettled([start("First"), start("Second")]);
    expect(checks).toBe(2);
    expect(sawItself).toBe(false);
    expect(
      results.map((r) =>
        r.status === "fulfilled"
          ? `made ${r.value?.name}`
          : r.reason instanceof SpawnAccessRefusedError
            ? `refused ${r.reason.refusal.refused}`
            : `threw ${String(r.reason)}`,
      ),
    ).toEqual(["made First", "refused folder_not_allowed"]);
    expect(
      o.srv.agentManager.getAllAgents().filter((a) => a.cwd === dir).length,
    ).toBe(1);
  });
});
