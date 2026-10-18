// An app token has the reach of the agent that owns the app (createdByAgentId),
// read live on every request, and every write it makes names the app (Nil,
// 2026-10-18, task c0204eb6). The whole-table parity of that reach lives in
// routes-table.test.ts; this file pins what only a real server shows:
//   - each live fact flips the reach on the SAME token: the owner's privileged
//     flag, its room, its manager's room grants, and whether it is alive;
//   - the legacy GET /agents manifest answers the app as it answers the agent;
//   - a write records the app, not the owner agent or the member;
//   - an ordinary agent cannot raise an app to privileged reach.
//
// The supervisor is the harness FAKE. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { createMember, getUserByName, updateUserById } from "../users.ts";
import { officeAuditStore } from "../audit-store.ts";
import type { AgentInfo, TaskItem } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}

async function call(
  srv: TestServer,
  method: string,
  path: string,
  bearer: string,
  payload?: unknown,
): Promise<Res> {
  const res = await srv.http(path, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function spawn(
  srv: TestServer,
  name: string,
  manager: string,
  roomId = srv.agentManager.getRooms()[0].id,
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
    manager,
    "codex",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

// An app registered by `builder`, with the app token its unit was given.
async function register(
  srv: TestServer,
  builder: AgentInfo,
  appName: string,
): Promise<{ appToken: string; builderToken: string }> {
  const builderToken = mintAgentToken(builder.id, builder.userId);
  const reg = await call(srv, "POST", "/api/apps", builderToken, {
    name: appName,
    command: "bun run serve.ts",
    cwd: srv.stateRoot,
  });
  expect(reg.status).toBe(201);
  const appToken = srv.appSupervisor.tokenFiles.get(appName);
  if (!appToken) throw new Error(`no token file for ${appName}`);
  return { appToken, builderToken };
}

const latestAudit = (operation: string) =>
  officeAuditStore().list({ operation, limit: 1 }).items[0];

const isPrivileged = (srv: TestServer, id: string) =>
  srv.agentManager.getAgent(id)?.privileged === true;

describe("app owner reach: the same token follows the owner agent live", () => {
  it("loses the privileged routes when its owner is demoted", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const owner = await spawn(srv, "PrivBot", "Boss");
    await srv.agentManager.setPrivileged(owner.id, true);
    const { appToken } = await register(srv, owner, "priv-app");

    expect(isPrivileged(srv, owner.id)).toBe(true);
    expect((await call(srv, "GET", "/api/cronjobs", appToken)).status).toBe(
      200,
    );
    await srv.agentManager.setPrivileged(owner.id, false);
    expect(isPrivileged(srv, owner.id)).toBe(false);
    expect((await call(srv, "GET", "/api/cronjobs", appToken)).status).toBe(
      403,
    );
    // Still its owner's ordinary reach.
    expect((await call(srv, "GET", "/api/tasks", appToken)).status).toBe(200);
  });

  it("files a task in its owner agent's current room, which moves with the agent", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const owner = await spawn(srv, "Mover", "Boss");
    const { appToken } = await register(srv, owner, "mover-app");
    const before = await call(srv, "POST", "/api/tasks", appToken, {
      title: "before the move",
    });
    expect(before.status).toBe(201);
    expect((before.body as TaskItem).roomId).toBe(owner.roomId);

    const newRoom = srv.agentManager.createRoom("NewHome");
    expect(newRoom).not.toBe(owner.roomId);
    expect(srv.agentManager.moveAgent(owner.id, newRoom)).toBe(true);
    const after = await call(srv, "POST", "/api/tasks", appToken, {
      title: "after the move",
    });
    expect(after.status).toBe(201);
    expect((after.body as TaskItem).roomId).toBe(newRoom);
  });

  it("loses a room when its owner agent's manager loses the room grant", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0].id;
    const created = createMember("Mia", { role: "member", allowedRooms: [room] });
    if (!created.ok) throw new Error(created.error);
    const owner = await spawn(srv, "MiaBot", "Mia", room);
    const peer = await spawn(srv, "MiaPeer", "Mia", room);
    const { appToken } = await register(srv, owner, "mia-app");
    const logs = `/api/agents/${peer.id}/logs`;

    expect(getUserByName("Mia")!.allowedRooms).toContain(room);
    expect((await call(srv, "GET", logs, appToken)).status).toBe(200);
    expect(updateUserById(created.user.id, { allowedRooms: [] }).ok).toBe(
      true,
    );
    expect(getUserByName("Mia")!.allowedRooms).not.toContain(room);
    expect((await call(srv, "GET", logs, appToken)).status).toBe(403);
  });

  it("falls back to the app-self routes when its owner agent is killed", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const owner = await spawn(srv, "Doomed", "Boss");
    const { appToken } = await register(srv, owner, "orphan-app");

    expect(srv.agentManager.getAgent(owner.id)).toBeDefined();
    expect((await call(srv, "GET", "/api/tasks", appToken)).status).toBe(200);
    await srv.agentManager.kill(owner.id);
    expect(srv.agentManager.getAgent(owner.id)).toBeUndefined();
    expect((await call(srv, "GET", "/api/tasks", appToken)).status).toBe(403);
    expect((await call(srv, "GET", "/agents", appToken)).status).toBe(403);
  });
});

describe("app owner reach: GET /agents", () => {
  it("answers the app as it answers its owner agent, for the live, back-room and killed rosters", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0].id;
    expect(srv.agentManager.setRoomBackRoom(room, true).ok).toBe(true);
    const owner = await spawn(srv, "Lister", "Boss", room);
    const back = await srv.agentManager.spawn(
      "BackSeat",
      srv.stateRoot,
      "default",
      null,
      undefined,
      room,
      undefined,
      undefined,
      undefined,
      "Boss",
      "codex",
    );
    expect(back?.desk).toBeGreaterThanOrEqual(8);
    const gone = await spawn(srv, "Gone", "Boss", room);
    await srv.agentManager.kill(gone.id);
    const { appToken, builderToken } = await register(srv, owner, "lister");

    for (const path of ["/agents", "/agents?back=1", "/agents?killed=1"]) {
      const byAgent = await call(srv, "GET", path, builderToken);
      const byApp = await call(srv, "GET", path, appToken);
      expect({ path, status: byAgent.status }).toEqual({ path, status: 200 });
      expect({ path, body: byApp.body, status: byApp.status }).toEqual({
        path,
        body: byAgent.body,
        status: 200,
      });
    }
  });
});

describe("app owner reach: writes name the app", () => {
  it("records the app on a task and in the audit row, never the owner agent or the member", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const owner = await spawn(srv, "LoopOwner", "Boss");
    const { appToken } = await register(srv, owner, "loop");

    const made = await call(srv, "POST", "/api/tasks", appToken, {
      title: "dispatch me",
    });
    expect(made.status).toBe(201);
    const task = made.body as TaskItem;
    expect(task.createdBy).toContain("loop");
    expect(task.createdBy).not.toBe(owner.name);
    expect(task.createdBy).not.toBe("Boss");
    expect(latestAudit("tasks.create")?.actor).toMatchObject({
      kind: "app",
      name: "loop",
    });

    const claimed = await call(
      srv,
      "POST",
      `/api/tasks/${task.id}/claim`,
      appToken,
      { assignee: "Worker 1" },
    );
    expect(claimed.status).toBe(200);
    expect(latestAudit("tasks.claim")?.actor).toMatchObject({
      kind: "app",
      name: "loop",
    });
  });

  it("records the app as the author of a memory line", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const owner = await spawn(srv, "MemOwner", "Boss");
    const { appToken } = await register(srv, owner, "notes");
    const r = await call(srv, "POST", "/api/memory", appToken, {
      scope: "office",
      text: "a line from the app",
    });
    expect(r.status).toBe(201);
    const read = await call(srv, "GET", "/api/memory?scope=office", appToken);
    expect(read.status).toBe(200);
    const text = JSON.stringify(read.body);
    expect(text).toContain("a line from the app");
    expect(text).toContain("notes");
    expect(text).not.toContain(owner.name);
  });
});

describe("app owner reach: an ordinary agent cannot raise an app to privileged", () => {
  it("refuses an ordinary agent, and passes a human and a privileged agent", async () => {
    const srv = await startTestServer();
    server = srv;
    const boss = await srv.seedOwner("Boss");
    const ordinary = await spawn(srv, "Plain", "Boss");
    const privileged = await spawn(srv, "Priv", "Boss");
    await srv.agentManager.setPrivileged(privileged.id, true);
    expect(isPrivileged(srv, privileged.id)).toBe(true);
    expect(isPrivileged(srv, ordinary.id)).toBe(false);
    const { appToken, builderToken } = await register(srv, ordinary, "raise");
    const privilegedToken = mintAgentToken(privileged.id, privileged.userId);
    const patch = (bearer: string, body: unknown) =>
      call(srv, "PATCH", "/api/apps/raise", bearer, body);

    // Registering makes the ordinary agent the owner, so the app has nothing
    // above that agent's reach.
    const record = await call(srv, "GET", "/api/apps/raise", builderToken);
    expect((record.body as { createdByAgentId?: string }).createdByAgentId).toBe(
      ordinary.id,
    );
    expect((await call(srv, "GET", "/api/cronjobs", appToken)).status).toBe(
      403,
    );

    // While the owner is ordinary, the ordinary agent changes command and cwd.
    expect((await patch(builderToken, { command: "bun run a.ts" })).status).toBe(
      200,
    );
    expect((await patch(builderToken, { cwd: srv.stateRoot })).status).toBe(
      200,
    );

    // Pointing the app at a privileged owner: neither the ordinary agent nor
    // its own app may.
    for (const bearer of [builderToken, appToken]) {
      expect(
        (await patch(bearer, { createdByAgentId: privileged.id })).status,
      ).toBe(403);
    }
    const byHuman = await srv.http("/api/apps/raise", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createdByAgentId: privileged.id }),
      rawSessionId: boss.rawSessionId,
    });
    expect(byHuman.status).toBe(200);

    // The owner is privileged now: the ordinary agent may not change its
    // owner, command or cwd, and may still change the description.
    for (const body of [
      { command: "bun run other.ts" },
      { cwd: srv.stateRoot },
      { createdByAgentId: ordinary.id },
    ]) {
      expect((await patch(builderToken, body)).status).toBe(403);
    }
    expect((await patch(builderToken, { description: "ok" })).status).toBe(
      200,
    );
    expect(
      (await patch(privilegedToken, { command: "bun run other.ts" })).status,
    ).toBe(200);
  });
});

describe("app owner reach: the raise check reads the owner's flag live", () => {
  it("lets an ordinary agent change command until the owner is made privileged", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const owner = await spawn(srv, "OwnerBot", "Boss");
    const other = await spawn(srv, "OtherBot", "Boss");
    await register(srv, owner, "flip");
    const otherToken = mintAgentToken(other.id, other.userId);
    const change = () =>
      call(srv, "PATCH", "/api/apps/flip", otherToken, {
        command: "bun run b.ts",
      });

    expect(isPrivileged(srv, owner.id)).toBe(false);
    expect(isPrivileged(srv, other.id)).toBe(false);
    expect((await change()).status).toBe(200);
    await srv.agentManager.setPrivileged(owner.id, true);
    expect(isPrivileged(srv, owner.id)).toBe(true);
    expect((await change()).status).toBe(403);
  });
});

describe("app owner reach: an owner agent of another member gives no reach", () => {
  it("falls back once a human repoints the app at another member's agent", async () => {
    const srv = await startTestServer();
    server = srv;
    const boss = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0].id;
    const created = createMember("Mia", { role: "member", allowedRooms: [room] });
    if (!created.ok) throw new Error(created.error);
    const owner = await spawn(srv, "BossBot", "Boss", room);
    const miaBot = await spawn(srv, "MiaBot", "Mia", room);
    const { appToken } = await register(srv, owner, "crossed");
    expect((await call(srv, "GET", "/api/tasks", appToken)).status).toBe(200);

    const repoint = await srv.http("/api/apps/crossed", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createdByAgentId: miaBot.id }),
      rawSessionId: boss.rawSessionId,
    });
    expect(repoint.status).toBe(200);
    expect(miaBot.userId).not.toBe(owner.userId);
    expect((await call(srv, "GET", "/api/tasks", appToken)).status).toBe(403);
    // The default message still reaches its target, the new owner agent.
    expect(
      (await call(srv, "POST", "/api/app/message", appToken, { text: "hi" }))
        .status,
    ).toBe(200);
  });
});

describe("app owner reach: integrations as an agent, never as a human", () => {
  it("cannot add a host to a saved secret, and reads an MCP server's host only", async () => {
    const srv = await startTestServer();
    server = srv;
    const boss = await srv.seedOwner("Boss");
    const owner = await spawn(srv, "IntegBot", "Boss");
    await srv.agentManager.setPrivileged(owner.id, true);
    const { appToken } = await register(srv, owner, "integ");
    const own = "/api/users/Boss";
    const asBoss = (method: string, path: string, body?: unknown) =>
      srv.http(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
        rawSessionId: boss.rawSessionId,
      });

    const created = await call(srv, "POST", `${own}/secrets`, appToken, {
      name: "APP_TOKEN",
      value: "fake-app-reach-value-0123456789",
      hosts: ["api.example.com"],
      form: { kind: "authorization" },
    });
    expect(created.status).toBe(201);
    const widened = { hosts: ["api.example.com", "github.com"] };
    expect(
      (await call(srv, "PATCH", `${own}/secrets/APP_TOKEN`, appToken, widened))
        .status,
    ).toBe(403);
    // The enabling condition: the same change is open to the member.
    expect(
      (await asBoss("PATCH", `${own}/secrets/APP_TOKEN`, widened)).status,
    ).toBe(200);

    const url = "https://mcp.example.com/path-token-APPSEKRIT/mcp";
    expect(
      (
        await call(srv, "POST", `${own}/mcp-servers`, appToken, {
          name: "docs",
          url,
          secret: null,
        })
      ).status,
    ).toBe(201);
    const byApp = await call(srv, "GET", `${own}/mcp-servers`, appToken);
    expect(byApp.status).toBe(200);
    expect(JSON.stringify(byApp.body)).not.toContain("APPSEKRIT");
    expect(JSON.stringify(byApp.body)).toContain("mcp.example.com");
    const byBoss = await asBoss("GET", `${own}/mcp-servers`);
    expect(await byBoss.text()).toContain("APPSEKRIT");
  });
});
