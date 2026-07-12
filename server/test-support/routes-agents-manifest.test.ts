// GET /agents — the agent-discovery manifest endpoint.
//
// Agents used to discover each other by reading ~/.isomux/agents-summary.json
// directly; the endpoint serves the same manifest over HTTP so agent system
// prompts can point at a `curl` recipe instead of a file read. The file keeps
// being written alongside for existing file-based readers and remains the
// full-manifest source; the endpoint always answers with an identity-scoped
// view.
//
// Auth posture (Nil-specced, round 3): identity REQUIRED — bearer token or
// login cookie. GET /agents is deliberately OFF the loopback-trust list, so an
// anonymous request 401s even from loopback (unlike /tasks and /cronjobs,
// whose loopback reads are a separately-tracked legacy posture). Non-GET on
// the exact path and the /agents/<id> action surface 401 as before.
//
// Visibility: the manifest is PROJECTED to the rooms the identity's user can
// access — owner: every room by rule; member: allowedRooms grants; agent /
// cron-run: the manager's/creator's access. Endpoint/file body parity
// therefore holds exactly on full-access views (any owner identity), which is
// what the parity test pins; scoped views are same-shape subsets.
//
// Browser-read hardening (also pinned here): an authenticated request carrying
// a cross-origin Origin header is rejected with 403, and NO
// Access-Control-Allow-Origin is ever sent, so a hostile web page open on the
// server's machine can neither receive nor read the manifest. Origin-less
// agent curl (with bearer) keeps working.
//
// Seam: startTestServer().http() + direct fetch for Origin control. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

// Spawn directly via the core (transport-agnostic setup), at an explicit desk.
async function spawnAt(
  srv: TestServer,
  name: string,
  roomId: string,
  desk: number,
) {
  const a = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    desk,
    undefined,
    roomId,
  );
  if (!a) throw new Error(`spawn failed: ${name}`);
  return a;
}

// Spawn an agent MANAGED BY a specific user (username + resolved userId), so
// its bearer token carries that user's room access for the projection tests.
async function spawnOwnedBy(
  srv: TestServer,
  name: string,
  roomId: string,
  desk: number,
  username: string,
) {
  const user = getUserByName(username);
  if (!user) throw new Error(`unknown user: ${username}`);
  const a = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    desk,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    username,
    "claude",
    undefined,
    user.id,
  );
  if (!a) throw new Error(`spawn failed: ${name}`);
  return a;
}

// Owner sets a member's room grants via the real REST users.setAccess route.
async function setAccess(
  srv: TestServer,
  ownerRawSessionId: string,
  username: string,
  roomIds: string[],
): Promise<void> {
  const res = await srv.http(
    `/api/users/${encodeURIComponent(username)}/access`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRooms: roomIds }),
      rawSessionId: ownerRawSessionId,
    },
  );
  if (res.status >= 400) {
    throw new Error(`setAccess ${username} -> ${res.status}`);
  }
}

function bearerFor(agentId: string): string {
  const token = getAgentTokenRaw(agentId);
  if (!token) throw new Error(`agent token not minted: ${agentId}`);
  return token;
}

async function manifestNames(res: Response): Promise<string[]> {
  const body = (await res.json()) as Array<{ name: string }>;
  return body.map((e) => e.name).sort();
}

function manifestOnDisk(srv: TestServer): unknown {
  return JSON.parse(
    readFileSync(join(srv.stateRoot, "agents-summary.json"), "utf-8"),
  );
}

describe("GET /agents (discovery manifest)", () => {
  it("owner-agent bearer gets the full manifest, matching the file on disk", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const rooms = srv.agentManager.getRooms();
    const r1 = rooms[0].id;
    const r2 = srv.agentManager.createRoom("Second Room");
    const a = await spawnOwnedBy(srv, "Alpha", r1, 0, owner.username);
    const b = await spawnOwnedBy(srv, "Beta", r2, 1, owner.username);

    // Origin-less bearer request, exactly what agent curl sends.
    const res = await fetch(`${srv.baseUrl}/agents`, {
      headers: { Authorization: `Bearer ${bearerFor(a.id)}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    // Never CORS-readable, not even wildcard (see file header).
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res.json()) as Array<Record<string, unknown>>;

    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);

    const alpha = body.find((e) => e.id === a.id);
    const beta = body.find((e) => e.id === b.id);
    if (!alpha || !beta) throw new Error("spawned agents missing from body");

    // Entry shape (the agents-summary.json contract).
    expect(alpha).toEqual({
      id: a.id,
      name: "Alpha",
      desk: 0,
      room: 1, // 1-based for human readability
      roomName: rooms[0].name,
      roomId: r1, // stable id, usable for memory scopeIds / room routes
      topic: null,
      cwd: srv.stateRoot,
      modelFamily: alpha.modelFamily,
      model: alpha.model,
      username: owner.username,
      logDir: join(srv.stateRoot, "logs", a.id),
    });
    expect(beta.room).toBe(2);
    expect(beta.roomName).toBe("Second Room");
    expect(beta.roomId).toBe(r2);
    expect(beta.desk).toBe(1);

    // Parity on the full-access view: the endpoint and the still-written file
    // must not drift (both come from persistence.buildManifest).
    expect(body).toEqual(manifestOnDisk(srv) as typeof body);
  });

  it("reflects live changes (kill) without waiting on file readers", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const a = await spawnOwnedBy(srv, "Alpha", r1, 0, owner.username);
    const b = await spawnOwnedBy(srv, "Beta", r1, 1, owner.username);

    await srv.agentManager.kill(a.id);

    const res = await fetch(`${srv.baseUrl}/agents`, {
      headers: { Authorization: `Bearer ${bearerFor(b.id)}` },
    });
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.map((e) => e.name)).toEqual(["Beta"]);
    expect(body).toEqual(manifestOnDisk(srv) as typeof body);
  });

  it("anonymous request -> 401, even from loopback", async () => {
    const srv = await startTestServer();
    server = srv;
    const r1 = srv.agentManager.getRooms()[0].id;
    await spawnAt(srv, "Alpha", r1, 0);

    // No bearer, no cookie — the harness IS a loopback peer, so this pins
    // that /agents is off the loopback-trust list (unlike /tasks).
    const res = await fetch(`${srv.baseUrl}/agents`, {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("authenticated but cross-origin Origin -> 403 with no CORS header (hostile web page)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const r1 = srv.agentManager.getRooms()[0].id;
    const a = await spawnOwnedBy(srv, "Alpha", r1, 0, owner.username);

    // A cross-origin Origin on an otherwise-valid request must be rejected
    // AND unreadable (no ACAO on any response). Anonymous hostile pages die
    // earlier at the 401 wall (previous test).
    const res = await fetch(`${srv.baseUrl}/agents`, {
      headers: {
        Origin: "https://evil.example",
        Authorization: `Bearer ${bearerFor(a.id)}`,
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("bad origin");
  });

  it("non-GET on /agents -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const res = await srv.http("/agents", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("GET /agents projection (room ACL)", () => {
  it("bearer identities are projected to their user's rooms", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mem");
    const r1 = srv.agentManager.getRooms()[0].id;
    const r2 = srv.agentManager.createRoom("Members Only");
    await setAccess(srv, owner.rawSessionId, member.username, [r2]);

    const ownerAgent = await spawnOwnedBy(
      srv,
      "OwnerAgent",
      r1,
      0,
      owner.username,
    );
    const memberAgent = await spawnOwnedBy(
      srv,
      "MemberAgent",
      r2,
      1,
      member.username,
    );

    // Member-managed agent's bearer -> only the member's granted room (r2).
    const asMember = await fetch(`${srv.baseUrl}/agents`, {
      headers: { Authorization: `Bearer ${bearerFor(memberAgent.id)}` },
    });
    expect(asMember.status).toBe(200);
    const memberView = (await asMember.json()) as Array<{
      name: string;
      roomId: string;
    }>;
    expect(memberView.map((e) => e.name)).toEqual(["MemberAgent"]);
    expect(memberView.every((e) => e.roomId === r2)).toBe(true);

    // Owner-managed agent's bearer -> every room by rule.
    const asOwner = await fetch(`${srv.baseUrl}/agents`, {
      headers: { Authorization: `Bearer ${bearerFor(ownerAgent.id)}` },
    });
    expect(asOwner.status).toBe(200);
    expect(await manifestNames(asOwner)).toEqual(["MemberAgent", "OwnerAgent"]);
  });

  it("cookie identities are projected the same way (member sees only granted rooms, owner sees all)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mem");
    const r1 = srv.agentManager.getRooms()[0].id;
    const r2 = srv.agentManager.createRoom("Members Only");
    await setAccess(srv, owner.rawSessionId, member.username, [r2]);
    await spawnOwnedBy(srv, "OwnerAgent", r1, 0, owner.username);
    await spawnOwnedBy(srv, "MemberAgent", r2, 1, member.username);

    // srv.http attaches the server's own Origin — the same-origin path —
    // plus the session cookie. With /agents off the loopback-trust list, the
    // cookie now resolves to a USER identity and projects.
    const asMember = await srv.http("/agents", {
      rawSessionId: member.rawSessionId,
    });
    expect(asMember.status).toBe(200);
    expect(await manifestNames(asMember)).toEqual(["MemberAgent"]);

    const asOwner = await srv.http("/agents", {
      rawSessionId: owner.rawSessionId,
    });
    expect(asOwner.status).toBe(200);
    expect(await manifestNames(asOwner)).toEqual(["MemberAgent", "OwnerAgent"]);
  });
});
