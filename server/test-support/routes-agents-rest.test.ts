// Phase 3d slice 7 - agent-lifecycle REST contract.
//
// HTTP-contract layer for the agent-lifecycle mutations cut over from WS in
// slice 7. Pins status codes + guard behavior for the cores built in
// server/routes/handlers/agents.ts.
//
//   7a (this file's first blocks): the FIRE-AND-FORGET mutations
//   (kill/abort/move/swapDesks/setTopic/clearTopic). agentParam(:id) resolves an
//   agent to its room and checks access, so a NON-EXISTENT or INACCESSIBLE agent
//   both collapse to a uniform 403 (no existence oracle) - even for an owner,
//   since roomIdForAgent(missing) is null before the owner rule is consulted.
//   move requires BOTH source-agent and target-room access; swapDesks requires
//   room access. The per-recipient projection of the move (and the two-guard
//   cross-room ACL) is frozen in projection.test.ts.
//
// Seam: startTestServer() - real auth + the /api executor. Zero LLM (the
// FakeBackend auto-completes), so spawn/kill/move are deterministic.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { loadRecentCwds } from "../persistence.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { DESK_COUNT } from "../../shared/desks.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}

async function req(
  srv: TestServer,
  method: string,
  path: string,
  init: { body?: unknown; rawSessionId?: string; bearer?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  const res = await srv.http(path, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    rawSessionId: init.rawSessionId,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const errCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } }).error?.code;

// Spawn directly via the core (transport-agnostic setup), at an explicit desk.
async function spawnAt(
  srv: TestServer,
  name: string,
  roomId: string,
  desk: number,
) {
  const a = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    desk,
    undefined,
    roomId,
  );
  if (!a) throw new Error(`spawn failed: ${name}`);
  return a;
}

describe("agents.kill REST (Phase 3d slice 7a)", () => {
  it("owner kills a live agent -> 204; agent leaves the live set", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "DELETE", `/api/agents/${x.id}`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);
    expect(srv.agentManager.getAllAgents().some((a) => a.id === x.id)).toBe(
      false,
    );
  });

  it("no identity -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "DELETE", `/api/agents/${x.id}`);
    expect(res.status).toBe(401);
    expect(srv.agentManager.getAllAgents().some((a) => a.id === x.id)).toBe(
      true,
    );
  });

  it("owner + nonexistent agent -> uniform 403 (no existence oracle)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const res = await req(srv, "DELETE", "/api/agents/nope", {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(403);
  });

  it("member with no access -> 403; agent untouched", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "DELETE", `/api/agents/${x.id}`, {
      rawSessionId: member.rawSessionId,
    });
    expect(res.status).toBe(403);
    expect(srv.agentManager.getAllAgents().some((a) => a.id === x.id)).toBe(
      true,
    );
  });
});

describe("agents.abort REST (Phase 3d slice 7a)", () => {
  it("owner aborts an idle agent -> 204 (no-op safe)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "POST", `/api/agents/${x.id}/abort`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);
  });
});

describe("agents.move REST (Phase 3d slice 7a)", () => {
  it("owner moves an agent -> 200 { agent } with the new roomId", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const r2 = srv.agentManager.createRoom("R2");
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "POST", `/api/agents/${x.id}/move`, {
      body: { targetRoomId: r2 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    const agent = (res.body as { agent?: { roomId?: string } }).agent;
    expect(agent?.roomId).toBe(r2);
    expect(srv.agentManager.getAgent(x.id)?.roomId).toBe(r2);
  });

  it("no identity -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const r2 = srv.agentManager.createRoom("R2");
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "POST", `/api/agents/${x.id}/move`, {
      body: { targetRoomId: r2 },
    });
    expect(res.status).toBe(401);
  });

  it("same-room move -> 200 { agent } (idempotent no-op, not a 404)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "POST", `/api/agents/${x.id}/move`, {
      body: { targetRoomId: r1 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    expect((res.body as { agent?: { roomId?: string } }).agent?.roomId).toBe(
      r1,
    );
  });

  it("owner + nonexistent target room -> 404 room_not_found (rule-based access passes the guard; the dep disambiguates)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "POST", `/api/agents/${x.id}/move`, {
      body: { targetRoomId: "no-such-room" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(404);
    expect(errCode(res.body)).toBe("room_not_found");
    expect(srv.agentManager.getAgent(x.id)?.roomId).toBe(r1); // untouched
  });

  it("full target room -> 409 no_free_desk (not a false agent_not_found)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const r2 = srv.agentManager.createRoom("R2");
    for (let d = 0; d < 8; d++) await spawnAt(srv, `F${d}`, r2, d); // fill r2
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "POST", `/api/agents/${x.id}/move`, {
      body: { targetRoomId: r2 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(409);
    expect(errCode(res.body)).toBe("no_free_desk");
    expect(srv.agentManager.getAgent(x.id)?.roomId).toBe(r1); // untouched
  });
});

describe("rooms.swapDesks REST (Phase 3d slice 7a)", () => {
  it("owner swaps two desks -> 204; the agents trade desks", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const a = await spawnAt(srv, "A", r1, 0);
    const b = await spawnAt(srv, "B", r1, 1);
    const res = await req(srv, "POST", `/api/rooms/${r1}/swap-desks`, {
      body: { deskA: 0, deskB: 1 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);
    expect(srv.agentManager.getAgent(a.id)?.desk).toBe(1);
    expect(srv.agentManager.getAgent(b.id)?.desk).toBe(0);
  });

  it("missing desk indices -> 422 invalid_desks", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "POST", `/api/rooms/${r1}/swap-desks`, {
      body: {},
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_desks");
  });

  it("member with no room access -> 403", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const r1 = srv.agentManager.getRooms()[0].id;
    await spawnAt(srv, "A", r1, 0);
    await spawnAt(srv, "B", r1, 1);
    const res = await req(srv, "POST", `/api/rooms/${r1}/swap-desks`, {
      body: { deskA: 0, deskB: 1 },
      rawSessionId: member.rawSessionId,
    });
    expect(res.status).toBe(403);
  });
});

describe("agents.setTopic / clearTopic REST (Phase 3d slice 7a)", () => {
  it("owner sets a topic -> 204; the topic lands", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "PUT", `/api/agents/${x.id}/topic`, {
      body: { topic: "Refactor planning" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);
    expect(srv.agentManager.getAgent(x.id)?.topic).toBe("Refactor planning");
  });

  it("owner clears a topic -> 204", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    srv.agentManager.setTopic(x.id, "to be cleared");
    const res = await req(srv, "DELETE", `/api/agents/${x.id}/topic`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(204);
  });

  it("missing topic -> 422 invalid_topic (malformed body, not an empty-topic write)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "PUT", `/api/agents/${x.id}/topic`, {
      body: {},
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_topic");
    expect(srv.agentManager.getAgent(x.id)?.topic).toBe(null);
  });
});

describe("agents.spawn REST (Phase 3d slice 7b)", () => {
  const spawnBody = (
    srv: TestServer,
    name: string,
    roomId: string,
    desk: number,
  ) => ({
    name,
    cwd: srv.stateRoot,
    roomId,
    desk,
    permissionMode: "default" as const,
  });

  it("owner spawns -> 201 { agent } in the target room", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "POST", "/api/agents", {
      body: spawnBody(srv, "Aria", r1, 0),
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(201);
    const agent = (
      res.body as { agent?: { id?: string; name?: string; roomId?: string } }
    ).agent;
    expect(agent?.name).toBe("Aria");
    expect(agent?.roomId).toBe(r1);
    expect(
      srv.agentManager.getAllAgents().some((a) => a.id === agent!.id),
    ).toBe(true);
  });

  it("duplicate name -> 409 name_taken (field hint for the dialog)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    await spawnAt(srv, "Dup", r1, 0);
    const res = await req(srv, "POST", "/api/agents", {
      body: spawnBody(srv, "Dup", r1, 1),
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(409);
    expect(errCode(res.body)).toBe("name_taken");
  });

  it("full target room -> 409 no_free_desk", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    for (let d = 0; d < 8; d++) await spawnAt(srv, `Fill${d}`, r1, d);
    const res = await req(srv, "POST", "/api/agents", {
      body: spawnBody(srv, "Extra", r1, 0),
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(409);
    expect(errCode(res.body)).toBe("no_free_desk");
  });

  // Task e87d9c7d: an explicit desk used to be accepted whenever the slot was
  // merely un-taken, never checked against the grid. The agent was real (it
  // showed up in /agents and took messages) but had no slot to be drawn at, so
  // rendering the room threw and the whole office view for that room went down.
  it("desk past the last slot -> 422 invalid_desk, and no agent is created", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "POST", "/api/agents", {
      body: spawnBody(srv, "OffGrid", r1, DESK_COUNT),
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_desk");
    expect(srv.agentManager.getAllAgents()).toHaveLength(0);
  });

  it("negative desk -> 422 invalid_desk (-1 is also the room-full sentinel)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "POST", "/api/agents", {
      body: spawnBody(srv, "Negative", r1, -1),
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_desk");
    expect(srv.agentManager.getAllAgents()).toHaveLength(0);
  });

  it("an out-of-range desk cannot smuggle an agent into a FULL room", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    for (let d = 0; d < DESK_COUNT; d++) await spawnAt(srv, `Fill${d}`, r1, d);
    const res = await req(srv, "POST", "/api/agents", {
      body: spawnBody(srv, "Ninth", r1, DESK_COUNT),
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(srv.agentManager.getAllAgents()).toHaveLength(DESK_COUNT);
  });

  // The core holds the same line for callers that don't come through REST
  // (boot/restore, the welcome seed, plugins).
  it("core: agentManager.spawn with an out-of-range desk returns null", async () => {
    const srv = await startTestServer();
    server = srv;
    const r1 = srv.agentManager.getRooms()[0].id;
    const created = await srv.agentManager.spawn(
      "CoreOffGrid",
      srv.stateRoot,
      "default",
      DESK_COUNT,
      undefined,
      r1,
    );
    expect(created).toBeNull();
    expect(srv.agentManager.getAllAgents()).toHaveLength(0);
  });

  it("invalid cwd -> 400 invalid_cwd", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "POST", "/api/agents", {
      body: {
        name: "BadCwd",
        cwd: "/no/such/dir/anywhere",
        roomId: r1,
        desk: 0,
        permissionMode: "default",
      },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(400);
    expect(errCode(res.body)).toBe("invalid_cwd");
  });

  it("member without access to the target room -> 403 (bodyRoom guard)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const r1 = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "POST", "/api/agents", {
      body: spawnBody(srv, "X", r1, 0),
      rawSessionId: member.rawSessionId,
    });
    expect(res.status).toBe(403);
  });

  it("no identity -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "POST", "/api/agents", {
      body: spawnBody(srv, "X", r1, 0),
    });
    expect(res.status).toBe(401);
  });

  it("malformed optional field -> 422 invalid_request (not a 500)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "POST", "/api/agents", {
      body: { name: "X", cwd: srv.stateRoot, roomId: r1, desk: 0, outfit: 123 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_request");
  });

  it("owner + nonexistent roomId -> 404 room_not_found, NOT a silent spawn into rooms[0]", async () => {
    // An owner's rule-based bodyRoom access passes ANY room id, so the bogus id
    // reaches the core. Before the fix, OfficeState.spawn coerced it to
    // rooms[0]; now it is rejected and the dep disambiguates to room_not_found.
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const res = await req(srv, "POST", "/api/agents", {
      body: spawnBody(srv, "Ghost", "no-such-room", 0),
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(404);
    expect(errCode(res.body)).toBe("room_not_found");
    // Nothing landed anywhere - especially not in rooms[0].
    expect(srv.agentManager.getAllAgents().length).toBe(0);
  });

  it("claude agentType (default) + Codex modelFamily -> 422 invalid_model_family, NOT a silent default-model spawn", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "POST", "/api/agents", {
      body: { ...spawnBody(srv, "Mismatch", r1, 0), modelFamily: "gpt-5.5" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_model_family");
    expect(srv.agentManager.getAllAgents().length).toBe(0);
  });

  it("codex agentType + Claude family -> 422 invalid_model_family (statically impossible pairing)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "POST", "/api/agents", {
      body: {
        ...spawnBody(srv, "Mismatch", r1, 0),
        agentType: "codex",
        modelFamily: "opus",
      },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_model_family");
  });

  it("matched agentType + modelFamily still spawns (codex + codex slug -> 201)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "POST", "/api/agents", {
      body: {
        ...spawnBody(srv, "Codexy", r1, 0),
        agentType: "codex",
        permissionMode: "on-request",
        modelFamily: "gpt-5.5",
      },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(201);
    const agent = (res.body as { agent?: { modelFamily?: string } }).agent;
    expect(agent?.modelFamily).toBe("gpt-5.5");
  });
});

describe("agents.update REST (Phase 3d slice 7b)", () => {
  it("owner edits -> 200 { agent } with the change applied", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: { name: "Renamed" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    expect((res.body as { agent?: { name?: string } }).agent?.name).toBe(
      "Renamed",
    );
    expect(srv.agentManager.getAgent(x.id)?.name).toBe("Renamed");
  });

  it("invalid cwd -> 400 invalid_cwd", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: { cwd: "/no/such/dir/anywhere" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(400);
    expect(errCode(res.body)).toBe("invalid_cwd");
  });

  it("member with no access -> 403", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: { name: "Z" },
      rawSessionId: member.rawSessionId,
    });
    expect(res.status).toBe(403);
  });

  it("malformed body field -> 422 invalid_request (not a 500); agent untouched", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: { name: 123 }, // truthy non-string would break the string path
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_request");
    expect(srv.agentManager.getAgent(x.id)?.name).toBe("X");
  });

  it("PATCH modelFamily alone with a wrong-engine value -> 422 invalid_model_family; agent untouched", async () => {
    // Before the fix this was silently coerced to the Claude default (i.e. the
    // PATCH was ignored or, worse, changed the model to the default).
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0); // claude agent
    const before = srv.agentManager.getAgent(x.id)?.modelFamily;
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: { modelFamily: "gpt-5.5" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_model_family");
    expect(srv.agentManager.getAgent(x.id)?.modelFamily).toBe(before);
  });

  it("PATCH valid cwd + mismatched modelFamily -> 422; NO side effect lands (agent and recent-cwd list untouched)", async () => {
    // Validation-before-side-effects: the cwd in a rejected edit must not be
    // recorded in the persisted recent-cwd list, and no field may change.
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: { cwd: "/tmp", modelFamily: "gpt-5.5" }, // cwd valid, family not
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_model_family");
    expect(srv.agentManager.getAgent(x.id)?.cwd).toBe(x.cwd); // untouched
    expect(loadRecentCwds()).not.toContain("/tmp");
  });

  // --- customInstructions version guard (task 44a2c98d) ----------------------
  // Blob-bearing PATCHes must echo AgentInfo.customInstructionsVersion (read
  // surfaces: the wire object for the UI, GET /api/agents/:id/instructions for
  // agents - pinned in the "agents.readInstructions REST" block below).
  // Scalar-only edits stay version-free (pinned by "owner edits" above, which
  // PATCHes name without a version and gets 200).

  it("PATCH customInstructions WITHOUT the version -> 400 invalid_version; blob untouched", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: { customInstructions: "be terse" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(400);
    expect(errCode(res.body)).toBe("invalid_version");
    expect(srv.agentManager.getAgent(x.id)?.customInstructions).toBeNull();
  });

  it("PATCH customInstructions WITH the current version -> 200; blob + version advance in lockstep on the returned agent", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    // Capture the token as a primitive: getAgent returns the LIVE object, so
    // reading the field off it after the PATCH would see the bumped value.
    const beforeVersion = srv.agentManager.getAgent(
      x.id,
    )!.customInstructionsVersion;
    expect(beforeVersion).toMatch(/^[0-9a-f]{12}$/);
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: {
        customInstructions: "be terse",
        customInstructionsVersion: beforeVersion,
      },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    const returned = (
      res.body as {
        agent: {
          customInstructions: string;
          customInstructionsVersion: string;
        };
      }
    ).agent;
    expect(returned.customInstructions).toBe("be terse");
    expect(returned.customInstructionsVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(returned.customInstructionsVersion).not.toBe(beforeVersion);
    expect(srv.agentManager.getAgent(x.id)?.customInstructions).toBe(
      "be terse",
    );
  });

  it("PATCH customInstructions with a STALE version -> 409 version_conflict carrying the CURRENT version; blob untouched", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    // Writer A reads, then writer B saves - A's token is now stale.
    const staleVersion = srv.agentManager.getAgent(
      x.id,
    )!.customInstructionsVersion;
    expect(
      (
        await req(srv, "PATCH", `/api/agents/${x.id}`, {
          body: {
            customInstructions: "B's instructions",
            customInstructionsVersion: staleVersion,
          },
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(200);
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: {
        customInstructions: "A's clobber",
        customInstructionsVersion: staleVersion,
      },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(409);
    const err = (res.body as { error?: { code?: string; version?: string } })
      .error;
    expect(err?.code).toBe("version_conflict");
    expect(err?.version).toBe(
      srv.agentManager.getAgent(x.id)!.customInstructionsVersion,
    );
    expect(srv.agentManager.getAgent(x.id)?.customInstructions).toBe(
      "B's instructions",
    );
  });

  it("failed cwd+instructions edit rolls back blob AND version in LOCKSTEP - the client's old token still works (no false 409)", async () => {
    // Reviewer2 finding (task 44a2c98d): the editAgent rollback snapshot must
    // restore customInstructionsVersion together with customInstructions. If it
    // didn't, a failed combined edit would leave the stored token derived from
    // the REJECTED blob while every client (which never saw an agent_updated -
    // the broadcast is held until the session side effect succeeds) still holds
    // the old token, so their next valid edit would false-409.
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    // Wake the agent so it holds a live session with a sessionId: a cwd change
    // on a session-bearing Claude agent must relocate the session's .jsonl, and
    // no such file exists anywhere for the fake session id - the move preflight
    // fails and the whole edit rolls back (the path under test). All Claude-dir
    // consults on this path are read-only, so no host state is touched.
    const enq = srv.agentManager.enqueueMessage(x.id, {
      sender: { kind: "user", username: "tester" },
      text: "wake",
    });
    expect(enq.ok).toBe(true);
    const deadline = Date.now() + 2000;
    while (srv.agentManager.getCurrentSessionId(x.id) === null) {
      if (Date.now() > deadline) throw new Error("wake never set a sessionId");
      await new Promise((r) => setTimeout(r, 10));
    }
    const oldCwd = srv.agentManager.getAgent(x.id)!.cwd;
    const v0 = srv.agentManager.getAgent(x.id)!.customInstructionsVersion;

    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: {
        cwd: "/tmp",
        customInstructions: "be terse",
        customInstructionsVersion: v0,
      },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(400);
    expect(errCode(res.body)).toBe("edit_failed");

    // Rollback restored the PAIR: blob back to null, token back to v0, cwd
    // untouched.
    const after = srv.agentManager.getAgent(x.id)!;
    expect(after.customInstructions).toBeNull();
    expect(after.customInstructionsVersion).toBe(v0);
    expect(after.cwd).toBe(oldCwd);

    // The client's old token is still valid: a plain instructions edit with v0
    // succeeds (this is the assertion that would fail with a token-only bump
    // left behind by the rollback).
    const retry = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: {
        customInstructions: "be terse",
        customInstructionsVersion: v0,
      },
      rawSessionId: owner.rawSessionId,
    });
    expect(retry.status).toBe(200);
    expect(srv.agentManager.getAgent(x.id)?.customInstructions).toBe(
      "be terse",
    );
  });

  it("agent_updated broadcast carries the bumped customInstructionsVersion alongside the blob (clients stay current without a refetch)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const sock = await srv.connectWs(owner.rawSessionId);
    const version = srv.agentManager.getAgent(x.id)!.customInstructionsVersion;
    await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: {
        customInstructions: "be terse",
        customInstructionsVersion: version,
      },
      rawSessionId: owner.rawSessionId,
    });
    await sock.waitFor("agent_updated");
    const evt = sock.messages.find(
      (m) =>
        (m as { type?: string }).type === "agent_updated" &&
        (m as { changes?: { customInstructions?: unknown } }).changes
          ?.customInstructions !== undefined,
    ) as {
      changes: {
        customInstructions: string;
        customInstructionsVersion: string;
      };
    };
    expect(evt.changes.customInstructions).toBe("be terse");
    expect(evt.changes.customInstructionsVersion).toBe(
      srv.agentManager.getAgent(x.id)!.customInstructionsVersion,
    );
  });

  it("PATCH a valid same-engine modelFamily -> 200 with the change applied (strict check doesn't over-reject)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0);
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: { modelFamily: "sonnet" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    expect(srv.agentManager.getAgent(x.id)?.modelFamily).toBe("sonnet");
  });

  it("PATCH agentType switch validates modelFamily against the NEW engine", async () => {
    // claude -> codex with a Claude family: rejected against the TARGET engine
    // (the caller almost certainly meant a Codex slug), agent untouched.
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0); // claude agent
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: { agentType: "codex", modelFamily: "opus" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_model_family");
    expect(srv.agentManager.getAgent(x.id)?.agentType).toBe("claude");
  });

  it("PATCH claude->codex WITH a Codex slug -> 200; the switch lands with that model", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "X", r1, 0); // claude agent
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: { agentType: "codex", modelFamily: "gpt-5.5" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    const after = srv.agentManager.getAgent(x.id);
    expect(after?.agentType).toBe("codex");
    expect(after?.modelFamily).toBe("gpt-5.5");
  });

  it("PATCH codex->claude with a Codex slug -> 422 (validated against the NEW engine, both directions)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await srv.agentManager.spawn(
      "Codexy",
      srv.stateRoot,
      "on-request",
      0,
      undefined,
      r1,
      undefined,
      "gpt-5.5",
      undefined,
      undefined,
      "codex",
    );
    if (!x) throw new Error("codex spawn failed");
    const res = await req(srv, "PATCH", `/api/agents/${x.id}`, {
      body: { agentType: "claude", modelFamily: "gpt-5.5" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errCode(res.body)).toBe("invalid_model_family");
    const after = srv.agentManager.getAgent(x.id);
    expect(after?.agentType).toBe("codex");
    expect(after?.modelFamily).toBe("gpt-5.5");
  });
});

describe("agents.revive REST (Phase 3d slice 7b)", () => {
  // autoSystemInit:false so the killed agent's lastSessionId is null and the
  // revive takes the fresh-session path (no resume preflight warning). The HTTP
  // contract is what we pin here; the lastRoomId/target-room ACL lives in
  // projection.test.ts.
  it("owner revives a killed agent -> 200 { agent }", async () => {
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({ session: { autoSystemInit: false } }),
    });
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "K", r1, 0);
    await srv.agentManager.kill(x.id);
    const res = await req(srv, "POST", `/api/agents/${x.id}/revive`, {
      body: { roomId: r1, desk: 0 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    expect((res.body as { agent?: { id?: string } }).agent?.id).toBe(x.id);
    expect(srv.agentManager.getAgent(x.id)).toBeDefined();
  });

  // Task e87d9c7d: revive shape-checks the desk range like spawn. The core
  // rejected an off-grid desk too, but as "That desk is no longer free." -
  // telling the boss a desk was occupied when it doesn't exist at all.
  it("out-of-range desk -> 422 invalid_desk, and the agent stays dead", async () => {
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({ session: { autoSystemInit: false } }),
    });
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnAt(srv, "K", r1, 0);
    await srv.agentManager.kill(x.id);
    for (const desk of [DESK_COUNT, -1]) {
      const res = await req(srv, "POST", `/api/agents/${x.id}/revive`, {
        body: { roomId: r1, desk },
        rawSessionId: owner.rawSessionId,
      });
      expect(res.status).toBe(422);
      expect(errCode(res.body)).toBe("invalid_desk");
    }
    expect(srv.agentManager.getAgent(x.id)).toBeUndefined();
  });

  it("no identity -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const res = await req(srv, "POST", "/api/agents/whatever/revive", {
      body: { roomId: r1, desk: 0 },
    });
    expect(res.status).toBe(401);
  });
});

describe("agents.readInstructions REST (task 68891fa1)", () => {
  // The sanctioned read half of the read-then-PATCH flow: GET
  // /api/agents/:id/instructions -> { customInstructions,
  // customInstructionsVersion }. Nil-decided policy pinned here: the read is
  // `authenticated` + room access - EVERY agent (privileged or not) may read
  // any agent it can see; privilege gates only the WRITE (agents.update), and
  // the version token is a lost-update guard, not an authorization mechanism.

  // Spawn an agent MANAGED BY a specific user, so its bearer token carries
  // that user's room access (an unowned agent's token has access to nothing).
  async function spawnOwnedBy(
    srv: TestServer,
    name: string,
    roomId: string,
    desk: number,
    username: string,
    customInstructions?: string,
  ) {
    const user = getUserByName(username);
    if (!user) throw new Error(`unknown user: ${username}`);
    const a = await srv.agentManager.spawn(
      name,
      srv.stateRoot,
      "default",
      desk,
      customInstructions,
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

  it("a NON-privileged agent bearer reads a room-mate's blob + version -> 200 (reads are not privilege-gated)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const target = await spawnOwnedBy(
      srv,
      "Target",
      r1,
      0,
      owner.username,
      "be terse",
    );
    const reader = await spawnOwnedBy(srv, "Reader", r1, 1, owner.username);
    const token = getAgentTokenRaw(reader.id);
    if (!token) throw new Error("agent token not minted on spawn");
    const res = await req(srv, "GET", `/api/agents/${target.id}/instructions`, {
      bearer: token,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      customInstructions: "be terse",
      customInstructionsVersion: srv.agentManager.getAgent(target.id)!
        .customInstructionsVersion,
    });
  });

  it("a null blob reads as { customInstructions: null } with the sentinel version (still echoable)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const target = await spawnOwnedBy(srv, "Target", r1, 0, owner.username);
    const reader = await spawnOwnedBy(srv, "Reader", r1, 1, owner.username);
    const res = await req(srv, "GET", `/api/agents/${target.id}/instructions`, {
      bearer: getAgentTokenRaw(reader.id)!,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      customInstructions: string | null;
      customInstructionsVersion: string;
    };
    expect(body.customInstructions).toBeNull();
    expect(body.customInstructionsVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it("read -> PATCH echoing the returned version -> 200; the pre-edit version is then stale (409)", async () => {
    // The end-to-end flow the endpoint exists for: an operator reads the blob
    // + version, edits, and echoes the version back through agents.update.
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const target = await spawnOwnedBy(srv, "Target", r1, 0, owner.username);
    const read = await req(
      srv,
      "GET",
      `/api/agents/${target.id}/instructions`,
      { rawSessionId: owner.rawSessionId },
    );
    expect(read.status).toBe(200);
    const { customInstructionsVersion: v0 } = read.body as {
      customInstructionsVersion: string;
    };
    const patch = await req(srv, "PATCH", `/api/agents/${target.id}`, {
      body: { customInstructions: "be terse", customInstructionsVersion: v0 },
      rawSessionId: owner.rawSessionId,
    });
    expect(patch.status).toBe(200);
    // A re-read returns the advanced version; the old token is now stale.
    const reread = await req(
      srv,
      "GET",
      `/api/agents/${target.id}/instructions`,
      { rawSessionId: owner.rawSessionId },
    );
    expect(
      (reread.body as { customInstructionsVersion: string })
        .customInstructionsVersion,
    ).not.toBe(v0);
    const stale = await req(srv, "PATCH", `/api/agents/${target.id}`, {
      body: { customInstructions: "clobber", customInstructionsVersion: v0 },
      rawSessionId: owner.rawSessionId,
    });
    expect(stale.status).toBe(409);
    expect(errCode(stale.body)).toBe("version_conflict");
  });

  it("an agent bearer without room access to the target -> uniform 403 (same for a nonexistent id - no existence oracle)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia"); // no room grants
    const r1 = srv.agentManager.getRooms()[0].id;
    const target = await spawnOwnedBy(srv, "Target", r1, 0, owner.username);
    // Reader is managed by the grant-less member, so its token can't see r1.
    const reader = await spawnOwnedBy(srv, "Reader", r1, 1, member.username);
    const token = getAgentTokenRaw(reader.id)!;
    const denied = await req(
      srv,
      "GET",
      `/api/agents/${target.id}/instructions`,
      { bearer: token },
    );
    expect(denied.status).toBe(403);
    const missing = await req(
      srv,
      "GET",
      "/api/agents/agent-0-none/instructions",
      { bearer: token },
    );
    expect(missing.status).toBe(403);
  });

  it("no identity -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const target = await spawnOwnedBy(srv, "Target", r1, 0, owner.username);
    const res = await req(
      srv,
      "GET",
      `/api/agents/${target.id}/instructions`,
      {},
    );
    expect(res.status).toBe(401);
  });
});
