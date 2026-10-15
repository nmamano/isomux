// The back room setting over REST (task b16f1e6a): PATCH /api/rooms/:roomId
// turns it on and off, GET settings reads it, and with it off spawn, move and
// revive take front desks only.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { DESK_COUNT, isBackSeat } from "../../shared/desks.ts";

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
  (
    body as {
      error?: { code?: string; message?: string; count?: number };
    }
  ).error;
const deskOf = (body: unknown) =>
  (body as { agent: { desk: number } }).agent.desk;

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
  const srv = await startTestServer({
    fakeBackend: new FakeBackend({ session: { autoSystemInit: false } }),
  });
  server = srv;
  const owner = await srv.seedOwner("Boss");
  const r1 = srv.agentManager.getRooms()[0].id;
  return { srv, owner, r1 };
}

const backRoomOf = (srv: TestServer, roomId: string) =>
  srv.agentManager.getRooms().find((r) => r.id === roomId)?.backRoom === true;

describe("PATCH /api/rooms/:roomId backRoom", () => {
  it("a new room is off; PATCH turns it on and off, and GET settings reads it", async () => {
    const { srv, owner } = await setup();
    const r2 = srv.agentManager.createRoom("R2");
    const read = async () =>
      (
        (
          await req(srv, "GET", `/api/rooms/${r2}/settings`, {
            rawSessionId: owner.rawSessionId,
          })
        ).body as { backRoom: unknown }
      ).backRoom;
    expect(await read()).toBe(false);
    const on = await req(srv, "PATCH", `/api/rooms/${r2}`, {
      body: { backRoom: true },
      rawSessionId: owner.rawSessionId,
    });
    expect(on.status).toBe(204);
    expect(await read()).toBe(true);
    const off = await req(srv, "PATCH", `/api/rooms/${r2}`, {
      body: { backRoom: false },
      rawSessionId: owner.rawSessionId,
    });
    expect(off.status).toBe(204);
    expect(await read()).toBe(false);
  });

  it("off with agents in the back -> 409 back_room_in_use with the count; nothing in the body is written", async () => {
    const { srv, owner, r1 } = await setup();
    srv.agentManager.setRoomBackRoom(r1, true);
    const b = await spawnCore(srv, "B", r1, null);
    await spawnCore(srv, "C", r1, null);
    const nameBefore = srv.agentManager
      .getRooms()
      .find((r) => r.id === r1)?.name;
    const res = await req(srv, "PATCH", `/api/rooms/${r1}`, {
      body: { backRoom: false, name: "Renamed" },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(409);
    expect(errOf(res.body)?.code).toBe("back_room_in_use");
    expect(errOf(res.body)?.count).toBe(2);
    expect(backRoomOf(srv, r1)).toBe(true);
    expect(srv.agentManager.getRooms().find((r) => r.id === r1)?.name).toBe(
      nameBefore,
    );
    expect(isBackSeat(srv.agentManager.getAgent(b.id)?.desk ?? -1)).toBe(true);
  });

  it("the lobby -> 422 back_room_not_supported; a non-boolean -> 422 invalid_back_room", async () => {
    const { srv, owner, r1 } = await setup();
    srv.agentManager.ensureLobby();
    for (const value of [true, false]) {
      const lobby = await req(srv, "PATCH", `/api/rooms/lobby`, {
        body: { backRoom: value },
        rawSessionId: owner.rawSessionId,
      });
      expect(lobby.status).toBe(422);
      expect(errOf(lobby.body)?.code).toBe("back_room_not_supported");
    }
    const bad = await req(srv, "PATCH", `/api/rooms/${r1}`, {
      body: { backRoom: "yes" },
      rawSessionId: owner.rawSessionId,
    });
    expect(bad.status).toBe(422);
    expect(errOf(bad.body)?.code).toBe("invalid_back_room");
    expect(backRoomOf(srv, r1)).toBe(false);
  });
});

describe("with the back room off", () => {
  it("spawn: no desk -> 201 at the first free front desk; desk null -> 409 back_room_off; a full front -> 409 no_free_desk", async () => {
    const { srv, owner, r1 } = await setup();
    await spawnCore(srv, "F0", r1, 0);
    const res = await req(srv, "POST", "/api/agents", {
      body: { name: "N", cwd: srv.stateRoot, roomId: r1 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(201);
    expect(deskOf(res.body)).toBe(1);
    const nul = await req(srv, "POST", "/api/agents", {
      body: { name: "Nul", cwd: srv.stateRoot, roomId: r1, desk: null },
      rawSessionId: owner.rawSessionId,
    });
    expect(nul.status).toBe(409);
    expect(errOf(nul.body)?.code).toBe("back_room_off");
    for (let d = 2; d < DESK_COUNT; d++) await spawnCore(srv, `F${d}`, r1, d);
    for (const desk of [undefined, 0]) {
      const full = await req(srv, "POST", "/api/agents", {
        body: { name: `Full${desk}`, cwd: srv.stateRoot, roomId: r1, desk },
        rawSessionId: owner.rawSessionId,
      });
      expect(full.status).toBe(409);
      expect(errOf(full.body)?.code).toBe("no_free_desk");
    }
    expect(
      srv.agentManager.getAllAgents().some((a) => isBackSeat(a.desk)),
    ).toBe(false);
  });

  it("move: desk null -> 409 back_room_off; no desk into a full front -> 409 no_free_desk", async () => {
    const { srv, owner, r1 } = await setup();
    const r2 = srv.agentManager.createRoom("R2");
    const x = await spawnCore(srv, "X", r1, 0);
    const nul = await req(srv, "POST", `/api/agents/${x.id}/move`, {
      body: { targetRoomId: r1, desk: null },
      rawSessionId: owner.rawSessionId,
    });
    expect(nul.status).toBe(409);
    expect(errOf(nul.body)?.code).toBe("back_room_off");
    for (let d = 0; d < DESK_COUNT; d++) await spawnCore(srv, `F${d}`, r2, d);
    const full = await req(srv, "POST", `/api/agents/${x.id}/move`, {
      body: { targetRoomId: r2 },
      rawSessionId: owner.rawSessionId,
    });
    expect(full.status).toBe(409);
    expect(errOf(full.body)?.code).toBe("no_free_desk");
    expect(srv.agentManager.getAgent(x.id)?.roomId).toBe(r1);
  });

  it("revive: no desk -> 200 at the first free front desk; desk null -> 409 back_room_off; a full front -> 409 no_free_desk", async () => {
    const { srv, owner, r1 } = await setup();
    const k = await spawnCore(srv, "K", r1, 0);
    await srv.agentManager.kill(k.id);
    const nul = await req(srv, "POST", `/api/agents/${k.id}/revive`, {
      body: { roomId: r1, desk: null },
      rawSessionId: owner.rawSessionId,
    });
    expect(nul.status).toBe(409);
    expect(errOf(nul.body)?.code).toBe("back_room_off");
    await spawnCore(srv, "F0", r1, 0);
    const res = await req(srv, "POST", `/api/agents/${k.id}/revive`, {
      body: { roomId: r1 },
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    expect(deskOf(res.body)).toBe(1);
    await srv.agentManager.kill(k.id);
    for (let d = 1; d < DESK_COUNT; d++) await spawnCore(srv, `F${d}`, r1, d);
    const full = await req(srv, "POST", `/api/agents/${k.id}/revive`, {
      body: { roomId: r1 },
      rawSessionId: owner.rawSessionId,
    });
    expect(full.status).toBe(409);
    expect(errOf(full.body)?.code).toBe("no_free_desk");
  });
});
