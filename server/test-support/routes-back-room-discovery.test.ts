// GET /agents with back room agents (task 5b503e32): an agent's default list
// shows each back room as one summary entry with a string name and no id;
// ?back=1 and non-agent callers get every agent; summaries respect room access.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { isBackSeat } from "../../shared/desks.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

type Entry = Record<string, unknown>;

async function spawnAs(
  srv: TestServer,
  name: string,
  roomId: string,
  desk: number | null,
  username: string,
) {
  const user = getUserByName(username);
  if (!user) throw new Error(`unknown user: ${username}`);
  const a = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    desk,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    username,
    "claude",
    undefined,
    user.id,
  );
  if (!a) throw new Error(`spawn failed: ${name}`);
  return a;
}

function bearer(agentId: string): string {
  const token = getAgentTokenRaw(agentId);
  if (!token) throw new Error(`no token: ${agentId}`);
  return token;
}

async function listAs(srv: TestServer, agentId: string, query = "") {
  const res = await fetch(`${srv.baseUrl}/agents${query}`, {
    headers: { Authorization: `Bearer ${bearer(agentId)}` },
  });
  return { status: res.status, body: (await res.json()) as Entry[] };
}

// One room with a front agent and three back agents, all the owner's.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const r1 = srv.agentManager.getRooms()[0].id;
  srv.agentManager.setRoomBackRoom(r1, true);
  const lead = await spawnAs(srv, "Lead", r1, 0, owner.username);
  for (const name of ["Worker 1", "Worker 2", "Worker 3"])
    await spawnAs(srv, name, r1, null, owner.username);
  return { srv, owner, r1, lead };
}

describe("GET /agents for an agent: one entry per back room", () => {
  it("lists front agents and one summary with a string name and no id", async () => {
    const { srv, r1, lead } = await office();
    const { status, body } = await listAs(srv, lead.id);
    expect(status).toBe(200);
    expect(body.map((e) => e.name)).toEqual(["Lead", "3 in the back room"]);
    const summary = body[1];
    expect(summary).toEqual({
      name: "3 in the back room",
      backRoom: true,
      roomId: r1,
      roomName: srv.agentManager.getRooms()[0].name,
      room: 1,
      agents: 3,
      busy: 0,
      pendingPrompt: 0,
    });
    expect("id" in summary).toBe(false);
  });

  it("keeps a jq-style name filter working over the whole list", async () => {
    const { srv, lead } = await office();
    const { body } = await listAs(srv, lead.id);
    // .[] | select(.name|test("Worker")) aborts on a null name; every entry
    // must carry a string one, and no summary may carry an agent's name.
    for (const e of body) expect(typeof e.name).toBe("string");
    const agentNames = new Set(
      srv.agentManager.getAllAgents().map((a) => a.name),
    );
    for (const e of body.filter((x) => x.backRoom === true))
      expect(agentNames.has(e.name as string)).toBe(false);
    expect(body.filter((e) => /Worker/.test(e.name as string))).toEqual([]);
  });

  it("?back=1 lists every back agent, marked backRoom, with front entries unchanged", async () => {
    const { srv, lead } = await office();
    const { status, body } = await listAs(srv, lead.id, "?back=1");
    expect(status).toBe(200);
    expect(body.map((e) => e.name)).toEqual([
      "Lead",
      "Worker 1",
      "Worker 2",
      "Worker 3",
    ]);
    expect("backRoom" in body[0]).toBe(false);
    for (const e of body.slice(1)) {
      expect(e.backRoom).toBe(true);
      expect(typeof e.id).toBe("string");
      expect(isBackSeat(e.desk as number)).toBe(true);
    }
  });

  it("a member's cookie gets every agent, as before", async () => {
    const { srv, owner } = await office();
    const res = await srv.http("/agents", { rawSessionId: owner.rawSessionId });
    const body = (await res.json()) as Entry[];
    expect(body.map((e) => e.name).sort()).toEqual([
      "Lead",
      "Worker 1",
      "Worker 2",
      "Worker 3",
    ]);
  });

  it("a summary counts only rooms the caller can see", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mem");
    const r1 = srv.agentManager.getRooms()[0].id;
    srv.agentManager.setRoomBackRoom(r1, true);
    const r2 = srv.agentManager.createRoom("Members Only");
    srv.agentManager.setRoomBackRoom(r2, true);
    const access = await srv.http(
      `/api/users/${encodeURIComponent(member.username)}/access`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedRooms: [r2] }),
        rawSessionId: owner.rawSessionId,
      },
    );
    expect(access.ok).toBe(true);
    await spawnAs(srv, "Hidden Worker", r1, null, owner.username);
    const mine = await spawnAs(srv, "Mine", r2, 0, member.username);
    const { body } = await listAs(srv, mine.id);
    expect(body.map((e) => e.name)).toEqual(["Mine"]);
    const ownerAgent = await spawnAs(
      srv,
      "Morgan Agent",
      r1,
      0,
      owner.username,
    );
    const all = await listAs(srv, ownerAgent.id);
    expect(all.body.map((e) => e.name)).toContain("1 in the back room");
  });

  it("back other than 1, or with killed -> 400", async () => {
    const { srv, lead } = await office();
    for (const q of ["?back=0", "?back=1&killed=1", "?back=yes"]) {
      const res = await fetch(`${srv.baseUrl}/agents${q}`, {
        headers: { Authorization: `Bearer ${bearer(lead.id)}` },
      });
      expect(res.status).toBe(400);
    }
  });
});
