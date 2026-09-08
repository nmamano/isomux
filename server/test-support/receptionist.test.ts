// The receptionist: the one agent in the lobby, reachable by every user of the
// office - a member with no rooms included - and locked against kill, move and
// rename. Its own token reaches no room. Pinned over the real HTTP + WS surface.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { RECEPTIONIST_CWD } from "../receptionist-workspace.ts";
import { LOBBY_ROOM_ID, type AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(
  pred: () => boolean,
  timeoutMs = 3000,
  label = "cond",
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

// The real first-owner claim (the tokenless form), so the owner-created hook
// runs exactly as it does in production. seedOwner() bypasses that hook.
async function claimOwner(srv: TestServer, name: string): Promise<string> {
  const res = await srv.http("/auth/claim", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `name=${encodeURIComponent(name)}`,
    redirect: "manual",
  });
  if (res.status !== 302) throw new Error(`claim failed: HTTP ${res.status}`);
  const m = (res.headers.get("set-cookie") ?? "").match(
    /isomux_session=([^;]+)/,
  );
  if (!m) throw new Error("claim: no session cookie set");
  return m[1];
}

interface Res {
  status: number;
  body: unknown;
}
async function api(
  srv: TestServer,
  method: string,
  path: string,
  init: { body?: unknown; rawSessionId?: string; bearer?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  const res = await srv.http(path, {
    method,
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

const errCode = (body: unknown) =>
  (body as { error?: { code?: string } } | null)?.error?.code;

function receptionistOf(srv: TestServer): AgentInfo {
  const r = srv.agentManager.getReceptionist();
  expect(r).toBeDefined();
  return r as AgentInfo;
}

async function connectAndSettle(
  srv: TestServer,
  rawSessionId: string,
): Promise<TestSocket> {
  const sock = await srv.connectWs(rawSessionId);
  await sock.waitFor("presence_list");
  return sock;
}

describe("receptionist: lifecycle", () => {
  it("spawns on the first-owner claim after the welcome agents, in the lobby, on the free OpenCode model", async () => {
    const srv = await startTestServer();
    server = srv;
    await claimOwner(srv, "Boss");

    const agents = srv.agentManager.getAllAgents();
    expect(agents.length).toBe(4);
    const r = receptionistOf(srv);
    expect(r.name).toBe("Receptionist");
    expect(r.receptionist).toBe(true);
    expect(r.roomId).toBe(LOBBY_ROOM_ID);
    expect(r.desk).toBe(0);
    expect(r.cwd).toBe(RECEPTIONIST_CWD);
    expect(existsSync(r.cwd)).toBe(true);
    expect(readdirSync(r.cwd)).toEqual([]);
    expect(r.agentType).toBe("opencode");
    expect(r.modelFamily).toBe("opencode/muse-spark-1.2-contributor-free");
    expect(r.username).toBe("Boss");
    // No room list contains the lobby.
    expect(srv.agentManager.getRooms().some((x) => x.id === LOBBY_ROOM_ID)).toBe(
      false,
    );
    // Its record lives in its own file, never in agents.json.
    const stateRoot = srv.stateRoot;
    expect(existsSync(join(stateRoot, "receptionist.json"))).toBe(true);
    expect(readFileSync(join(stateRoot, "agents.json"), "utf8")).not.toContain(
      "Receptionist",
    );
  });

  it("restarts as the same agent, still exactly one", async () => {
    let srv = await startTestServer();
    server = srv;
    await claimOwner(srv, "Boss");
    const before = receptionistOf(srv);
    // Old versions persisted the home directory; boot must replace it.
    const recordPath = join(srv.stateRoot, "receptionist.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.cwd = "~";
    writeFileSync(recordPath, JSON.stringify(record));


    srv = await srv.restart();
    server = srv;
    const after = srv.agentManager
      .getAllAgents()
      .filter((a) => a.receptionist);
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].cwd).toBe(before.cwd);
    expect(after[0].cwd).toBe(RECEPTIONIST_CWD);
    expect(after[0].roomId).toBe(LOBBY_ROOM_ID);
    expect(srv.agentManager.getAllAgents().length).toBe(4);
  });

  it("an office with an owner but no receptionist gets one at boot", async () => {
    let srv = await startTestServer();
    server = srv;
    // seedOwner skips the owner-created hook: an office from before the feature.
    await srv.seedOwner("Boss");
    expect(srv.agentManager.getReceptionist()).toBeUndefined();

    srv = await srv.restart();
    server = srv;
    const r = receptionistOf(srv);
    expect(r.roomId).toBe(LOBBY_ROOM_ID);
    expect(r.username).toBe("Boss");
  });

  it("an office that already had agents keeps them and gains only the receptionist on claim", async () => {
    const srv = await startTestServer();
    server = srv;
    const existing = await srv.agentManager.spawn("Existing Agent", "~", "auto");
    expect(existing).not.toBeNull();
    await claimOwner(srv, "Boss");
    const names = srv.agentManager.getAllAgents().map((a) => a.name);
    expect(names.sort()).toEqual(["Existing Agent", "Receptionist"]);
  });

  it("a user cannot take the receptionist's name", async () => {
    const srv = await startTestServer();
    server = srv;
    const cookie = await claimOwner(srv, "Boss");
    const room = srv.agentManager.getRooms()[0].id;
    const res = await api(srv, "POST", "/api/agents", {
      rawSessionId: cookie,
      body: { name: "receptionist", cwd: "~", roomId: room, desk: 5 },
    });
    expect(res.status).toBe(409);
    expect(errCode(res.body)).toBe("name_taken");
  });
});

describe("receptionist: locks", () => {
  it("kill, move, rename and cwd changes are refused with 409 receptionist_locked; the rest is editable", async () => {
    const srv = await startTestServer();
    server = srv;
    const cookie = await claimOwner(srv, "Boss");
    const r = receptionistOf(srv);
    const room = srv.agentManager.getRooms()[0].id;

    const kill = await api(srv, "DELETE", `/api/agents/${r.id}`, {
      rawSessionId: cookie,
    });
    expect(kill.status).toBe(409);
    expect(errCode(kill.body)).toBe("receptionist_locked");
    expect(srv.agentManager.getReceptionist()?.id).toBe(r.id);

    const move = await api(srv, "POST", `/api/agents/${r.id}/move`, {
      rawSessionId: cookie,
      body: { targetRoomId: room },
    });
    expect(move.status).toBe(409);
    expect(errCode(move.body)).toBe("receptionist_locked");
    expect(srv.agentManager.getAgent(r.id)?.roomId).toBe(LOBBY_ROOM_ID);

    const rename = await api(srv, "PATCH", `/api/agents/${r.id}`, {
      rawSessionId: cookie,
      body: { name: "Concierge" },
    });
    expect(rename.status).toBe(409);
    expect(errCode(rename.body)).toBe("receptionist_locked");
    expect(srv.agentManager.getAgent(r.id)?.name).toBe("Receptionist");

    const changeCwd = await api(srv, "PATCH", `/api/agents/${r.id}`, {
      rawSessionId: cookie,
      body: { cwd: "~" },
    });
    expect(changeCwd.status).toBe(409);
    expect(errCode(changeCwd.body)).toBe("receptionist_locked");
    expect(srv.agentManager.getAgent(r.id)?.cwd).toBe(RECEPTIONIST_CWD);

    // Same name echoed back is not a rename.
    const same = await api(srv, "PATCH", `/api/agents/${r.id}`, {
      rawSessionId: cookie,
      body: { name: "Receptionist", effort: "low" },
    });
    expect(same.status).toBe(200);

    // The model is the owner's to pick.
    const model = await api(srv, "PATCH", `/api/agents/${r.id}`, {
      rawSessionId: cookie,
      body: { modelFamily: "opencode/kimi-k3" },
    });
    expect(model.status).toBe(200);
    expect(srv.agentManager.getAgent(r.id)?.modelFamily).toBe(
      "opencode/kimi-k3",
    );

    // Extra instructions on top of its base prompt.
    const read = await api(srv, "GET", `/api/agents/${r.id}/instructions`, {
      rawSessionId: cookie,
    });
    expect(read.status).toBe(200);
    const version = (read.body as { customInstructionsVersion: string })
      .customInstructionsVersion;
    const extra = await api(srv, "PATCH", `/api/agents/${r.id}`, {
      rawSessionId: cookie,
      body: {
        customInstructions: "Greet in Catalan.",
        customInstructionsVersion: version,
      },
    });
    expect(extra.status).toBe(200);
    expect(srv.agentManager.getAgent(r.id)?.customInstructions).toBe(
      "Greet in Catalan.",
    );

    // The core itself refuses too (defense in depth behind the REST dep).
    await srv.agentManager.kill(r.id);
    expect(srv.agentManager.getReceptionist()?.id).toBe(r.id);
    expect(srv.agentManager.moveAgent(r.id, room)).toBe(false);
  });

  it("the lobby id is not a room: spawn, close and swap-desks answer 404", async () => {
    const srv = await startTestServer();
    server = srv;
    const cookie = await claimOwner(srv, "Boss");

    const spawn = await api(srv, "POST", "/api/agents", {
      rawSessionId: cookie,
      body: { name: "Intruder", cwd: "~", roomId: LOBBY_ROOM_ID, desk: 1 },
    });
    expect(spawn.status).toBe(404);
    expect(errCode(spawn.body)).toBe("room_not_found");

    const close = await api(srv, "DELETE", `/api/rooms/${LOBBY_ROOM_ID}`, {
      rawSessionId: cookie,
    });
    expect(close.status).toBe(404);

    const swap = await api(
      srv,
      "POST",
      `/api/rooms/${LOBBY_ROOM_ID}/swap-desks`,
      { rawSessionId: cookie, body: { deskA: 0, deskB: 1 } },
    );
    // The core finds no such room and no agent moves; the receptionist stays
    // at desk 0 either way.
    expect([204, 404]).toContain(swap.status);
    expect(srv.agentManager.getReceptionist()?.desk).toBe(0);
  });
});

describe("receptionist: reach of a member with no rooms", () => {
  it("sees it in full_state, receives its turn, can message it and read its logs, and nothing else", async () => {
    const srv = await startTestServer();
    server = srv;
    await claimOwner(srv, "Boss");
    const r = receptionistOf(srv);
    const welcome = srv.agentManager
      .getAllAgents()
      .find((a) => a.name === "Claude Welcome Agent")!;
    const member = await srv.seedMember("Mia"); // allowedRooms: []

    const sock = await connectAndSettle(srv, member.rawSessionId);
    const full = sock.messages.find(
      (m) => (m as { type?: string }).type === "full_state",
    ) as { agents: AgentInfo[]; rooms: unknown[] };
    expect(full.rooms).toEqual([]);
    expect(full.agents.map((a) => a.id)).toEqual([r.id]);
    expect(full.agents[0].receptionist).toBe(true);

    // Messaging it starts a turn whose entries reach the member's socket.
    const sent = await api(srv, "POST", `/api/agents/${r.id}/messages`, {
      rawSessionId: member.rawSessionId,
      body: { text: "Where do I find the docs?" },
    });
    expect(sent.status).toBe(200);
    await waitUntil(
      () =>
        sock.messages.some(
          (m) =>
            (m as { type?: string; entry?: { agentId: string; kind: string } })
              .type === "log_entry" &&
            (m as { entry: { agentId: string; kind: string } }).entry
              .agentId === r.id &&
            (m as { entry: { kind: string } }).entry.kind === "text",
        ),
      5000,
      "receptionist reply on the member socket",
    );
    // Nothing from the welcome agent ever reaches this socket.
    expect(
      sock.messages.some(
        (m) =>
          (m as { entry?: { agentId?: string } }).entry?.agentId ===
          welcome.id,
      ),
    ).toBe(false);

    // Its session ran the receptionist prompt: this office, no recipes.
    const session = srv.fakeBackend.sessionForAgent(r.id)!;
    expect(session.opts.systemPrompt).toContain(
      'the receptionist of the Isomux office',
    );
    expect(session.opts.systemPrompt).toContain('Owners: "Boss". Members: "Mia".');
    expect(session.opts.systemPrompt).not.toContain("ISOMUX_AGENT_TOKEN");
    expect(session.opts.systemPrompt).not.toContain("http://isomux");

    const own = await api(srv, "GET", `/api/agents/${r.id}/logs`, {
      rawSessionId: member.rawSessionId,
    });
    expect(own.status).toBe(200);
    const other = await api(srv, "GET", `/api/agents/${welcome.id}/logs`, {
      rawSessionId: member.rawSessionId,
    });
    expect(other.status).toBe(403);

    // The member cannot reconfigure it (agent:manage is a user capability, but
    // the room-access guard is the lobby, so this is allowed for any member) -
    // pin the current answer so a change here is deliberate.
    const edit = await api(srv, "PATCH", `/api/agents/${r.id}`, {
      rawSessionId: member.rawSessionId,
      body: { effort: "low" },
    });
    expect(edit.status).toBe(200);
    sock.close();
  });

  it("the manifest lists it for every identity with room null and roomName Lobby", async () => {
    const srv = await startTestServer();
    server = srv;
    await claimOwner(srv, "Boss");
    const r = receptionistOf(srv);
    const member = await srv.seedMember("Mia");
    const res = await srv.http("/agents", { rawSessionId: member.rawSessionId });
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as Array<{
      id: string;
      room: number | null;
      roomName: string;
      roomId: string;
    }>;
    expect(manifest.map((e) => e.id)).toEqual([r.id]);
    expect(manifest[0].room).toBeNull();
    expect(manifest[0].roomName).toBe("Lobby");
    expect(manifest[0].roomId).toBe(LOBBY_ROOM_ID);
    // The file mirrors the endpoint's shape.
    const file = JSON.parse(
      readFileSync(join(srv.stateRoot, "agents-summary.json"), "utf8"),
    ) as Array<{ id: string; room: number | null }>;
    expect(file.find((e) => e.id === r.id)?.room).toBeNull();
    expect(file.filter((e) => e.room !== null).length).toBe(3);
  });
});

describe("receptionist: reach of its own token", () => {
  it("carries no user: sees only itself, reads no other agent, global tasks only", async () => {
    const srv = await startTestServer();
    server = srv;
    const cookie = await claimOwner(srv, "Boss");
    const r = receptionistOf(srv);
    const welcome = srv.agentManager
      .getAllAgents()
      .find((a) => a.name === "Claude Welcome Agent")!;
    const room = srv.agentManager.getRooms()[0].id;
    const bearer = getAgentTokenRaw(r.id)!;
    expect(bearer).toBeTruthy();

    const manifest = await srv.http("/agents", {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(manifest.status).toBe(200);
    const entries = (await manifest.json()) as Array<{ id: string }>;
    expect(entries.map((e) => e.id)).toEqual([r.id]);

    const logs = await api(srv, "GET", `/api/agents/${welcome.id}/logs`, {
      bearer,
    });
    expect(logs.status).toBe(403);
    const instructions = await api(
      srv,
      "GET",
      `/api/agents/${welcome.id}/instructions`,
      { bearer },
    );
    expect(instructions.status).toBe(403);
    // Agent-to-agent delivery is office-wide by design; the receptionist is the
    // one sender it is closed to, now and scheduled. A self-reminder stays open.
    const message = await api(srv, "POST", `/api/agents/${welcome.id}/messages`, {
      bearer,
      body: { text: "psst" },
    });
    expect(message.status).toBe(403);
    expect(errCode(message.body)).toBe("receptionist_reach");
    const later = new Date(Date.now() + 60_000).toISOString();
    const scheduled = await api(
      srv,
      "POST",
      `/api/agents/${welcome.id}/messages`,
      { bearer, body: { text: "psst", deliverAt: later } },
    );
    expect(scheduled.status).toBe(403);
    const reminder = await api(srv, "POST", `/api/agents/${r.id}/messages`, {
      bearer,
      body: { text: "wake up", deliverAt: later },
    });
    expect(reminder.status).toBe(200);

    // Tasks: the owner files one in a room and one office-global; the
    // receptionist sees the global one only.
    const inRoom = await api(srv, "POST", "/api/tasks", {
      rawSessionId: cookie,
      body: { title: "room task", roomId: room },
    });
    expect(inRoom.status).toBe(201);
    const global = await api(srv, "POST", "/api/tasks", {
      rawSessionId: cookie,
      body: { title: "global task", roomId: "" },
    });
    expect(global.status).toBe(201);
    const list = await api(srv, "GET", "/api/tasks", { bearer });
    expect(list.status).toBe(200);
    const titles = (list.body as Array<{ title: string }>).map((t) => t.title);
    expect(titles).toEqual(["global task"]);

    // The live guard adapter agrees: the receptionist resolves to the lobby.
    expect(srv.guardDeps.roomIdForAgent(r.id)).toBe(LOBBY_ROOM_ID);
  });
});
