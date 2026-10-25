// Phase 3d slice 9b - the users.* REST EXPAND contract (Group 7 auth surface).
//
// users.create (task ec1724a8): an owner creates a member up front - with the
// profile and room grants an invite used to carry - and a sign-in link only
// targets that existing member.
//
// users.{update,setAccess,delete} were table-declared but NEVER registered
// (Phase 1 probe: an unauth probe returned the LEGACY flat {error:"..."} shape,
// identical to a nonexistent path), so this slice BUILDS them. What it freezes:
//   - The update_user SPLIT (Option A, Nil-gated): users.update carries ONLY the
//     record fields (name/avatar); it CANNOT change allowedRooms (not
//     in UserUpdateReq) - a member sending allowedRooms in the body is ignored,
//     no escalation. users.setAccess (officeOwner) owns allowedRooms.
//   - selfOrOwner on update/delete: a member edits/deletes only their OWN record;
//     editing/deleting another's is a uniform 403 (no existence oracle).
//   - The two delete preconditions: owner!=self (403 owner_self_delete) and
//     not-last-owner; missing target is an idempotent 204.
//   - The member's instructions have their own route (routes-instructions).
//
// (users.list - built recipient-scoped in 9b - was removed as callerless in the
// Phase 4 close-out: the UI hydrates the roster from the users_list broadcasts.)
//
// Seam: startTestServer(). Zero LLM.

import { existsSync } from "fs";
import { join } from "path";

import { mintMemberLink } from "./member-link.ts";
import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { _testMintLegacyInvite, acceptInvite, peekInvite } from "../auth.ts";
import { getUserByName } from "../users.ts";
import { managedUserEnvNotesPath, managedUserEnvPath } from "../user-env.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import type { ApiTokenCreateRes } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}
async function api(
  srv: TestServer,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    rawSessionId?: string;
    bearer?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function addOwner(name: string): Promise<string> {
  const { rawToken } = await mintMemberLink(name, "owner");
  const acc = await acceptInvite(rawToken, { userAgent: "test" });
  if (!acc.ok) throw new Error(`addOwner accept: ${acc.error}`);
  return acc.rawSessionId;
}

const errCode = (r: Res) =>
  (r.body as { error?: { code?: string } })?.error?.code;
const userOf = (r: Res) => (r.body as { user: Record<string, unknown> }).user;

describe("routes/users REST - create (owner creates a member before any link)", () => {
  it("owner creates a pending member -> 201 { user } with profile + grants, a link then signs them in keeping them; an owner-role member gets no grants but every room's notifications", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Grants B");

    const r = await api(srv, "/api/users", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {
        name: " Yu ",
        role: "member",
        instructions: "Explain each step.",
        avatarVariant: "sleepy",
        allowedRooms: [roomA, roomB, roomA],
      },
    });
    expect(r.status).toBe(201);
    expect(userOf(r)).toMatchObject({
      name: "Yu",
      role: "member",
      pendingSignIn: true,
      memberPrompt: "Explain each step.",
      avatarVariant: "sleepy",
      allowedRooms: [roomA, roomB],
      // A member is notified for the rooms granted at creation.
      notifRooms: [roomA, roomB],
      language: null,
    });

    const link = await api(srv, "/api/invites", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { userId: userOf(r).id },
    });
    expect(link.status).toBe(200);
    const rawToken = (link.body as { url: string }).url.split("/i/")[1];
    const acc = await acceptInvite(rawToken, { userAgent: null });
    expect(acc.ok).toBe(true);
    expect(getUserByName("Yu")).toMatchObject({
      id: userOf(r).id,
      allowedRooms: [roomA, roomB],
      memberPrompt: "Explain each step.",
    });
    expect(getUserByName("Yu")?.pendingSignIn).toBeUndefined();

    // An owner-role member gets no grants but notifications for every room.
    const rooms = srv.agentManager.getRooms().map((room) => room.id);
    const co = await api(srv, "/api/users", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { name: "Co Owner", role: "owner" },
    });
    expect(co.status).toBe(201);
    expect(userOf(co)).toMatchObject({
      role: "owner",
      allowedRooms: [],
      notifRooms: rooms,
      pendingSignIn: true,
    });
  });

  it("refuses: taken name 409, bad name 400, grants on an owner or an unknown room 400, malformed 422 - creating no one", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Alice");
    const roomA = srv.agentManager.getRooms()[0].id;
    const cases: [unknown, number, string][] = [
      [{ name: "alice", role: "member" }, 409, "name_taken"],
      [{ name: "bad<script>", role: "member" }, 400, "invalid_name"],
      [{ name: "x".repeat(65), role: "member" }, 400, "invalid_name"],
      [
        { name: "Yu", role: "owner", allowedRooms: [roomA] },
        400,
        "invalid_rooms",
      ],
      [
        { name: "Yu", role: "member", allowedRooms: ["nope"] },
        400,
        "invalid_rooms",
      ],
      [
        { name: "Yu", role: "member", allowedRooms: [42] },
        422,
        "invalid_request",
      ],
      [{ name: "Yu", role: "king" }, 422, "invalid_request"],
      [{ name: " ", role: "member" }, 422, "invalid_request"],
      [
        { name: "Yu", role: "member", instructions: {} },
        422,
        "invalid_request",
      ],
    ];
    for (const [body, status, code] of cases) {
      const r = await api(srv, "/api/users", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body,
      });
      expect({ body, status: r.status, code: errCode(r) }).toEqual({
        body,
        status,
        code,
      });
    }
    expect(getUserByName("Yu")).toBeUndefined();
  });

  it("an owner's privileged agent and API token create a plain member, and cannot mint its link; a member and a member's proxies cannot create", async () => {
    const srv = (server = await startTestServer());
    const morgan = await srv.seedOwner("Morgan");
    const alice = await srv.seedMember("Alice");
    const morganId = getUserByName("Morgan")!.id;
    const aliceId = getUserByName("Alice")!.id;
    const roomId = srv.agentManager.getRooms()[0].id;
    const spawn = async (name: string) => {
      const info = await srv.agentManager.spawn(
        name,
        srv.stateRoot,
        "default",
        undefined,
        undefined,
        roomId,
        undefined,
        undefined,
        undefined,
        undefined,
        "claude",
      );
      if (!info) throw new Error("spawn failed");
      return info;
    };
    const apiToken = async (rawSessionId: string) => {
      const r = await srv.http("/api/me/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Remote", expiresInDays: 30 }),
        rawSessionId,
      });
      expect(r.status).toBe(201);
      return ((await r.json()) as ApiTokenCreateRes).token;
    };
    const morganAgent = mintAgentToken(
      (await spawn("MorganBot")).id,
      morganId,
      true,
    );
    const aliceAgent = mintAgentToken(
      (await spawn("AliceBot")).id,
      aliceId,
      true,
    );
    const morganApi = await apiToken(morgan.rawSessionId);
    const aliceApi = await apiToken(alice.rawSessionId);
    const create = (bearer: string, body: unknown) =>
      api(srv, "/api/users", { method: "POST", bearer, body });

    const byAgent = await create(morganAgent, { name: "Yu", role: "member" });
    expect(byAgent.status).toBe(201);
    expect(userOf(byAgent)).toMatchObject({
      name: "Yu",
      role: "member",
      pendingSignIn: true,
      allowedRooms: [],
    });
    const byApi = await create(morganApi, { name: "Zed", role: "member" });
    expect(byApi.status).toBe(201);
    expect(userOf(byApi)).toMatchObject({ role: "member", allowedRooms: [] });
    // Room grants are allowed: the member still has no sign-in until a human
    // owner mints the link.
    for (const [bearer, name] of [
      [morganAgent, "Ola"],
      [morganApi, "Pia"],
    ] as const) {
      const granted = await create(bearer, {
        name,
        role: "member",
        allowedRooms: [roomId],
      });
      expect({ name, status: granted.status }).toEqual({ name, status: 201 });
      expect(userOf(granted)).toMatchObject({
        role: "member",
        allowedRooms: [roomId],
        pendingSignIn: true,
      });
    }

    // No sign-in link for a proxy: invites stay with a human owner.
    for (const bearer of [morganAgent, morganApi]) {
      const link = await api(srv, "/api/invites", {
        method: "POST",
        bearer,
        body: { userId: userOf(byAgent).id },
      });
      expect(link.status).toBe(403);
    }

    const refused: [string, unknown][] = [
      [morganAgent, { name: "Owen", role: "owner" }],
      [morganApi, { name: "Owen", role: "owner" }],
      [aliceAgent, { name: "Owen", role: "member" }],
      [aliceApi, { name: "Owen", role: "member" }],
    ];
    for (const [bearer, body] of refused) {
      const r = await create(bearer, body);
      expect({ body, status: r.status }).toEqual({ body, status: 403 });
    }
    // A member's own cookie: officeOwner refuses it.
    const byMember = await api(srv, "/api/users", {
      method: "POST",
      rawSessionId: alice.rawSessionId,
      body: { name: "Owen", role: "member" },
    });
    expect(byMember.status).toBe(403);
    expect(getUserByName("Owen")).toBeUndefined();
  });

  // Legacy new-member rows minted before members were created up front still
  // seed their grants at accept, pruned to rooms that still exist.
  it("a legacy new-member invite prunes a room deleted between mint and accept", async () => {
    const srv = (server = await startTestServer());
    await srv.seedOwner("Morgan");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Doomed");
    const legacy = await _testMintLegacyInvite({
      username: "Yu",
      role: "member",
      allowedRooms: [roomA, roomB],
    });
    expect(srv.agentManager.closeRoom(roomB)).toBe(true);

    const acc = await acceptInvite(legacy.rawToken, { userAgent: null });
    if (!acc.ok) throw new Error(`accept failed: ${acc.error}`);
    const u = getUserByName("Yu");
    expect(u?.allowedRooms).toEqual([roomA]);
    expect(u?.notifRooms).toEqual([roomA]);
  });
});

describe("routes/users REST - update (record split, Option A)", () => {
  it("an owner edits a member's record but never its grants; a member edits only their own and cannot escalate; a bad name is 422, a taken one 409, envFile is ignored", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const mia = await server.seedMember("Mia");
    await server.seedMember("Bob");
    const patch = (name: string, rawSessionId: string, body: unknown) =>
      api(server!, `/api/users/${name}`, {
        method: "PATCH",
        rawSessionId,
        body,
      });

    const r = await patch("Mia", owner.rawSessionId, {
      avatarColor: "#123456",
      allowedRooms: ["sneaky"],
    });
    expect(r.status).toBe(200);
    expect(userOf(r).avatarColor).toBe("#123456");
    // allowedRooms is not in UserUpdateReq; the handler ignores a body field.
    expect(getUserByName("Mia")!.allowedRooms).toEqual([]);

    // selfOrOwner: another member's record is a 403.
    expect(
      (await patch("Bob", mia.rawSessionId, { avatarColor: "#000000" })).status,
    ).toBe(403);

    expect((await patch("Mia", owner.rawSessionId, { name: 123 })).status).toBe(
      422,
    );
    // Names collide case-insensitively.
    const taken = await patch("Mia", owner.rawSessionId, { name: "mOrGaN" });
    expect([taken.status, errCode(taken)]).toEqual([409, "name_taken"]);
    // Per-user env files are managed by isomux now (Connections page); the
    // old envFile path setting is gone from the wire. A stale client that
    // still sends it is ignored, not rejected, and nothing is stored.
    const staleEnv = await patch("Mia", owner.rawSessionId, {
      envFile: "/no/such/file/at/all.env",
    });
    expect(staleEnv.status).toBe(200);
    expect(getUserByName("Mia")).not.toHaveProperty("envFile");

    // A member's own record edit succeeds, and the grants in the body do not.
    const own = await patch("Mia", mia.rawSessionId, {
      allowedRooms: ["r1", "r2"],
      name: "Mia2",
    });
    expect(own.status).toBe(200);
    expect(getUserByName("Mia2")!.allowedRooms).toEqual([]);
  });
});

describe("routes/users REST - setAccess (owner-only allowedRooms)", () => {
  it("an owner sets a member's grants; a member cannot; a malformed list is 422", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const mia = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const put = (rawSessionId: string, body: unknown) =>
      api(server!, `/api/users/${mia.username}/access`, {
        method: "PUT",
        rawSessionId,
        body,
      });

    expect((await put(mia.rawSessionId, { allowedRooms: [r1] })).status).toBe(
      403,
    );
    expect(
      (await put(owner.rawSessionId, { allowedRooms: "all" })).status,
    ).toBe(422);
    expect(getUserByName(mia.username)!.allowedRooms).toEqual([]);

    const r = await put(owner.rawSessionId, { allowedRooms: [r1] });
    expect(r.status).toBe(200);
    expect((userOf(r).allowedRooms as string[]) ?? []).toEqual([r1]);
    expect(getUserByName(mia.username)!.allowedRooms).toEqual([r1]);
  });
});

describe("routes/users REST - delete (preconditions + non-leak)", () => {
  it("deleting a member deletes their secrets, variables and MCP servers, and no one else's", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Morgan");
    const rawSessionId = owner.rawSessionId;
    // What an owner can give a member on the Integrations page.
    async function equip(username: string): Promise<string[]> {
      for (const [path, method, body] of [
        [
          `/api/users/${username}/secrets`,
          "POST",
          {
            name: "LINEAR_TOKEN",
            value: "fake-linear-value-0001",
            hosts: ["mcp.example.com"],
            form: { kind: "authorization" },
          },
        ],
        [
          `/api/users/${username}/env/ZED_TOKEN`,
          "PUT",
          { value: "fake-zed-value", note: "For the Zed CLI." },
        ],
        [
          `/api/users/${username}/mcp-servers`,
          "POST",
          {
            name: "linear",
            url: "https://mcp.example.com/mcp",
            secret: "LINEAR_TOKEN",
          },
        ],
      ] as const)
        expect(
          (await api(srv, path, { method, body, rawSessionId })).status,
        ).toBeLessThan(300);
      const id = getUserByName(username)!.id;
      const files = [
        join(srv.stateRoot, "secrets", "users", `${id}.json`),
        managedUserEnvPath(id),
        managedUserEnvNotesPath(id),
        join(srv.stateRoot, "mcp-servers", "users", `${id}.json`),
      ];
      for (const file of files) expect(existsSync(file)).toBe(true);
      return files;
    }
    const mia = await equip((await srv.seedMember("Mia")).username);
    const bob = await equip((await srv.seedMember("Bob")).username);
    const office = await api(srv, "/api/office/secrets", {
      method: "POST",
      rawSessionId,
      body: {
        name: "OFFICE_TOKEN",
        value: "fake-office-value-0001",
        hosts: ["api.example.com"],
        form: { kind: "authorization" },
      },
    });
    expect(office.status).toBe(201);

    const r = await api(srv, "/api/users/Mia", {
      method: "DELETE",
      rawSessionId,
    });
    expect(r.status).toBe(204);
    expect(getUserByName("Mia")).toBeUndefined();
    for (const file of mia) expect(existsSync(file)).toBe(false);
    for (const file of bob) expect(existsSync(file)).toBe(true);
    expect(existsSync(join(srv.stateRoot, "secrets", "office.json"))).toBe(
      true,
    );
  });

  it("deleting a member revokes their outstanding sign-in link", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const { rawToken } = await mintMemberLink("Mia");
    const r = await api(server, "/api/users/Mia", {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(204);
    expect(peekInvite(rawToken)).toEqual({ error: "not_found" });
    const list = await api(server, "/api/invites", {
      rawSessionId: owner.rawSessionId,
    });
    expect((list.body as { invites: unknown[] }).invites).toEqual([]);
  });

  it("an owner CANNOT delete their own record -> 403 owner_self_delete", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    await addOwner("Morgan2"); // a 2nd owner exists, so it's not a last-owner case
    const r = await api(server, `/api/users/${owner.username}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(403);
    expect(errCode(r)).toBe("owner_self_delete");
    expect(getUserByName(owner.username)).toBeDefined();
  });

  it("a member deletes their own record; another user, real or not, is the same 403; an owner's delete of a ghost is an idempotent 204", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const mia = await server.seedMember("Mia");
    await server.seedMember("Bob");
    const del = (name: string, rawSessionId: string) =>
      api(server!, `/api/users/${name}`, { method: "DELETE", rawSessionId });
    const foreign = await del("Bob", mia.rawSessionId);
    expect(foreign.status).toBe(403);
    expect(getUserByName("Bob")).toBeDefined();
    // The same 403 for a nonexistent target (no exists-vs-hidden distinction).
    const ghost = await del("Nobody", mia.rawSessionId);
    expect(ghost.status).toBe(403);
    expect(ghost.body).toEqual(foreign.body);
    // Owner deleting a nonexistent user is an idempotent no-op (full visibility).
    expect((await del("Nobody", owner.rawSessionId)).status).toBe(204);

    expect((await del(mia.username, mia.rawSessionId)).status).toBe(204);
    expect(getUserByName(mia.username)).toBeUndefined();
  });
});
