// The back room over REST (task 5b503e32): spawn, move and revive with no
// desk or desk null, the refusals that name a back seat or a taken desk, and
// the 409 for a full back room. Every room but the lobby has a back room with
// no setting (task e2fb9fa0), so these run in rooms as the server makes them;
// PATCH /api/rooms/:roomId still takes a `backRoom` key from an older client
// and ignores it. GET /agents with back room agents:
// routes-agents-manifest.test.ts.

import { sessionCookieName } from "../auth.ts";
import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  BACK_ROOM_SEATS,
  DESK_COUNT,
  deskOfBackSeat,
  isBackSeat,
} from "../../shared/desks.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function req(
  srv: TestServer,
  method: string,
  path: string,
  init: { body?: unknown; rawSessionId?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await srv.http(path, {
    method,
    headers:
      init.body !== undefined ? { "Content-Type": "application/json" } : {},
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

const errOf = (body: unknown) =>
  (body as { error?: { code?: string; count?: number } }).error;
const deskOf = (body: unknown) =>
  (body as { agent: { desk: number } }).agent.desk;

// desk undefined is the core's default: first free front desk, then the back.
async function spawnCore(
  srv: TestServer,
  name: string,
  roomId: string,
  desk?: number | null,
) {
  const a = await srv.agentManager.spawn(
    name,
    srv.workDir,
    "default",
    desk,
    undefined,
    roomId,
  );
  if (!a) throw new Error(`spawn failed: ${name}`);
  return a;
}

async function setup() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const r1 = srv.agentManager.getRooms()[0].id;
  return { srv, owner, r1 };
}

describe("spawn into the back room", () => {
  it("no desk -> 201 at the first back seat, with the front free; desk null -> 201 at a back seat", async () => {
    const { srv, owner, r1 } = await setup();
    const res = await req(srv, "POST", "/api/agents", {
      body: { name: "W", cwd: srv.workDir, roomId: r1 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(201);
    expect(deskOf(res.body)).toBe(deskOfBackSeat({ table: 0, stool: 0 }));
    const nul = await req(srv, "POST", "/api/agents", {
      body: { name: "W2", cwd: srv.workDir, roomId: r1, desk: null },
      rawSessionId: owner.rawSessionId,
    });
    expect(nul.status).toBe(201);
    expect(isBackSeat(deskOf(nul.body))).toBe(true);
  });

  it("a back seat number -> 422 invalid_desk (the server assigns seats)", async () => {
    const { srv, owner, r1 } = await setup();
    const res = await req(srv, "POST", "/api/agents", {
      body: {
        name: "W",
        cwd: srv.workDir,
        roomId: r1,
        desk: deskOfBackSeat({ table: 0, stool: 0 }),
      },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errOf(res.body)?.code).toBe("invalid_desk");
    expect(srv.agentManager.getAllAgents()).toHaveLength(0);
  });
});

describe("move between front and back", () => {
  it("desk null in the agent's own room -> 200, front desk to back seat; a free front desk -> 200, back seat to that desk", async () => {
    const { srv, owner, r1 } = await setup();
    const a = await spawnCore(srv, "A", r1, 2);
    const res = await req(srv, "POST", `/api/agents/${a.id}/move`, {
      body: { targetRoomId: r1, desk: null },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    expect(srv.agentManager.getAgent(a.id)?.desk).toBe(
      deskOfBackSeat({ table: 0, stool: 0 }),
    );
    const back = await req(srv, "POST", `/api/agents/${a.id}/move`, {
      body: { targetRoomId: r1, desk: 4 },
      rawSessionId: owner.rawSessionId,
    });
    expect(back.status).toBe(200);
    expect(srv.agentManager.getAgent(a.id)?.desk).toBe(4);
  });

  it("a taken front desk -> 409 desk_taken; nobody moves", async () => {
    const { srv, owner, r1 } = await setup();
    const front = await spawnCore(srv, "F", r1, 0);
    const back = await spawnCore(srv, "B", r1, null);
    const res = await req(srv, "POST", `/api/agents/${back.id}/move`, {
      body: { targetRoomId: r1, desk: 0 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(409);
    expect(errOf(res.body)?.code).toBe("desk_taken");
    expect(srv.agentManager.getAgent(front.id)?.desk).toBe(0);
    expect(isBackSeat(srv.agentManager.getAgent(back.id)?.desk ?? -1)).toBe(
      true,
    );
  });

  it("a back seat number -> 422 invalid_desk", async () => {
    const { srv, owner, r1 } = await setup();
    const a = await spawnCore(srv, "A", r1, 0);
    const res = await req(srv, "POST", `/api/agents/${a.id}/move`, {
      body: { targetRoomId: r1, desk: deskOfBackSeat({ table: 1, stool: 1 }) },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errOf(res.body)?.code).toBe("invalid_desk");
  });
});

// One fill (the spawns are the cost) for all three ways in.
describe("a full room: front and back taken", () => {
  it("spawn, move and revive into it -> 409 back_room_full; nothing moves", async () => {
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({ session: { autoSystemInit: false } }),
    });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r1 = srv.agentManager.getRooms()[0].id;
    const r2 = srv.agentManager.createRoom("R2");
    const x = await spawnCore(srv, "X", r1, 0);
    const k = await spawnCore(srv, "K", r1, 1);
    await srv.agentManager.kill(k.id);
    for (let i = 0; i < DESK_COUNT + BACK_ROOM_SEATS; i++)
      await spawnCore(srv, `A${i}`, r2);

    const spawn = await req(srv, "POST", "/api/agents", {
      body: { name: "Last", cwd: srv.workDir, roomId: r2, desk: 0 },
      rawSessionId: owner.rawSessionId,
    });
    const move = await req(srv, "POST", `/api/agents/${x.id}/move`, {
      body: { targetRoomId: r2 },
      rawSessionId: owner.rawSessionId,
    });
    const revive = await req(srv, "POST", `/api/agents/${k.id}/revive`, {
      body: { roomId: r2 },
      rawSessionId: owner.rawSessionId,
    });
    expect(
      [spawn, move, revive].map((r) => [r.status, errOf(r.body)?.code]),
    ).toEqual([
      [409, "back_room_full"],
      [409, "back_room_full"],
      [409, "back_room_full"],
    ]);
    expect(srv.agentManager.getAgent(x.id)?.roomId).toBe(r1);
    expect(srv.agentManager.getAgent(k.id)).toBeUndefined();
  });
});

describe("revive into the back room", () => {
  async function killed() {
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({ session: { autoSystemInit: false } }),
    });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r1 = srv.agentManager.getRooms()[0].id;
    const x = await spawnCore(srv, "K", r1, 0);
    await srv.agentManager.kill(x.id);
    return { srv, owner, r1, x };
  }

  it("no desk -> 200 at a back seat", async () => {
    const { srv, owner, r1, x } = await killed();
    const res = await req(srv, "POST", `/api/agents/${x.id}/revive`, {
      body: { roomId: r1 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    expect(isBackSeat(srv.agentManager.getAgent(x.id)?.desk ?? -1)).toBe(true);
  });

  it("a taken front desk stays 409 desk_taken (not a back seat)", async () => {
    const { srv, owner, r1, x } = await killed();
    await spawnCore(srv, "Other", r1, 0);
    const res = await req(srv, "POST", `/api/agents/${x.id}/revive`, {
      body: { roomId: r1, desk: 0 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(409);
    expect(errOf(res.body)?.code).toBe("desk_taken");
    expect(srv.agentManager.getAgent(x.id)).toBeUndefined();
  });
});

// The lobby has no back room: no desk there means its one desk, for spawn,
// move and revive alike; an explicit null is a 422.
describe("the lobby with no desk", () => {
  async function claimOwner(srv: TestServer, name: string): Promise<string> {
    const res = await srv.http("/auth/claim", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `name=${encodeURIComponent(name)}&key=${encodeURIComponent(srv.setupKey())}`,
      redirect: "manual",
    });
    const m = (res.headers.get("set-cookie") ?? "").match(
      new RegExp(`${sessionCookieName()}=([^;]+)`),
    );
    if (res.status !== 302 || !m) throw new Error("claim failed");
    return m[1];
  }

  // A claimed office with the lobby emptied (its receptionist killed).
  async function emptyLobby() {
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({ session: { autoSystemInit: false } }),
    });
    server = srv;
    const rawSessionId = await claimOwner(srv, "Morgan");
    const receptionist = srv.agentManager
      .getAllAgents()
      .find((a) => a.roomId === "lobby");
    if (!receptionist) throw new Error("no receptionist");
    await srv.agentManager.kill(receptionist.id);
    return { srv, rawSessionId, receptionist };
  }

  it("spawn -> 201 at desk 0; desk null -> 422", async () => {
    const { srv, rawSessionId } = await emptyLobby();
    const nul = await req(srv, "POST", "/api/agents", {
      body: { name: "N", cwd: srv.workDir, roomId: "lobby", desk: null },
      rawSessionId,
    });
    expect(nul.status).toBe(422);
    expect(errOf(nul.body)?.code).toBe("invalid_desk");
    const res = await req(srv, "POST", "/api/agents", {
      body: { name: "L", cwd: srv.workDir, roomId: "lobby" },
      rawSessionId,
    });
    expect(res.status).toBe(201);
    expect(deskOf(res.body)).toBe(0);
  });

  // Task b16f1e6a: a full lobby was 409 desk_taken here, against the design.
  it("revive into a full lobby -> 409 no_free_desk; an empty one -> 200 at desk 0", async () => {
    const { srv, rawSessionId, receptionist } = await emptyLobby();
    const sitter = await spawnCore(srv, "Sitter", "lobby", 0);
    const res = await req(
      srv,
      "POST",
      `/api/agents/${receptionist.id}/revive`,
      {
        body: { roomId: "lobby" },
        rawSessionId,
      },
    );
    expect(res.status).toBe(409);
    expect(errOf(res.body)?.code).toBe("no_free_desk");
    expect(srv.agentManager.getAgent(receptionist.id)).toBeUndefined();

    await srv.agentManager.kill(sitter.id);
    const empty = await req(
      srv,
      "POST",
      `/api/agents/${receptionist.id}/revive`,
      { body: { roomId: "lobby" }, rawSessionId },
    );
    expect(empty.status).toBe(200);
    expect(srv.agentManager.getAgent(receptionist.id)?.desk).toBe(0);
  });
});

// An older client still sends `backRoom`: the key is accepted and ignored,
// whatever its value and on any room that exists, the lobby included.
describe("PATCH /api/rooms/:roomId with backRoom", () => {
  // Mutants: keep the old 409 back_room_in_use, 422 invalid_back_room or 422
  // back_room_not_supported; answer 204 before the room is looked up; emit a
  // room event or write the room for a body that carries only backRoom.
  it("alone -> 204 and nothing changes, for any value and the lobby; beside a name the name applies; an unknown room -> 404", async () => {
    const { srv, owner, r1 } = await setup();
    srv.agentManager.ensureLobby();
    const b = await spawnCore(srv, "B", r1, null);
    const seat = b.desk;
    expect(isBackSeat(seat)).toBe(true);
    const nameOf = () =>
      srv.agentManager.getRooms().find((r) => r.id === r1)?.name;
    const nameBefore = nameOf();
    const sock = await srv.connectWs(owner.rawSessionId);

    const answers: Array<[string, unknown, number]> = [];
    for (const roomId of [r1, "lobby"]) {
      for (const value of [true, false, "x", null]) {
        const res = await req(srv, "PATCH", `/api/rooms/${roomId}`, {
          body: { backRoom: value },
          rawSessionId: owner.rawSessionId,
        });
        answers.push([roomId, value, res.status]);
      }
    }
    expect(answers.filter(([, , status]) => status !== 204)).toEqual([]);
    expect(nameOf()).toBe(nameBefore);
    expect(srv.agentManager.getAgent(b.id)?.desk).toBe(seat);

    const both = await req(srv, "PATCH", `/api/rooms/${r1}`, {
      body: { backRoom: false, name: "Renamed" },
      rawSessionId: owner.rawSessionId,
    });
    expect(both.status).toBe(204);
    expect(nameOf()).toBe("Renamed");
    expect(srv.agentManager.getAgent(b.id)?.desk).toBe(seat);
    // The rename's event is the barrier: every PATCH before it was answered,
    // so a room event for any of them would be in the buffer by now.
    await sock.waitFor("room_renamed");
    const roomEvents = sock.messages
      .map((m) => (m as { type?: string }).type ?? "")
      .filter((t) => t.startsWith("room_"));
    expect(roomEvents).toEqual(["room_renamed"]);
    sock.close();

    const unknown = await req(srv, "PATCH", "/api/rooms/no-such-room", {
      body: { backRoom: true },
      rawSessionId: owner.rawSessionId,
    });
    expect(unknown.status).toBe(404);
    expect(errOf(unknown.body)?.code).toBe("room_not_found");
  });

  it("GET settings carries no backRoom", async () => {
    const { srv, owner, r1 } = await setup();
    const res = await req(srv, "GET", `/api/rooms/${r1}/settings`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual(
      ["cwd", "decor", "pet", "skin"].sort(),
    );
  });
});
