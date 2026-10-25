// An office owner gives an agent a new manager, and a deleted member's agents
// pass to the oldest office owner (task 6a9deaba; rulings in
// internal-docs/agent-manager-design.md). This file pins what only a real
// server shows:
//   - the transfer changes the agent's manager fields and token, keeps its
//     privilege, and kills the running session: the next turn is a fresh
//     session under the new manager's token, also for a message that was
//     queued when the transfer started;
//   - the apps, schedules and webhooks the agent made move with it while the
//     old manager owns them, and nothing else moves;
//   - a resumed session from an earlier manager names that manager;
//   - deleting a member passes their live and killed agents to the oldest
//     office owner, not to the owner who deletes;
//   - deleting a member passes every webhook and schedule they own to that
//     owner turned off, each webhook with a new secret, so a secret they read
//     stops working (task 438900d2); a record their agent made is off before
//     it becomes the owner's (task be7708d3).
//
// Seam: startTestServer() with a FakeBackend. Zero LLM. Copy is never matched:
// a system line is found by the member names it carries.

import { describe, it, expect, afterEach } from "bun:test";
import { createHmac, randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { getAgentTokenRaw, resolveToken } from "../identity/tokens.ts";
import { identityHasCapability } from "../identity/index.ts";
import {
  getUserById,
  getUserByName,
  setUserRoleById,
  updateUserById,
} from "../users.ts";
import { officeAuditStore } from "../audit-store.ts";
import type {
  AgentInfo,
  AppListWire,
  Cronjob,
  WebhookWire,
} from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  pred: () => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

interface Res {
  status: number;
  body: unknown;
}

async function api(
  srv: TestServer,
  method: string,
  path: string,
  caller: { rawSessionId?: string; bearer?: string },
  payload?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (caller.bearer) headers["Authorization"] = `Bearer ${caller.bearer}`;
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method,
    headers,
    rawSessionId: caller.rawSessionId,
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

const errCode = (r: Res): string | undefined =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

// A backend whose every turn completes, so an agent goes back to idle.
const completingBackend = () =>
  new FakeBackend({
    session: {
      onSend: (_t, _a, session) => session.completeTurn({ text: "ok" }),
    },
  });

const idOf = (name: string): string => {
  const user = getUserByName(name);
  if (!user) throw new Error(`no member ${name}`);
  return user.id;
};

function agentOf(srv: TestServer, id: string): AgentInfo {
  const agent = srv.agentManager.getAgent(id);
  if (!agent) throw new Error(`agent ${id} not live`);
  return agent;
}

// The live queue: getAllAgents splices it in, getAgent does not.
function queueOf(srv: TestServer, id: string): AgentInfo["queue"] {
  return srv.agentManager.getAllAgents().find((a) => a.id === id)!.queue;
}

// The stored records, read from disk as an older release would read them.
function persistedAgent(
  srv: TestServer,
  id: string,
): Record<string, unknown> | undefined {
  const path = join(srv.stateRoot, "agents.json");
  if (!existsSync(path)) return undefined;
  const rooms = JSON.parse(readFileSync(path, "utf-8")) as {
    agents: Record<string, unknown>[];
  }[];
  return rooms.flatMap((room) => room.agents).find((a) => a.id === id);
}

function persistedHistory(
  srv: TestServer,
  id: string,
): Record<string, unknown> | undefined {
  const path = join(srv.stateRoot, "agent-history.json");
  if (!existsSync(path)) return undefined;
  return (
    JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >
  )[id];
}

function latestSession(srv: TestServer, agentId: string): FakeSession {
  const session = srv.fakeBackend.sessionForAgent(agentId);
  if (!session) throw new Error("no fake session for agent");
  return session;
}

async function spawn(
  srv: TestServer,
  name: string,
  manager: string,
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    undefined,
    undefined,
    manager,
    "codex",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

// One member turn to idle; returns the session it ran in.
async function runTurn(srv: TestServer, agentId: string): Promise<FakeSession> {
  const before = srv.fakeBackend.sessions.length;
  await srv.agentManager.sendMessage(agentId, "hello", "tester");
  await waitUntil(
    () =>
      srv.fakeBackend.sessions.length > before ||
      latestSession(srv, agentId).sent.length > 0,
    "turn sent",
  );
  await waitUntil(
    () => agentOf(srv, agentId).state === "waiting_for_response",
    "turn finished",
  );
  return latestSession(srv, agentId);
}

const systemLines = (srv: TestServer, agentId: string, since = 0): string[] =>
  srv.agentManager
    .getAgentLogs(agentId)
    .filter((e) => e.kind === "system" && e.timestamp >= since)
    .map((e) => e.content);

// The system lines a resume adds (replayed entries keep their old times).
async function resumeLines(
  srv: TestServer,
  agentId: string,
  sessionId: string,
): Promise<string[]> {
  await sleep(2);
  const since = Date.now();
  await srv.agentManager.resume(agentId, sessionId);
  return systemLines(srv, agentId, since);
}

const setManager = (
  srv: TestServer,
  agentId: string,
  userId: unknown,
  rawSessionId: string,
) =>
  api(
    srv,
    "PUT",
    `/api/agents/${agentId}/manager`,
    { rawSessionId },
    {
      userId,
    },
  );

// An office: owner Morgan, members Alice, Bea and Cleo, each with access to
// the first room.
async function office(backend = completingBackend()) {
  const srv = await startTestServer({ fakeBackend: backend });
  server = srv;
  const morgan = await srv.seedOwner("Morgan");
  const roomId = srv.agentManager.getRooms()[0].id;
  const alice = await srv.seedMember("Alice");
  await srv.seedMember("Bea");
  await srv.seedMember("Cleo");
  for (const name of ["Alice", "Bea", "Cleo"])
    expect(updateUserById(idOf(name), { allowedRooms: [roomId] }).ok).toBe(
      true,
    );
  return { srv, morgan, alice };
}

describe("agents.setManager: the agent itself", () => {
  it("changes the manager fields and token, keeps privilege, and the next turn is a fresh session", async () => {
    const { srv, morgan } = await office();
    const agent = await spawn(srv, "Mover", "Alice");
    await srv.agentManager.setPrivileged(agent.id, true);
    const old = await runTurn(srv, agent.id);
    const oldToken = getAgentTokenRaw(agent.id)!;
    expect(resolveToken(oldToken)?.userId).toBe(idOf("Alice"));

    const res = await setManager(
      srv,
      agent.id,
      idOf("Bea"),
      morgan.rawSessionId,
    );
    expect(res.status).toBe(200);
    expect((res.body as { agent: AgentInfo }).agent).toMatchObject({
      id: agent.id,
      userId: idOf("Bea"),
      manager: "Bea",
      privileged: true,
    });
    expect(agentOf(srv, agent.id)).toMatchObject({
      userId: idOf("Bea"),
      manager: "Bea",
      privileged: true,
    });
    // agents.json names the manager under `manager` only: the old
    // `username` key went one release after task f41c93e9 (task 744fa64a).
    await waitUntil(
      () => persistedAgent(srv, agent.id)?.manager === "Bea",
      "agents.json names the new manager",
    );
    expect(persistedAgent(srv, agent.id)).toMatchObject({
      userId: idOf("Bea"),
      manager: "Bea",
    });
    expect(Object.keys(persistedAgent(srv, agent.id)!)).not.toContain(
      "username",
    );

    // The token is re-minted for the new manager, with the same privilege.
    const token = getAgentTokenRaw(agent.id)!;
    expect(resolveToken(oldToken)).toBeNull();
    const identity = resolveToken(token)!;
    expect(identity.userId).toBe(idOf("Bea"));
    expect(identityHasCapability(identity, "agent:manage")).toBe(true);

    // The running session is killed and the chat holds one line, which
    // names the owner who made the change and the new manager.
    expect(old.closed).toBe(true);
    const lines = systemLines(srv, agent.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Morgan");
    expect(lines[0]).toContain("Bea");

    // The next turn starts a new conversation, not a resume of the old one.
    const next = await runTurn(srv, agent.id);
    expect(next).not.toBe(old);
    expect(next.isResume).toBe(false);
    expect(next.sessionId).not.toBe(old.sessionId);
    expect(next.opts.env?.ISOMUX_AGENT_TOKEN).toBe(token);
  });

  it("runs a message queued during the transfer under the new manager's token", async () => {
    // Each turn parks in "thinking": the first message holds the agent busy,
    // so the second waits in the queue.
    const { srv, morgan } = await office(
      new FakeBackend({
        session: {
          onSend: (_t, _a, s) =>
            s.push({ kind: "assistant_text", text: "..." }),
        },
      }),
    );
    const agent = await spawn(srv, "Busy", "Alice");
    const sender = { kind: "user" as const, username: "tester" };
    srv.agentManager.enqueueMessage(agent.id, { sender, text: "first" });
    await waitUntil(
      () => agentOf(srv, agent.id).state === "thinking",
      "first turn running",
    );
    const old = latestSession(srv, agent.id);
    srv.agentManager.enqueueMessage(agent.id, { sender, text: "second" });
    expect(queueOf(srv, agent.id).some((q) => q.text === "second")).toBe(true);

    const res = await setManager(
      srv,
      agent.id,
      idOf("Bea"),
      morgan.rawSessionId,
    );
    expect(res.status).toBe(200);

    await waitUntil(
      () =>
        srv.fakeBackend.sessions.some(
          (s) =>
            s !== old &&
            s.opts.agentId === agent.id &&
            s.sent.some((m) => m.text.includes("second")),
        ),
      "queued message sent in a fresh session",
    );
    const fresh = srv.fakeBackend.sessions.find(
      (s) =>
        s !== old &&
        s.opts.agentId === agent.id &&
        s.sent.some((m) => m.text.includes("second")),
    )!;
    expect(old.closed).toBe(true);
    expect(fresh.isResume).toBe(false);
    const freshToken = fresh.opts.env?.ISOMUX_AGENT_TOKEN;
    expect(freshToken).toBe(getAgentTokenRaw(agent.id)!);
    expect(resolveToken(freshToken!)?.userId).toBe(idOf("Bea"));
  });

  it("does nothing when the member already manages the agent", async () => {
    const { srv, morgan } = await office();
    const agent = await spawn(srv, "Stays", "Alice");
    const session = await runTurn(srv, agent.id);
    const token = getAgentTokenRaw(agent.id);
    const logLength = srv.agentManager.getAgentLogs(agent.id).length;
    expect(logLength).toBeGreaterThan(0);

    const res = await setManager(
      srv,
      agent.id,
      idOf("Alice"),
      morgan.rawSessionId,
    );
    expect(res.status).toBe(200);
    expect(getAgentTokenRaw(agent.id)).toBe(token);
    expect(session.closed).toBe(false);
    expect(srv.agentManager.getAgentLogs(agent.id)).toHaveLength(logLength);
  });

  it("answers a bad body, an unknown member, an unknown agent and a member caller", async () => {
    const { srv, morgan, alice } = await office();
    const agent = await spawn(srv, "Target", "Alice");

    for (const bad of [undefined, 42, ""]) {
      const r = await setManager(srv, agent.id, bad, morgan.rawSessionId);
      expect(r.status).toBe(422);
      expect(errCode(r)).toBe("invalid_request");
    }
    const unknown = await setManager(
      srv,
      agent.id,
      "u-nobody",
      morgan.rawSessionId,
    );
    expect(unknown.status).toBe(422);
    expect(errCode(unknown)).toBe("unknown_member");

    const noAgent = await setManager(
      srv,
      "agent-nope",
      idOf("Bea"),
      morgan.rawSessionId,
    );
    expect(noAgent.status).toBe(404);
    expect(errCode(noAgent)).toBe("agent_not_found");

    // The agent's own manager cannot give it away.
    const byMember = await setManager(
      srv,
      agent.id,
      idOf("Bea"),
      alice.rawSessionId,
    );
    expect(byMember.status).toBe(403);
    // None of the refusals changed anything.
    expect(agentOf(srv, agent.id).userId).toBe(idOf("Alice"));
  });
});

describe("agents.setManager: what the agent made moves with it", () => {
  it("moves the agent's apps, schedules and webhooks that the old manager owns, and nothing else", async () => {
    const { srv, morgan } = await office();
    const agent = await spawn(srv, "Maker", "Alice");
    // Only a privileged agent manages schedules.
    await srv.agentManager.setPrivileged(agent.id, true);
    const bearer = getAgentTokenRaw(agent.id)!;
    const aliceId = idOf("Alice");

    // Made by the agent through the API: each records the agent.
    const cron = await api(
      srv,
      "POST",
      "/api/cronjobs",
      { bearer },
      {
        name: "by agent",
        prompt: "Check the build.",
        cwd: srv.stateRoot,
        schedule: { type: "interval", minutes: 60 },
        agentType: "claude",
        modelFamily: "opus",
        effort: "medium",
        permissionMode: "bypassPermissions",
      },
    );
    expect(cron.status).toBe(201);
    const byAgent = cron.body as Cronjob;
    expect(byAgent.userId).toBe(aliceId);
    const job = (id: string): Cronjob =>
      srv.cronjobManager.listCronjobs().find((j) => j.id === id)!;
    expect(job(byAgent.id).createdByAgentId).toBe(agent.id);

    const hook = await api(
      srv,
      "POST",
      "/api/webhooks",
      { bearer },
      {
        name: "wake",
        scheme: "github-hmac-sha256",
        rules: [{ event: "push" }],
      },
    );
    expect(hook.status).toBe(201);
    expect((hook.body as WebhookWire).userId).toBe(aliceId);

    const app = await api(
      srv,
      "POST",
      "/api/apps",
      { bearer },
      {
        name: "maker-app",
        command: "bun run serve.ts",
        cwd: srv.stateRoot,
      },
    );
    expect(app.status).toBe(201);
    const appToken = srv.appSupervisor.tokenFiles.get("maker-app")!;
    // The app has its privileged owner agent's reach while both share a
    // manager.
    expect(
      (await api(srv, "GET", "/api/cronjobs", { bearer: appToken })).status,
    ).toBe(200);

    const add = (username: string, extra: Partial<Cronjob> = {}) =>
      srv.cronjobManager.addCronjob({
        name: "seeded",
        schedule: { type: "interval", minutes: 60 },
        prompt: "p",
        cwd: srv.stateRoot,
        agentType: "claude",
        modelFamily: "opus",
        effort: "medium",
        permissionMode: "bypassPermissions",
        username,
        userId: idOf(username),
        ...(extra.createdByAgentId
          ? { createdByAgentId: extra.createdByAgentId }
          : {}),
      });
    const agentRow = (jobId: string, time: number) =>
      officeAuditStore().insert({
        time,
        actor: {
          kind: "agent",
          id: agent.id,
          name: agent.name,
          ownerId: aliceId,
        },
        operation: "cron.create",
        targets: [jobId],
        fields: [],
      });
    // Alice's own job: no agent made it.
    const byAlice = add("Alice");
    // Made by the agent before jobs recorded their agent: only the audit log
    // knows.
    const legacy = add("Alice");
    expect(legacy.createdByAgentId).toBeUndefined();
    agentRow(legacy.id, legacy.createdAt);
    // Alice's job whose id an old, deleted job of the agent once had.
    const reused = add("Alice");
    agentRow(reused.id, reused.createdAt - 30 * 24 * 60 * 60 * 1000);
    // Made by the agent, but a third member owns it now.
    const third = add("Cleo", { createdByAgentId: agent.id });
    expect(third.createdByAgentId).toBe(agent.id);

    const res = await setManager(
      srv,
      agent.id,
      idOf("Bea"),
      morgan.rawSessionId,
    );
    expect(res.status).toBe(200);

    const beaId = idOf("Bea");
    for (const id of [byAgent.id, legacy.id])
      expect(job(id)).toMatchObject({ userId: beaId, username: "Bea" });
    for (const id of [byAlice.id, reused.id])
      expect(job(id)).toMatchObject({ userId: aliceId, username: "Alice" });
    expect(job(third.id)).toMatchObject({ userId: idOf("Cleo") });

    const hookNow = await api(
      srv,
      "GET",
      `/api/webhooks/${(hook.body as WebhookWire).id}`,
      { rawSessionId: morgan.rawSessionId },
    );
    expect((hookNow.body as WebhookWire).userId).toBe(beaId);

    const apps = (
      await api(srv, "GET", "/api/apps", { rawSessionId: morgan.rawSessionId })
    ).body as AppListWire[];
    expect(apps.find((a) => a.name === "maker-app")?.userId).toBe(beaId);
    // The same app token keeps its owner agent's reach.
    expect(
      (await api(srv, "GET", "/api/cronjobs", { bearer: appToken })).status,
    ).toBe(200);
  });
});

describe("resuming a session from an earlier manager", () => {
  it("names the manager each session was born under, by their current name, and nothing for the current manager's", async () => {
    const { srv, morgan } = await office();
    const agent = await spawn(srv, "Resumer", "Alice");
    const underAlice = (await runTurn(srv, agent.id)).sessionId;
    expect(
      (await setManager(srv, agent.id, idOf("Bea"), morgan.rawSessionId))
        .status,
    ).toBe(200);
    const underBea = (await runTurn(srv, agent.id)).sessionId;
    expect(
      (await setManager(srv, agent.id, idOf("Cleo"), morgan.rawSessionId))
        .status,
    ).toBe(200);
    const underCleo = (await runTurn(srv, agent.id)).sessionId;
    expect(new Set([underAlice, underBea, underCleo]).size).toBe(3);

    const named = (lines: string[], name: string) =>
      lines.filter((l) => l.includes(name)).length;

    const alice = await resumeLines(srv, agent.id, underAlice);
    expect(named(alice, "Alice")).toBe(1);
    expect(named(alice, "Bea")).toBe(0);

    // The second transfer kept the first stamp and stamped only Bea's session.
    const bea = await resumeLines(srv, agent.id, underBea);
    expect(named(bea, "Bea")).toBe(1);
    expect(named(bea, "Alice")).toBe(0);

    const own = await resumeLines(srv, agent.id, underCleo);
    expect(named(own, "Alice") + named(own, "Bea")).toBe(0);
    // Positive control: this resume did add its own lines.
    expect(own.length).toBeGreaterThan(0);

    // The member's current name, not the name at the transfer.
    expect(updateUserById(idOf("Alice"), { name: "Alicia" }).ok).toBe(true);
    const renamed = await resumeLines(srv, agent.id, underAlice);
    expect(named(renamed, "Alicia")).toBe(1);
  });
});

describe("deleting a member passes their agents to the oldest office owner", () => {
  it("moves live and killed agents, with what they made, to the oldest owner, not to the owner who deletes", async () => {
    const { srv, morgan } = await office();
    // A second owner, newer than Morgan, who deletes Alice.
    await sleep(2);
    const zed = await srv.seedMember("Zed");
    expect(setUserRoleById(idOf("Zed"), "owner")).toBe(true);
    const morganId = idOf("Morgan");
    expect(getUserById(morganId)!.createdAt).toBeLessThan(
      getUserById(idOf("Zed"))!.createdAt,
    );
    void morgan;

    const live = await spawn(srv, "Live", "Alice");
    await srv.agentManager.setPrivileged(live.id, true);
    const old = await runTurn(srv, live.id);
    const bearer = getAgentTokenRaw(live.id)!;
    const cron = await api(
      srv,
      "POST",
      "/api/cronjobs",
      { bearer },
      {
        name: "by agent",
        prompt: "Check the build.",
        cwd: srv.stateRoot,
        schedule: { type: "interval", minutes: 60 },
        agentType: "claude",
        modelFamily: "opus",
        effort: "medium",
        permissionMode: "bypassPermissions",
      },
    );
    expect(cron.status).toBe(201);
    const hook = await api(
      srv,
      "POST",
      "/api/webhooks",
      { bearer },
      {
        name: "wake",
        scheme: "github-hmac-sha256",
        rules: [{ event: "push" }],
      },
    );
    expect(hook.status).toBe(201);
    const app = await api(
      srv,
      "POST",
      "/api/apps",
      { bearer },
      {
        name: "live-app",
        command: "bun run serve.ts",
        cwd: srv.stateRoot,
      },
    );
    expect(app.status).toBe(201);

    const killed = await spawn(srv, "Gone", "Alice");
    await srv.agentManager.kill(killed.id);
    expect(srv.agentManager.killedAgentManagerUserId(killed.id)).toBe(
      idOf("Alice"),
    );

    const del = await api(srv, "DELETE", "/api/users/Alice", {
      rawSessionId: zed.rawSessionId,
    });
    expect(del.status).toBeLessThan(300);
    expect(getUserByName("Alice")).toBeUndefined();

    expect(agentOf(srv, live.id)).toMatchObject({
      userId: morganId,
      manager: "Morgan",
      privileged: true,
    });
    // Both stores name the manager under `manager` only.
    await waitUntil(
      () =>
        persistedAgent(srv, live.id)?.manager === "Morgan" &&
        persistedHistory(srv, killed.id)?.manager === "Morgan",
      "agents.json and agent-history.json name the new manager",
    );
    expect(persistedAgent(srv, live.id)).toMatchObject({
      userId: morganId,
      manager: "Morgan",
    });
    expect(persistedHistory(srv, killed.id)).toMatchObject({
      userId: morganId,
      manager: "Morgan",
    });
    for (const record of [
      persistedAgent(srv, live.id)!,
      persistedHistory(srv, killed.id)!,
    ])
      expect(Object.keys(record)).not.toContain("username");
    expect(resolveToken(getAgentTokenRaw(live.id)!)?.userId).toBe(morganId);
    expect(old.closed).toBe(true);
    expect(srv.agentManager.killedAgentManagerUserId(killed.id)).toBe(morganId);

    const job = srv.cronjobManager
      .listCronjobs()
      .find((j) => j.id === (cron.body as Cronjob).id)!;
    expect(job).toMatchObject({ userId: morganId, username: "Morgan" });
    const hookNow = await api(
      srv,
      "GET",
      `/api/webhooks/${(hook.body as WebhookWire).id}`,
      { rawSessionId: zed.rawSessionId },
    );
    expect((hookNow.body as WebhookWire).userId).toBe(morganId);
    const apps = (
      await api(srv, "GET", "/api/apps", { rawSessionId: zed.rawSessionId })
    ).body as AppListWire[];
    expect(apps.find((a) => a.name === "live-app")?.userId).toBe(morganId);

    // A session from Alice's time still names her after her record is gone.
    const lines = await resumeLines(srv, live.id, old.sessionId);
    expect(lines.filter((l) => l.includes("Alice"))).toHaveLength(1);
  });

  // The member could read the secret of every hook they owned, so each one
  // passes turned off, with a secret they never saw (task 438900d2).
  it("passes every webhook and schedule the member owns turned off, each webhook with a new secret, to the oldest owner", async () => {
    const { srv, morgan, alice } = await office();
    const morganId = idOf("Morgan");
    const as = (rawSessionId: string) => ({ rawSessionId });
    const makeHook = async (
      caller: { rawSessionId?: string; bearer?: string },
      name: string,
      target?: unknown,
    ): Promise<WebhookWire> => {
      const res = await api(srv, "POST", "/api/webhooks", caller, {
        name,
        scheme: "github-hmac-sha256",
        rules: [{ event: "push" }],
        ...(target ? { target } : {}),
      });
      expect(res.status).toBe(201);
      return res.body as WebhookWire;
    };
    const secretOf = async (rawSessionId: string, id: string) => {
      const res = await api(srv, "GET", `/api/webhooks/${id}/secret`, {
        rawSessionId,
      });
      expect(res.status).toBe(200);
      return (res.body as { secret: string }).secret;
    };
    const hookNow = async (id: string): Promise<WebhookWire> => {
      const res = await api(
        srv,
        "GET",
        `/api/webhooks/${id}`,
        as(morgan.rawSessionId),
      );
      expect(res.status).toBe(200);
      return res.body as WebhookWire;
    };
    // A GitHub push, signed with `secret`: the signature is the only
    // credential the public route takes. A body of its own each time, since
    // the route drops a repeated body as a duplicate.
    const deliver = async (id: string, secret: string) => {
      const body = new TextEncoder().encode(
        JSON.stringify({ ref: "main", after: randomUUID() }),
      );
      const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      const res = await fetch(`${srv.baseUrl}/hooks/${id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Connection: "close",
          "X-GitHub-Event": "push",
          "X-GitHub-Delivery": randomUUID(),
          "X-Hub-Signature-256": signature,
        },
        body,
      });
      await res.text();
      return res.status;
    };

    // Made by Alice herself: a schedule, and a hook that runs it.
    const cron = await api(
      srv,
      "POST",
      "/api/cronjobs",
      as(alice.rawSessionId),
      {
        name: "by hand",
        prompt: "Triage the push.",
        cwd: srv.stateRoot,
        schedule: { type: "none" },
        agentType: "claude",
        modelFamily: "opus",
        effort: "medium",
        permissionMode: "bypassPermissions",
      },
    );
    expect(cron.status).toBe(201);
    const jobId = (cron.body as Cronjob).id;
    const job = () =>
      srv.cronjobManager.listCronjobs().find((j) => j.id === jobId)!;
    expect(job().userId).toBe(idOf("Alice"));
    expect(job().createdByAgentId).toBeUndefined();
    expect(job().enabled).toBe(true);
    const runs = () => srv.cronjobManager.getRunsForCronjob(jobId).length;
    const byHand = await makeHook(as(alice.rawSessionId), "by-hand", {
      kind: "cronjob",
      cronjobId: jobId,
    });

    // Made by her agents: one still live, one killed before the delete.
    const live = await spawn(srv, "Live", "Alice");
    await srv.agentManager.setPrivileged(live.id, true);
    const byAgent = await makeHook(
      { bearer: getAgentTokenRaw(live.id)! },
      "by-agent",
    );
    const agentCron = await api(
      srv,
      "POST",
      "/api/cronjobs",
      { bearer: getAgentTokenRaw(live.id)! },
      {
        name: "by agent",
        prompt: "Check the build.",
        cwd: srv.stateRoot,
        schedule: { type: "interval", minutes: 60 },
        agentType: "claude",
        modelFamily: "opus",
        effort: "medium",
        permissionMode: "bypassPermissions",
      },
    );
    expect(agentCron.status).toBe(201);
    const agentJobId = (agentCron.body as Cronjob).id;
    const agentJob = () =>
      srv.cronjobManager.listCronjobs().find((j) => j.id === agentJobId)!;
    expect(agentJob()).toMatchObject({
      userId: idOf("Alice"),
      createdByAgentId: live.id,
      enabled: true,
    });
    const gone = await spawn(srv, "Gone", "Alice");
    await srv.agentManager.setPrivileged(gone.id, true);
    const byKilled = await makeHook(
      { bearer: getAgentTokenRaw(gone.id)! },
      "by-killed",
    );
    await srv.agentManager.kill(gone.id);

    // Morgan's own hook: not Alice's, so the delete leaves it as it is.
    const morgans = await makeHook(as(morgan.rawSessionId), "morgans", {
      kind: "agent",
      agentId: live.id,
    });

    const aliceHooks = [byHand, byAgent, byKilled];
    const oldSecrets = new Map<string, string>();
    for (const hook of aliceHooks) {
      expect(hook.userId).toBe(idOf("Alice"));
      expect(hook.enabled).toBe(true);
      oldSecrets.set(hook.id, await secretOf(alice.rawSessionId, hook.id));
    }
    const morgansSecret = await secretOf(morgan.rawSessionId, morgans.id);

    // While Alice is a member, her secret starts a run of her schedule.
    expect(await deliver(byHand.id, oldSecrets.get(byHand.id)!)).toBe(202);
    expect(runs()).toBe(1);

    const del = await api(
      srv,
      "DELETE",
      "/api/users/Alice",
      as(morgan.rawSessionId),
    );
    expect(del.status).toBeLessThan(300);
    expect(getUserByName("Alice")).toBeUndefined();

    for (const hook of aliceHooks) {
      expect(await hookNow(hook.id)).toMatchObject({
        userId: morganId,
        enabled: false,
      });
      expect(await secretOf(morgan.rawSessionId, hook.id)).not.toBe(
        oldSecrets.get(hook.id),
      );
    }
    expect(await hookNow(morgans.id)).toMatchObject({
      userId: morganId,
      enabled: true,
    });
    expect(await secretOf(morgan.rawSessionId, morgans.id)).toBe(morgansSecret);

    // Her schedules pass to Morgan turned off, also the one her agent made
    // (Nil, 2026-10-25): Morgan reads each one and turns it on again.
    for (const passed of [job(), agentJob()])
      expect(passed).toMatchObject({
        userId: morganId,
        username: "Morgan",
        enabled: false,
      });

    // Alice's secret no longer starts a run: the hook is off...
    expect(await deliver(byHand.id, oldSecrets.get(byHand.id)!)).toBe(404);
    expect(runs()).toBe(1);
    // ...and when Morgan turns it on again, her secret is still refused,
    // while the new one runs the schedule.
    const on = await api(
      srv,
      "PATCH",
      `/api/webhooks/${byHand.id}`,
      as(morgan.rawSessionId),
      { enabled: true },
    );
    expect(on.status).toBe(200);
    expect(await deliver(byHand.id, oldSecrets.get(byHand.id)!)).toBe(401);
    expect(runs()).toBe(1);
    expect(
      await deliver(byHand.id, await secretOf(morgan.rawSessionId, byHand.id)),
    ).toBe(202);
    expect(runs()).toBe(2);
  });
  // An agent's records become the heir's when its transfer returns, and the
  // delete then awaits the next agent's drain. A record that became the
  // heir's on would run in that window with the heir's environment, on what
  // the member wrote (task be7708d3).
  it("turns the member's records off before an agent transfer gives them to the heir", async () => {
    // A closed session's stream stays open until the test ends it, which
    // parks the delete in each agent's transfer.
    const { srv, morgan } = await office(
      new FakeBackend({
        session: {
          onSend: (_t, _a, session) => session.completeTurn({ text: "ok" }),
          hangOnClose: true,
        },
      }),
    );
    const morganId = idOf("Morgan");
    const agents = [
      await spawn(srv, "One", "Alice"),
      await spawn(srv, "Two", "Alice"),
    ];
    const made = new Map<string, { jobId: string; hookId: string }>();
    for (const agent of agents) {
      await srv.agentManager.setPrivileged(agent.id, true);
      await runTurn(srv, agent.id);
      const bearer = getAgentTokenRaw(agent.id)!;
      const cron = await api(
        srv,
        "POST",
        "/api/cronjobs",
        { bearer },
        {
          name: `by ${agent.name}`,
          prompt: "Check the build.",
          cwd: srv.stateRoot,
          schedule: { type: "interval", minutes: 60 },
          agentType: "claude",
          modelFamily: "opus",
          effort: "medium",
          permissionMode: "bypassPermissions",
        },
      );
      expect(cron.status).toBe(201);
      const hook = await api(
        srv,
        "POST",
        "/api/webhooks",
        { bearer },
        {
          name: `wake-${agent.name.toLowerCase()}`,
          scheme: "github-hmac-sha256",
          rules: [{ event: "push" }],
        },
      );
      expect(hook.status).toBe(201);
      made.set(agent.id, {
        jobId: (cron.body as Cronjob).id,
        hookId: (hook.body as WebhookWire).id,
      });
    }
    const jobOf = (agentId: string) =>
      srv.cronjobManager
        .listCronjobs()
        .find((j) => j.id === made.get(agentId)!.jobId)!;
    const hookOf = async (agentId: string): Promise<WebhookWire> => {
      const res = await api(
        srv,
        "GET",
        `/api/webhooks/${made.get(agentId)!.hookId}`,
        { rawSessionId: morgan.rawSessionId },
      );
      expect(res.status).toBe(200);
      return res.body as WebhookWire;
    };
    for (const agent of agents) {
      expect(jobOf(agent.id)).toMatchObject({
        userId: idOf("Alice"),
        enabled: true,
      });
      expect(await hookOf(agent.id)).toMatchObject({
        userId: idOf("Alice"),
        enabled: true,
      });
    }

    const sessions = new Map(
      agents.map((a) => [a.id, latestSession(srv, a.id)] as const),
    );
    const removing = api(srv, "DELETE", "/api/users/Alice", {
      rawSessionId: morgan.rawSessionId,
    });
    try {
      // The delete parks in the first transfer; ending that drain lets the
      // first agent's records move, and the delete parks in the second.
      await waitUntil(
        () => agents.some((a) => sessions.get(a.id)!.closed),
        "the delete parked in the first transfer",
      );
      const first = agents.find((a) => sessions.get(a.id)!.closed)!;
      const second = agents.find((a) => a.id !== first.id)!;
      expect(sessions.get(second.id)!.closed).toBe(false);
      sessions.get(first.id)!.endStream();
      await waitUntil(
        () => sessions.get(second.id)!.closed,
        "the delete parked in the second transfer",
      );

      // The first agent's records are the heir's now, and off.
      expect(jobOf(first.id)).toMatchObject({
        userId: morganId,
        enabled: false,
      });
      expect(await hookOf(first.id)).toMatchObject({
        userId: morganId,
        enabled: false,
      });
    } finally {
      // A red run must not leave the delete parked into the next test.
      for (const session of sessions.values()) session.endStream();
      await removing.catch(() => null);
    }
    expect((await removing).status).toBeLessThan(300);
    expect(getUserByName("Alice")).toBeUndefined();
    for (const agent of agents) {
      expect(jobOf(agent.id)).toMatchObject({
        userId: morganId,
        enabled: false,
      });
      expect(await hookOf(agent.id)).toMatchObject({
        userId: morganId,
        enabled: false,
      });
    }
  });
});

// The manager snapshot on the agent is a display name; the prompt finds the
// manager by userId, so a rename keeps the manager's section, their special
// instructions and their memory under the new name (task f41c93e9).
describe("renaming the manager", () => {
  it("keeps the manager's special instructions and memory in both prompt paths, under the new name", async () => {
    const { srv, morgan } = await office();
    expect(
      updateUserById(idOf("Alice"), { memberPrompt: "MANAGER_PROMPT_MARKER" })
        .ok,
    ).toBe(true);
    const agent = await spawn(srv, "Renamed", "Alice");
    const routePrompt = async (): Promise<string> => {
      const res = await api(
        srv,
        "GET",
        `/api/agents/${agent.id}/system-prompt`,
        { rawSessionId: morgan.rawSessionId },
      );
      expect(res.status).toBe(200);
      return (res.body as { prompt: string }).prompt;
    };
    const sessionPrompt = async (): Promise<string> => {
      await srv.agentManager.newConversation(agent.id);
      return (await runTurn(srv, agent.id)).opts.systemPrompt ?? "";
    };

    // Enabling condition: both paths carry the manager's instructions.
    for (const prompt of [await routePrompt(), await sessionPrompt()]) {
      expect(prompt).toContain("MANAGER_PROMPT_MARKER");
      expect(prompt).toContain(`"Alice"`);
    }

    const renamed = await api(
      srv,
      "PATCH",
      "/api/users/Alice",
      { rawSessionId: morgan.rawSessionId },
      { name: "Alicia" },
    );
    expect(renamed.status).toBe(200);
    expect(getUserById(agentOf(srv, agent.id).userId)?.name).toBe("Alicia");

    for (const prompt of [await routePrompt(), await sessionPrompt()]) {
      expect(prompt).toContain("MANAGER_PROMPT_MARKER");
      expect(prompt).toContain(`"Alicia"`);
      expect(prompt).not.toContain(`"Alice"`);
    }

    // The member-memory block is labeled with the current name too.
    const saved = await api(
      srv,
      "POST",
      "/api/memory",
      { rawSessionId: morgan.rawSessionId },
      {
        scope: "member",
        scopeId: idOf("Alicia"),
        text: "MANAGER_MEMORY_MARKER",
      },
    );
    expect(saved.status).toBe(201);
    for (const prompt of [await routePrompt(), await sessionPrompt()]) {
      const lines = prompt.split("\n");
      const at = lines.findIndex((l) => l.includes("MANAGER_MEMORY_MARKER"));
      expect(at).toBeGreaterThan(0);
      expect(lines[at - 1]).toContain(`"Alicia"`);
    }
  });
});
