// Member usage cap (task 6de8f530, internal-docs/usage-caps-design.md) through
// the real server: who is capped on which path, what a refusal does to the
// queue, the session and a cron run, and the owner's switch.
//
// Seam: startTestServer() with a parking FakeBackend, and the office's cap
// swapped for one over a scripted reader, so no provider is ever read.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { buildOfficeEnv } from "../env-loader.ts";
import { effectiveProviderDirectory } from "../provider-account-manager.ts";
import {
  createMemberUsageCap,
  memberUsageCap,
  officeUsageTarget,
  setMemberUsageCapForTests,
} from "../member-usage-cap.ts";
import {
  createOfficeUsageReader,
  WEEK_MS,
  type OfficeUsageProbe,
  type OfficeWeeklyOutcome,
} from "../office-usage.ts";
import { loadMemberUsageCap, saveMemberUsageCap } from "../persistence.ts";
import { STATE_ROOT } from "../config.ts";
import { claudeProjectDir } from "../cwd-utils.ts";
import { setTestManagedOfficeEnv } from "./managed-office-env.ts";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";
import type { OfficeSettingsRes } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => {
  setMemberUsageCapForTests(null);
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

// Ahead of the pace line (60% used at mid-week) or behind it (40%).
function weekly(usedPercent: number): OfficeWeeklyOutcome {
  return {
    kind: "weekly",
    usedPercent,
    resetsAtMs: Date.now() + WEEK_MS / 2,
    observedAtMs: Date.now(),
  };
}
const AHEAD = () => weekly(60);
const BEHIND = () => weekly(40);

// Swap in a cap over a scripted reader. `reading` is read on every admission.
function installCap(opts: { enabled?: boolean } = {}) {
  const state = { reading: AHEAD, reads: 0 };
  setMemberUsageCapForTests(
    createMemberUsageCap({
      reader: {
        async read() {
          state.reads++;
          return state.reading();
        },
        invalidate() {},
        close() {},
      },
      officeDir: (provider) =>
        effectiveProviderDirectory(provider, buildOfficeEnv()),
      load: opts.enabled === false ? loadMemberUsageCap : () => true,
      save: saveMemberUsageCap,
    }),
  );
  return state;
}

// A backend that parks each turn in "thinking" until completeTurn().
function parkingBackend(): FakeBackend {
  return new FakeBackend({
    storedSessionState: "missing",
    session: {
      onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
    },
  });
}

async function spawnFor(
  srv: TestServer,
  name: string,
  username: string,
): Promise<AgentInfo> {
  const room = srv.agentManager.getRooms()[0];
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    room.id,
    undefined,
    undefined,
    undefined,
    username,
    "claude",
    undefined,
    getUserByName(username)?.id ?? null,
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

function sentTexts(srv: TestServer, agentId: string): string[] {
  return (srv.fakeBackend.sessionForAgent(agentId)?.sent ?? []).map(
    (m) => m.text,
  );
}

function errors(srv: TestServer, agentId: string): LogEntry[] {
  return srv.agentManager
    .getAgentLogs(agentId)
    .filter((entry) => entry.kind === "error");
}

function stateOf(srv: TestServer, id: string): string {
  return srv.agentManager.getAllAgents().find((a) => a.id === id)!.state;
}

function queueOf(srv: TestServer, id: string): AgentInfo["queue"] {
  return srv.agentManager.getAllAgents().find((a) => a.id === id)!.queue;
}

async function postAsAgent(
  srv: TestServer,
  path: string,
  senderId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await srv.http(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAgentTokenRaw(senderId)}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// A member turn is refused or sent: wait for whichever comes first, so a test
// whose gate is broken fails on its no-send assertion, not on a timeout.
async function refusedOrSent(srv: TestServer, agentId: string) {
  await waitUntil(
    () => errors(srv, agentId).length > 0 || sentTexts(srv, agentId).length > 0,
    1000,
    "turn refused or sent",
  );
}

// The conditions a refusal needs: the cap on, and Alice a member.
function expectCappedSetup(cap: { reads: number }) {
  expect(memberUsageCap().isEnabled()).toBe(true);
  expect(getUserByName("Alice")?.role).toBe("member");
  expect(cap.reads).toBe(0);
}

async function boot() {
  const srv = await startTestServer({ fakeBackend: parkingBackend() });
  server = srv;
  const owner = await srv.seedOwner("Boss");
  const member = await srv.seedMember("Alice");
  return { srv, owner, member };
}

describe("member usage cap: direct human input", () => {
  it("refuses a member's message ahead of pace, runs it behind pace, and never stops the owner", async () => {
    const { srv } = await boot();
    const agent = await spawnFor(srv, "AliceBot", "Alice");
    const cap = installCap();

    expectCappedSetup(cap);
    void srv.agentManager.sendMessage(agent.id, "member hello", "Alice");
    await refusedOrSent(srv, agent.id);
    expect(sentTexts(srv, agent.id)).toEqual([]);
    expect(errors(srv, agent.id)).toHaveLength(1);
    // The refusal came from reading the office account.
    expect(cap.reads).toBeGreaterThan(0);
    expect(stateOf(srv, agent.id)).toBe("waiting_for_response");

    // The owner's own input to a member's agent is never capped.
    void srv.agentManager.sendMessage(agent.id, "owner hello", "Boss");
    await waitUntil(
      () =>
        sentTexts(srv, agent.id).some((t) => t.includes("owner hello")) ||
        errors(srv, agent.id).length > 1,
      2000,
      "owner turn sent or refused",
    );
    expect(errors(srv, agent.id)).toHaveLength(1);
    srv.fakeBackend.sessionForAgent(agent.id)!.completeTurn();
    await waitUntil(() => stateOf(srv, agent.id) === "waiting_for_response");

    cap.reading = BEHIND;
    void srv.agentManager.sendMessage(agent.id, "member again", "Alice");
    await waitUntil(
      () => sentTexts(srv, agent.id).some((t) => t.includes("member again")),
      2000,
      "member turn sent behind pace",
    );
  });

  it("refuses a member's skill before it runs", async () => {
    const { srv } = await boot();
    const skillDir = join(STATE_ROOT, "skills", "capskill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "skill body marker");
    const agent = await spawnFor(srv, "AliceBot", "Alice");
    const cap = installCap();

    expectCappedSetup(cap);
    void srv.agentManager.sendMessage(agent.id, "/capskill", "Alice");
    await refusedOrSent(srv, agent.id);
    expect(sentTexts(srv, agent.id)).toEqual([]);
    expect(errors(srv, agent.id)).toHaveLength(1);
    expect(cap.reads).toBeGreaterThan(0);
    expect(stateOf(srv, agent.id)).toBe("waiting_for_response");

    cap.reading = BEHIND;
    void srv.agentManager.sendMessage(agent.id, "/capskill", "Alice");
    await waitUntil(
      () =>
        sentTexts(srv, agent.id).some((t) => t.includes("skill body marker")),
      2000,
      "skill sent behind pace",
    );
  });

  it("does nothing while the owner leaves it off", async () => {
    const { srv } = await boot();
    const agent = await spawnFor(srv, "AliceBot", "Alice");
    const cap = installCap({ enabled: false });

    void srv.agentManager.sendMessage(agent.id, "member hello", "Alice");
    await waitUntil(
      () => sentTexts(srv, agent.id).some((t) => t.includes("member hello")),
      2000,
      "turn sent with the cap off",
    );
    expect(cap.reads).toBe(0);
  });
});

describe("member usage cap: queued input", () => {
  it("drains only the capped items of a batch and sends the rest", async () => {
    const { srv } = await boot();
    const agent = await spawnFor(srv, "AliceBot", "Alice");
    const ownerAgent = await spawnFor(srv, "BossBot", "Boss");
    const cap = installCap();
    cap.reading = BEHIND;

    // Hold the agent busy so every message queues.
    void srv.agentManager.sendMessage(agent.id, "first", "Boss");
    await waitUntil(() => sentTexts(srv, agent.id).length === 1);
    void srv.agentManager.sendMessage(agent.id, "owner queued", "Boss");
    void srv.agentManager.sendMessage(agent.id, "member queued", "Alice");
    // No human sent this one, and the receiver's manager is a member.
    const fromAgent = await postAsAgent(
      srv,
      `/api/agents/${agent.id}/messages`,
      ownerAgent.id,
      { text: "agent queued" },
    );
    expect(fromAgent.status).toBe(200);
    await waitUntil(() => (queueOf(srv, agent.id) ?? []).length === 3);

    cap.reading = AHEAD;
    srv.fakeBackend.sessionForAgent(agent.id)!.completeTurn();
    // The flush settles when the queue is empty, whatever it sent: a kept
    // item leaves the queue only once its send is accepted.
    await waitUntil(
      () =>
        (queueOf(srv, agent.id) ?? []).length === 0 &&
        errors(srv, agent.id).length > 0,
      2000,
      "queue settled",
    );
    const batch = sentTexts(srv, agent.id)[1] ?? "";
    expect(batch).toContain("owner queued");
    expect(batch).not.toContain("member queued");
    expect(batch).not.toContain("agent queued");
    expect(queueOf(srv, agent.id) ?? []).toEqual([]);
    expect(errors(srv, agent.id)).toHaveLength(1);
  });
});

describe("member usage cap: input no human sent", () => {
  it("answers an agent's message to a member's agent with 429 usage_cap", async () => {
    const { srv } = await boot();
    const target = await spawnFor(srv, "AliceBot", "Alice");
    const sender = await spawnFor(srv, "BossBot", "Boss");
    const cap = installCap();

    const refused = await postAsAgent(
      srv,
      `/api/agents/${target.id}/messages`,
      sender.id,
      { text: "please do X" },
    );
    expect(refused.status).toBe(429);
    const error = refused.body.error as { code: string; retryAtMs: number };
    expect(error.code).toBe("usage_cap");
    expect(error.retryAtMs).toBeGreaterThan(Date.now());
    expect(queueOf(srv, target.id) ?? []).toEqual([]);

    // An owner's agent is not capped for the same input.
    const toOwnerAgent = await postAsAgent(
      srv,
      `/api/agents/${sender.id}/messages`,
      target.id,
      { text: "reply" },
    );
    expect(toOwnerAgent.status).toBe(200);

    cap.reading = BEHIND;
    const accepted = await postAsAgent(
      srv,
      `/api/agents/${target.id}/messages`,
      sender.id,
      { text: "please do X" },
    );
    expect(accepted.status).toBe(200);
  });

  it("refuses a handoff before it resets the session", async () => {
    const { srv } = await boot();
    const agent = await spawnFor(srv, "AliceBot", "Alice");
    void srv.agentManager.sendMessage(agent.id, "start", "Boss");
    await waitUntil(() => sentTexts(srv, agent.id).length === 1);
    srv.fakeBackend.sessionForAgent(agent.id)!.completeTurn();
    await waitUntil(() => stateOf(srv, agent.id) === "waiting_for_response");
    const sessionBefore = srv.fakeBackend.sessionForAgent(agent.id);
    installCap();

    const refused = await postAsAgent(
      srv,
      `/api/agents/${agent.id}/handoff`,
      agent.id,
      { text: "brief" },
    );
    expect(refused.status).toBe(429);
    expect((refused.body.error as { code: string }).code).toBe("usage_cap");
    expect(srv.fakeBackend.sessionForAgent(agent.id)).toBe(sessionBefore);
    expect(sessionBefore!.closed).toBe(false);
  });
});

describe("member usage cap: cron runs", () => {
  it("fails a member's cronjob run before it sends, and runs the owner's", async () => {
    const { srv } = await boot();
    installCap();
    const seed = (username: string) =>
      srv.cronjobManager.addCronjob({
        name: `${username} job`,
        schedule: { type: "interval", minutes: 60 },
        prompt: `${username} prompt`,
        cwd: srv.stateRoot,
        agentType: "claude",
        modelFamily: "opus",
        effort: "medium",
        permissionMode: "bypassPermissions",
        username,
        userId: getUserByName(username)?.id ?? null,
      });

    const memberJob = seed("Alice");
    const memberRun = srv.cronjobManager.runCronjobNow(memberJob.id, "Alice")!;
    const memberPromptSent = () =>
      srv.fakeBackend.sessions
        .flatMap((s) => s.sent)
        .some((m) => m.text.includes("Alice prompt"));
    // Settles either way, so a wrong send fails on the assertion below.
    await waitUntil(
      () =>
        memberPromptSent() ||
        srv.cronjobManager.findRun(memberJob.id, memberRun.id)?.status ===
          "failed",
      1000,
      "member run refused or sent",
    );
    expect(memberPromptSent()).toBe(false);
    expect(srv.cronjobManager.findRun(memberJob.id, memberRun.id)?.status).toBe(
      "failed",
    );

    const ownerJob = seed("Boss");
    const ownerRun = srv.cronjobManager.runCronjobNow(ownerJob.id, "Boss")!;
    expect(ownerRun).not.toBeNull();
    await waitUntil(
      () =>
        srv.fakeBackend.sessions
          .flatMap((s) => s.sent)
          .some((m) => m.text.includes("Boss prompt")),
      3000,
      "owner run sent",
    );
  });
});

describe("member usage cap: cron run follow-ups", () => {
  it("refuses a member's follow-up in a run before it resumes, and takes the owner's", async () => {
    let sends = 0;
    const fb = new FakeBackend({
      session: {
        onSend: (_t, _a, s) => {
          if (++sends === 1) s.completeTurn({ text: "primary done" });
        },
      },
    });
    const srv = await startTestServer({ fakeBackend: fb });
    server = srv;
    await srv.seedOwner("Boss");
    await srv.seedMember("Alice");
    // A temp office Claude home, so the resume precheck never reads ~/.claude.
    const claudeHome = join(srv.stateRoot, "office-claude-home");
    setTestManagedOfficeEnv({ CLAUDE_CONFIG_DIR: claudeHome });
    const job = srv.cronjobManager.addCronjob({
      name: "Boss job",
      schedule: { type: "interval", minutes: 60 },
      prompt: "p",
      cwd: srv.stateRoot,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username: "Boss",
      userId: getUserByName("Boss")?.id ?? null,
    });
    const run = srv.cronjobManager.runCronjobNow(job.id, "Boss")!;
    await waitUntil(
      () => srv.cronjobManager.findRun(job.id, run.id)?.status === "completed",
      3000,
      "run completed",
    );
    const finalized = srv.cronjobManager.findRun(job.id, run.id)!;
    const leaf = finalized.currentSessionId ?? finalized.rootSessionId;
    const projDir = claudeProjectDir(srv.stateRoot, {
      CLAUDE_CONFIG_DIR: claudeHome,
    });
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${leaf}.jsonl`), "");
    installCap();

    const errorsBefore = srv.cronjobManager
      .getRunTranscript(job.id, run.id)
      .entries.filter((e) => e.kind === "error").length;
    await srv.cronjobManager.sendRunMessage(job.id, run.id, "more", "Alice");
    expect(fb.resumeSessionCount).toBe(0);
    expect(
      srv.cronjobManager
        .getRunTranscript(job.id, run.id)
        .entries.filter((e) => e.kind === "error").length,
    ).toBe(errorsBefore + 1);

    await srv.cronjobManager.sendRunMessage(job.id, run.id, "more", "Boss");
    expect(fb.resumeSessionCount).toBe(1);
  });
});

describe("member usage cap: owner switch", () => {
  it("is off by default, persists, moves the settings version, and reports status while on", async () => {
    const { srv, owner, member } = await boot();
    installCap({ enabled: false });
    const get = async (rawSessionId: string) => {
      const res = await srv.http("/api/office/settings", { rawSessionId });
      return {
        status: res.status,
        body: (await res.json()) as OfficeSettingsRes,
      };
    };

    const before = await get(owner.rawSessionId);
    expect(before.body.memberUsageCap).toBe(false);
    expect(before.body.memberUsageStatus).toEqual([]);

    const put = await srv.http("/api/office/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      rawSessionId: owner.rawSessionId,
      body: JSON.stringify({
        prompt: null,
        version: before.body.version,
        memberUsageCap: true,
      }),
    });
    expect(put.status).toBe(204);

    const after = await get(owner.rawSessionId);
    expect(after.body.memberUsageCap).toBe(true);
    expect(after.body.version).not.toBe(before.body.version);
    expect(after.body.memberUsageStatus?.length).toBeGreaterThan(0);
    const config = JSON.parse(
      readFileSync(join(STATE_ROOT, "office-config.json"), "utf8"),
    ) as { memberUsageCap?: boolean };
    expect(config.memberUsageCap).toBe(true);

    // Omitting the field preserves it; a non-boolean is refused.
    const keep = await srv.http("/api/office/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      rawSessionId: owner.rawSessionId,
      body: JSON.stringify({ prompt: "p", version: after.body.version }),
    });
    expect(keep.status).toBe(204);
    expect((await get(owner.rawSessionId)).body.memberUsageCap).toBe(true);
    const bad = await srv.http("/api/office/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      rawSessionId: owner.rawSessionId,
      body: JSON.stringify({
        prompt: "p",
        version: (await get(owner.rawSessionId)).body.version,
        memberUsageCap: "yes",
      }),
    });
    expect(bad.status).toBe(400);

    // Members cannot read or set it.
    expect((await get(member.rawSessionId)).status).toBe(403);
  });
});

describe("member usage cap: office sign-in changes", () => {
  // The production reader and office target over a counting probe factory.
  function installRealReader(createProbe: () => OfficeUsageProbe): void {
    setMemberUsageCapForTests(
      createMemberUsageCap({
        reader: createOfficeUsageReader({
          officeTarget: officeUsageTarget,
          createProbe,
        }),
        officeDir: (provider) => officeUsageTarget(provider).dir,
        load: () => true,
      }),
    );
  }

  it("reads the office account again after the office variables change", async () => {
    const { srv, owner } = await boot();
    let created = 0;
    installRealReader(() => {
      created++;
      return {
        read: async () => ({
          kind: "weekly",
          usedPercent: 10,
          resetsAtMs: Date.now() + WEEK_MS / 2,
        }),
        close() {},
      };
    });
    const office = {
      provider: "claude" as const,
      dir: officeUsageTarget("claude").dir,
    };
    await memberUsageCap().admit(office);
    expect(created).toBe(1);
    expect(memberUsageCap().peek(office)).not.toBeNull();

    const put = await srv.http("/api/office/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      rawSessionId: owner.rawSessionId,
      body: JSON.stringify({ values: { ANTHROPIC_API_KEY: "sk-test" } }),
    });
    expect(put.status).toBe(204);
    // The recent answer is gone, and the next read starts a new reader
    // inside the 60-second reuse window.
    expect(memberUsageCap().peek(office)).toBeNull();
    await memberUsageCap().admit(office);
    expect(created).toBe(2);
  });

  it("keeps the owner's settings usable when the reader cannot start", async () => {
    const { srv, owner } = await boot();
    installRealReader(() => {
      throw new Error("spawn failed");
    });
    const res = await srv.http("/api/office/settings", {
      rawSessionId: owner.rawSessionId,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OfficeSettingsRes;
    expect(body.memberUsageCap).toBe(true);
    expect(body.memberUsageStatus?.map((row) => row.state)).toEqual([
      "failed",
      "failed",
    ]);
  });
});
