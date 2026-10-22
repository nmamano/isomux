// The rooms REST contract: rooms.create / rooms.close / rooms.rename (a
// partial PATCH over name, pet, skin and decor) and the settings pair
// rooms.getSettings / rooms.setSettings.
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
//   - The settings PUT requires the GET's version (missing -> 400
//     invalid_version, stale -> 409 version_conflict carrying the CURRENT
//     version); existence is checked before the version.
//
// The value rules are unit-pinned: parseRoomPet (ui/office/RoomProps.test.ts),
// parseRoomSkin (ui/office/skins/skins.test.ts), the decor parse and merge
// (room-decor.test.ts). The room prompt's read/write round trip, its version
// and its broadcast ride the instructions route too: routes-instructions.test.ts
// (room layer, "shares one store with the old route").
//
// Seam: startTestServer() - real auth + /api executor. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
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
  (body as { error?: { code?: string } }).error?.code;

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

describe("rooms.getSettings and rooms.setSettings REST", () => {
  it("an unknown id is the owner's 404 before any version check; a member without access gets 403 on both and the prompt stays", async () => {
    const { srv, owner, member, id, room } = await office();
    const version = (
      (
        await req(srv, "GET", `/api/rooms/${id}/settings`, {
          rawSessionId: owner.rawSessionId,
        })
      ).body as { version: string }
    ).version;
    for (const [method, body] of [
      ["GET", undefined],
      // Any version: an unknown room is a 404, never a bogus 409.
      ["PUT", { prompt: "x", version: "0123456789ab" }],
    ] as const) {
      const unknown = await req(srv, method, "/api/rooms/deadbeef/settings", {
        body,
        rawSessionId: owner.rawSessionId,
      });
      expect([method, unknown.status, errCode(unknown.body)]).toEqual([
        method,
        404,
        "room_not_found",
      ]);
      const denied = await req(srv, method, `/api/rooms/${id}/settings`, {
        body: body && { prompt: "y", version },
        rawSessionId: member.rawSessionId,
      });
      expect([method, denied.status]).toEqual([method, 403]);
    }
    expect(room().prompt).toBeNull();
  });

  it("a PUT needs the GET's version: missing is 400, stale is 409 with the current version, and neither writes", async () => {
    const { srv, owner, id, room } = await office();
    const settings = `/api/rooms/${id}/settings`;
    const put = (body: unknown) =>
      req(srv, "PUT", settings, { body, rawSessionId: owner.rawSessionId });
    const readVersion = async () =>
      (
        (await req(srv, "GET", settings, { rawSessionId: owner.rawSessionId }))
          .body as { version: string }
      ).version;

    const missing = await put({ prompt: "x" });
    expect([missing.status, errCode(missing.body)]).toEqual([
      400,
      "invalid_version",
    ]);
    expect(room().prompt).toBeNull();

    // Writer A reads, then writer B saves: A's version is now stale.
    const stale = await readVersion();
    expect((await put({ prompt: "B's prompt", version: stale })).status).toBe(
      204,
    );
    const clobber = await put({ prompt: "A's clobber", version: stale });
    expect(clobber.status).toBe(409);
    const err = (clobber.body as { error: { code: string; version: string } })
      .error;
    expect(err.code).toBe("version_conflict");
    expect(err.version).toBe(await readVersion());
    expect(room().prompt).toBe("B's prompt");
  });

  // An agent reads the look before it changes it; the version guards the
  // prompt alone, so a look write does not move it.
  it("the settings read carries the look, and a look write does not move the version", async () => {
    const { srv, owner, id, patch } = await office();
    const read = async () =>
      (
        await req(srv, "GET", `/api/rooms/${id}/settings`, {
          rawSessionId: owner.rawSessionId,
        })
      ).body as Record<string, unknown>;
    const before = await read();
    expect(before).toMatchObject({ skin: null, pet: null, decor: null });
    await patch({
      skin: "hospital",
      pet: { species: "cat", coat: 1 },
      decor: { pet: "shown" },
    });
    const after = await read();
    expect(after).toMatchObject({
      skin: "hospital",
      pet: { species: "cat", coat: 1 },
      decor: { pet: "shown" },
    });
    expect(after.version).toBe(before.version);
  });
});
