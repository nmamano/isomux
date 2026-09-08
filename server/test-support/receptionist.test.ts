import { describe, it, expect, afterEach, spyOn } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { homedir } from "os";
import { ISOMUX_KNOWLEDGE } from "../../api/chat.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { LOBBY_ROOM } from "../../shared/types.ts";
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
  const r = srv.agentManager
    .getAllAgents()
    .find((a) => a.roomId === LOBBY_ROOM_ID);
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

describe("receptionist profile and lobby", () => {
  it("claim creates three welcome agents and one ordinary lobby agent; preclaim has none", async () => {
    const srv = (server = await startTestServer());
    expect(srv.agentManager.getAllAgents()).toHaveLength(0);
    expect(srv.agentManager.getRooms().some((r) => r.type === "lobby")).toBe(
      false,
    );
    await claimOwner(srv, "Boss");
    expect(
      srv.agentManager
        .getAllAgents()
        .map((a) => a.name)
        .sort(),
    ).toEqual([
      "Claude Welcome Agent",
      "Codex Welcome Agent",
      "Free Welcome Agent",
      "Receptionist",
    ]);
    const r = receptionistOf(srv);
    expect(r.cwd).toBe(homedir());
    expect(r.permissionMode).toBe("bypassPermissions");
    expect(r.username).toBe("Boss");
    expect(r.userId).toBeTruthy();
    expect(r.customInstructions).toContain(ISOMUX_KNOWLEDGE);
    expect(r.customInstructions).toContain('Owners: "Boss". Members: none.');
    expect("receptionist" in r).toBe(false);
    expect(srv.agentManager.getOrdinaryRooms()[0].canCloseWhenEmpty).toBe(
      false,
    );
    expect(
      srv.agentManager.getRooms().find((r) => r.type === "lobby")
        ?.canCloseWhenEmpty,
    ).toBe(false);
    const rooms = JSON.parse(
      readFileSync(join(srv.stateRoot, "agents.json"), "utf8"),
    );
    expect(
      rooms.find((r: { type?: string }) => r.type === "lobby").agents[0].id,
    ).toBe(r.id);
  });

  for (const failure of ["null", "throw"] as const) {
    it(`retries a ${failure} default spawn after restart without losing welcome agents`, async () => {
      let srv = (server = await startTestServer());
      const spawn = spyOn(srv.agentManager, "spawn");
      if (failure === "null") spawn.mockResolvedValueOnce(null);
      else spawn.mockRejectedValueOnce(new Error("seed failed once"));
      try {
        await claimOwner(srv, "Boss");
      } finally {
        spawn.mockRestore();
      }
      expect(
        srv.agentManager
          .getAllAgents()
          .map((a) => a.name)
          .sort(),
      ).toEqual([
        "Claude Welcome Agent",
        "Codex Welcome Agent",
        "Free Welcome Agent",
      ]);
      const pending = JSON.parse(
        readFileSync(join(srv.stateRoot, "agents.json"), "utf8"),
      );
      expect(
        pending.find((r: { id: string }) => r.id === "lobby")
          .defaultAgentPending,
      ).toBe(true);
      srv = server = await srv.restart();
      expect(receptionistOf(srv).username).toBe("Boss");
      expect(srv.agentManager.getAllAgents()).toHaveLength(4);
      const complete = JSON.parse(
        readFileSync(join(srv.stateRoot, "agents.json"), "utf8"),
      );
      expect(
        complete.find((r: { id: string }) => r.id === "lobby")
          .defaultAgentPending,
      ).toBeUndefined();
    });
  }

  it("settles a pending seed that already has an occupant before a later move", async () => {
    let srv = (server = await startTestServer());
    await claimOwner(srv, "Boss");
    const r = receptionistOf(srv);
    const file = join(srv.stateRoot, "agents.json");
    const rooms = JSON.parse(readFileSync(file, "utf8"));
    rooms.find(
      (room: { id: string }) => room.id === "lobby",
    ).defaultAgentPending = true;
    writeFileSync(file, JSON.stringify(rooms));
    srv = server = await srv.restart();
    expect(receptionistOf(srv).id).toBe(r.id);
    expect(srv.agentManager.lobbySeedIsPending()).toBe(false);
    expect(
      srv.agentManager.moveAgent(
        r.id,
        srv.agentManager.getOrdinaryRooms()[0].id,
      ),
    ).toBe(true);
    srv = server = await srv.restart();
    expect(
      srv.agentManager.getAllAgents().some((agent) => agent.roomId === "lobby"),
    ).toBe(false);
  });

  it("uses a discovered free model for both receptionist and Free Welcome Agent", async () => {
    const srv = (server = await startTestServer({
      startServer: {
        discoverWelcomeOpenCodeModels: async () => [
          {
            id: "opencode/available-free",
            label: "Available",
            isFree: true,
            supportedEfforts: [],
          },
        ],
      },
    }));
    await claimOwner(srv, "Boss");
    expect(receptionistOf(srv).modelFamily).toBe("opencode/available-free");
    expect(
      srv.agentManager
        .getAllAgents()
        .find((a) => a.name === "Free Welcome Agent")?.modelFamily,
    ).toBe("opencode/available-free");
  });

  it("keeps lobby access at the id boundary before the canonical room exists", async () => {
    const srv = (server = await startTestServer());
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    expect(
      srv.agentManager.getRooms().some((room) => room.id === "lobby"),
    ).toBe(false);
    const response = await api(srv, "DELETE", "/api/rooms/lobby", {
      rawSessionId: member.rawSessionId,
    });
    expect(response.status).toBe(404);
    expect(errCode(response.body)).toBe("room_not_found");
  });

  it("protects the first ordinary room even with lobby-first storage", () => {
    const state = new OfficeState({
      rooms: [LOBBY_ROOM, { id: "ordinary", name: "Room 1", prompt: null }],
    });
    expect(state.rooms.map((r) => r.canCloseWhenEmpty)).toEqual([false, false]);
    expect(state.closeRoom("ordinary")).toEqual([]);
    expect(state.closeRoom("lobby")).toEqual([]);
  });

  it("allows name/cwd edits, move out and in, kill and revive; persists empty lobby", async () => {
    let srv = (server = await startTestServer());
    const cookie = await claimOwner(srv, "Boss");
    const r = receptionistOf(srv);
    const room = srv.agentManager.getOrdinaryRooms()[0].id;
    const edit = await api(srv, "PATCH", `/api/agents/${r.id}`, {
      rawSessionId: cookie,
      body: { name: "Concierge", cwd: srv.stateRoot },
    });
    expect(edit.status).toBe(200);
    expect(srv.agentManager.getAgent(r.id)?.cwd).toBe(srv.stateRoot);
    expect(
      (
        await api(srv, "POST", `/api/agents/${r.id}/move`, {
          rawSessionId: cookie,
          body: { targetRoomId: room },
        })
      ).status,
    ).toBe(200);
    const other = srv.agentManager.getAllAgents().find((a) => a.id !== r.id)!;
    expect(srv.agentManager.moveAgent(other.id, "lobby")).toBe(true);
    expect(srv.agentManager.moveAgent(r.id, "lobby")).toBe(false);
    expect(srv.agentManager.moveAgent(other.id, room)).toBe(true);
    expect(srv.agentManager.moveAgent(r.id, "lobby")).toBe(true);
    expect(srv.agentManager.getAgent(r.id)?.desk).toBe(0);
    expect(
      (
        await api(srv, "DELETE", `/api/agents/${r.id}`, {
          rawSessionId: cookie,
        })
      ).status,
    ).toBe(204);
    expect(srv.agentManager.getAgent(r.id)).toBeUndefined();
    srv = server = await srv.restart();
    expect(
      srv.agentManager.getAllAgents().some((a) => a.roomId === "lobby"),
    ).toBe(false);
    const revived = await srv.agentManager.revive(r.id, "lobby", 0);
    expect(revived.ok).toBe(true);
    expect(srv.agentManager.getAgent(r.id)?.name).toBe("Concierge");
    expect(srv.agentManager.getAgent(r.id)?.cwd).toBe(srv.stateRoot);
  });

  it("seeds an upgraded office with an owner and no lobby at boot", async () => {
    let srv = (server = await startTestServer());
    await srv.seedOwner("Boss");
    srv = server = await srv.restart();
    expect(receptionistOf(srv).username).toBe("Boss");
  });

  it("renders a validated profile at spawn and enforces the target desk range", async () => {
    const srv = (server = await startTestServer());
    const cookie = await claimOwner(srv, "Boss");
    const room = srv.agentManager.getOrdinaryRooms()[0].id;
    const body = {
      name: "Fresh Receptionist",
      cwd: "~",
      roomId: room,
      desk: 4,
      permissionMode: "bypassPermissions",
      profileKey: "isomux-receptionist",
      customInstructions: "My edited voice.",
    };
    const result = await api(srv, "POST", "/api/agents", {
      rawSessionId: cookie,
      body,
    });
    expect(result.status).toBe(201);
    const agent = (result.body as { agent: AgentInfo }).agent;
    expect(agent.customInstructions?.startsWith("My edited voice.")).toBe(true);
    expect(agent.customInstructions).toContain(ISOMUX_KNOWLEDGE);
    const badProfile = await api(srv, "POST", "/api/agents", {
      rawSessionId: cookie,
      body: { ...body, name: "Invalid", profileKey: "unknown" },
    });
    expect(errCode(badProfile.body)).toBe("invalid_request");
    for (const desk of [-1, 1, 7, 0.5]) {
      const badDesk = await api(srv, "POST", "/api/agents", {
        rawSessionId: cookie,
        body: { ...body, name: "Invalid", roomId: "lobby", desk },
      });
      expect(badDesk.status).toBe(422);
      expect(JSON.stringify(badDesk.body)).toContain("0 to 0");
    }
    const swap = await api(srv, "POST", "/api/rooms/lobby/swap-desks", {
      rawSessionId: cookie,
      body: { deskA: 0, deskB: 1 },
    });
    expect(swap.status).toBe(422);
  });

  it("shows the current lobby occupant to a member, and keeps ordinary grants separate", async () => {
    const srv = (server = await startTestServer());
    await claimOwner(srv, "Boss");
    const r = receptionistOf(srv);
    const member = await srv.seedMember("Mia");
    const sock = await connectAndSettle(srv, member.rawSessionId);
    const full = sock.messages.find(
      (m) => (m as { type?: string }).type === "full_state",
    ) as { agents: AgentInfo[]; rooms: { id: string }[] };
    expect(full.rooms.map((r) => r.id)).toEqual(["lobby"]);
    expect(full.agents.map((a) => a.id)).toEqual([r.id]);
    const manifest = await api(srv, "GET", "/agents", {
      rawSessionId: member.rawSessionId,
    });
    expect(
      (manifest.body as { room: number | null; roomId: string }[])[0],
    ).toMatchObject({ room: null, roomId: "lobby" });
    const sent = await api(srv, "POST", `/api/agents/${r.id}/messages`, {
      rawSessionId: member.rawSessionId,
      body: { text: "Help" },
    });
    expect(sent.status).toBe(200);
    await waitUntil(() => !!srv.fakeBackend.sessionForAgent(r.id));
    const prompt = srv.fakeBackend.sessionForAgent(r.id)!.opts.systemPrompt;
    expect(prompt).toContain(ISOMUX_KNOWLEDGE);
    expect(prompt).toContain('Owners: "Boss". Members: none.');
    expect(prompt).toContain("curl");
    expect(prompt).not.toContain("What you can and cannot see");
    expect(
      (
        await api(srv, "POST", "/api/tasks", {
          rawSessionId: member.rawSessionId,
          body: { title: "Lobby task", roomId: "lobby" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(srv, "GET", "/api/memory?scope=room&scopeId=lobby", {
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(404);
    sock.close();
  });

  it("omits lobby room memory in session prompts and the system-prompt command", async () => {
    const srv = (server = await startTestServer());
    const cookie = await claimOwner(srv, "Boss");
    const r = receptionistOf(srv);
    const memoryDir = join(srv.stateRoot, "memory", "rooms");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, "lobby.md"),
      "LOBBY_ROOM_MEMORY_MUST_NOT_LOAD",
    );
    await srv.agentManager.newConversation(r.id);
    expect(
      (
        await api(srv, "POST", `/api/agents/${r.id}/messages`, {
          rawSessionId: cookie,
          body: { text: "Hello" },
        })
      ).status,
    ).toBe(200);
    await waitUntil(() => !!srv.fakeBackend.sessionForAgent(r.id));
    expect(
      srv.fakeBackend.sessionForAgent(r.id)!.opts.systemPrompt,
    ).not.toContain("LOBBY_ROOM_MEMORY_MUST_NOT_LOAD");
    expect(
      (
        await api(srv, "POST", `/api/agents/${r.id}/messages`, {
          rawSessionId: cookie,
          body: { text: "/isomux-system-prompt" },
        })
      ).status,
    ).toBe(200);
    await waitUntil(() =>
      srv.agentManager
        .getAgentLogs(r.id)
        .some((entry) => entry.content.includes("## Your Manager")),
    );
    expect(
      srv.agentManager
        .getAgentLogs(r.id)
        .map((entry) => entry.content)
        .join("\n"),
    ).not.toContain("LOBBY_ROOM_MEMORY_MUST_NOT_LOAD");
  });

  it("uses the first owner's normal token reach for rooms, agents, tasks and messages", async () => {
    const srv = (server = await startTestServer());
    const cookie = await claimOwner(srv, "Boss");
    const r = receptionistOf(srv);
    const saved = await api(srv, "POST", "/api/memory", {
      rawSessionId: cookie,
      body: {
        scope: "boss",
        scopeId: r.userId,
        text: "Boss memory marker for receptionist profile.",
      },
    });
    expect(saved.status).toBe(201);
    await srv.agentManager.newConversation(r.id);
    expect(
      (
        await api(srv, "POST", `/api/agents/${r.id}/messages`, {
          rawSessionId: cookie,
          body: { text: "Hello" },
        })
      ).status,
    ).toBe(200);
    await waitUntil(() => !!srv.fakeBackend.sessionForAgent(r.id));
    expect(srv.fakeBackend.sessionForAgent(r.id)!.opts.systemPrompt).toContain(
      "Boss memory marker for receptionist profile.",
    );
    const bearer = getAgentTokenRaw(r.id)!;
    const other = srv.agentManager.getAllAgents().find((a) => a.id !== r.id)!;
    const manifest = await api(srv, "GET", "/agents", { bearer });
    expect((manifest.body as unknown[]).length).toBe(4);
    expect(
      (
        await api(srv, "GET", `/api/agents/${other.id}/instructions`, {
          bearer,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(srv, "POST", `/api/agents/${other.id}/messages`, {
          bearer,
          body: { text: "Hello" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(srv, "POST", `/api/agents/${other.id}/messages`, {
          bearer,
          body: {
            text: "Later",
            deliverAt: new Date(Date.now() + 60000).toISOString(),
          },
        })
      ).status,
    ).toBe(200);
    const room = srv.agentManager.getOrdinaryRooms()[0].id;
    expect(
      (
        await api(srv, "POST", "/api/tasks", {
          rawSessionId: cookie,
          body: { title: "Room task", roomId: room },
        })
      ).status,
    ).toBe(201);
    const implicit = await api(srv, "POST", "/api/tasks", {
      bearer,
      body: { title: "Default lobby task" },
    });
    expect(implicit.status).toBe(201);
    expect((implicit.body as { roomId?: string }).roomId).toBeUndefined();
    const humanList = await api(srv, "GET", "/api/tasks", {
      rawSessionId: cookie,
    });
    expect(humanList.status).toBe(200);
    expect(
      (humanList.body as { title: string }[]).map((task) => task.title),
    ).toContain("Default lobby task");
    expect(
      (
        await api(srv, "POST", "/api/tasks", {
          bearer,
          body: { title: "Invalid lobby scope", roomId: "lobby" },
        })
      ).status,
    ).toBe(404);
    const list = await api(srv, "GET", "/api/tasks", { bearer });
    expect((list.body as { title: string }[]).map((t) => t.title)).toContain(
      "Room task",
    );
  });
});
