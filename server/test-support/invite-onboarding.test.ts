import { afterEach, describe, expect, it } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  acceptInvite,
  mintInvite,
  peekInvite,
  validateSession,
} from "../auth.ts";
import { getUserByName } from "../users.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("invite onboarding", () => {
  it("carries owner defaults through REST, shows a localized name form, and accepts the invitee's language", async () => {
    let srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const res = await srv.http("/api/invites", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "member",
        label: "Marc",
        language: "ca",
        memberPrompt: "Explain each step.",
      }),
    });
    expect(res.status).toBe(200);
    const { url, invite } = await res.json();
    expect(invite.label).toBe("Marc");
    expect(invite.username).toBeNull();
    expect(invite.memberPrompt).toBeUndefined();
    expect(getUserByName("Marc")).toBeUndefined();
    const token = new URL(url).pathname.split("/").at(-1)!;
    srv = server = await srv.restart();
    const page = await srv.http(`/i/${token}`, {
      headers: { "Accept-Language": "en" },
    });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('<html lang="ca"');
    expect(html).toContain('name="name"');
    expect(html).toContain('value="Marc"');
    expect(html).toContain("Pots canviar el teu nom i idioma");
    expect(html).toContain('value="ca" selected');
    expect(html).not.toContain("Explain each step.");
    expect(peekInvite(token)).not.toHaveProperty("error");
    const accepted = await srv.http("/auth/accept", {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ token, name: "Marc Garcia", language: "es" }),
    });
    expect(accepted.status).toBe(302);
    expect(accepted.headers.has("set-cookie")).toBe(true);
    expect(getUserByName("Marc Garcia")).toMatchObject({
      language: "es",
      memberPrompt: "Explain each step.",
      role: "member",
    });
    expect(peekInvite(token)).toEqual({ error: "consumed" });
  });

  it("rejects an existing name without consuming the invite, preserves the form, and permits a retry", async () => {
    const srv = (server = await startTestServer());
    await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const minted = await mintInvite({
      username: null,
      role: "owner",
      createdBy: "Boss",
      allowExisting: false,
      language: "es",
    });
    if (!minted.ok) throw new Error(minted.error);
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
      mintInvite({
        username: null,
        role: "member",
        createdBy: "Boss",
        allowExisting: false,
      });
    const a = await mint(),
      b = await mint();
    if (!a.ok || !b.ok) throw new Error("mint failed");
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

  it("refuses a signed-in owner on a new invite and rejects malformed defaults", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Boss");
    const minted = await mintInvite({
      username: null,
      role: "member",
      createdBy: "Boss",
      allowExisting: false,
    });
    if (!minted.ok) throw new Error(minted.error);
    const page = await srv.http(`/i/${minted.rawToken}`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(page.status).toBe(409);
    expect(peekInvite(minted.rawToken)).not.toHaveProperty("error");
    for (const fields of [
      { label: 42 },
      { label: "a".repeat(65) },
      { language: "fr" },
      { memberPrompt: {} },
    ]) {
      const res = await srv.http("/api/invites", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "member", ...fields }),
      });
      expect(res.status).toBe(400);
    }
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
