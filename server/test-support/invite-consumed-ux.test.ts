// Invite-consumption UX — regression net for the "Yu" incident (a new member
// accepted an invite successfully, re-opened the one-time link, saw "already
// been used", and the owner's open tab showed the new session but not the new
// user). Two fixes frozen here:
//
//   1. setOnInviteConsumed (index.ts registerBootHooks) also fans out
//      emitUsersList(): invite acceptance is the ONE path that creates a user
//      record outside the users.* handlers, so without it an already-open
//      owner socket saw sessions refresh while the user roster stayed stale
//      until reload.
//
//   2. A visitor who hits a CONSUMED invite (GET /i/<token> peek OR a
//      duplicate POST /auth/accept) while holding a valid session is 302'd
//      into the office instead of dead-ending on the 410 — that visitor is
//      almost always the invitee who just accepted. An unauthenticated
//      visitor on a consumed link still gets the honest 410.
//
// Seam: startTestServer() — the real boot path (registerBootHooks) and the
// real HTTP auth routes. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintInvite, COOKIE_NAME } from "../auth.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "cond",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

async function mintFor(username: string): Promise<string> {
  const mint = await mintInvite({
    username,
    role: "member",
    createdBy: null,
    allowExisting: false,
  });
  if (!mint.ok) throw new Error(`mint failed: ${mint.error}`);
  return mint.rawToken;
}

// POST /auth/accept the way a browser does: urlencoded form, no auto-follow
// (we assert on the 302 + Set-Cookie ourselves).
function acceptViaHttp(srv: TestServer, rawToken: string): Promise<Response> {
  return srv.http("/auth/accept", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `token=${encodeURIComponent(rawToken)}`,
  });
}

function sessionCookieOf(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${COOKIE_NAME}=([^;]+)`).exec(setCookie);
  if (!m) throw new Error(`no ${COOKIE_NAME} cookie in: ${setCookie}`);
  return m[1];
}

describe("invite consumption — owner roster fanout", () => {
  it("HTTP accept pushes users_list/users_admin_list to an already-open owner socket", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const sock = await server.connectWs(owner.rawSessionId);
    // Drain to a known point so the assertion below can't match hydration.
    sock.send({ type: "ping" });
    await sock.waitFor("pong");
    const before = sock.messages.length;

    const rawToken = await mintFor("Yu");
    const res = await acceptViaHttp(server, rawToken);
    expect(res.status).toBe(302);

    // The open owner tab hears about the NEW USER without reconnecting —
    // both the public roster and the owners-only admin roster.
    const listsWithYu = (type: string) => () =>
      sock.messages.slice(before).some((m) => {
        const msg = m as { type?: string; users?: { name?: string }[] };
        return (
          msg.type === type &&
          Array.isArray(msg.users) &&
          msg.users.some((u) => u.name === "Yu")
        );
      });
    await waitUntil(listsWithYu("users_admin_list"), 2000, "users_admin_list");
    await waitUntil(listsWithYu("users_list"), 2000, "users_list");
    sock.close();
  });
});

describe("consumed invite — signed-in visitor is redirected, not dead-ended", () => {
  it("GET /i/<token> after a successful accept: with the session cookie -> 302 /; anonymous -> 410", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const rawToken = await mintFor("Yu");
    const acc = await acceptViaHttp(server, rawToken);
    expect(acc.status).toBe(302);
    const yuCookie = sessionCookieOf(acc);

    // The incident shape: the invitee re-opens the one-time link in the
    // same (now signed-in) browser.
    const again = await server.http(`/i/${rawToken}`, {
      redirect: "manual",
      rawSessionId: yuCookie,
    });
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe("/");

    // A visitor WITHOUT a session on the same consumed link still gets the
    // honest 410 — the redirect must not leak "someone is signed in" into a
    // free pass past the error page.
    const anon = await server.http(`/i/${rawToken}`, { redirect: "manual" });
    expect(anon.status).toBe(410);
  });

  it("duplicate POST /auth/accept: with the session cookie -> 302 /; anonymous -> 410", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const rawToken = await mintFor("Yu");
    const first = await acceptViaHttp(server, rawToken);
    expect(first.status).toBe(302);
    const yuCookie = sessionCookieOf(first);

    // Stale accept form re-POSTed from the signed-in browser.
    const dup = await server.http("/auth/accept", {
      method: "POST",
      redirect: "manual",
      rawSessionId: yuCookie,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(rawToken)}`,
    });
    expect(dup.status).toBe(302);
    expect(dup.headers.get("location")).toBe("/");

    // Anonymous duplicate stays a 410.
    const anonDup = await acceptViaHttp(server, rawToken);
    expect(anonDup.status).toBe(410);
  });
});
