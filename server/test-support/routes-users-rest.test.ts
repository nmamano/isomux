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
//     record fields (name/env/prompt/avatar); it CANNOT change allowedRooms (not
//     in UserUpdateReq) - a member sending allowedRooms in the body is ignored,
//     no escalation. users.setAccess (officeOwner) owns allowedRooms.
//   - selfOrOwner on update/delete: a member edits/deletes only their OWN record;
//     editing/deleting another's is a uniform 403 (no existence oracle).
//   - The two delete preconditions: owner!=self (403 owner_self_delete) and
//     not-last-owner; missing target is an idempotent 204.
//   - Only privileged agents reach memberPrompt reads and version-guarded edits.
//
// (users.list - built recipient-scoped in 9b - was removed as callerless in the
// Phase 4 close-out: the UI hydrates the roster from the users_list broadcasts.)
//
// Seam: startTestServer(). Zero LLM.

import { versionOf } from "../../shared/blob-version.ts";
import { mintMemberLink } from "./member-link.ts";
import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { _testMintLegacyInvite, acceptInvite, peekInvite } from "../auth.ts";
import { getUserByName } from "../users.ts";
import { getAgentTokenRaw, mintAgentToken } from "../identity/tokens.ts";
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
  it("owner creates a pending member -> 201 { user } with profile + grants; a link then signs them in keeping them", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Grants B");

    const r = await api(srv, "/api/users", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {
        name: " Yu ",
        role: "member",
        memberPrompt: "Explain each step.",
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
  });

  it("an owner-role member gets no grants but notifications for every room", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const rooms = srv.agentManager.getRooms().map((room) => room.id);

    const r = await api(srv, "/api/users", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { name: "Co Owner", role: "owner" },
    });
    expect(r.status).toBe(201);
    expect(userOf(r)).toMatchObject({
      role: "owner",
      allowedRooms: [],
      notifRooms: rooms,
      pendingSignIn: true,
    });
  });

  it("refuses: taken name 409, bad name 400, grants on an owner or an unknown room 400, malformed 422 - creating no one", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
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
        { name: "Yu", role: "member", memberPrompt: {} },
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

  it("a member -> 403 (officeOwner); AGENT bearer -> 403; unauth -> 401", async () => {
    const srv = (server = await startTestServer());
    await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const roomId = srv.agentManager.getRooms()[0].id;
    const info = await srv.agentManager.spawn(
      "Bot",
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
    const body = { name: "Yu", role: "member" };
    expect(
      (
        await api(srv, "/api/users", {
          method: "POST",
          rawSessionId: alice.rawSessionId,
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, "/api/users", {
          method: "POST",
          bearer: getAgentTokenRaw(info.id)!,
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (await api(srv, "/api/users", { method: "POST", body })).status,
    ).toBe(401);
    expect(getUserByName("Yu")).toBeUndefined();
  });

  it("an owner's privileged agent and API token create a plain member, and cannot mint its link", async () => {
    const srv = (server = await startTestServer());
    const boss = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bossId = getUserByName("Boss")!.id;
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
    const bossAgent = mintAgentToken((await spawn("BossBot")).id, bossId, true);
    const aliceAgent = mintAgentToken(
      (await spawn("AliceBot")).id,
      aliceId,
      true,
    );
    const bossApi = await apiToken(boss.rawSessionId);
    const aliceApi = await apiToken(alice.rawSessionId);
    const create = (bearer: string, body: unknown) =>
      api(srv, "/api/users", { method: "POST", bearer, body });

    const byAgent = await create(bossAgent, { name: "Yu", role: "member" });
    expect(byAgent.status).toBe(201);
    expect(userOf(byAgent)).toMatchObject({
      name: "Yu",
      role: "member",
      pendingSignIn: true,
      allowedRooms: [],
    });
    const byApi = await create(bossApi, { name: "Zed", role: "member" });
    expect(byApi.status).toBe(201);
    expect(userOf(byApi)).toMatchObject({ role: "member", allowedRooms: [] });
    // Room grants are allowed: the member still has no sign-in until a human
    // owner mints the link.
    for (const [bearer, name] of [
      [bossAgent, "Ola"],
      [bossApi, "Pia"],
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
    for (const bearer of [bossAgent, bossApi]) {
      const link = await api(srv, "/api/invites", {
        method: "POST",
        bearer,
        body: { userId: userOf(byAgent).id },
      });
      expect(link.status).toBe(403);
    }

    const refused: [string, unknown][] = [
      [bossAgent, { name: "Owen", role: "owner" }],
      [bossApi, { name: "Owen", role: "owner" }],
      [aliceAgent, { name: "Owen", role: "member" }],
      [aliceApi, { name: "Owen", role: "member" }],
    ];
    for (const [bearer, body] of refused) {
      const r = await create(bearer, body);
      expect({ body, status: r.status }).toEqual({ body, status: 403 });
    }
    expect(getUserByName("Owen")).toBeUndefined();
  });

  // Legacy new-member rows minted before members were created up front still
  // seed their grants at accept, pruned to rooms that still exist.
  it("a legacy new-member invite prunes a room deleted between mint and accept", async () => {
    const srv = (server = await startTestServer());
    await srv.seedOwner("Boss");
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
  it("owner edits a member's record -> 200 { user }; allowedRooms is NOT touched", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r = await api(server, `/api/users/${member.username}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: {
        memberPrompt: "hi",
        memberPromptVersion: versionOf(""),
        allowedRooms: ["sneaky"],
      },
    });
    expect(r.status).toBe(200);
    expect(userOf(r).memberPrompt).toBe("hi");
    // allowedRooms is not in UserUpdateReq; the handler ignores a body field.
    expect(getUserByName(member.username)!.allowedRooms).toEqual([]);
  });

  it("a member editing ANOTHER user's record -> 403 (selfOrOwner)", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const mia = await server.seedMember("Mia");
    await server.seedMember("Bob");
    const r = await api(server, `/api/users/Bob`, {
      method: "PATCH",
      rawSessionId: mia.rawSessionId,
      body: { memberPrompt: "x" },
    });
    expect(r.status).toBe(403);
  });

  it("a member CANNOT escalate by sending allowedRooms on their own record", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const mia = await server.seedMember("Mia");
    const r = await api(server, `/api/users/${mia.username}`, {
      method: "PATCH",
      rawSessionId: mia.rawSessionId,
      body: { allowedRooms: ["r1", "r2"], name: "Mia2" },
    });
    expect(r.status).toBe(200); // record edit (rename) succeeds
    expect(getUserByName("Mia2")!.allowedRooms).toEqual([]); // grants untouched
  });

  it("unauth -> 401 (new envelope); malformed name -> 422; envFile is no longer a setting and is ignored", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const mia = await server.seedMember("Mia");
    const unauth = await api(server, `/api/users/${mia.username}`, {
      method: "PATCH",
      body: { name: "x" },
    });
    expect(unauth.status).toBe(401);
    expect(errCode(unauth)).toBe("unauthenticated");

    const bad = await api(server, `/api/users/${mia.username}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { name: 123 },
    });
    expect(bad.status).toBe(422);

    // Per-user env files are managed by isomux now (Connections page); the
    // old envFile path setting is gone from the wire. A stale client that
    // still sends it is ignored, not rejected, and nothing is stored.
    const staleEnv = await api(server, `/api/users/${mia.username}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { envFile: "/no/such/file/at/all.env" },
    });
    expect(staleEnv.status).toBe(200);
    expect(getUserByName("Mia")).toBeDefined();
    expect(getUserByName("Mia")).not.toHaveProperty("envFile");
  });

  it("a rename to an existing name -> 409 name_taken", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    await server.seedMember("Mia");
    const r = await api(server, `/api/users/Mia`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { name: "Boss" },
    });
    expect(r.status).toBe(409);
    expect(errCode(r)).toBe("name_taken");
  });
});

describe("routes/users REST - setAccess (owner-only allowedRooms)", () => {
  it("owner sets a member's access -> 200 { user } with the new grants", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r = await api(server, `/api/users/${member.username}/access`, {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { allowedRooms: [r1] },
    });
    expect(r.status).toBe(200);
    expect((userOf(r).allowedRooms as string[]) ?? []).toEqual([r1]);
    expect(getUserByName(member.username)!.allowedRooms).toEqual([r1]);
  });

  it("a member CANNOT call setAccess (officeOwner) -> 403, grants unchanged", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const mia = await server.seedMember("Mia");
    const r1 = server.agentManager.getRooms()[0].id;
    const r = await api(server, `/api/users/${mia.username}/access`, {
      method: "PUT",
      rawSessionId: mia.rawSessionId,
      body: { allowedRooms: [r1] },
    });
    expect(r.status).toBe(403);
    expect(getUserByName(mia.username)!.allowedRooms).toEqual([]);
  });

  it("malformed allowedRooms -> 422; AGENT bearer -> 403", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const bad = await api(server, `/api/users/${member.username}/access`, {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { allowedRooms: "all" },
    });
    expect(bad.status).toBe(422);

    const agent = await server.agentManager.spawn(
      "Probe",
      server.stateRoot,
      "default",
      undefined,
      undefined,
      server.agentManager.getRooms()[0].id,
      undefined,
      undefined,
      undefined,
      undefined,
      "claude",
    );
    const bearer = getAgentTokenRaw(agent!.id);
    const r = await api(server, `/api/users/${member.username}/access`, {
      method: "PUT",
      bearer: bearer ?? undefined,
      body: { allowedRooms: [] },
    });
    expect(r.status).toBe(403);
  });
});

describe("routes/users REST - delete (preconditions + non-leak)", () => {
  it("owner deletes a member -> 204; record gone", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r = await api(server, `/api/users/${member.username}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(204);
    expect(getUserByName(member.username)).toBeUndefined();
  });

  it("deleting a member revokes their outstanding sign-in link", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
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
    const owner = await server.seedOwner("Boss");
    await addOwner("Boss2"); // a 2nd owner exists, so it's not a last-owner case
    const r = await api(server, `/api/users/${owner.username}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(403);
    expect(errCode(r)).toBe("owner_self_delete");
    expect(getUserByName(owner.username)).toBeDefined();
  });

  it("a member deletes their OWN record -> 204", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const mia = await server.seedMember("Mia");
    const r = await api(server, `/api/users/${mia.username}`, {
      method: "DELETE",
      rawSessionId: mia.rawSessionId,
    });
    expect(r.status).toBe(204);
    expect(getUserByName(mia.username)).toBeUndefined();
  });

  it("a member deleting ANOTHER user -> 403 (uniform, no oracle); owner deleting a ghost -> idempotent 204", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const mia = await server.seedMember("Mia");
    await server.seedMember("Bob");
    const foreign = await api(server, `/api/users/Bob`, {
      method: "DELETE",
      rawSessionId: mia.rawSessionId,
    });
    expect(foreign.status).toBe(403);
    expect(getUserByName("Bob")).toBeDefined();
    // The same 403 for a nonexistent target (no exists-vs-hidden distinction).
    const ghost = await api(server, `/api/users/Nobody`, {
      method: "DELETE",
      rawSessionId: mia.rawSessionId,
    });
    expect(ghost.status).toBe(403);
    // Owner deleting a nonexistent user is an idempotent no-op (full visibility).
    const ownerGhost = await api(server, `/api/users/Nobody`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(ownerGhost.status).toBe(204);
  });
});

describe("routes/users member prompt", () => {
  it("checks both writers, rejects every extra agent field, and returns only prompt data", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const mia = await srv.seedMember("Mia");
    const room = srv.agentManager.getRooms()[0].id;
    const agent = await srv.agentManager.spawn(
      "Prompt editor",
      srv.stateRoot,
      "default",
      undefined,
      undefined,
      room,
    );
    if (!agent) throw new Error("spawn failed");
    const bossId = getUserByName("Boss")!.id;
    const miaId = getUserByName("Mia")!.id;
    const read = (bearer: string, name = "Boss") =>
      api(srv, `/api/users/${name}/member-prompt`, { bearer });
    const patch = (bearer: string, body: unknown, name = "Boss") =>
      api(srv, `/api/users/${name}`, { bearer, method: "PATCH", body });
    const tokenRes = await api(srv, "/api/me/api-tokens", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { name: "Prompt exclusion", expiresInDays: 30 },
    });
    const apiToken = (tokenRes.body as ApiTokenCreateRes).token;
    expect((await read(apiToken)).status).toBe(403);
    expect(
      (
        await patch(apiToken, {
          memberPrompt: "denied",
          memberPromptVersion: versionOf(""),
        })
      ).status,
    ).toBe(403);
    const ordinary = mintAgentToken(agent.id, bossId, false);
    expect((await read(ordinary)).status).toBe(403);
    expect(
      (
        await patch(ordinary, {
          memberPrompt: "denied",
          memberPromptVersion: versionOf(""),
        })
      ).status,
    ).toBe(403);
    const member = mintAgentToken(agent.id, miaId, true);
    expect((await read(member)).status).toBe(403);
    expect((await read(member, "Unknown")).status).toBe(403);
    expect(
      (
        await patch(member, {
          memberPrompt: "denied",
          memberPromptVersion: versionOf(""),
        })
      ).status,
    ).toBe(403);
    expect((await read(member, "Mia")).status).toBe(200);
    expect(
      (
        await patch(
          member,
          { memberPrompt: "mine", memberPromptVersion: versionOf("") },
          "Mia",
        )
      ).status,
    ).toBe(200);
    const privileged = mintAgentToken(agent.id, bossId, true);
    const initial = await read(privileged);
    expect(initial.body).toEqual({
      memberPrompt: null,
      memberPromptVersion: versionOf(""),
    });
    for (const [key, value] of Object.entries({
      role: "owner",
      name: "Renamed",
      avatarColor: "#000000",
      avatarVariant: "sleepy",
      allowedRooms: [room],
      language: "es",
      hidden: [room],
      unknown: true,
    })) {
      const before = structuredClone(getUserByName("Mia"));
      expect(
        (
          await patch(
            privileged,
            {
              memberPrompt: "denied",
              memberPromptVersion: versionOf("mine"),
              [key]: value,
            },
            "Mia",
          )
        ).status,
        key,
      ).toBe(403);
      expect(getUserByName("Mia")).toEqual(before);
    }
    for (const memberPromptVersion of [undefined, "", null, 7]) {
      const r = await patch(privileged, {
        memberPrompt: "denied",
        memberPromptVersion,
      });
      expect(r.status).toBe(400);
      expect(errCode(r)).toBe("invalid_version");
      expect(getUserByName("Boss")!.memberPrompt).toBeNull();
    }
    for (const memberPromptVersion of ["stale"]) {
      const r = await patch(privileged, {
        memberPrompt: "denied",
        memberPromptVersion,
      });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({
        error: { code: "version_conflict", version: versionOf("") },
      });
      expect(getUserByName("Boss")!.memberPrompt).toBeNull();
    }
    const saved = await patch(privileged, {
      memberPrompt: " agent text ",
      memberPromptVersion: versionOf(""),
    });
    expect(saved.body).toEqual({
      memberPrompt: "agent text",
      memberPromptVersion: versionOf("agent text"),
    });
    expect((await read(privileged)).body).toEqual(saved.body);
    const humanStale = await api(srv, "/api/users/Boss", {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: {
        name: "Wrong",
        memberPrompt: "old draft",
        memberPromptVersion: versionOf(""),
      },
    });
    expect(humanStale.status).toBe(409);
    expect(getUserByName("Boss")!.memberPrompt).toBe("agent text");
    expect(getUserByName("Wrong")).toBeUndefined();
    const humanMissing = await api(srv, "/api/users/Mia", {
      method: "PATCH",
      rawSessionId: mia.rawSessionId,
      body: { memberPrompt: null },
    });
    expect(humanMissing.status).toBe(400);
    expect(errCode(humanMissing)).toBe("invalid_version");
    expect(getUserByName("Mia")!.memberPrompt).toBe("mine");
    expect(
      (
        await patch(
          privileged,
          { memberPrompt: null, memberPromptVersion: versionOf("mine") },
          "Mia",
        )
      ).body,
    ).toEqual({ memberPrompt: null, memberPromptVersion: versionOf("") });
    const humanSave = await api(srv, "/api/users/Boss", {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: {
        memberPrompt: "human text",
        memberPromptVersion: versionOf("agent text"),
      },
    });
    expect(userOf(humanSave).memberPrompt).toBe("human text");
    expect(
      (
        await patch(privileged, {
          memberPrompt: "stale agent",
          memberPromptVersion: versionOf("agent text"),
        })
      ).status,
    ).toBe(409);
    expect(getUserByName("Boss")!.memberPrompt).toBe("human text");
    expect(
      (
        await patch(privileged, {
          memberPrompt: 7,
          memberPromptVersion: versionOf("human text"),
        })
      ).status,
    ).toBe(422);
    const scalar = await api(srv, "/api/users/Boss", {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { avatarColor: "#000000" },
    });
    expect(scalar.status).toBe(200);
  });
});
