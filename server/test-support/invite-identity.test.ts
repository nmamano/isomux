// Invite acceptance must never silently replace a live browser identity.
// These tests drive the real GET/POST auth routes because the safety property
// belongs at the HTTP boundary, before acceptInvite consumes the token.

import { afterEach, describe, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  COOKIE_NAME,
  _testSetSessionExpiry,
  listInvites,
  mintInvite,
  peekInvite,
  revokeSessionByPrefix,
  validateSession,
} from "../auth.ts";
import { getUserByName, setUserRoleById } from "../users.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function mintFor(
  username: string,
  role: "owner" | "member" = "member",
  allowExisting = false,
): Promise<string> {
  const minted = await mintInvite({
    username,
    role,
    createdBy: "Boss",
    allowExisting,
  });
  if (!minted.ok) throw new Error(`mint failed: ${minted.error}`);
  return minted.rawToken;
}

function postAccept(
  srv: TestServer,
  token: string,
  rawSessionId?: string,
  name?: string,
): Promise<Response> {
  return srv.http("/auth/accept", {
    method: "POST",
    redirect: "manual",
    rawSessionId,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      ...(name === undefined ? {} : { name }),
    }).toString(),
  });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${COOKIE_NAME}=([^;]+)`).exec(header);
  if (!match) throw new Error(`missing ${COOKIE_NAME} cookie: ${header}`);
  return match[1];
}

describe("invite identity allow-list", () => {
  it("direct POST: sole owner cannot accept a brand-new member identity", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const token = await mintFor("Newbie");
    expect(listInvites()).toHaveLength(1);

    // No GET peek first: the POST is the authoritative security boundary.
    const refused = await postAccept(server, token, owner.rawSessionId);
    expect(refused.status).toBe(409);
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(validateSession(owner.rawSessionId)?.username).toBe("Boss");
    expect(peekInvite(token)).toMatchObject({ username: "Newbie" });
    expect(listInvites()).toHaveLength(1);

    const body = await refused.text();
    expect(body).toContain("This invite is for a different user");
    expect(body).toContain("You are signed in as Boss.");
    expect(body).toContain("To accept it as Newbie");

    // The refused recipient still has a usable one-time link.
    const accepted = await postAccept(server, token);
    expect(accepted.status).toBe(302);
    expect(validateSession(cookieFrom(accepted))?.username).toBe("Newbie");
    expect(peekInvite(token)).toEqual({ error: "consumed" });
  });

  it("GET mirrors the cross-user refusal without an accept form", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const token = await mintFor("Newbie");

    const page = await server.http(`/i/${token}`, {
      rawSessionId: owner.rawSessionId,
      redirect: "manual",
    });
    expect(page.status).toBe(409);
    const html = await page.text();
    expect(html).toContain("This invite is for a different user");
    expect(html).not.toContain('action="/auth/accept"');
    expect(peekInvite(token)).toMatchObject({ username: "Newbie" });
  });

  it("refuses every cross-user role shape, including a second-owner invite", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Bob");

    for (const [cookie, username, role] of [
      [owner.rawSessionId, "Alice", "owner"],
      [member.rawSessionId, "Carol", "member"],
    ] as const) {
      const token = await mintFor(username, role);
      const response = await postAccept(server, token, cookie);
      expect({ username, status: response.status }).toEqual({
        username,
        status: 409,
      });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(peekInvite(token)).toMatchObject({ username });
    }
  });

  it("allows a same-user recovery invite and keeps the stable identity", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const before = validateSession(owner.rawSessionId)!;
    const socket = await server.connectWs(owner.rawSessionId);
    const openContext = (await socket.waitFor("session_context")) as {
      context: { userId: string; username: string };
    };
    const token = await mintFor("Boss", "owner", true);

    const accepted = await postAccept(server, token, owner.rawSessionId);
    expect(accepted.status).toBe(302);
    const replacement = cookieFrom(accepted);
    const after = validateSession(replacement)!;
    expect(after.userId).toBe(before.userId);
    expect(after.username).toBe("Boss");
    expect(replacement).not.toBe(owner.rawSessionId);

    // The already-open tab remains the same stable identity. A reload/reconnect
    // uses the replacement cookie and also remains that identity.
    expect(openContext.context).toMatchObject({
      userId: before.userId,
      username: "Boss",
    });
    expect(socket.raw.readyState).toBe(WebSocket.OPEN);
    const reconnected = await server.connectWs(replacement);
    const reconnectContext = (await reconnected.waitFor("session_context")) as {
      context: { userId: string; username: string };
    };
    expect(reconnectContext.context).toMatchObject({
      userId: before.userId,
      username: "Boss",
    });
    socket.close();
    reconnected.close();
  });

  it("uses the bootstrap binder's trimmed name for the same-user allow-list", async () => {
    server = await startTestServer();
    const originalOwner = await server.seedOwner("Boss");
    const alice = await server.seedMember("Alice");
    // Model a migrated pre-owner office that already has member records.
    setUserRoleById(
      validateSession(originalOwner.rawSessionId)!.userId,
      "member",
    );
    const minted = await mintInvite({
      username: null,
      role: "owner",
      createdBy: null,
      allowExisting: false,
      bootstrap: true,
    });
    if (!minted.ok) throw new Error(`mint failed: ${minted.error}`);

    const wrongIdentity = await postAccept(
      server,
      minted.rawToken,
      alice.rawSessionId,
      "Brand New Owner",
    );
    expect(wrongIdentity.status).toBe(409);
    expect(peekInvite(minted.rawToken)).toMatchObject({ bootstrap: true });

    const sameIdentity = await postAccept(
      server,
      minted.rawToken,
      alice.rawSessionId,
      "  Alice  ",
    );
    expect(sameIdentity.status).toBe(302);
    const accepted = validateSession(cookieFrom(sameIdentity))!;
    expect(accepted.userId).toBe(getUserByName("Alice")!.id);
    expect(accepted.role).toBe("owner");
  });

  it("treats expired, revoked, and unresolvable cookies as anonymous", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const expired = await server.seedMember("Expired");
    const revoked = await server.seedMember("Revoked");
    _testSetSessionExpiry(expired.rawSessionId, { expiresAt: Date.now() - 1 });
    const revokedLookup = validateSession(revoked.rawSessionId)!;
    expect(await revokeSessionByPrefix(revokedLookup.sessionPrefix)).toBe("ok");

    for (const [cookie, username] of [
      [expired.rawSessionId, "NewFromExpired"],
      [revoked.rawSessionId, "NewFromRevoked"],
      ["not-a-session", "NewFromUnknown"],
    ]) {
      const token = await mintFor(username);
      const accepted = await postAccept(server, token, cookie);
      expect({ username, status: accepted.status }).toEqual({
        username,
        status: 302,
      });
      expect(validateSession(cookieFrom(accepted))?.username).toBe(username);
    }
  });

  it("keeps anonymous acceptance unchanged", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const token = await mintFor("Newbie");
    const accepted = await postAccept(server, token);
    expect(accepted.status).toBe(302);
    expect(validateSession(cookieFrom(accepted))?.username).toBe("Newbie");
  });
});
