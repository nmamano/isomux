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
import { getUserById, getUserByName } from "../users.ts";
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

// Part 2: a member's room access (member-room) and role (member-role). The
// office of these cases adds Dana, a member with no room, and a room Other
// that only an owner's agents reach.
async function membersOffice() {
  const o = await office();
  const dana = await o.srv.seedMember("Dana");
  const other = o.srv.agentManager.createRoom("Other");
  return {
    ...o,
    other,
    dana: dana.rawSessionId,
    danaName: dana.username,
    danaId: getUserByName(dana.username)!.id,
  };
}
type MembersOffice = Awaited<ReturnType<typeof membersOffice>>;

const roomStep = (username: string, roomId: string, grant: boolean) => ({
  kind: "member-room",
  username,
  roomId,
  grant,
});
const roleStep = (username: string, role: string) => ({
  kind: "member-role",
  username,
  role,
});

const roomsOf = (userId: string) => [...getUserById(userId)!.allowedRooms];
const roleOf = (userId: string) => getUserById(userId)!.role;

async function closesDone(o: Office, askerId: string, askId: string) {
  await waitUntil(
    async () => (await askStatus(o, askerId, askId)) === "done",
    "the ask closes",
  );
}

describe("a member-room ask at create", () => {
  it("opens for an owner with the member stored by id, no link, nothing run, even for a member who shares no room with the asking agent", async () => {
    const o = await membersOffice();
    // Casey's agent reaches only the first room; Dana reaches none.
    const asker = await spawn(o, "Asker", { manager: "Casey" });
    const entry = await opened(
      o,
      asker.id,
      roomStep(o.danaName, o.room, true),
      o.morganName,
    );
    expect([entry.step, entry.link, entry.memberUserId]).toEqual([
      { kind: "member-room", userId: o.danaId, roomId: o.room, grant: true },
      undefined,
      o.morganId,
    ]);
    expect(roomsOf(o.danaId)).toEqual([]);
  });

  it("refuses a step that is not one room for one member: 400", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const bad: [string, Record<string, unknown>][] = [
      [
        "grant not a boolean",
        { ...roomStep(o.danaName, o.room, true), grant: "yes" },
      ],
      ["no room", { kind: "member-room", username: o.danaName, grant: true }],
      ["no member", { kind: "member-room", roomId: o.room, grant: true }],
      [
        "several rooms",
        { ...roomStep(o.danaName, o.room, true), roomId: [o.room, o.other] },
      ],
      [
        "an extra key",
        { ...roomStep(o.danaName, o.room, true), pack: TASKS_READ },
      ],
      [
        "a stored field",
        { ...roomStep(o.danaName, o.room, true), userId: o.danaId },
      ],
    ];
    for (const [label, step] of bad)
      expect({ label, ...outcome(await ask(o, asker.id, step)) }).toEqual({
        label,
        status: 400,
        code: "invalid_request",
      });
  });

  it("answers a room the asking agent cannot reach exactly as a missing one, before the owner, member and done checks", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker", { manager: "Casey" });
    const missingId = "no-such-room";
    const missing = await ask(
      o,
      asker.id,
      roomStep(o.danaName, missingId, true),
      o.morganName,
    );
    expect(outcome(missing)).toEqual({ status: 422, code: "unknown_room" });
    const answer = (res: Res, id: string) => ({
      status: res.status,
      body: JSON.stringify(res.body).replaceAll(id, "<id>"),
    });
    // Other: Morgan is an owner (owner_has_all_rooms if checked first),
    // Casey may not run it (403), Dana lacks it already (409).
    const cases: [string, Record<string, unknown>, string][] = [
      ["an owner", roomStep(o.morganName, o.other, true), o.morganName],
      [
        "a member who cannot run it",
        roomStep(o.danaName, o.other, true),
        o.caseyName,
      ],
      ["done", roomStep(o.danaName, o.other, false), o.morganName],
    ];
    for (const [label, step, member] of cases)
      expect({
        label,
        ...answer(await ask(o, asker.id, step, member), o.other),
      }).toEqual({
        label,
        ...answer(missing, missingId),
      });
  });

  it("refuses a member that does not exist (422 unknown_member), the lobby, an owner, a member who cannot run it, and a grant that is done, in that order", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const at = async (step: Record<string, unknown>, member?: string) =>
      outcome(await ask(o, asker.id, step, member));
    expect(await at(roomStep("nobody", o.room, true))).toEqual({
      status: 422,
      code: "unknown_member",
    });
    // Unknown member before the lobby.
    expect(await at(roomStep("nobody", "lobby", true))).toEqual({
      status: 422,
      code: "unknown_member",
    });
    expect(await at(roomStep(o.danaName, "lobby", true))).toEqual({
      status: 422,
      code: "lobby_open_to_all",
    });
    // The lobby before the owner rule.
    expect(await at(roomStep(o.morganName, "lobby", true))).toEqual({
      status: 422,
      code: "lobby_open_to_all",
    });
    expect(await at(roomStep(o.morganName, o.room, true))).toEqual({
      status: 422,
      code: "owner_has_all_rooms",
    });
    // Casey is not an office owner; Casey has the room already (409 if
    // checked first).
    expect(await at(roomStep(o.caseyName, o.room, true), o.caseyName)).toEqual({
      status: 403,
      code: "member_not_allowed",
    });
    expect(await at(roomStep(o.caseyName, o.room, true))).toEqual({
      status: 409,
      code: "step_done",
    });
    expect(await at(roomStep(o.danaName, o.room, false))).toEqual({
      status: 409,
      code: "step_done",
    });
    // The other direction of each is open.
    await opened(o, asker.id, roomStep(o.caseyName, o.room, false));
    await opened(o, asker.id, roomStep(o.danaName, o.room, true));
  });
});

describe("a member-room ask run from the card", () => {
  it("grants the room with the owner's session, keeps the member's other rooms, closes the ask as done, tells the agent, and writes one audit row with the ask", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, roomStep(o.danaName, o.room, true));
    // A room granted by hand after the create is kept: the run reads the
    // member's rooms when it runs.
    const byHand = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/users/${o.danaName}/access`,
      { allowedRooms: [o.other] },
    );
    expect(byHand.status).toBe(200);
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBe(200);
    expect(roomsOf(o.danaId).sort()).toEqual([o.room, o.other].sort());
    await closesDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toEqual([
      "systemEntries.stepAsk.memberRoomSet",
    ]);
    const rows = officeAuditStore().list({
      operation: "users.setAccess",
    }).items;
    // The by-hand row has no ask; the run's names Dana and the ask.
    expect(
      rows.map((r) => ({
        actor: [r.actor.kind, r.actor.id],
        dana: r.targets.includes(o.danaId),
        ask: r.targets.includes(entry.id),
      })),
    ).toContainEqual({ actor: ["member", o.morganId], dana: true, ask: true });
    expect(rows.filter((r) => r.targets.includes(entry.id))).toHaveLength(1);
  });

  it("two asks for one member, run one after the other, give both rooms", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const first = await opened(o, asker.id, roomStep(o.danaName, o.room, true));
    const second = await opened(
      o,
      asker.id,
      roomStep(o.danaName, o.other, true),
    );
    expect((await run(o, o.morgan, first.id)).status).toBe(200);
    expect((await run(o, o.morgan, second.id)).status).toBe(200);
    expect(roomsOf(o.danaId).sort()).toEqual([o.room, o.other].sort());
    await closesDone(o, asker.id, first.id);
    await closesDone(o, asker.id, second.id);
  });

  it("removes the room and leaves the others", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const both = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/users/${o.caseyName}/access`,
      { allowedRooms: [o.room, o.other] },
    );
    expect(both.status).toBe(200);
    const entry = await opened(
      o,
      asker.id,
      roomStep(o.caseyName, o.room, false),
    );
    expect((await run(o, o.morgan, entry.id)).status).toBe(200);
    expect(roomsOf(o.caseyId)).toEqual([o.other]);
    await closesDone(o, asker.id, entry.id);
  });

  it("runs only for the member the ask is for: another member 404, nothing changed", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, roomStep(o.danaName, o.room, true));
    expect(outcome(await run(o, o.casey, entry.id))).toEqual({
      status: 404,
      code: "not_found",
    });
    expect(roomsOf(o.danaId)).toEqual([]);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
  });

  it("a member gone since the create: 422 unknown_member, the ask stays open", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, roomStep(o.danaName, o.room, true));
    const removed = await asSession(
      o,
      o.morgan,
      "DELETE",
      `/api/users/${o.danaName}`,
    );
    expect(removed.status).toBeLessThan(300);
    expect(outcome(await run(o, o.morgan, entry.id))).toEqual({
      status: 422,
      code: "unknown_member",
    });
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
  });

  it("a room closed since the create: a grant is refused (422 unknown_room) and stays open; a removal closes as done", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const casey = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/users/${o.caseyName}/access`,
      { allowedRooms: [o.room, o.other] },
    );
    expect(casey.status).toBe(200);
    const grant = await opened(
      o,
      asker.id,
      roomStep(o.danaName, o.other, true),
    );
    const removal = await opened(
      o,
      asker.id,
      roomStep(o.caseyName, o.other, false),
    );
    const closed = await asSession(
      o,
      o.morgan,
      "DELETE",
      `/api/rooms/${o.other}`,
    );
    expect(closed.status).toBeLessThan(300);
    await closesDone(o, asker.id, removal.id);
    expect(outcome(await run(o, o.morgan, grant.id))).toEqual({
      status: 422,
      code: "unknown_room",
    });
    expect(roomsOf(o.danaId)).toEqual([]);
    expect(await askStatus(o, asker.id, grant.id)).toBe("open");
  });

  it("a grant closes as done when the member is made an owner, who reaches every room", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, roomStep(o.danaName, o.room, true));
    const promoted = await asSession(
      o,
      o.morgan,
      "PATCH",
      `/api/users/${o.danaName}`,
      { role: "owner" },
    );
    expect(promoted.status).toBe(200);
    expect(roomsOf(o.danaId)).toEqual([]);
    await closesDone(o, asker.id, entry.id);
  });

  it("a removal for a member made an owner since the create: 422 owner_has_all_rooms at the run, nothing written, the ask stays open", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const entry = await opened(
      o,
      asker.id,
      roomStep(o.caseyName, o.room, false),
    );
    const promoted = await asSession(
      o,
      o.morgan,
      "PATCH",
      `/api/users/${o.caseyName}`,
      { role: "owner" },
    );
    expect(promoted.status).toBe(200);
    const before = roomsOf(o.caseyId);
    expect(outcome(await run(o, o.morgan, entry.id))).toEqual({
      status: 422,
      code: "owner_has_all_rooms",
    });
    expect(roomsOf(o.caseyId)).toEqual(before);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
    expect(stepLines(o, asker.id)).toEqual([]);
  });

  it("a change by hand on the page closes it; a change to another room does not", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, roomStep(o.danaName, o.room, true));
    const set = (rooms: string[]) =>
      asSession(o, o.morgan, "PUT", `/api/users/${o.danaName}/access`, {
        allowedRooms: rooms,
      });
    expect((await set([o.other])).status).toBe(200);
    await Bun.sleep(50);
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
    expect((await set([o.other, o.room])).status).toBe(200);
    await closesDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toEqual([
      "systemEntries.stepAsk.memberRoomSet",
    ]);
  });
});

describe("a member-role ask at create", () => {
  it("opens for an owner with the member stored by id and nothing run", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker", { manager: "Casey" });
    const entry = await opened(
      o,
      asker.id,
      roleStep(o.danaName, "owner"),
      o.morganName,
    );
    expect([entry.step, entry.link]).toEqual([
      { kind: "member-role", userId: o.danaId, role: "owner" },
      undefined,
    ]);
    expect(roleOf(o.danaId)).toBe("member");
  });

  it("refuses a role that is not member or owner, and extra keys: 400", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    for (const step of [
      roleStep(o.danaName, "admin"),
      { kind: "member-role", role: "owner" },
      { ...roleStep(o.danaName, "owner"), roomId: o.room },
    ])
      expect(outcome(await ask(o, asker.id, step))).toEqual({
        status: 400,
        code: "invalid_request",
      });
  });

  it("refuses an unknown member (422), a member who is not an owner (403, before done, and for their own role too), the last owner (409 last_owner), and a role the member has (409 step_done)", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const at = async (step: Record<string, unknown>, member?: string) =>
      outcome(await ask(o, asker.id, step, member));
    expect(await at(roleStep("nobody", "owner"))).toEqual({
      status: 422,
      code: "unknown_member",
    });
    // Casey may edit her own record on the page, but not her role.
    expect(await at(roleStep(o.caseyName, "owner"), o.caseyName)).toEqual({
      status: 403,
      code: "member_not_allowed",
    });
    expect(await at(roleStep(o.danaName, "owner"), o.caseyName)).toEqual({
      status: 403,
      code: "member_not_allowed",
    });
    // Casey is a member already (409 if checked first).
    expect(await at(roleStep(o.caseyName, "member"), o.caseyName)).toEqual({
      status: 403,
      code: "member_not_allowed",
    });
    expect(await at(roleStep(o.morganName, "member"))).toEqual({
      status: 409,
      code: "last_owner",
    });
    expect(await at(roleStep(o.morganName, "owner"))).toEqual({
      status: 409,
      code: "step_done",
    });
    expect(await at(roleStep(o.danaName, "member"))).toEqual({
      status: 409,
      code: "step_done",
    });
  });
});

describe("a member-role ask run from the card", () => {
  it("makes the member an owner with the owner's session, closes the ask as done, tells the agent, and writes one audit row with the ask", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, roleStep(o.danaName, "owner"));
    const res = await run(o, o.morgan, entry.id);
    expect(res.status).toBe(200);
    expect(roleOf(o.danaId)).toBe("owner");
    await closesDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toEqual([
      "systemEntries.stepAsk.memberRoleSet",
    ]);
    const rows = officeAuditStore()
      .list({ operation: "users.update" })
      .items.filter((r) => r.targets.includes(entry.id));
    expect(
      rows.map((r) => ({
        actor: [r.actor.kind, r.actor.id],
        dana: r.targets.includes(o.danaId),
      })),
    ).toEqual([{ actor: ["member", o.morganId], dana: true }]);
  });

  it("runs on the member's name now: a rename after the create does not break it", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, roleStep(o.danaName, "owner"));
    const renamed = await asSession(
      o,
      o.morgan,
      "PATCH",
      `/api/users/${o.danaName}`,
      { name: "Drew" },
    );
    expect(renamed.status).toBe(200);
    expect((await run(o, o.morgan, entry.id)).status).toBe(200);
    expect(roleOf(o.danaId)).toBe("owner");
    await closesDone(o, asker.id, entry.id);
  });

  it("an owner demotes themselves from the card when another owner is left", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const promoted = await asSession(
      o,
      o.morgan,
      "PATCH",
      `/api/users/${o.danaName}`,
      { role: "owner" },
    );
    expect(promoted.status).toBe(200);
    const entry = await opened(o, asker.id, roleStep(o.morganName, "member"));
    expect((await run(o, o.morgan, entry.id)).status).toBe(200);
    expect(roleOf(o.morganId)).toBe("member");
    await closesDone(o, asker.id, entry.id);
  });

  it("a member gone since the create: 422 unknown_member, the ask stays open", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, roleStep(o.danaName, "owner"));
    const removed = await asSession(
      o,
      o.morgan,
      "DELETE",
      `/api/users/${o.danaName}`,
    );
    expect(removed.status).toBeLessThan(300);
    expect(outcome(await run(o, o.morgan, entry.id))).toEqual({
      status: 422,
      code: "unknown_member",
    });
    expect(await askStatus(o, asker.id, entry.id)).toBe("open");
  });

  it("a role change by hand closes it", async () => {
    const o = await membersOffice();
    const asker = await spawn(o, "Asker");
    const entry = await opened(o, asker.id, roleStep(o.danaName, "owner"));
    const set = await asSession(
      o,
      o.morgan,
      "PATCH",
      `/api/users/${o.danaName}`,
      { role: "owner" },
    );
    expect(set.status).toBe(200);
    await closesDone(o, asker.id, entry.id);
    expect(stepLines(o, asker.id)).toEqual([
      "systemEntries.stepAsk.memberRoleSet",
    ]);
  });
});

describe("member asks from /mcp", () => {
  it("open_ask takes a member-room and a member-role step", async () => {
    const o: MembersOffice = await membersOffice();
    const agent = await spawn(o, "Triage");
    // /mcp takes an agent below Standard.
    const lowered = await asSession(
      o,
      o.morgan,
      "PUT",
      `/api/agents/${agent.id}/access`,
      { access: "office", pack: { areas: { asks: "write" } } },
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
    for (const [step, stored] of [
      [
        roomStep(o.danaName, o.room, true),
        { kind: "member-room", userId: o.danaId, roomId: o.room, grant: true },
      ],
      [
        roleStep(o.danaName, "owner"),
        { kind: "member-role", userId: o.danaId, role: "owner" },
      ],
    ] as const) {
      const result = (await client.callTool({
        name: "open_ask",
        arguments: { prompt: "Please change this.", step },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      expect({ kind: step.kind, error: result.isError ?? false }).toEqual({
        kind: step.kind,
        error: false,
      });
      const entry = JSON.parse(result.content?.[0]?.text ?? "{}") as AskEntry;
      expect(entry.step as unknown).toEqual(stored);
    }
  });
});
