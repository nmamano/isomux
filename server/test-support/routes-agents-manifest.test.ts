// GET /agents - the agent-discovery manifest endpoint.
//
// Agents used to discover each other by reading ~/.isomux/agents-summary.json
// directly; the endpoint serves the same manifest over HTTP so agent system
// prompts can point at a `curl` recipe instead of a file read. The file keeps
// being written alongside for existing file-based readers and remains the
// full-manifest source; the endpoint always answers with an identity-scoped
// view.
//
// Auth posture (Nil-specced, round 3): identity REQUIRED - bearer token or
// login cookie. There is no loopback trust on any path, so an anonymous
// request 401s even from loopback. An authenticated non-GET on /agents or
// under it is a JSON 404, so a stale caller is not handed the SPA shell.
//
// Visibility: the manifest is PROJECTED to the rooms the identity's user can
// access - owner: every room by rule; member: allowedRooms grants; agent /
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw, mintRunToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { DEFAULT_EFFORT, type EffortLevel } from "../../shared/types.ts";
import { isBackSeat } from "../../shared/desks.ts";

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
  desk: number | null,
  username: string,
  effort?: EffortLevel,
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
    effort,
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await sleep(5);
  }
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

// The endpoint's documented difference from the file: it carries the agent's
// LIVE pendingPrompt and inFlightTurn, while the file has neither. These tests
// have no parked/running agents, so both live values are null everywhere.
function withLiveFields(onDisk: unknown): unknown {
  return (onDisk as Record<string, unknown>[]).map((e) => ({
    ...e,
    pendingPrompt: null,
    inFlightTurn: null,
  }));
}

describe("GET /agents (discovery manifest)", () => {
  it("reports the live turn and oldest active-tool time without disclosing its name or persisting it", async () => {
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({ session: { onSend() {} } }),
    });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const room = srv.agentManager.getRooms()[0].id;
    const agent = await spawnOwnedBy(srv, "Alpha", room, 0, owner.username);
    const send = await srv.http(`/api/agents/${agent.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "start" }),
      rawSessionId: owner.rawSessionId,
    });
    expect(send.status).toBe(200);
    const session = srv.fakeBackend.sessionForAgent(agent.id)!;
    await waitUntil(() => session.sent.length === 1);
    session.push({
      kind: "tool_call",
      toolUseId: "old",
      name: "Bash",
      input: {},
    });
    await sleep(5);
    session.push({
      kind: "tool_call",
      toolUseId: "new",
      name: "Read",
      input: {},
    });
    await waitUntil(
      () =>
        srv.agentManager.inFlightTurnForLogs(agent.id)?.activeTool?.name ===
        "Bash",
    );

    const res = await fetch(`${srv.baseUrl}/agents`, {
      headers: { Authorization: `Bearer ${bearerFor(agent.id)}` },
    });
    const body = (await res.json()) as Array<Record<string, unknown>>;
    const live = body.find((entry) => entry.id === agent.id)?.inFlightTurn as {
      startedAt: number;
      activeTool: { startedAt: number };
    };
    expect(live.startedAt).toBeGreaterThan(0);
    expect(live.activeTool.startedAt).toBeGreaterThanOrEqual(live.startedAt);
    expect(live.activeTool).not.toHaveProperty("name");
    expect(
      (manifestOnDisk(srv) as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty("inFlightTurn");
  });

  it("owner-agent bearer gets the full manifest, matching the file on disk", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
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
      effort: DEFAULT_EFFORT,
      permissionMode: "default",
      sandbox: null,
      // `manager` is the field; `username` is its alias for older readers
      // until the alias task removes it (task f41c93e9).
      manager: owner.username,
      username: owner.username,
      logDir: join(srv.stateRoot, "logs", a.id),
      // Live parked-prompt state (task 29daebe2). Null for an agent that is
      // not waiting on a prompt.
      pendingPrompt: null,
      inFlightTurn: null,
    });
    expect(beta.room).toBe(2);
    expect(beta.roomName).toBe("Second Room");
    expect(beta.roomId).toBe(r2);
    expect(beta.desk).toBe(1);

    // Parity on the full-access view: the endpoint and the still-written file
    // must not drift (both come from persistence.buildManifest) - EXCEPT for
    // pendingPrompt, which the endpoint adds and the file deliberately omits.
    // It is live state, and a snapshot written when an agent parked would keep
    // claiming a prompt long after it was answered, which is the exact
    // confusion task 29daebe2 exists to remove.
    expect(body).toEqual(withLiveFields(manifestOnDisk(srv)) as typeof body);
  });

  // Task cf666d6d: effort is settable over PATCH /api/agents/<id> but used to
  // be write-only - no way to read the current value back, so a manager could
  // only blind-write. Pinned with a non-default value so a hardcoded constant
  // can't pass.
  it("reports each agent's own effort", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r1 = srv.agentManager.getRooms()[0].id;
    const a = await spawnOwnedBy(srv, "Alpha", r1, 0, owner.username, "low");
    const b = await spawnOwnedBy(srv, "Beta", r1, 1, owner.username);

    const res = await fetch(`${srv.baseUrl}/agents`, {
      headers: { Authorization: `Bearer ${bearerFor(a.id)}` },
    });
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.find((e) => e.id === a.id)?.effort).toBe("low");
    expect(body.find((e) => e.id === b.id)?.effort).toBe(DEFAULT_EFFORT);
    expect(body).toEqual(withLiveFields(manifestOnDisk(srv)) as typeof body);
  });

  it("authenticated but cross-origin Origin -> 403 with no CORS header (hostile web page)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
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
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("bad_origin");
  });

  it("an authenticated non-GET on /agents or under it -> JSON 404 with no CORS grant, never the SPA shell", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    for (const [method, path] of [
      ["POST", "/agents"],
      ["DELETE", "/agents"],
      ["POST", "/agents/some-agent/read-file"],
      ["PUT", "/agents/some-agent"],
    ] as const) {
      const res = await srv.http(path, {
        method,
        rawSessionId: owner.rawSessionId,
      });
      expect({
        method,
        path,
        status: res.status,
        type: res.headers.get("content-type"),
        cors: res.headers.get("access-control-allow-origin"),
      }).toEqual({
        method,
        path,
        status: 404,
        type: "application/json",
        cors: null,
      });
    }
  });
});

describe("GET /agents projection (room ACL)", () => {
  it("gives context and subscription checks the same room reach as logs", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mem");
    const r1 = srv.agentManager.getRooms()[0].id;
    const r2 = srv.agentManager.createRoom("Members Only");
    await setAccess(srv, owner.rawSessionId, member.username, [r2]);
    const hidden = await spawnOwnedBy(srv, "Hidden", r1, 0, owner.username);
    const visible = await spawnOwnedBy(srv, "Visible", r2, 1, owner.username);
    const caller = await spawnOwnedBy(srv, "Caller", r2, 2, member.username);
    const headers = { Authorization: `Bearer ${bearerFor(caller.id)}` };

    for (const suffix of ["context", "subscription"] as const) {
      expect(
        (await srv.http(`/api/agents/${visible.id}/${suffix}`, { headers }))
          .status,
      ).toBe(200);
      expect(
        (await srv.http(`/api/agents/${hidden.id}/${suffix}`, { headers }))
          .status,
      ).toBe(403);
    }
  });

  it("cookie identities are projected the same way (member sees only granted rooms, owner sees all)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mem");
    const r1 = srv.agentManager.getRooms()[0].id;
    const r2 = srv.agentManager.createRoom("Members Only");
    await setAccess(srv, owner.rawSessionId, member.username, [r2]);
    await spawnOwnedBy(srv, "OwnerAgent", r1, 0, owner.username);
    await spawnOwnedBy(srv, "MemberAgent", r2, 1, member.username);

    // srv.http attaches the server's own Origin - the same-origin path -
    // plus the session cookie. With no loopback trust anywhere, the
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

// GET /agents?killed=1 - the other roster (task 18fded2c). It exists so the
// killed-agent log reach shipped in ffb90761 is usable: an agent could read a
// dead agent's transcripts but had no way to learn its id.
//
// SCOPED LIKE THE LOG GUARD, deliberately NOT like the live manifest above: the
// killed agent's own manager plus office owners, never "anyone who shares its last
// room". These pin exactly that difference - a room-mate managed by a different
// manager is the case a room projection would wrongly let through.
describe("GET /agents?killed=1 (killed roster)", () => {
  async function killedFor(
    srv: TestServer,
    init: { bearer?: string; rawSessionId?: string },
  ): Promise<Array<Record<string, unknown>>> {
    const res = await srv.http("/agents?killed=1", {
      headers: init.bearer
        ? { Authorization: `Bearer ${init.bearer}` }
        : undefined,
      rawSessionId: init.rawSessionId,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<Record<string, unknown>>;
  }

  it("an agent sees its own manager's killed agents, with a logDir it can read", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r1 = srv.agentManager.getRooms()[0].id;
    const doomed = await spawnOwnedBy(srv, "Doomed", r1, 0, owner.username);
    const survivor = await spawnOwnedBy(srv, "Survivor", r1, 1, owner.username);
    await srv.agentManager.kill(doomed.id);

    const list = await killedFor(srv, { bearer: bearerFor(survivor.id) });
    const entry = list.find((k) => k.id === doomed.id);
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("Doomed");
    expect(entry!.lastRoomId).toBe(r1);
    expect(entry!.logDir).toBe(join(srv.stateRoot, "logs", doomed.id));
    expect(typeof entry!.killedAt).toBe("number");
    // The LIVE arm must be unaffected: it still answers live agents only, and
    // reflects the kill at once, in parity with the file.
    const live = await srv.http("/agents", {
      headers: { Authorization: `Bearer ${bearerFor(survivor.id)}` },
    });
    const liveBody = (await live.json()) as Array<{ name: string }>;
    expect(liveBody.map((e) => e.name)).toEqual(["Survivor"]);
    expect(liveBody).toEqual(
      withLiveFields(manifestOnDisk(srv)) as typeof liveBody,
    );
  });

  it("a room-mate managed by a DIFFERENT manager does not see it", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mem");
    const r1 = srv.agentManager.getRooms()[0].id;
    await setAccess(srv, owner.rawSessionId, member.username, [r1]);

    // Both sat in the SAME room, so a room-scoped rule would let Mem's agent see
    // Morgan's killed one. The manager rule must not.
    const doomed = await spawnOwnedBy(srv, "Doomed", r1, 0, owner.username);
    const memberAgent = await spawnOwnedBy(
      srv,
      "MemBot",
      r1,
      1,
      member.username,
    );
    await srv.agentManager.kill(doomed.id);

    const asMember = await killedFor(srv, {
      bearer: bearerFor(memberAgent.id),
    });
    expect(asMember.find((k) => k.id === doomed.id)).toBeUndefined();
    // ...while an office owner's cookie sees every killed agent.
    const asOwner = await killedFor(srv, { rawSessionId: owner.rawSessionId });
    expect(asOwner.find((k) => k.id === doomed.id)).toBeDefined();
  });

  it("a member sees only the killed agents they spawned", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mem");
    const r1 = srv.agentManager.getRooms()[0].id;
    await setAccess(srv, owner.rawSessionId, member.username, [r1]);
    const theirs = await spawnOwnedBy(srv, "MorganBot", r1, 0, owner.username);
    const mine = await spawnOwnedBy(srv, "MemBot", r1, 1, member.username);
    await srv.agentManager.kill(theirs.id);
    await srv.agentManager.kill(mine.id);

    const list = await killedFor(srv, { rawSessionId: member.rawSessionId });
    const ids = list.map((k) => k.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it("anonymous is still 401; only killed=1 selects the roster, else 400", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r1 = srv.agentManager.getRooms()[0].id;
    const doomed = await spawnOwnedBy(srv, "Doomed", r1, 0, owner.username);
    await srv.agentManager.kill(doomed.id);

    const anon = await fetch(`${srv.baseUrl}/agents?killed=1`);
    expect(anon.status).toBe(401);

    const yes = await srv.http("/agents?killed=1", {
      rawSessionId: owner.rawSessionId,
    });
    expect(yes.status).toBe(200);
    expect(
      ((await yes.json()) as Array<{ id: string }>).some(
        (k) => k.id === doomed.id,
      ),
    ).toBe(true);

    // Every other present value is a loud 400. `?killed=0` reads as "no" and
    // must not be answered with the killed list; a typo must not be answered
    // with the LIVE list, which is what a presence check would have done.
    for (const q of ["?killed", "?killed=0", "?killed=true", "?killed=yes"]) {
      const res = await srv.http(`/agents${q}`, {
        rawSessionId: owner.rawSessionId,
      });
      expect(res.status).toBe(400);
    }
  });

  // Task 9643a66a: spawning agents kill finished workers, so the roster pages.
  it("pages newest kill first with limit and before", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r1 = srv.agentManager.getRooms()[0].id;
    const ids: string[] = [];
    for (const [i, name] of ["W1", "W2", "W3"].entries()) {
      const a = await spawnOwnedBy(srv, name, r1, i, owner.username);
      await srv.agentManager.kill(a.id);
      ids.push(a.id);
    }
    const spawner = await spawnOwnedBy(srv, "Spawner", r1, 3, owner.username);
    // Distinct kill times, so the page boundaries below are exact.
    const historyFile = join(srv.stateRoot, "agent-history.json");
    const history = JSON.parse(readFileSync(historyFile, "utf-8"));
    ids.forEach((id, i) => (history[id].killedAt = 1_000 * (i + 1)));
    writeFileSync(historyFile, JSON.stringify(history));

    const get = async (q: string) => {
      const res = await srv.http(`/agents?killed=1${q}`, {
        headers: { Authorization: `Bearer ${bearerFor(spawner.id)}` },
      });
      return {
        status: res.status,
        body: (await res.json()) as Array<{ id: string; killedAt: number }>,
      };
    };
    const first = await get("&limit=2");
    expect(first.status).toBe(200);
    expect(first.body.map((k) => k.id)).toEqual([ids[2], ids[1]]);
    const second = await get(`&limit=2&before=${first.body[1].killedAt}`);
    expect(second.body.map((k) => k.id)).toEqual([ids[0]]);
    // No limit: the default page holds all three.
    expect((await get("")).body.map((k) => k.id)).toEqual([
      ids[2],
      ids[1],
      ids[0],
    ]);

    for (const bad of ["&limit=0", "&limit=501", "&limit=x", "&before=-1"]) {
      expect((await get(bad)).status).toBe(400);
    }
  });

  it("a CRON-RUN token is denied, matching the log route it feeds", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r1 = srv.agentManager.getRooms()[0].id;
    const doomed = await spawnOwnedBy(srv, "Doomed", r1, 0, owner.username);
    await srv.agentManager.kill(doomed.id);

    // A run token carries its cronjob CREATOR's userId, so without an explicit
    // denial it would inherit that manager's killed-agent reach - out-reaching
    // logSearchAccess, which denies cron-run outright.
    const runToken = mintRunToken(
      "job-1",
      "run-1",
      getUserByName("Morgan")!.id,
    );
    const res = await srv.http("/agents?killed=1", {
      headers: { Authorization: `Bearer ${runToken}` },
    });
    expect(res.status).toBe(403);
  });

  it("excludes revived agents and legacy records with no recorded manager", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r1 = srv.agentManager.getRooms()[0].id;
    const revived = await spawnOwnedBy(srv, "Revived", r1, 0, owner.username);
    const stays = await spawnOwnedBy(srv, "Stays", r1, 1, owner.username);
    await srv.agentManager.kill(revived.id);
    await srv.agentManager.kill(stays.id);
    await srv.agentManager.revive(revived.id, r1, 0);

    const list = (await (
      await srv.http("/agents?killed=1", { rawSessionId: owner.rawSessionId })
    ).json()) as Array<{ id: string }>;
    // Back among the living -> off the killed roster (it has a history entry).
    expect(list.some((k) => k.id === revived.id)).toBe(false);
    expect(list.some((k) => k.id === stays.id)).toBe(true);

    // A history entry with NO recorded userId - what a legacy record from before
    // agents stored their manager looks like - must fail CLOSED for everyone but an
    // office owner: no real userId can match `undefined`.
    const unowned = await spawnAt(srv, "Unowned", r1, 2); // no username passed
    await srv.agentManager.kill(unowned.id);
    const member = await srv.seedMember("Mem");
    const asMember = (await (
      await srv.http("/agents?killed=1", { rawSessionId: member.rawSessionId })
    ).json()) as Array<{ id: string }>;
    expect(asMember.some((k) => k.id === unowned.id)).toBe(false);
    expect(asMember).toEqual([]); // Mem spawned nothing of their own either
    // The owner still sees it, so the exclusion above is the manager rule biting,
    // not the entry being dropped from the roster altogether.
    const asOwner = (await (
      await srv.http("/agents?killed=1", { rawSessionId: owner.rawSessionId })
    ).json()) as Array<{ id: string }>;
    expect(asOwner.some((k) => k.id === unowned.id)).toBe(true);
  });
});

it("exposes skill deletion to agents with editor authority and refreshes the catalog", async () => {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const room = srv.agentManager.getRooms()[0].id;
  const agent = await spawnOwnedBy(
    srv,
    "Skill editor",
    room,
    0,
    owner.username,
  );
  const folder = join(srv.stateRoot, ".claude", "skills", "delete-fixture");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "SKILL.md");
  writeFileSync(
    path,
    "---\nname: delete-fixture\ndescription: fixture\n---\nBody\n",
  );
  writeFileSync(join(folder, "resource.txt"), "resource");
  const headers = {
    Authorization: `Bearer ${bearerFor(agent.id)}`,
    "Content-Type": "application/json",
  };
  const read = await fetch(
    `${srv.baseUrl}/api/skills/file?path=${encodeURIComponent(path)}`,
    { headers },
  );
  expect(read.status).toBe(200);
  const file = (await read.json()) as { rev: number };
  const remove = (expectedRev: number, target = path) =>
    fetch(`${srv.baseUrl}/api/skills/file`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ path: target, expectedRev }),
    });
  expect((await remove(file.rev)).status).toBe(403);
  expect(existsSync(path)).toBe(true);
  await srv.agentManager.setPrivileged(agent.id, true);
  headers.Authorization = `Bearer ${bearerFor(agent.id)}`;
  expect(
    (await remove(file.rev, join(srv.stateRoot, "not-a-skill.md"))).status,
  ).toBe(404);
  expect((await remove(file.rev - 1)).status).toBe(409);
  const socket = await srv.connectWs(owner.rawSessionId);
  expect((await remove(file.rev)).status).toBe(204);
  const refresh = await socket.waitFor("slash_commands");
  expect(refresh.agentId).toBe(agent.id);
  expect(
    (refresh.skills as { name: string }[]).some(
      (skill) => skill.name === "delete-fixture",
    ),
  ).toBe(false);
  expect(existsSync(folder)).toBe(false);
  const catalog = (await fetch(`${srv.baseUrl}/api/skills`, { headers }).then(
    (r) => r.json(),
  )) as { engines: { skills: { path: string }[] }[] };
  expect(
    catalog.engines
      .flatMap((engine) => engine.skills)
      .some((skill) => skill.path === path),
  ).toBe(false);
});

// GET /agents with back room agents (task 5b503e32): an agent's default list
// shows each back room as one summary entry with a string name and no id;
// ?back=1 and non-agent callers get every agent; summaries respect room access.
describe("GET /agents for an agent: one entry per back room", () => {
  type Entry = Record<string, unknown>;

  async function listAs(srv: TestServer, agentId: string, query = "") {
    const res = await fetch(`${srv.baseUrl}/agents${query}`, {
      headers: { Authorization: `Bearer ${bearerFor(agentId)}` },
    });
    return { status: res.status, body: (await res.json()) as Entry[] };
  }

  // One room with a front agent and three back agents, all the owner's.
  async function office() {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const r1 = srv.agentManager.getRooms()[0].id;
    srv.agentManager.setRoomBackRoom(r1, true);
    const lead = await spawnOwnedBy(srv, "Lead", r1, 0, owner.username);
    for (const name of ["Worker 1", "Worker 2", "Worker 3"])
      await spawnOwnedBy(srv, name, r1, null, owner.username);
    return { srv, owner, r1, lead };
  }

  it("lists front agents and one summary with a string name and no id", async () => {
    const { srv, r1, lead } = await office();
    const { status, body } = await listAs(srv, lead.id);
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe("Lead");
    const summary = body[1];
    expect(summary).toEqual({
      name: expect.any(String),
      backRoom: true,
      roomId: r1,
      roomName: srv.agentManager.getRooms()[0].name,
      room: 1,
      agents: 3,
      busy: 0,
      pendingPrompt: 0,
    });
    expect("id" in summary).toBe(false);
    // .[] | select(.name|test("Worker")) aborts on a null name, and a summary
    // must not carry an agent's name.
    const agentNames = new Set(
      srv.agentManager.getAllAgents().map((a) => a.name),
    );
    expect(agentNames.has(summary.name as string)).toBe(false);
    expect(body.filter((e) => /Worker/.test(e.name as string))).toEqual([]);
  });

  it("?back=1 lists every back agent, marked backRoom, with front entries unchanged", async () => {
    const { srv, lead } = await office();
    const { status, body } = await listAs(srv, lead.id, "?back=1");
    expect(status).toBe(200);
    expect(body.map((e) => e.name)).toEqual([
      "Lead",
      "Worker 1",
      "Worker 2",
      "Worker 3",
    ]);
    expect("backRoom" in body[0]).toBe(false);
    for (const e of body.slice(1)) {
      expect(e.backRoom).toBe(true);
      expect(typeof e.id).toBe("string");
      expect(isBackSeat(e.desk as number)).toBe(true);
    }
  });

  it("a user's cookie gets every agent, back ones included", async () => {
    const { srv, owner } = await office();
    const res = await srv.http("/agents", { rawSessionId: owner.rawSessionId });
    expect(await manifestNames(res)).toEqual([
      "Lead",
      "Worker 1",
      "Worker 2",
      "Worker 3",
    ]);
  });

  it("a summary counts only rooms the caller can see", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Mem");
    const r1 = srv.agentManager.getRooms()[0].id;
    srv.agentManager.setRoomBackRoom(r1, true);
    const r2 = srv.agentManager.createRoom("Members Only");
    srv.agentManager.setRoomBackRoom(r2, true);
    await setAccess(srv, owner.rawSessionId, member.username, [r2]);
    await spawnOwnedBy(srv, "Hidden Worker", r1, null, owner.username);
    const mine = await spawnOwnedBy(srv, "Mine", r2, 0, member.username);
    const { body } = await listAs(srv, mine.id);
    expect(body.map((e) => e.name)).toEqual(["Mine"]);
    const ownerAgent = await spawnOwnedBy(
      srv,
      "Morgan Agent",
      r1,
      0,
      owner.username,
    );
    const all = await listAs(srv, ownerAgent.id);
    expect(
      all.body
        .filter((e) => e.backRoom === true)
        .map((e) => ({ roomId: e.roomId, agents: e.agents })),
    ).toEqual([{ roomId: r1, agents: 1 }]);
  });

  it("back other than 1, or with killed -> 400", async () => {
    const { srv, lead } = await office();
    for (const q of ["?back=0", "?back=1&killed=1", "?back=yes"]) {
      const res = await fetch(`${srv.baseUrl}/agents${q}`, {
        headers: { Authorization: `Bearer ${bearerFor(lead.id)}` },
      });
      expect(res.status).toBe(400);
    }
  });
});
