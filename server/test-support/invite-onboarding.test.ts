import { afterEach, describe, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  acceptInvite,
  _testMintLegacyInvite,
  peekInvite,
  validateSession,
} from "../auth.ts";
import { getUserByName } from "../users.ts";
import { mintMemberLink } from "./member-link.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("invite onboarding", () => {
  it("keeps an owner-created member through an expired link and takes their language at first sign-in", async () => {
    let srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const created = await srv.http("/api/users", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Marc",
        role: "member",
        memberPrompt: "Explain each step.",
      }),
    });
    expect(created.status).toBe(201);
    const { user } = await created.json();
    expect(user).toMatchObject({
      name: "Marc",
      pendingSignIn: true,
      memberPrompt: "Explain each step.",
      language: null,
    });

    // The bug this flow fixes: an expired link loses nothing.
    const expired = await mintMemberLink("Marc", "member", -1000);
    expect(peekInvite(expired.rawToken)).toEqual({ error: "expired" });
    expect(getUserByName("Marc")).toMatchObject({
      pendingSignIn: true,
      memberPrompt: "Explain each step.",
    });

    const res = await srv.http("/api/invites", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id }),
    });
    expect(res.status).toBe(200);
    const { url, invite } = await res.json();
    expect(invite.username).toBe("Marc");
    const token = new URL(url).pathname.split("/").at(-1)!;
    srv = server = await srv.restart();
    const page = await srv.http(`/i/${token}`, {
      headers: { "Accept-Language": "ca" },
    });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('<html lang="ca"');
    expect(html).not.toContain('name="name"');
    expect(html).toContain('value="ca" selected');
    expect(html).not.toContain("Explain each step.");
    expect(peekInvite(token)).toMatchObject({ firstSignIn: true });

    const accepted = await srv.http("/auth/accept", {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ token, language: "es" }),
    });
    expect(accepted.status).toBe(302);
    expect(accepted.headers.has("set-cookie")).toBe(true);
    const after = getUserByName("Marc");
    expect(after).toMatchObject({
      id: user.id,
      language: "es",
      memberPrompt: "Explain each step.",
      role: "member",
    });
    expect(after?.pendingSignIn).toBeUndefined();
    expect(peekInvite(token)).toEqual({ error: "consumed" });

    // A later link is a plain sign-in: no language question.
    const later = await mintMemberLink("Marc");
    expect(peekInvite(later.rawToken)).not.toHaveProperty("firstSignIn");
  });

  it("refuses an unsupported language at first sign-in without consuming the link", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const { rawToken } = await mintMemberLink("Marc");
    expect(
      await acceptInvite(rawToken, { userAgent: null, language: "fr" }),
    ).toEqual({ ok: false, error: "invalid_language" });
    expect(getUserByName("Marc")?.pendingSignIn).toBe(true);
    expect(peekInvite(rawToken)).not.toHaveProperty("error");
  });

  // Legacy new-member rows minted before this change still accept until
  // they expire: the invitee chooses their name.
  it("rejects an existing name without consuming the invite, preserves the form, and permits a retry", async () => {
    const srv = (server = await startTestServer());
    await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const minted = await _testMintLegacyInvite({
      username: null,
      role: "owner",
      createdBy: "Boss",
      language: "es",
    });
    const token = minted.rawToken;
    const refused = await srv.http("/auth/accept", {
      method: "POST",
      body: new URLSearchParams({ token, name: "alice", language: "ca" }),
    });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).toContain("Aquest nom ja està en ús.");
    expect(html).toContain('value="alice"');
    expect(html).toContain('value="ca" selected');
    expect(refused.headers.has("set-cookie")).toBe(false);
    expect(getUserByName("Alice")?.role).toBe("member");
    expect(validateSession(alice.rawSessionId)?.username).toBe("Alice");
    expect(peekInvite(token)).not.toHaveProperty("error");
    const retry = await acceptInvite(token, {
      userAgent: null,
      chosenName: "Another Alice",
    });
    expect(retry.ok).toBe(true);
    expect(getUserByName("Another Alice")?.language).toBe("es");
  });

  it("allows only one of two simultaneous invites to claim a name", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const mint = () =>
      _testMintLegacyInvite({
        username: null,
        role: "member",
        createdBy: "Boss",
      });
    const a = await mint(),
      b = await mint();
    const results = await Promise.all(
      [a, b].map((m) =>
        acceptInvite(m.rawToken, { userAgent: null, chosenName: "Same Name" }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: "name_taken" },
    ]);
  });

  it("refuses a signed-in owner on a legacy new-member invite and an unsupported language", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const minted = await _testMintLegacyInvite({
      username: null,
      role: "member",
      createdBy: "Boss",
    });
    const page = await srv.http(`/i/${minted.rawToken}`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(page.status).toBe(409);
    expect(peekInvite(minted.rawToken)).not.toHaveProperty("error");
    expect(
      await acceptInvite(minted.rawToken, {
        userAgent: null,
        chosenName: "Good Name",
        language: "fr",
      }),
    ).toEqual({ ok: false, error: "invalid_language" });
    expect(getUserByName("Good Name")).toBeUndefined();
  });
});
