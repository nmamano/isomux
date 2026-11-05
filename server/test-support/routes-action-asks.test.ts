// Action asks (task e3d1bc63), through the real server: an agent asks a
// member to move an agent on the access slider, and the member runs it from
// the ask card (POST /api/asks/:askId/action), which dispatches the slider's
// own route with the member's session. The create refuses what the member
// could not run, what is done, and a target the asking agent cannot see,
// without telling the agent which. The ask closes when the agent reaches the
// grant, by the card or by any other path.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { officeAuditStore } from "../audit-store.ts";
import { FOLDER_NOT_ALLOWED } from "../../shared/agent-access.ts";
import type { AgentInfo, AskEntry } from "../../shared/types.ts";

let server: TestServer | null = null;
const folders: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

const TASKS_READ = { areas: { tasks: "read" } } as const;

interface Res {
  status: number;
  body: unknown;
}

// Morgan owns the office; Casey is a member with its first room.
async function office() {
  const srv = await startTestServer({});
  server = srv;
  const morgan = await srv.seedOwner("Morgan");
  const casey = await srv.seedMember("Casey");
  const room = srv.agentManager.getRooms()[0].id;
  const o = {
    srv,
    room,
    morgan: morgan.rawSessionId,
    morganName: morgan.username,
    morganId: getUserByName(morgan.username)!.id,
    casey: casey.rawSessionId,
    caseyName: casey.username,
    caseyId: getUserByName(casey.username)!.id,
  };
  const rooms = await asSession(
    o,
    o.morgan,
    "PUT",
    `/api/users/${o.caseyName}/access`,
    { allowedRooms: [room] },
  );
  expect(rooms.status).toBe(200);
  return o;
}
type Office = Awaited<ReturnType<typeof office>>;

async function spawn(
  o: Office,
  name: string,
  opts: {
    manager?: "Morgan" | "Casey";
    roomId?: string;
    agentType?: AgentInfo["agentType"];
    cwd?: string;
  } = {},
): Promise<AgentInfo> {
  const manager = opts.manager ?? "Morgan";
  let cwd = opts.cwd;
  if (!cwd) {
    cwd = mkdtempSync(join(tmpdir(), "action-asks-"));
    folders.push(cwd);
  }
  const agent = await o.srv.agentManager.spawn(
    name,
    cwd,
    "default",
    undefined,
    undefined,
    opts.roomId ?? o.room,
    undefined,
    undefined,
    undefined,
    manager === "Morgan" ? o.morganName : o.caseyName,
    opts.agentType ?? "claude",
    undefined,
    manager === "Morgan" ? o.morganId : o.caseyId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

async function read(res: Response): Promise<Res> {
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function asSession(
  o: Office,
  session: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  return read(
    await o.srv.http(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      rawSessionId: session,
    }),
  );
}

async function asAgent(
  o: Office,
  agentId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  return read(
    await o.srv.http(path, {
      method,
      headers: {
        Authorization: `Bearer ${getAgentTokenRaw(agentId)}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const codeOf = (res: Res) =>
  (res.body as { error?: { code?: string } } | null)?.error?.code;
const outcome = (res: Res) => ({ status: res.status, code: codeOf(res) });

// The asking agent's POST /asks with an agent-access step.
function ask(
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
  member?: string,
): Promise<Res> {
  return asAgent(o, askerId, "POST", `/api/agents/${askerId}/asks`, {
    text: "Please move this agent.",
    step,
    ...(member ? { member } : {}),
  });
}

async function opened(
  o: Office,
  askerId: string,
  step: Record<string, unknown>,
  member?: string,
): Promise<AskEntry> {
  const res = await ask(o, askerId, step, member);
  expect(outcome(res)).toEqual({ status: 201, code: undefined });
  return res.body as AskEntry;
}

const accessStep = (
  agentId: string,
  access: string,
  pack?: Record<string, unknown>,
) => ({ kind: "agent-access", agentId, access, ...(pack ? { pack } : {}) });

// "open", the closed ask's outcome, or the status of a refused read.
async function askStatus(o: Office, askerId: string, askId: string) {
  const res = await asAgent(
    o,
    askerId,
    "GET",
    `/api/agents/${askerId}/asks/${askId}`,
  );
  if (res.status !== 200) return String(res.status);
  return (
    (res.body as { closed?: { outcome: string } }).closed?.outcome ?? "open"
  );
}

function run(o: Office, session: string, askId: string): Promise<Res> {
  return asSession(o, session, "POST", `/api/asks/${askId}/action`);
}

function agentOf(o: Office, id: string): AgentInfo {
  const agent = o.srv.agentManager.getAllAgents().find((a) => a.id === id);
  if (!agent) throw new Error(`agent ${id} not found`);
  return agent;
}

const grantOf = (o: Office, id: string) => {
  const a = agentOf(o, id);
  return { access: a.access ?? "standard", pack: a.pack };
};

async function waitUntil(pred: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 3000;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await Bun.sleep(10);
  }
}

// The keys of the step lines in the agent's chat.
const stepLines = (o: Office, agentId: string) =>
  o.srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "system")
    .map((e) => JSON.stringify(e).match(/systemEntries\.stepAsk\.\w+/)?.[0])
    .filter((key): key is string => key !== undefined);

describe("an agent-access ask at create", () => {
  it("opens for the manager with the grant asked for and no link, at a plain stop and at a pack stop", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const target = await spawn(o, "Curator");
    const up = await opened(o, asker.id, accessStep(target.id, "privileged"));
    expect([up.step, up.link]).toEqual([
      { kind: "agent-access", agentId: target.id, access: "privileged" },
      undefined,
    ]);
    const down = await opened(
      o,
      asker.id,
      accessStep(target.id, "office", TASKS_READ),
    );
    expect(down.step).toEqual({
      kind: "agent-access",
      agentId: target.id,
      access: "office",
      pack: TASKS_READ,
    });
    // Nothing ran: the target is where it was.
    expect(grantOf(o, target.id)).toEqual({
      access: "standard",
      pack: undefined,
    });
  });

  it("refuses a step that is not a grant: 400, nothing opened", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const target = await spawn(o, "Curator");
    const bad: [string, Record<string, unknown>][] = [
      ["an unknown stop", accessStep(target.id, "root")],
      ["a pack at privileged", accessStep(target.id, "privileged", TASKS_READ)],
      ["no pack at office", accessStep(target.id, "office")],
      ["no agent", { kind: "agent-access", access: "privileged" }],
      [
        "an extra key",
        { ...accessStep(target.id, "privileged"), roomId: o.room },
      ],
    ];
    for (const [label, step] of bad)
      expect({ label, ...outcome(await ask(o, asker.id, step)) }).toEqual({
        label,
        status: 400,
        code: "invalid_request",
      });
    // An action step has no link: the card runs it.
    const withLink = await asAgent(
      o,
      asker.id,
      "POST",
      `/api/agents/${asker.id}/asks`,
      {
        text: "Please move this agent.",
        step: accessStep(target.id, "privileged"),
        link: "/integrations",
      },
    );
    expect(outcome(withLink)).toEqual({ status: 400, code: "invalid_request" });
    const open = await asAgent(
      o,
      asker.id,
      "GET",
      `/api/agents/${asker.id}/asks`,
    );
    expect(JSON.stringify(open.body)).not.toContain(target.id);
  });

  it("answers a target the asking agent cannot reach exactly as a missing one, before the member's verdict and the done check", async () => {
    const o = await office();
    // Casey's agent reaches only Casey's room.
    const asker = await spawn(o, "Asker", { manager: "Casey" });
    const other = o.srv.agentManager.createRoom("Other");
    const hidden = await spawn(o, "Hidden", { roomId: other });
    const missingId = "no-such-agent";
    const missing = await ask(o, asker.id, accessStep(missingId, "privileged"));
    expect(outcome(missing)).toEqual({ status: 422, code: "unknown_agent" });
    // The whole answer, with the id the agent sent written the same way.
    const answer = (res: Res, id: string) => ({
      status: res.status,
      body: JSON.stringify(res.body).replaceAll(id, "<id>"),
    });
    // Casey may not move Hidden (403 if checked first), and Hidden is at
    // Standard already (409 if checked first): neither leaks.
    for (const access of ["privileged", "standard"]) {
      const res = await ask(o, asker.id, accessStep(hidden.id, access));
      expect({ access, ...answer(res, hidden.id) }).toEqual({
        access,
        ...answer(missing, missingId),
      });
    }
  });

  it("refuses a member who could not run it (403), and opens for one who can", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const morgans = await spawn(o, "Morgans");
    const caseys = await spawn(o, "Caseys", { manager: "Casey" });
    // Casey is neither an office owner nor Morgans's manager.
    expect(
      outcome(
        await ask(
          o,
          asker.id,
          accessStep(morgans.id, "privileged"),
          o.caseyName,
        ),
      ),
    ).toEqual({ status: 403, code: "member_not_allowed" });
    // Her own agent is hers to move.
    const ok = await opened(
      o,
      asker.id,
      accessStep(caseys.id, "privileged"),
      o.caseyName,
    );
    expect(ok.memberUserId).toBe(o.caseyId);
  });

  it("refuses a grant the slider route refuses past its guards: the engine and the folder rule (422, the route's codes)", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    // Codex on its default model does not run below Standard.
    const codex = await spawn(o, "Codex", { agentType: "codex" });
    expect(
      outcome(
        await ask(o, asker.id, accessStep(codex.id, "office", TASKS_READ)),
      ),
    ).toEqual({ status: 422, code: "engine_below_standard" });
    // A folder stop is refused for an agent whose folder holds the office
    // state.
    const inState = await spawn(o, "InState", { cwd: o.srv.stateRoot });
    expect(
      outcome(
        await ask(o, asker.id, accessStep(inState.id, "folder", TASKS_READ)),
      ),
    ).toEqual({ status: 422, code: FOLDER_NOT_ALLOWED });
    // The same agents at a stop their refusal does not cover open.
    await opened(o, asker.id, accessStep(codex.id, "privileged"));
    await opened(o, asker.id, accessStep(inState.id, "office", TASKS_READ));
  });

  it("refuses a grant the agent has: 409 step_done", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const target = await spawn(o, "Curator");
    expect(
      outcome(await ask(o, asker.id, accessStep(target.id, "standard"))),
    ).toEqual({ status: 409, code: "step_done" });
    const set = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/agents/${target.id}/access`,
      {
        access: "office",
        pack: TASKS_READ,
      },
    );
    expect(set.status).toBe(200);
    expect(
      outcome(
        await ask(o, asker.id, accessStep(target.id, "office", TASKS_READ)),
      ),
    ).toEqual({ status: 409, code: "step_done" });
    // Another pack at the same stop is not done.
    await opened(
      o,
      asker.id,
      accessStep(target.id, "office", { areas: { tasks: "write" } }),
    );
  });
});

describe("an agent-access ask run from the card", () => {
  it("moves the agent with the member's session, closes the ask as done, tells the agent, and writes one audit row with the ask", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const target = await spawn(o, "Curator");
    const entry = await opened(
      o,
      asker.id,
      accessStep(target.id, "privileged"),
    );
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBe(200);
    // The slider route's own answer.
    expect((res.body as { agent: AgentInfo }).agent).toMatchObject({
      id: target.id,
      access: "privileged",
    });
    expect(grantOf(o, target.id).access).toBe("privileged");
    await waitUntil(
      async () => (await askStatus(o, asker.id, entry.id)) === "done",
      "the ask closes",
    );
    expect(stepLines(o, asker.id)).toEqual([
      "systemEntries.stepAsk.agentAccessSet",
    ]);
    // One row for one change: the slider's, by Morgan, naming the agent
    // and the ask.
    const rows = officeAuditStore().list({
      operation: "agents.setAccess",
    }).items;
    expect(
      rows.map((r) => ({
        actor: [r.actor.kind, r.actor.id],
        agent: r.targets.includes(target.id),
        ask: r.targets.includes(entry.id),
      })),
    ).toEqual([{ actor: ["member", o.morganId], agent: true, ask: true }]);
    expect(
      officeAuditStore().list({ operation: "asks.runAction" }).items,
    ).toEqual([]);
  });

  it("runs only for the member the ask is for: another member 404, the agent's token refused, nothing moved", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const target = await spawn(o, "Curator");
    const entry = await opened(
      o,
      asker.id,
      accessStep(target.id, "privileged"),
    );
    // Casey reaches the room, but the ask is Morgan's.
    expect(outcome(await run(o, o.casey, entry.id))).toEqual({
      status: 404,
      code: "not_found",
    });
    const byAgent = await asAgent(
      o,
      asker.id,
      "POST",
      `/api/asks/${entry.id}/action`,
    );
    expect(byAgent.status).toBe(403);
    expect(grantOf(o, target.id).access).toBe("standard");
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
  });

  it("passes a refused run's status and code through, and the ask stays open", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const target = await spawn(o, "Curator");
    const entry = await opened(
      o,
      asker.id,
      accessStep(target.id, "office", TASKS_READ),
    );
    // After the create, the agent moves to an engine that does not run
    // the stop.
    const moved = await asSession(
      o,
      o.morgan,
      "PATCH",
      `/api/agents/${target.id}`,
      {
        agentType: "codex",
      },
    );
    expect(moved.status).toBe(200);
    expect(outcome(await run(o, o.morgan, entry.id))).toEqual({
      status: 422,
      code: "engine_below_standard",
    });
    expect(grantOf(o, target.id).access).toBe("standard");
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
    expect(stepLines(o, asker.id)).toEqual([]);
  });

  it("a target gone after the create: the run is refused and the ask stays open", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const target = await spawn(o, "Curator");
    const entry = await opened(
      o,
      asker.id,
      accessStep(target.id, "privileged"),
    );
    const killed = await asSession(
      o,
      o.morgan,
      "DELETE",
      `/api/agents/${target.id}`,
    );
    expect(killed.status).toBeLessThan(300);
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
  });
});

describe("an agent-access ask closes when the agent reaches the grant by another path", () => {
  it("the Privileged switch closes it", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const target = await spawn(o, "Curator");
    const entry = await opened(
      o,
      asker.id,
      accessStep(target.id, "privileged"),
    );
    const set = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/agents/${target.id}/privileged`,
      { privileged: true },
    );
    expect(set.status).toBe(200);
    await waitUntil(
      async () => (await askStatus(o, asker.id, entry.id)) === "done",
      "the ask closes",
    );
    expect(stepLines(o, asker.id)).toEqual([
      "systemEntries.stepAsk.agentAccessSet",
    ]);
  });

  it("a move with no route (the manager-transfer and pack clamps) closes it; a move to another grant does not", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const target = await spawn(o, "Curator");
    const entry = await opened(
      o,
      asker.id,
      accessStep(target.id, "office", TASKS_READ),
    );
    // Another pack at the same stop: not the grant asked for.
    await o.srv.agentManager.setAccess(target.id, {
      access: "office",
      pack: { areas: { tasks: "write" } },
    });
    await Bun.sleep(50);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
    await o.srv.agentManager.setAccess(target.id, {
      access: "office",
      pack: TASKS_READ,
    });
    await waitUntil(
      async () => (await askStatus(o, asker.id, entry.id)) === "done",
      "the ask closes",
    );
  });
});

// An agent below Standard reaches the office only through /mcp: its
// open_ask carries the step, so it can ask to be moved back up.
describe("an agent-access ask from /mcp", () => {
  it("an agent below Standard opens one with open_ask, and the member's Apply closes it", async () => {
    const o = await office();
    const agent = await spawn(o, "Triage");
    const lowered = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/agents/${agent.id}/access`,
      {
        access: "office",
        pack: { areas: { asks: "write" } },
      },
    );
    expect(lowered.status).toBe(200);
    const client = new Client({ name: "action-asks-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${o.srv.baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${getAgentTokenRaw(agent.id)}` },
        },
      }),
    );
    clients.push(client);
    const result = (await client.callTool({
      name: "open_ask",
      arguments: {
        prompt: "Move me back to Standard?",
        step: accessStep(agent.id, "standard"),
      },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError ?? false).toBe(false);
    const opened = JSON.parse(result.content?.[0]?.text ?? "{}") as AskEntry;
    expect(opened.step as unknown).toEqual(accessStep(agent.id, "standard"));
    const res = await run(o, o.morgan, opened.id);
    expect(res.status).toBe(200);
    expect(grantOf(o, agent.id)).toEqual({
      access: "standard",
      pack: undefined,
    });
    const memberAsks = async () =>
      (await asSession(o, o.morgan, "GET", "/api/asks")).body as AskEntry[];
    await waitUntil(
      async () => !(await memberAsks()).some((a) => a.id === opened.id),
      "the ask closes",
    );
  });
});
