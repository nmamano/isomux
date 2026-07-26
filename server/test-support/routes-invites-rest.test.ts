// Phase 3a slice 3a.4a — Invites on the unified REST surface
// (opIds invites.{mint,mintSelf,list,revoke}).
//
// TDD'd against the typed route table. What this freezes:
//   - Recipient-scoped projection: GET /api/invites returns owner→all,
//     member→own; the DIRECT list read NEVER fans out to other sockets.
//   - Mutation fan-out: mint/revoke emit a per-user invites_list (a 2nd member
//     proves zero cross-user rows leak), and revoke emits invite_revoked
//     OWNERS-ONLY (members/other users never receive it).
//   - Non-leak revoke authz (inviteOwnerOrSelf precondition): a member's foreign
//     AND nonexistent prefix BOTH 403 with an identical body — no existence leak.
//   - ROLE SOURCE = user RECORD (Reviewer1 Option A): a member promoted in the
//     record without reconnecting projects/revokes as an owner. invites.mint
//     alone stays officeOwner (session) — a member POST is 403.
//   - Status mapping: mint INVALID→400 / conflict→409 / ok→200; member revoke
//     uniform 403; owner nonexistent→404.
//   - AGENT bearer → 403 (no invite:manage); no identity → 401 (allowLoopback:false).
//   - Strangler: the legacy WS arms share the SAME core (covered where it bites —
//     the recipient-scoped emit + record-role revoke run on both transports).
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { setUserRole, getUserByName } from "../users.ts";
import { acceptInvite, INVITE_TTL_MS } from "../auth.ts";
import type { AgentInfo, InviteWire } from "../../shared/types.ts";

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

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
): Promise<AgentInfo> {
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
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

// Mint an outstanding invite bound to an EXISTING user via the self-invite
// route, as that user; return its prefix. Post-eb3354e6 this is the ONLY way
// to create an invite for an existing account (invites.mint is new-user only,
// 409 on an existing name), so the scoping/revoke tests ride it.
async function mintFor(srv: TestServer, session: string): Promise<string> {
  const r = await api(srv, "/api/invites/self", {
    method: "POST",
    rawSessionId: session,
  });
  if (r.status !== 200) {
    throw new Error(`mintFor -> ${r.status}`);
  }
  return (r.body as { invite: InviteWire }).invite.tokenPrefix;
}

function invitesOf(r: Res): InviteWire[] {
  return (r.body as { invites: InviteWire[] }).invites;
}
function lastInvitesList(sock: TestSocket): InviteWire[] | null {
  for (let i = sock.messages.length - 1; i >= 0; i--) {
    const m = sock.messages[i] as { type?: string; invites?: InviteWire[] };
    if (m.type === "invites_list") return m.invites ?? [];
  }
  return null;
}
function hasPrefix(list: InviteWire[] | null, prefix: string): boolean {
  return !!list && list.some((i) => i.tokenPrefix === prefix);
}
function countType(sock: TestSocket, type: string): number {
  return sock.messages.filter((m) => (m as { type?: string }).type === type)
    .length;
}

describe("routes/invites REST: direct list scoping (no fan-out on reads)", () => {
  it("owner sees all, each member sees only own", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");
    const pa = await mintFor(srv, alice.rawSessionId);
    const pb = await mintFor(srv, bob.rawSessionId);

    const ownerList = await api(srv, "/api/invites", {
      rawSessionId: owner.rawSessionId,
    });
    expect(ownerList.status).toBe(200);
    expect(hasPrefix(invitesOf(ownerList), pa)).toBe(true);
    expect(hasPrefix(invitesOf(ownerList), pb)).toBe(true);

    const aliceList = await api(srv, "/api/invites", {
      rawSessionId: alice.rawSessionId,
    });
    expect(aliceList.status).toBe(200);
    expect(hasPrefix(invitesOf(aliceList), pa)).toBe(true);
    expect(hasPrefix(invitesOf(aliceList), pb)).toBe(false); // no cross-user leak

    const bobList = await api(srv, "/api/invites", {
      rawSessionId: bob.rawSessionId,
    });
    expect(hasPrefix(invitesOf(bobList), pb)).toBe(true);
    expect(hasPrefix(invitesOf(bobList), pa)).toBe(false);
  });

  it("a list READ does NOT emit invites_list to other connected sockets", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const bob = await srv.seedMember("Bob");
    await mintFor(srv, bob.rawSessionId);

    // bob connects AFTER the mint (so no fan-out is buffered), then the owner
    // performs a pure READ. bob must receive nothing.
    const bobSock = await srv.connectWs(bob.rawSessionId);
    const r = await api(srv, "/api/invites", {
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(200);

    bobSock.send({ type: "ping" });
    await bobSock.waitFor("pong");
    expect(countType(bobSock, "invites_list")).toBe(0);
  });
});

describe("routes/invites REST: mutation fan-out (recipient-scoped)", () => {
  it("mint fans out a scoped invites_list: owner full, member own, a 2nd member zero cross rows", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");

    const ownerSock = await srv.connectWs(owner.rawSessionId);
    const aliceSock = await srv.connectWs(alice.rawSessionId);
    const bobSock = await srv.connectWs(bob.rawSessionId);

    // Self-invite by Alice (owner-minted invites are new-user only now); the
    // recipient-scoped fan-out contract under test is unchanged.
    const r = await api(srv, "/api/invites/self", {
      method: "POST",
      rawSessionId: alice.rawSessionId,
    });
    expect(r.status).toBe(200);
    const pa = (r.body as { invite: InviteWire }).invite.tokenPrefix;

    await waitUntil(
      () => hasPrefix(lastInvitesList(ownerSock), pa),
      2000,
      "owner sees the new invite",
    );
    await waitUntil(
      () => hasPrefix(lastInvitesList(aliceSock), pa),
      2000,
      "alice sees her own invite",
    );
    // bob is emitted his OWN (empty) scoped list — never Alice's rows.
    await waitUntil(
      () => lastInvitesList(bobSock) !== null,
      2000,
      "bob receives a scoped invites_list",
    );
    expect(hasPrefix(lastInvitesList(bobSock), pa)).toBe(false);
  });

  // Reviewer1 P2 (eb3354e6 revision): the owner-mint (invites.mint) and
  // self-mint (invites.mintSelf) seams carry SEPARATE explicit emitInvitesList
  // calls in server/isomux-office.ts — the self-mint test above no longer exercises
  // the owner-mint one, so cover it with a genuinely NEW username.
  it("owner mint (new user) fans out a scoped invites_list: owner gets the row, a member gets none", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");

    const ownerSock = await srv.connectWs(owner.rawSessionId);
    const aliceSock = await srv.connectWs(alice.rawSessionId);

    const r = await api(srv, "/api/invites", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { username: "Zed", role: "member" },
    });
    expect(r.status).toBe(200);
    const pz = (r.body as { invite: InviteWire }).invite.tokenPrefix;

    await waitUntil(
      () => hasPrefix(lastInvitesList(ownerSock), pz),
      2000,
      "owner sees the new-user invite",
    );
    // alice is emitted her OWN (empty) scoped list — never Zed's row.
    await waitUntil(
      () => lastInvitesList(aliceSock) !== null,
      2000,
      "alice receives a scoped invites_list",
    );
    expect(hasPrefix(lastInvitesList(aliceSock), pz)).toBe(false);
  });
});

// invites.mintRecovery (task eb3354e6 final revision): owner-only device link
// for an EXISTING user — the escape hatch for a user signed out of every
// device (self-service device links require a live session). Targeted by
// stable userId; name/role derive from the record server-side.
describe("routes/invites REST: mintRecovery (owner recovery for existing users)", () => {
  it("owner mints by userId: bound to the target's name/role, target sees own row, replaces prior link", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const aliceId = getUserByName("Alice")!.id;
    const aliceSock = await srv.connectWs(alice.rawSessionId);

    const r = await api(srv, "/api/invites/recovery", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { userId: aliceId },
    });
    expect(r.status).toBe(200);
    const inv = (r.body as { invite: InviteWire }).invite;
    expect(inv.username).toBe("Alice");
    expect(inv.role).toBe("member");

    // Recipient-scoped fan-out: Alice's socket receives her own row.
    await waitUntil(
      () => hasPrefix(lastInvitesList(aliceSock), inv.tokenPrefix),
      2000,
      "alice sees the recovery link",
    );

    // One outstanding link per user: a second recovery mint replaces the first.
    const r2 = await api(srv, "/api/invites/recovery", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { userId: aliceId },
    });
    expect(r2.status).toBe(200);
    const inv2 = (r2.body as { invite: InviteWire }).invite;
    const listed = invitesOf(
      await api(srv, "/api/invites", { rawSessionId: owner.rawSessionId }),
    ).filter((i) => i.username === "Alice");
    expect(listed.map((i) => i.tokenPrefix)).toEqual([inv2.tokenPrefix]);

    // TTL POLICY LOCK (Reviewer1 third-pass P2): recovery links get the
    // standard 24h owner-issued window — the seam's ttlMsOverride must keep
    // defeating replacePriorForUsername's implicit 1h self-invite branch.
    expect(inv2.expiresAt - inv2.createdAt).toBe(INVITE_TTL_MS);
    expect(INVITE_TTL_MS).toBe(24 * 60 * 60 * 1000);

    // Companion: a SELF-mint stays on the tighter 1h TTL (and replaces the
    // recovery link — one outstanding link per user across both paths).
    const selfR = await api(srv, "/api/invites/self", {
      method: "POST",
      rawSessionId: alice.rawSessionId,
    });
    expect(selfR.status).toBe(200);
    const selfInv = (selfR.body as { invite: InviteWire }).invite;
    expect(selfInv.expiresAt - selfInv.createdAt).toBe(60 * 60 * 1000);
    const listedAfterSelf = invitesOf(
      await api(srv, "/api/invites", { rawSessionId: owner.rawSessionId }),
    ).filter((i) => i.username === "Alice");
    expect(listedAfterSelf.map((i) => i.tokenPrefix)).toEqual([
      selfInv.tokenPrefix,
    ]);
  });

  it("member -> 403; unknown userId -> 404; missing userId -> 400", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const aliceId = getUserByName("Alice")!.id;

    expect(
      (
        await api(srv, "/api/invites/recovery", {
          method: "POST",
          rawSessionId: alice.rawSessionId,
          body: { userId: aliceId },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, "/api/invites/recovery", {
          method: "POST",
          rawSessionId: owner.rawSessionId,
          body: { userId: "no-such-user" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(srv, "/api/invites/recovery", {
          method: "POST",
          rawSessionId: owner.rawSessionId,
          body: {},
        })
      ).status,
    ).toBe(400);
  });
});

describe("routes/invites REST: revoke authz + non-leak", () => {
  it("member: foreign prefix AND nonexistent prefix BOTH 403 with identical body; nothing removed", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");
    const pb = await mintFor(srv, bob.rawSessionId); // Alice does NOT own this

    const foreign = await api(srv, `/api/invites/${pb}`, {
      method: "DELETE",
      rawSessionId: alice.rawSessionId,
    });
    const missing = await api(srv, `/api/invites/deadbeef`, {
      method: "DELETE",
      rawSessionId: alice.rawSessionId,
    });
    expect(foreign.status).toBe(403);
    expect(missing.status).toBe(403);
    // Identical envelope — the foreign case must be indistinguishable from the
    // nonexistent case (no exists-but-hidden leak).
    expect(foreign.body).toEqual(missing.body);

    // Bob's invite survives untouched.
    const ownerList = await api(srv, "/api/invites", {
      rawSessionId: owner.rawSessionId,
    });
    expect(hasPrefix(invitesOf(ownerList), pb)).toBe(true);
  });

  it("member revokes OWN invite: 204; invite_revoked reaches OWNER sockets only; invites_list re-emits scoped", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");
    const pa = await mintFor(srv, alice.rawSessionId);

    const ownerSock = await srv.connectWs(owner.rawSessionId);
    const aliceSock = await srv.connectWs(alice.rawSessionId);
    const bobSock = await srv.connectWs(bob.rawSessionId);

    const r = await api(srv, `/api/invites/${pa}`, {
      method: "DELETE",
      rawSessionId: alice.rawSessionId,
    });
    expect(r.status).toBe(204);

    // Owner gets invite_revoked + a re-scoped invites_list (no longer has pa).
    const revoked = (await ownerSock.waitFor("invite_revoked")) as {
      tokenPrefix?: string;
    };
    expect(revoked.tokenPrefix).toBe(pa);
    await waitUntil(
      () =>
        lastInvitesList(ownerSock) !== null &&
        !hasPrefix(lastInvitesList(ownerSock), pa),
      2000,
      "owner invites_list re-emitted without pa",
    );

    // invite_revoked is OWNERS-ONLY: neither the revoking member nor a 2nd member
    // receives it. ping/pong barrier guarantees ordered delivery already settled.
    aliceSock.send({ type: "ping" });
    await aliceSock.waitFor("pong");
    bobSock.send({ type: "ping" });
    await bobSock.waitFor("pong");
    expect(countType(aliceSock, "invite_revoked")).toBe(0);
    expect(countType(bobSock, "invite_revoked")).toBe(0);
    // Alice's own scoped list re-emit dropped the invite too.
    expect(hasPrefix(lastInvitesList(aliceSock), pa)).toBe(false);
  });

  it("owner revokes any invite (204 + invite_revoked); owner nonexistent prefix -> 404", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const bob = await srv.seedMember("Bob");
    const pb = await mintFor(srv, bob.rawSessionId);

    const ownerSock = await srv.connectWs(owner.rawSessionId);
    const ok = await api(srv, `/api/invites/${pb}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(ok.status).toBe(204);
    const revoked = (await ownerSock.waitFor("invite_revoked")) as {
      tokenPrefix?: string;
    };
    expect(revoked.tokenPrefix).toBe(pb);

    // Owner has full visibility, so an honest 404 on a truly-missing prefix is
    // not a leak (contrast the member uniform-403 above).
    const missing = await api(srv, `/api/invites/deadbeef`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(missing.status).toBe(404);
  });

  it("a demoted ex-owner's CONNECTED socket leaves the owners audience immediately (task edac170a)", async () => {
    // ownerSessions in liveEmitDeps selects owner-broadcast recipients by the
    // CACHED ws.data.session.role. Before the setOnUserRoleChanged refresh
    // hook, a just-demoted ex-owner who stayed connected and SILENT (no
    // inbound message → no per-message revalidateByHash self-heal) received
    // one more owner-only event. This freezes the proactive refresh.
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");
    const pb = await mintFor(srv, bob.rawSessionId);

    // Promote Alice in the record, THEN connect — the socket caches an
    // owner-role session.
    expect(setUserRole("Alice", "owner")).toBe(true);
    const aliceSock = await srv.connectWs(alice.rawSessionId);
    const ownerSock = await srv.connectWs(owner.rawSessionId);

    // Demote while her socket stays connected and idle.
    expect(setUserRole("Alice", "member")).toBe(true);

    // Owner-only fan-out AFTER the demote.
    const ok = await api(srv, `/api/invites/${pb}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(ok.status).toBe(204);
    const revoked = (await ownerSock.waitFor("invite_revoked")) as {
      tokenPrefix?: string;
    };
    expect(revoked.tokenPrefix).toBe(pb);

    // ping/pong barrier: any stale-role delivery would already be buffered.
    aliceSock.send({ type: "ping" });
    await aliceSock.waitFor("pong");
    expect(countType(aliceSock, "invite_revoked")).toBe(0);
  });
});

describe("routes/invites REST: mint validation + officeOwner + mintSelf", () => {
  it("mint: missing username -> 400; bad role -> 400; existing user -> 409 (new-user only)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    await srv.seedMember("Alice");

    expect(
      (
        await api(srv, "/api/invites", {
          method: "POST",
          rawSessionId: owner.rawSessionId,
          body: { role: "member" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(srv, "/api/invites", {
          method: "POST",
          rawSessionId: owner.rawSessionId,
          body: { username: "Zed", role: "king" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(srv, "/api/invites", {
          method: "POST",
          rawSessionId: owner.rawSessionId,
          body: { username: "Alice", role: "member" }, // exists
        })
      ).status,
    ).toBe(409);
    // eb3354e6 revision: invites.mint is NEW-USER only. The retired
    // allowExisting escape hatch is ignored on the wire — still 409.
    expect(
      (
        await api(srv, "/api/invites", {
          method: "POST",
          rawSessionId: owner.rawSessionId,
          body: { username: "Alice", role: "member", allowExisting: true },
        })
      ).status,
    ).toBe(409);
  });

  it("invites.mint is officeOwner-only: a member POST /api/invites -> 403", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const r = await api(srv, "/api/invites", {
      method: "POST",
      rawSessionId: alice.rawSessionId,
      body: { username: "New", role: "member" },
    });
    expect(r.status).toBe(403);
  });

  it("mintSelf: a member mints an own-device invite (200); it lands in their scoped list; replaces the prior one", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");

    const first = await api(srv, "/api/invites/self", {
      method: "POST",
      rawSessionId: alice.rawSessionId,
    });
    expect(first.status).toBe(200);
    const p1 = (first.body as { invite: InviteWire }).invite;
    expect(p1.username).toBe("Alice");
    expect(p1.role).toBe("member");

    const listed = await api(srv, "/api/invites", {
      rawSessionId: alice.rawSessionId,
    });
    expect(hasPrefix(invitesOf(listed), p1.tokenPrefix)).toBe(true);

    // replacePriorForUsername: a second self-mint supersedes the first.
    const second = await api(srv, "/api/invites/self", {
      method: "POST",
      rawSessionId: alice.rawSessionId,
    });
    expect(second.status).toBe(200);
    const p2 = (second.body as { invite: InviteWire }).invite.tokenPrefix;
    const after = await api(srv, "/api/invites", {
      rawSessionId: alice.rawSessionId,
    });
    expect(hasPrefix(invitesOf(after), p2)).toBe(true);
    expect(hasPrefix(invitesOf(after), p1.tokenPrefix)).toBe(false);
  });
});

describe("routes/invites REST: record-role projection (Option A) + scope/auth", () => {
  it("a member promoted in the RECORD (no reconnect) projects + revokes as an owner", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");
    const pb = await mintFor(srv, bob.rawSessionId);

    // Promote Alice in the user record; her existing session.role stays "member".
    expect(setUserRole("Alice", "owner")).toBe(true);

    // Record-role projection: she now sees ALL invites (including Bob's).
    const list = await api(srv, "/api/invites", {
      rawSessionId: alice.rawSessionId,
    });
    expect(hasPrefix(invitesOf(list), pb)).toBe(true);

    // Record-role revoke: she may now revoke an invite that isn't hers.
    const r = await api(srv, `/api/invites/${pb}`, {
      method: "DELETE",
      rawSessionId: alice.rawSessionId,
    });
    expect(r.status).toBe(204);
    const ownerList = await api(srv, "/api/invites", {
      rawSessionId: owner.rawSessionId,
    });
    expect(hasPrefix(invitesOf(ownerList), pb)).toBe(false);
  });

  it("AGENT bearer -> 403 on every invites route; no identity -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id);
    if (!token) throw new Error("agent token not minted on spawn");

    // AGENT scope lacks invite:manage -> stage-1 capability 403 on all four.
    expect(
      (
        await api(srv, "/api/invites", {
          method: "POST",
          bearer: token,
          body: { username: "X", role: "member" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await api(srv, "/api/invites/self", { method: "POST", bearer: token }))
        .status,
    ).toBe(403);
    expect((await api(srv, "/api/invites", { bearer: token })).status).toBe(
      403,
    );
    expect(
      (await api(srv, "/api/invites/x", { method: "DELETE", bearer: token }))
        .status,
    ).toBe(403);

    // No identity (no cookie, no bearer) -> 401 (allowLoopback:false on /api).
    expect((await api(srv, "/api/invites")).status).toBe(401);
    expect(
      (await api(srv, "/api/invites", { method: "POST", body: {} })).status,
    ).toBe(401);
    expect(
      (await api(srv, "/api/invites/x", { method: "DELETE" })).status,
    ).toBe(401);
  });
});

describe("routes/invites REST: room grants (pre-assigned rooms on member invites)", () => {
  it("mint with allowedRooms -> 200 + wire carries them; accept seeds the NEW member's allowedRooms + notifRooms", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id; // default "Room 1"
    const roomB = srv.agentManager.createRoom("Grants B");

    const r = await api(srv, "/api/invites", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { username: "Yu", role: "member", allowedRooms: [roomA, roomB] },
    });
    expect(r.status).toBe(200);
    const body = r.body as { url: string; invite: InviteWire };
    expect(body.invite.allowedRooms).toEqual([roomA, roomB]);

    // The owner's list projection carries the grants too.
    const list = await api(srv, "/api/invites", {
      rawSessionId: owner.rawSessionId,
    });
    const row = invitesOf(list).find(
      (i) => i.tokenPrefix === body.invite.tokenPrefix,
    );
    expect(row?.allowedRooms).toEqual([roomA, roomB]);

    // Accept creates the member record seeded with the grants; claimUser
    // seeds notifRooms from allowedRooms, so the invitee lands in the
    // intended rooms with notifications on — not an empty office.
    const rawToken = body.url.split("/i/")[1];
    const acc = await acceptInvite(rawToken, { userAgent: null });
    if (!acc.ok) throw new Error(`accept failed: ${acc.error}`);
    const u = getUserByName("Yu");
    expect(u?.role).toBe("member");
    expect(u?.allowedRooms).toEqual([roomA, roomB]);
    expect(u?.notifRooms).toEqual([roomA, roomB]);
  });

  it("mint refuses grants for: unknown room id / owner role / existing user (all 400); grant-less mint carries no field", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    await srv.seedMember("Alice");
    const roomA = srv.agentManager.getRooms()[0].id;

    const unknown = await api(srv, "/api/invites", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { username: "Yu", role: "member", allowedRooms: ["nope"] },
    });
    expect(unknown.status).toBe(400);

    const ownerRole = await api(srv, "/api/invites", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { username: "Yu", role: "owner", allowedRooms: [roomA] },
    });
    expect(ownerRole.status).toBe(400);

    // eb3354e6 revision: an existing user is rejected up-front (USER_EXISTS
    // -> 409) regardless of grants — the grants check is unreachable for
    // existing names now that invites.mint is new-user only.
    const existing = await api(srv, "/api/invites", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {
        username: "Alice",
        role: "member",
        allowedRooms: [roomA],
      },
    });
    expect(existing.status).toBe(409);

    // Same with a mismatched role: USER_EXISTS wins (it precedes the role
    // comparison in the core), still 409.
    const mismatchWithGrants = await api(srv, "/api/invites", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {
        username: "Alice",
        role: "owner",
        allowedRooms: [roomA],
      },
    });
    expect(mismatchWithGrants.status).toBe(409);

    // Bad shape (non-string entries) is rejected at the handler.
    const badShape = await api(srv, "/api/invites", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { username: "Yu", role: "member", allowedRooms: [42] },
    });
    expect(badShape.status).toBe(400);

    // A grant-less mint never grows the field (legacy wire shape preserved).
    const plain = await api(srv, "/api/invites", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { username: "Yu", role: "member" },
    });
    expect(plain.status).toBe(200);
    expect(
      (plain.body as { invite: InviteWire }).invite.allowedRooms,
    ).toBeUndefined();
  });

  it("a room deleted between mint and accept is pruned from the seeded grants", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Doomed");

    const r = await api(srv, "/api/invites", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { username: "Yu", role: "member", allowedRooms: [roomA, roomB] },
    });
    expect(r.status).toBe(200);
    const body = r.body as { url: string; invite: InviteWire };

    // Close the granted room before the invitee clicks (closeRoom is
    // empty-only; the fresh room has no agents).
    expect(srv.agentManager.closeRoom(roomB)).toBe(true);

    const rawToken = body.url.split("/i/")[1];
    const acc = await acceptInvite(rawToken, { userAgent: null });
    if (!acc.ok) throw new Error(`accept failed: ${acc.error}`);
    const u = getUserByName("Yu");
    expect(u?.allowedRooms).toEqual([roomA]);
    expect(u?.notifRooms).toEqual([roomA]);
  });
});
