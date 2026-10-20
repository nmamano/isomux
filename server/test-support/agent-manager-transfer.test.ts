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
//     office owner, not to the owner who deletes.
//
// Seam: startTestServer() with a FakeBackend. Zero LLM. Copy is never matched:
// a system line is found by the member names it carries.

import { describe, it, expect, afterEach } from "bun:test";
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

// An office: owner Boss, members Alice, Bea and Cleo, each with access to
// the first room.
async function office(backend = completingBackend()) {
  const srv = await startTestServer({ fakeBackend: backend });
  server = srv;
  const boss = await srv.seedOwner("Boss");
  const roomId = srv.agentManager.getRooms()[0].id;
  const alice = await srv.seedMember("Alice");
  await srv.seedMember("Bea");
  await srv.seedMember("Cleo");
  for (const name of ["Alice", "Bea", "Cleo"])
    expect(updateUserById(idOf(name), { allowedRooms: [roomId] }).ok).toBe(
      true,
    );
  return { srv, boss, alice };
}

describe("agents.setManager: the agent itself", () => {
  it("changes the manager fields and token, keeps privilege, and the next turn is a fresh session", async () => {
    const { srv, boss } = await office();
    const agent = await spawn(srv, "Mover", "Alice");
    await srv.agentManager.setPrivileged(agent.id, true);
    const old = await runTurn(srv, agent.id);
    const oldToken = getAgentTokenRaw(agent.id)!;
    expect(resolveToken(oldToken)?.userId).toBe(idOf("Alice"));

    const res = await setManager(srv, agent.id, idOf("Bea"), boss.rawSessionId);
    expect(res.status).toBe(200);
    expect((res.body as { agent: AgentInfo }).agent).toMatchObject({
      id: agent.id,
      userId: idOf("Bea"),
      username: "Bea",
      privileged: true,
    });
    expect(agentOf(srv, agent.id)).toMatchObject({
      userId: idOf("Bea"),
      username: "Bea",
      privileged: true,
    });

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
    expect(lines[0]).toContain("Boss");
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
    const { srv, boss } = await office(
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

    const res = await setManager(srv, agent.id, idOf("Bea"), boss.rawSessionId);
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
    const { srv, boss } = await office();
    const agent = await spawn(srv, "Stays", "Alice");
    const session = await runTurn(srv, agent.id);
    const token = getAgentTokenRaw(agent.id);
    const logLength = srv.agentManager.getAgentLogs(agent.id).length;
    expect(logLength).toBeGreaterThan(0);

    const res = await setManager(
      srv,
      agent.id,
      idOf("Alice"),
      boss.rawSessionId,
    );
    expect(res.status).toBe(200);
    expect(getAgentTokenRaw(agent.id)).toBe(token);
    expect(session.closed).toBe(false);
    expect(srv.agentManager.getAgentLogs(agent.id)).toHaveLength(logLength);
  });

  it("answers a bad body, an unknown member, an unknown agent and a member caller", async () => {
    const { srv, boss, alice } = await office();
    const agent = await spawn(srv, "Target", "Alice");

    for (const bad of [undefined, 42, ""]) {
      const r = await setManager(srv, agent.id, bad, boss.rawSessionId);
      expect(r.status).toBe(422);
      expect(errCode(r)).toBe("invalid_request");
    }
    const unknown = await setManager(
      srv,
      agent.id,
      "u-nobody",
      boss.rawSessionId,
    );
    expect(unknown.status).toBe(422);
    expect(errCode(unknown)).toBe("unknown_member");

    const noAgent = await setManager(
      srv,
      "agent-nope",
      idOf("Bea"),
      boss.rawSessionId,
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
    const { srv, boss } = await office();
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

    const res = await setManager(srv, agent.id, idOf("Bea"), boss.rawSessionId);
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
      { rawSessionId: boss.rawSessionId },
    );
    expect((hookNow.body as WebhookWire).userId).toBe(beaId);

    const apps = (
      await api(srv, "GET", "/api/apps", { rawSessionId: boss.rawSessionId })
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
    const { srv, boss } = await office();
    const agent = await spawn(srv, "Resumer", "Alice");
    const underAlice = (await runTurn(srv, agent.id)).sessionId;
    expect(
      (await setManager(srv, agent.id, idOf("Bea"), boss.rawSessionId)).status,
    ).toBe(200);
    const underBea = (await runTurn(srv, agent.id)).sessionId;
    expect(
      (await setManager(srv, agent.id, idOf("Cleo"), boss.rawSessionId)).status,
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
    const { srv, boss } = await office();
    // A second owner, newer than Boss, who deletes Alice.
    await sleep(2);
    const zed = await srv.seedMember("Zed");
    expect(setUserRoleById(idOf("Zed"), "owner")).toBe(true);
    const bossId = idOf("Boss");
    expect(getUserById(bossId)!.createdAt).toBeLessThan(
      getUserById(idOf("Zed"))!.createdAt,
    );
    void boss;

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
      userId: bossId,
      username: "Boss",
      privileged: true,
    });
    expect(resolveToken(getAgentTokenRaw(live.id)!)?.userId).toBe(bossId);
    expect(old.closed).toBe(true);
    expect(srv.agentManager.killedAgentManagerUserId(killed.id)).toBe(bossId);

    const job = srv.cronjobManager
      .listCronjobs()
      .find((j) => j.id === (cron.body as Cronjob).id)!;
    expect(job).toMatchObject({ userId: bossId, username: "Boss" });
    const hookNow = await api(
      srv,
      "GET",
      `/api/webhooks/${(hook.body as WebhookWire).id}`,
      { rawSessionId: zed.rawSessionId },
    );
    expect((hookNow.body as WebhookWire).userId).toBe(bossId);
    const apps = (
      await api(srv, "GET", "/api/apps", { rawSessionId: zed.rawSessionId })
    ).body as AppListWire[];
    expect(apps.find((a) => a.name === "live-app")?.userId).toBe(bossId);

    // A session from Alice's time still names her after her record is gone.
    const lines = await resumeLines(srv, live.id, old.sessionId);
    expect(lines.filter((l) => l.includes("Alice"))).toHaveLength(1);
  });
});
