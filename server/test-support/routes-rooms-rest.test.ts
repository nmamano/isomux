// The rooms REST contract: rooms.create / rooms.close / rooms.rename (a
// partial PATCH over name, pet, skin and decor) and the settings read
// rooms.getSettings. The room's instructions: routes-instructions.test.ts.
//
//   - create: room:manage is a USER capability and the guard is
//     `authenticated`, so any user (owner OR member) creates -> 201 { room }.
//     The member-creator grant + the per-recipient projection of room_created
//     live in projection.test.ts.
//   - close/rename/settings: guarded by requiresRoomAccess(:roomId). An owner
//     reaches an unknown id by rule and gets the core's 404 room_not_found
//     (Follow-up #6, not a leak: an owner already sees every real room); a
//     member without access gets the uniform 403 (no exists-vs-hidden oracle).
//   - PATCH applies each field only when the body carries it, validates all
//     of them before it writes any, and refuses the lobby a skin or decor
//     before it looks at the value.
//
// The value rules are unit-pinned: parseRoomPet (ui/office/RoomProps.test.ts),
// parseRoomSkin (ui/office/skins/skins.test.ts), the decor parse and the
// stored-decor filter (room-state.test.ts).
//
// Seam: startTestServer() - real auth + /api executor. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { startTestServer, type TestServer } from "./harness.ts";

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
  (body as { error?: { code?: string } } | null)?.error?.code;

// An owner, a member with no room grant, and a PATCH on the first room.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Mia");
  const id = srv.agentManager.getRooms()[0].id;
  const patch = (body: unknown, roomId = id) =>
    req(srv, "PATCH", `/api/rooms/${roomId}`, {
      body,
      rawSessionId: owner.rawSessionId,
    });
  const room = (roomId = id) =>
    srv.agentManager.getRooms().find((r) => r.id === roomId)!;
  return { srv, owner, member, id, patch, room };
}

describe("rooms.create REST", () => {
  it("an owner and a member create a room, with or without a skin; an unknown skin creates nothing", async () => {
    const { srv, owner, member } = await office();
    const before = srv.agentManager.getRooms().length;
    const create = (rawSessionId: string, body: unknown) =>
      req(srv, "POST", "/api/rooms", { body, rawSessionId });

    const plain = await create(owner.rawSessionId, { name: "Plain" });
    expect(plain.status).toBe(201);
    const room = (plain.body as { room: { id: string; name: string } }).room;
    expect(room.name).toBe("Plain");
    // The default look is the ABSENCE of the field, so a room created without
    // one has the same record every room had before skins existed.
    expect(room).not.toHaveProperty("skin");
    expect(srv.agentManager.getRooms().some((r) => r.id === room.id)).toBe(
      true,
    );

    const ward = await create(owner.rawSessionId, {
      name: "Ward",
      skin: "hospital",
    });
    expect(ward.status).toBe(201);
    const wardId = (ward.body as { room: { id: string } }).room.id;
    expect(srv.agentManager.getRooms().find((r) => r.id === wardId)?.skin).toBe(
      "hospital",
    );

    // room:manage is a user capability: a member creates too.
    expect((await create(member.rawSessionId, {})).status).toBe(201);

    const refused = await create(owner.rawSessionId, {
      name: "Clinic",
      skin: "clinic",
    });
    expect(refused.status).toBe(422);
    expect(errCode(refused.body)).toBe("invalid_skin");
    expect(srv.agentManager.getRooms().length).toBe(before + 3);
  });
});

describe("rooms.close and rooms.rename REST", () => {
  it("an owner closes and renames; an unknown id is the owner's 404; a member without access gets 403 and nothing changes", async () => {
    const { srv, owner, member, id, patch, room } = await office();
    const extra = srv.agentManager.createRoom("Extra");
    const asMember = { rawSessionId: member.rawSessionId };

    expect(
      (await req(srv, "DELETE", `/api/rooms/${extra}`, asMember)).status,
    ).toBe(403);
    expect(
      (
        await req(srv, "PATCH", `/api/rooms/${id}`, {
          ...asMember,
          body: { name: "Z" },
        })
      ).status,
    ).toBe(403);
    expect(srv.agentManager.getRooms().some((r) => r.id === extra)).toBe(true);
    const name = room().name;
    expect(name).not.toBe("Z");

    for (const [method, body] of [
      ["DELETE", undefined],
      ["PATCH", { name: "Z" }],
      // A skin write on an unknown room is the 404, not the lobby's answer.
      ["PATCH", { skin: "hospital" }],
    ] as const) {
      const r = await req(srv, method, "/api/rooms/deadbeef", {
        body,
        rawSessionId: owner.rawSessionId,
      });
      expect({ method, body, status: r.status, code: errCode(r.body) }).toEqual(
        { method, body, status: 404, code: "room_not_found" },
      );
    }

    expect((await patch({ name: "Renamed" })).status).toBe(204);
    expect(room().name).toBe("Renamed");
    expect(
      (
        await req(srv, "DELETE", `/api/rooms/${extra}`, {
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(204);
    expect(srv.agentManager.getRooms().some((r) => r.id === extra)).toBe(false);
  });
});

// PATCH is a partial update over independent fields. The pairs that matter:
// a field alone leaves the others (the old guard read `if (!name) 422`, and
// extending it would have renamed rooms to the empty string on every pet
// write), null clears, and decor applies after the skin.
describe("rooms.rename REST: a partial update", () => {
  it("each field alone leaves the others; null clears pet, skin and decor; decor merges and applies after the skin", async () => {
    const { patch, room } = await office();
    const name = room().name;

    expect((await patch({ pet: { species: "dog", coat: 2 } })).status).toBe(
      204,
    );
    expect(room().pet).toEqual({ species: "dog", coat: 2 });
    expect(room().name).toBe(name);

    expect((await patch({ name: "Kennel" })).status).toBe(204);
    expect(room().name).toBe("Kennel");
    expect(room().pet).toEqual({ species: "dog", coat: 2 });

    expect((await patch({ skin: "hospital" })).status).toBe(204);
    expect(room().skin).toBe("hospital");
    expect(room().name).toBe("Kennel");

    expect(
      (
        await patch({
          name: "Both",
          pet: { species: "tortoise", coat: 0 },
          skin: "office",
        })
      ).status,
    ).toBe(204);
    expect(room()).toMatchObject({
      name: "Both",
      pet: { species: "tortoise", coat: 0 },
      skin: "office",
    });

    // Decor slots merge, and null clears one.
    expect((await patch({ decor: { walls: "clinic" } })).status).toBe(204);
    expect((await patch({ decor: { ward: "beds" } })).status).toBe(204);
    expect(room().decor).toEqual({ walls: "clinic", ward: "beds" });
    expect((await patch({ decor: { walls: null } })).status).toBe(204);
    expect(room().decor).toEqual({ ward: "beds" });
    // A skin alone keeps the decor; a skin with a decor object applies the
    // decor after the skin; a skin with decor:null is the reset.
    expect((await patch({ skin: "hospital" })).status).toBe(204);
    expect(room().decor).toEqual({ ward: "beds" });
    expect(
      (
        await patch({
          skin: "office",
          decor: { ward: null, curtains: "none" },
        })
      ).status,
    ).toBe(204);
    expect(room()).toMatchObject({
      skin: "office",
      decor: { curtains: "none" },
    });
    expect((await patch({ skin: "hospital", decor: null })).status).toBe(204);
    expect(room().decor ?? null).toBe(null);

    for (const field of ["pet", "skin"] as const) {
      expect((await patch({ [field]: null })).status).toBe(204);
      expect(room()[field]).toBe(null);
    }
    expect(room().name).toBe("Both");
  });

  it("refuses an empty body, an empty name and each bad value with its own code, and writes no field of a refused body", async () => {
    const { patch, room } = await office();
    const before = room().name;

    const empty = await patch({});
    expect([empty.status, errCode(empty.body)]).toEqual([
      422,
      "invalid_request",
    ]);
    const blank = await patch({ name: "   " });
    expect([blank.status, errCode(blank.body)]).toEqual([422, "invalid_name"]);

    const good = {
      name: "Should not stick",
      skin: "hospital",
      pet: { species: "dog", coat: 0 },
    };
    for (const [bad, code] of [
      [{ pet: { species: "duck", coat: 0 } }, "invalid_pet"],
      [{ skin: "clinic" }, "invalid_skin"],
      [{ decor: { lamp: "on" } }, "invalid_decor"],
    ] as const) {
      const r = await patch({ ...good, ...bad });
      expect({ bad, status: r.status, code: errCode(r.body) }).toEqual({
        bad,
        status: 422,
        code,
      });
    }
    expect(room().name).toBe(before);
    expect(room().skin ?? null).toBe(null);
    expect(room().pet ?? null).toBe(null);
    expect(room().decor ?? null).toBe(null);
  });

  // Hiding the control in the settings pane is not the rule; this is. The
  // order is the rule too (Nil via Isomux PM, 2026-09-12): the room is asked
  // whether it takes a skin BEFORE the value is looked at.
  it("the lobby takes no skin and no decor, and says so before it validates the value", async () => {
    const { srv, patch, room } = await office();
    srv.agentManager.ensureLobby();
    for (const body of [
      { skin: "hospital" },
      { skin: "clinic" },
      { decor: { walls: "clinic" } },
      { decor: { lamp: "on" } },
    ]) {
      const r = await patch(body, "lobby");
      expect({ body, status: r.status, code: errCode(r.body) }).toEqual({
        body,
        status: 422,
        code: "skin_not_supported",
      });
    }
    expect(room("lobby").skin ?? null).toBe(null);
    expect(room("lobby").decor ?? null).toBe(null);
  });
});

describe("rooms.getSettings REST", () => {
  it("an unknown id is the owner's 404; a member without access gets 403", async () => {
    const { srv, owner, member, id } = await office();
    const unknown = await req(srv, "GET", "/api/rooms/deadbeef/settings", {
      rawSessionId: owner.rawSessionId,
    });
    expect([unknown.status, errCode(unknown.body)]).toEqual([
      404,
      "room_not_found",
    ]);
    const denied = await req(srv, "GET", `/api/rooms/${id}/settings`, {
      rawSessionId: member.rawSessionId,
    });
    expect(denied.status).toBe(403);
  });

  // An agent reads the look before it changes it.
  it("the settings read carries the look", async () => {
    const { srv, owner, id, patch } = await office();
    const read = async () =>
      (
        await req(srv, "GET", `/api/rooms/${id}/settings`, {
          rawSessionId: owner.rawSessionId,
        })
      ).body as Record<string, unknown>;
    expect(await read()).toMatchObject({ skin: null, pet: null, decor: null });
    await patch({
      skin: "hospital",
      pet: { species: "cat", coat: 1 },
      decor: { pet: "shown" },
    });
    expect(await read()).toMatchObject({
      skin: "hospital",
      pet: { species: "cat", coat: 1 },
      decor: { pet: "shown" },
    });
  });
});

// The folder new agents in a room start in (task e871e36f). A set value is an
// absolute or "~"-rooted path to an existing directory, stored as typed after a
// trim; "" and null clear it. The spawn side: routes-agents-rest.test.ts.
describe("rooms.rename REST: the working folder", () => {
  const folderOf = async (srv: TestServer, rawSessionId: string, id: string) =>
    (
      (await req(srv, "GET", `/api/rooms/${id}/settings`, { rawSessionId }))
        .body as { cwd?: unknown }
    ).cwd;

  it("sets, trims and clears it; the settings read and a live event carry it; it survives a restart; the lobby takes one too", async () => {
    const { srv, owner, id, patch, room } = await office();
    const dir = join(srv.stateRoot, "room-folder");
    mkdirSync(dir, { recursive: true });
    expect(await folderOf(srv, owner.rawSessionId, id)).toBeNull();

    const sock = await srv.connectWs(owner.rawSessionId);
    try {
      await sock.waitFor("full_state");
      expect((await patch({ cwd: `  ${dir}  ` })).status).toBe(204);
      expect(await sock.waitFor("room_cwd_updated")).toMatchObject({
        roomId: id,
        cwd: dir,
      });
    } finally {
      sock.close();
    }
    expect(room().cwd).toBe(dir);
    expect(await folderOf(srv, owner.rawSessionId, id)).toBe(dir);

    // "~" is stored as typed, not expanded.
    expect((await patch({ cwd: "~" })).status).toBe(204);
    expect(await folderOf(srv, owner.rawSessionId, id)).toBe("~");

    for (const clear of ["", "   ", null]) {
      expect((await patch({ cwd: dir })).status).toBe(204);
      expect((await patch({ cwd: clear })).status).toBe(204);
      expect({
        clear,
        cwd: await folderOf(srv, owner.rawSessionId, id),
      }).toEqual({ clear, cwd: null });
    }

    // A name alone leaves the folder.
    expect((await patch({ cwd: dir })).status).toBe(204);
    expect((await patch({ name: "Renamed" })).status).toBe(204);
    expect(room().cwd).toBe(dir);

    srv.agentManager.ensureLobby();
    expect((await patch({ cwd: dir }, "lobby")).status).toBe(204);

    // Both reach agents.json and come back at boot, in the room wire too.
    const booted = await srv.restart();
    server = booted;
    expect(await folderOf(booted, owner.rawSessionId, id)).toBe(dir);
    expect(await folderOf(booted, owner.rawSessionId, "lobby")).toBe(dir);
    const sock2 = await booted.connectWs(owner.rawSessionId);
    try {
      const full = (await sock2.waitFor("full_state")) as {
        rooms: Array<{ id: string; cwd?: unknown }>;
      };
      expect(full.rooms.find((r) => r.id === id)?.cwd).toBe(dir);
    } finally {
      sock2.close();
    }
  });

  it("refuses a missing folder, a file and a relative path with 400 invalid_cwd, a non-string with 422, and writes no field of a refused body", async () => {
    const { srv, owner, id, patch, room } = await office();
    const file = join(srv.stateRoot, "a-file");
    writeFileSync(file, "x");
    // The relative path names a folder that exists from the server's working
    // directory, so only the absolute-or-"~" rule can refuse it.
    expect(existsSync(resolve("server"))).toBe(true);
    const before = room().name;
    for (const [cwd, status] of [
      [join(srv.stateRoot, "missing"), 400],
      [file, 400],
      ["server", 400],
      [42, 422],
    ] as const) {
      const r = await patch({ name: "Should not stick", cwd });
      expect({ cwd, status: r.status, code: errCode(r.body) }).toEqual({
        cwd,
        status,
        code: "invalid_cwd",
      });
    }
    expect(room().name).toBe(before);
    expect(room().cwd ?? null).toBeNull();
    expect(await folderOf(srv, owner.rawSessionId, id)).toBeNull();
  });
});
