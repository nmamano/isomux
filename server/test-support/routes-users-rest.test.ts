// Phase 3d slice 9b - the users.* REST EXPAND contract (Group 7 auth surface).
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
//   - AGENT bearer can never reach the user-management routes (USER-scoped guards).
//
// (users.list - built recipient-scoped in 9b - was removed as callerless in the
// Phase 4 close-out: the UI hydrates the roster from the users_list broadcasts.)
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintInvite, acceptInvite } from "../auth.ts";
import { getUserByName } from "../users.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";

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
  const mint = await mintInvite({
    username: name,
    role: "owner",
    createdBy: null,
    allowExisting: false,
  });
  if (!mint.ok) throw new Error(`addOwner mint: ${mint.error}`);
  const acc = await acceptInvite(mint.rawToken, {
    userAgent: "test",
    chosenName: name,
  });
  if (!acc.ok) throw new Error(`addOwner accept: ${acc.error}`);
  return acc.rawSessionId;
}

const errCode = (r: Res) =>
  (r.body as { error?: { code?: string } })?.error?.code;
const userOf = (r: Res) => (r.body as { user: Record<string, unknown> }).user;

describe("routes/users REST - update (record split, Option A)", () => {
  it("owner edits a member's record -> 200 { user }; allowedRooms is NOT touched", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const r = await api(server, `/api/users/${member.username}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { memberPrompt: "hi", allowedRooms: ["sneaky"] },
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

  it("unauth -> 401 (new envelope); malformed name -> 422; invalid env -> 400", async () => {
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

    const badEnv = await api(server, `/api/users/${mia.username}`, {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { envFile: "/no/such/file/at/all.env" },
    });
    expect(badEnv.status).toBe(400);
    expect(errCode(badEnv)).toBe("invalid_env");
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
