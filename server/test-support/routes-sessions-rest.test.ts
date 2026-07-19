// Phase 3a slice 3a.4b — Sessions on the unified REST surface
// (opIds sessions.{list,revoke,logout}).
//
// Mirrors the 3a.4a invites net. What this freezes:
//   - Recipient-scoped projection: GET /api/sessions → owner all, member own;
//     the DIRECT list read NEVER fans out to other sockets.
//   - Revoke double-signal: owner revokes a member → owner gets session_revoked
//     (OWNERS-ONLY) + a re-scoped sessions_active_list; a 2nd member sees zero
//     cross-user rows and no session_revoked. The TARGET gets session_expired +
//     socket close through the force-expire BRIDGE (auth core), not liveEmit.
//   - Non-leak revoke authz (sessionOwnerOrSelf): member foreign AND nonexistent
//     prefix BOTH 403, identical body — paired with a positive control (the same
//     member revoking their OWN session succeeds).
//   - Last-owner lockout (notLastOwnerLockout): sole-owner revoke-self AND
//     logout-as-sole-owner BOTH 409 — each paired with a positive control (a 2nd
//     owner session makes the same op 204).
//   - Logout fails CLOSED for a bearer (no cookie session) — 403, never a no-op.
//   - ROLE SOURCE = record (Option A): a member promoted in the record (no
//     reconnect) lists + revokes as an owner.
//   - AGENT bearer → 403 (list/revoke missing session:manage; logout missing
//     caller session hash); no identity → 401.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { mintInvite, acceptInvite } from "../auth.ts";
import { setUserRole } from "../users.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import type { AgentInfo, SessionWire } from "../../shared/types.ts";

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

// Add a SECOND owner user (distinct name) with an active session — the positive
// control for last-owner lockout. Returns its cookie.
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

function sessionsOf(r: Res): SessionWire[] {
  return (r.body as { sessions: SessionWire[] }).sessions;
}
// The session prefix bound to `username` (each test seeds one session per name,
// except the deliberately-added 2nd owner which uses a distinct name).
async function prefixFor(
  srv: TestServer,
  viewerSession: string,
  username: string,
): Promise<string> {
  const r = await api(srv, "/api/sessions", { rawSessionId: viewerSession });
  const mine = sessionsOf(r).find((s) => s.username === username);
  if (!mine) throw new Error(`no session for ${username}`);
  return mine.sessionPrefix;
}
function lastSessionsList(sock: TestSocket): SessionWire[] | null {
  for (let i = sock.messages.length - 1; i >= 0; i--) {
    const m = sock.messages[i] as { type?: string; sessions?: SessionWire[] };
    if (m.type === "sessions_active_list") return m.sessions ?? [];
  }
  return null;
}
function hasPrefix(list: SessionWire[] | null, prefix: string): boolean {
  return !!list && list.some((s) => s.sessionPrefix === prefix);
}
function countType(sock: TestSocket, type: string): number {
  return sock.messages.filter((m) => (m as { type?: string }).type === type)
    .length;
}

describe("routes/sessions REST: direct list scoping (no fan-out on reads)", () => {
  it("owner sees all, member sees only own; a list READ does not emit to other sockets", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");

    const ownerList = await api(srv, "/api/sessions", {
      rawSessionId: owner.rawSessionId,
    });
    expect(ownerList.status).toBe(200);
    const names = sessionsOf(ownerList).map((s) => s.username);
    expect(names).toContain("Boss");
    expect(names).toContain("Alice");
    expect(names).toContain("Bob");

    const aliceList = await api(srv, "/api/sessions", {
      rawSessionId: alice.rawSessionId,
    });
    expect(sessionsOf(aliceList).every((s) => s.username === "Alice")).toBe(
      true,
    );

    // No fan-out: bob connects, owner READs, bob must receive nothing.
    const bobSock = await srv.connectWs(bob.rawSessionId);
    await api(srv, "/api/sessions", { rawSessionId: owner.rawSessionId });
    bobSock.send({ type: "ping" });
    await bobSock.waitFor("pong");
    expect(countType(bobSock, "sessions_active_list")).toBe(0);
  });
});

describe("routes/sessions REST: revoke double-signal + bridge", () => {
  it("owner revokes a member session: member session_expired + close; owner session_revoked + re-scoped list; 2nd member zero cross rows", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");
    const alicePrefix = await prefixFor(srv, owner.rawSessionId, "Alice");

    const ownerSock = await srv.connectWs(owner.rawSessionId);
    const aliceSock = await srv.connectWs(alice.rawSessionId);
    const bobSock = await srv.connectWs(bob.rawSessionId);

    const r = await api(srv, `/api/sessions/${alicePrefix}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(r.status).toBe(204);

    // BRIDGE: the target gets session_expired then its socket closes (force-
    // expire in the auth core, NOT liveEmit).
    await aliceSock.waitFor("session_expired");
    await waitUntil(
      () => aliceSock.raw.readyState >= 2,
      2000,
      "alice socket closed by the bridge",
    );

    // Owner gets session_revoked + a re-scoped sessions_active_list (drops alice).
    const revoked = (await ownerSock.waitFor("session_revoked")) as {
      sessionPrefix?: string;
    };
    expect(revoked.sessionPrefix).toBe(alicePrefix);
    await waitUntil(
      () =>
        lastSessionsList(ownerSock) !== null &&
        !hasPrefix(lastSessionsList(ownerSock), alicePrefix),
      2000,
      "owner list re-emitted without alice",
    );

    // 2nd member: no session_revoked (owners-only), and his scoped list never
    // carried alice's row.
    bobSock.send({ type: "ping" });
    await bobSock.waitFor("pong");
    expect(countType(bobSock, "session_revoked")).toBe(0);
    expect(hasPrefix(lastSessionsList(bobSock), alicePrefix)).toBe(false);
  });

  it("member revokes own session: 204 + session_expired to self (bridge)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const alicePrefix = await prefixFor(srv, alice.rawSessionId, "Alice");

    const aliceSock = await srv.connectWs(alice.rawSessionId);
    const r = await api(srv, `/api/sessions/${alicePrefix}`, {
      method: "DELETE",
      rawSessionId: alice.rawSessionId,
    });
    expect(r.status).toBe(204);
    await aliceSock.waitFor("session_expired");
    await waitUntil(() => aliceSock.raw.readyState >= 2, 2000, "self closed");
  });
});

describe("routes/sessions REST: revoke non-leak (+ positive control)", () => {
  it("member foreign AND nonexistent prefix both 403 identical body; own revoke succeeds", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    await srv.seedMember("Bob");
    const bobPrefix = await prefixFor(srv, owner.rawSessionId, "Bob");
    const alicePrefix = await prefixFor(srv, owner.rawSessionId, "Alice");

    const foreign = await api(srv, `/api/sessions/${bobPrefix}`, {
      method: "DELETE",
      rawSessionId: alice.rawSessionId,
    });
    const missing = await api(srv, `/api/sessions/deadbeef`, {
      method: "DELETE",
      rawSessionId: alice.rawSessionId,
    });
    expect(foreign.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(foreign.body).toEqual(missing.body); // no exists-but-hidden leak

    // Bob's session survives.
    expect(
      sessionsOf(
        await api(srv, "/api/sessions", { rawSessionId: owner.rawSessionId }),
      ).some((s) => s.sessionPrefix === bobPrefix),
    ).toBe(true);

    // POSITIVE CONTROL: the same member CAN revoke their OWN session — proves the
    // 403s above are the scope check, not a blanket failure.
    const own = await api(srv, `/api/sessions/${alicePrefix}`, {
      method: "DELETE",
      rawSessionId: alice.rawSessionId,
    });
    expect(own.status).toBe(204);
  });
});

describe("routes/sessions REST: last-owner lockout (+ positive controls)", () => {
  it("sole-owner revoke-self -> 409; with a 2nd owner session -> 204", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const bossPrefix = await prefixFor(srv, owner.rawSessionId, "Boss");

    // Sole owner session: revoking it would strand the office.
    const blocked = await api(srv, `/api/sessions/${bossPrefix}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(blocked.status).toBe(409);
    expect((blocked.body as { error?: { code?: string } }).error?.code).toBe(
      "would_strand_office",
    );

    // POSITIVE CONTROL: add a 2nd owner session → the same revoke now succeeds.
    await addOwner("Boss2");
    const ok = await api(srv, `/api/sessions/${bossPrefix}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(ok.status).toBe(204);
  });

  it("logout as sole owner -> 409; with a 2nd owner session -> 204", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");

    const blocked = await api(srv, "/api/sessions/current", {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(blocked.status).toBe(409);
    expect((blocked.body as { error?: { code?: string } }).error?.code).toBe(
      "would_strand_office",
    );

    await addOwner("Boss2");
    const ok = await api(srv, "/api/sessions/current", {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(ok.status).toBe(204);
  });

  it("member logout succeeds (204) and expires the caller's own socket (bridge)", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const aliceSock = await srv.connectWs(alice.rawSessionId);

    const r = await api(srv, "/api/sessions/current", {
      method: "DELETE",
      rawSessionId: alice.rawSessionId,
    });
    expect(r.status).toBe(204);
    await aliceSock.waitFor("session_expired");
    await waitUntil(() => aliceSock.raw.readyState >= 2, 2000, "self closed");
  });
});

describe("routes/sessions REST: record-role projection (Option A) + scope/auth", () => {
  it("a member promoted in the RECORD (no reconnect) lists + revokes as an owner", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    await srv.seedMember("Bob");
    const bobPrefix = await prefixFor(srv, owner.rawSessionId, "Bob");

    // Promote Alice in the record; her session.role stays "member".
    expect(setUserRole("Alice", "owner")).toBe(true);

    // Record-role projection: Alice now sees ALL sessions.
    const list = await api(srv, "/api/sessions", {
      rawSessionId: alice.rawSessionId,
    });
    expect(sessionsOf(list).some((s) => s.username === "Bob")).toBe(true);

    // Record-role revoke: Alice (now owner) may revoke Bob's session. Boss is
    // still an owner session, so no lockout interferes.
    const r = await api(srv, `/api/sessions/${bobPrefix}`, {
      method: "DELETE",
      rawSessionId: alice.rawSessionId,
    });
    expect(r.status).toBe(204);
  });

  it("AGENT bearer -> 403 (list/revoke missing session:manage, logout missing session); no identity -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id);
    if (!token) throw new Error("agent token not minted on spawn");

    expect((await api(srv, "/api/sessions", { bearer: token })).status).toBe(
      403,
    );
    expect(
      (await api(srv, "/api/sessions/x", { method: "DELETE", bearer: token }))
        .status,
    ).toBe(403);
    // logout: authenticated bearer passes stage 1, but no caller session hash →
    // fail closed (403), NOT a 204 no-op.
    expect(
      (
        await api(srv, "/api/sessions/current", {
          method: "DELETE",
          bearer: token,
        })
      ).status,
    ).toBe(403);

    // No identity at all → 401.
    expect((await api(srv, "/api/sessions")).status).toBe(401);
    expect(
      (await api(srv, "/api/sessions/current", { method: "DELETE" })).status,
    ).toBe(401);
  });
});

// Task 557dc8ce — device label on the session wire. The client's
// presence_update device label (the one name-tags show) is stamped onto the
// backing auth session (last non-null wins) and surfaced read-only as
// SessionWire.device, so the Sessions pane can say WHICH device a session is.
describe("routes/sessions REST: device label stamp (task 557dc8ce)", () => {
  it("presence_update stamps device onto the session; unnamed updates never erase it", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("presence_list");

    const listDevice = async (): Promise<string | null | undefined> => {
      const r = await api(server!, "/api/sessions", {
        rawSessionId: owner.rawSessionId,
      });
      return (r.body as { sessions: SessionWire[] }).sessions[0]?.device;
    };
    // Before any named presence_update: null (legacy/unnamed sessions).
    expect(await listDevice()).toBe(null);

    sock.send({
      type: "presence_update",
      currentRoomId: null,
      focusedAgentId: null,
      viewMode: "away",
      device: "Phone",
    });
    {
      // waitUntil takes a sync predicate; poll the async read explicitly.
      const deadline = Date.now() + 2000;
      while ((await listDevice()) !== "Phone") {
        if (Date.now() > deadline) throw new Error("device stamp timed out");
        await sleep(10);
      }
    }

    // A later update WITHOUT a device label (tab that hasn't named itself)
    // must not erase the learned label.
    sock.send({
      type: "presence_update",
      currentRoomId: null,
      focusedAgentId: null,
      viewMode: "away",
    });
    await sleep(50);
    expect(await listDevice()).toBe("Phone");

    // The stamp fans out a fresh scoped sessions_active_list carrying it.
    await waitUntil(
      () =>
        (sock.messages as Record<string, unknown>[]).some(
          (m) =>
            m.type === "sessions_active_list" &&
            (m.sessions as SessionWire[]).some((s) => s.device === "Phone"),
        ),
      2000,
      "sessions_active_list fanout",
    );
  });
});
