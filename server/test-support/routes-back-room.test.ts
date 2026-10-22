// The back room over REST (task 5b503e32): spawn, move and revive with no
// desk or desk null, the refusals that name a back seat or a taken desk, and
// the 409 for a full back room.

import { sessionCookieName } from "../auth.ts";
import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  BACK_ROOM_FULL_MESSAGE,
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
  (body as { error?: { code?: string; message?: string } }).error;
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
    srv.stateRoot,
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
  srv.agentManager.setRoomBackRoom(r1, true);
  return { srv, owner, r1 };
}

describe("spawn into the back room", () => {
  it("no desk -> 201 at the first back seat, with the front free", async () => {
    const { srv, owner, r1 } = await setup();
    const res = await req(srv, "POST", "/api/agents", {
      body: { name: "W", cwd: srv.stateRoot, roomId: r1 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(201);
    expect(deskOf(res.body)).toBe(deskOfBackSeat({ table: 0, stool: 0 }));
  });

  it("desk null -> 201 at a back seat", async () => {
    const { srv, owner, r1 } = await setup();
    const res = await req(srv, "POST", "/api/agents", {
      body: { name: "W", cwd: srv.stateRoot, roomId: r1, desk: null },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(201);
    expect(isBackSeat(deskOf(res.body))).toBe(true);
  });

  it("a back seat number -> 422 invalid_desk (the server assigns seats)", async () => {
    const { srv, owner, r1 } = await setup();
    const res = await req(srv, "POST", "/api/agents", {
      body: {
        name: "W",
        cwd: srv.stateRoot,
        roomId: r1,
        desk: deskOfBackSeat({ table: 0, stool: 0 }),
      },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(422);
    expect(errOf(res.body)?.code).toBe("invalid_desk");
    expect(srv.agentManager.getAllAgents()).toHaveLength(0);
  });

  it("front and back room full -> 409 back_room_full", async () => {
    const { srv, owner, r1 } = await setup();
    for (let i = 0; i < DESK_COUNT + BACK_ROOM_SEATS; i++)
      await spawnCore(srv, `A${i}`, r1);
    const res = await req(srv, "POST", "/api/agents", {
      body: { name: "Last", cwd: srv.stateRoot, roomId: r1, desk: 0 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(409);
    expect(errOf(res.body)).toMatchObject({
      code: "back_room_full",
      message: BACK_ROOM_FULL_MESSAGE,
    });
  });
});

describe("move between front and back", () => {
  it("desk null in the agent's own room -> 200, front desk to back seat", async () => {
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
  });

  it("a free front desk -> 200, back seat to that desk", async () => {
    const { srv, owner, r1 } = await setup();
    const a = await spawnCore(srv, "A", r1, null);
    const res = await req(srv, "POST", `/api/agents/${a.id}/move`, {
      body: { targetRoomId: r1, desk: 4 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
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

  it("into a full back room -> 409 back_room_full", async () => {
    const { srv, owner, r1 } = await setup();
    const r2 = srv.agentManager.createRoom("R2");
    srv.agentManager.setRoomBackRoom(r2, true);
    for (let i = 0; i < DESK_COUNT + BACK_ROOM_SEATS; i++)
      await spawnCore(srv, `A${i}`, r2);
    const x = await spawnCore(srv, "X", r1, 0);
    const res = await req(srv, "POST", `/api/agents/${x.id}/move`, {
      body: { targetRoomId: r2 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(409);
    expect(errOf(res.body)?.code).toBe("back_room_full");
    expect(srv.agentManager.getAgent(x.id)?.roomId).toBe(r1);
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
    srv.agentManager.setRoomBackRoom(r1, true);
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
    const r1 = srv.agentManager.getOrdinaryRooms()[0].id;
    srv.agentManager.setRoomBackRoom(r1, true);
    return { srv, rawSessionId, receptionist, r1 };
  }

  it("spawn -> 201 at desk 0; desk null -> 422", async () => {
    const { srv, rawSessionId } = await emptyLobby();
    const nul = await req(srv, "POST", "/api/agents", {
      body: { name: "N", cwd: srv.stateRoot, roomId: "lobby", desk: null },
      rawSessionId,
    });
    expect(nul.status).toBe(422);
    expect(errOf(nul.body)?.code).toBe("invalid_desk");
    const res = await req(srv, "POST", "/api/agents", {
      body: { name: "L", cwd: srv.stateRoot, roomId: "lobby" },
      rawSessionId,
    });
    expect(res.status).toBe(201);
    expect(deskOf(res.body)).toBe(0);
  });

  it("move of a back agent -> 200 at desk 0", async () => {
    const { srv, rawSessionId, r1 } = await emptyLobby();
    const b = await spawnCore(srv, "B", r1, null);
    const res = await req(srv, "POST", `/api/agents/${b.id}/move`, {
      body: { targetRoomId: "lobby" },
      rawSessionId,
    });
    expect(res.status).toBe(200);
    expect(srv.agentManager.getAgent(b.id)?.desk).toBe(0);
  });

  it("revive -> 200 at desk 0", async () => {
    const { srv, rawSessionId, receptionist } = await emptyLobby();
    const res = await req(
      srv,
      "POST",
      `/api/agents/${receptionist.id}/revive`,
      {
        body: { roomId: "lobby" },
        rawSessionId,
      },
    );
    expect(res.status).toBe(200);
    expect(srv.agentManager.getAgent(receptionist.id)?.desk).toBe(0);
  });
  // Task b16f1e6a: a full lobby was 409 desk_taken here, against the design.
  it("revive into a full lobby -> 409 no_free_desk", async () => {
    const { srv, rawSessionId, receptionist } = await emptyLobby();
    await spawnCore(srv, "Sitter", "lobby", 0);
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
  });
});
