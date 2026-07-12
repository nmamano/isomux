// Phase 3d slice 7 — agent-lifecycle REST contract.
//
// HTTP-contract layer for the agent-lifecycle mutations cut over from WS in
// slice 7. Pins status codes + guard behavior for the cores built in
// server/routes/handlers/agents.ts.
//
//   7a (this file's first blocks): the FIRE-AND-FORGET mutations
//   (kill/abort/move/swapDesks/setTopic/clearTopic). agentParam(:id) resolves an
//   agent to its room and checks access, so a NON-EXISTENT or INACCESSIBLE agent
//   both collapse to a uniform 403 (no existence oracle) — even for an owner,
//   since roomIdForAgent(missing) is null before the owner rule is consulted.
//   move requires BOTH source-agent and target-room access; swapDesks requires
//   room access. The per-recipient projection of the move (and the two-guard
//   cross-room ACL) is frozen in projection.test.ts.
//
// Seam: startTestServer() — real auth + the /api executor. Zero LLM (the
// FakeBackend auto-completes), so spawn/kill/move are deterministic.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { loadRecentCwds } from "../persistence.ts";

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
  init: { body?: unknown; rawSessionId?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
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
    // Nothing landed anywhere — especially not in rooms[0].
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
