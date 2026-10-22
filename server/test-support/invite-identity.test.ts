// Invite acceptance must never silently replace a live browser identity.
// These tests drive the real GET/POST auth routes because the safety property
// belongs at the HTTP boundary, before acceptInvite consumes the token.

import { afterEach, describe, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  sessionCookieName,
  _testSetSessionExpiry,
  listInvites,
  _testMintLegacyInvite,
  peekInvite,
  revokeSessionByPrefix,
  validateSession,
} from "../auth.ts";
import { getUserByName, setUserRoleById } from "../users.ts";
import { mintMemberLink } from "./member-link.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// A sign-in link for `username`; an unknown name is created first, as an
// owner does in Members before inviting.
async function mintFor(
  username: string,
  role: "owner" | "member" = "member",
): Promise<string> {
  return (await mintMemberLink(username, role)).rawToken;
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
  const match = new RegExp(`${sessionCookieName()}=([^;]+)`).exec(header);
  if (!match)
    throw new Error(`missing ${sessionCookieName()} cookie: ${header}`);
  return match[1];
}

describe("invite identity allow-list", () => {
  it("direct POST: sole owner cannot accept a brand-new member identity", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const token = await mintFor("Newbie");
    expect(listInvites()).toHaveLength(1);

    // No GET peek first: the POST is the authoritative security boundary.
    const refused = await postAccept(server, token, owner.rawSessionId);
    expect(refused.status).toBe(409);
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(validateSession(owner.rawSessionId)?.username).toBe("Morgan");
    expect(peekInvite(token)).toMatchObject({ username: "Newbie" });
    expect(listInvites()).toHaveLength(1);

    // The page names both the signed-in member and the invite's member.
    const body = await refused.text();
    expect(body).toContain("Morgan");
    expect(body).toContain("Newbie");

    // The refused recipient still has a usable one-time link.
    const accepted = await postAccept(server, token);
    expect(accepted.status).toBe(302);
    expect(validateSession(cookieFrom(accepted))?.username).toBe("Newbie");
    expect(peekInvite(token)).toEqual({ error: "consumed" });
  });

  it("GET mirrors the cross-user refusal without an accept form", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const token = await mintFor("Newbie");

    const page = await server.http(`/i/${token}`, {
      rawSessionId: owner.rawSessionId,
      redirect: "manual",
    });
    expect(page.status).toBe(409);
    const html = await page.text();
    expect(html).toContain("Newbie");
    expect(html).not.toContain('action="/auth/accept"');
    expect(peekInvite(token)).toMatchObject({ username: "Newbie" });
  });

  it("allows a same-user recovery invite and keeps the stable identity", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const before = validateSession(owner.rawSessionId)!;
    const socket = await server.connectWs(owner.rawSessionId);
    await socket.waitFor("session_context");
    const token = await mintFor("Morgan", "owner");

    const accepted = await postAccept(server, token, owner.rawSessionId);
    expect(accepted.status).toBe(302);
    const replacement = cookieFrom(accepted);
    const after = validateSession(replacement)!;
    expect(after.userId).toBe(before.userId);
    expect(after.username).toBe("Morgan");
    expect(replacement).not.toBe(owner.rawSessionId);

    // The already-open tab stays open, and its old cookie stays valid.
    expect(socket.raw.readyState).toBe(WebSocket.OPEN);
    expect(validateSession(owner.rawSessionId)?.userId).toBe(before.userId);
    socket.close();
  });

  it("uses the bootstrap binder's trimmed name for the same-user allow-list", async () => {
    server = await startTestServer();
    const originalOwner = await server.seedOwner("Morgan");
    const alice = await server.seedMember("Alice");
    // Model a migrated pre-owner office that already has member records.
    setUserRoleById(
      validateSession(originalOwner.rawSessionId)!.userId,
      "member",
    );
    const minted = await _testMintLegacyInvite({
      username: null,
      role: "owner",
      bootstrap: true,
    });

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
    await server.seedOwner("Morgan");
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
});
