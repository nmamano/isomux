// POST /api/agents/:id/command (agents.runCommand, task 2712f246, GitHub #79):
// an operator (member, API token, privileged agent) runs a skill or an engine
// command on an agent it reaches; an ordinary agent runs one only on itself.
// Seam: startTestServer() + FakeBackend, over HTTP with real auth.
//
// What this freezes:
//   - Only what runs in the conversation runs: a skill or an engine command.
//     EVERY supported Isomux handler is refused (fail closed), and a named
//     replacement route exists in the route table.
//   - Refusal codes: invalid_text, has_route, unsupported_command,
//     unknown_command, engine_unsupported, awaits_member_answer.
//   - An agent sender is an agent, never a member: the echo carries the agent
//     sender fields and no username, the prompt carries the agent label, and
//     no member's skill-use count moves.
//   - The prompt for one agent-sent skill is the same whether the target runs
//     it now or after its turn.
//   - A busy target queues: {queued, messageId}; the caller takes it back with
//     DELETE /queue/:messageId; a native item goes alone and as typed.
import { describe, it, expect, afterEach, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { commands } from "../commands.ts";
import { STATE_ROOT } from "../config.ts";
import { API_ROUTES } from "../routes/table.ts";
import { getUserByName } from "../users.ts";
import { getSkillUseCounts } from "../skill-usage.ts";
import { mintAgentToken, _testResetTokens } from "../identity/tokens.ts";
import type { AgentInfo } from "../../shared/types.ts";

setDefaultTimeout(30_000);

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
  _testResetTokens();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

const SKILL = "zebra-ledger";
const SKILL_MARKER = "zebra ledger skill body marker";

function writeUserSkill(): void {
  const dir = join(STATE_ROOT, "skills", SKILL);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), SKILL_MARKER);
}

// The first send of each agent parks (the agent stays busy) when `park` holds
// that agent's id; every other send completes.
function backend(parkFor: Set<string> = new Set()) {
  const parked = new Map<string, FakeSession>();
  const fake = new FakeBackend({
    session: {
      onSend: (_t, _a, s) => {
        const id = s.opts.agentId;
        if (parkFor.has(id) && !parked.has(id)) {
          parked.set(id, s);
          s.push({ kind: "assistant_text", text: "..." });
          return;
        }
        s.completeTurn({ text: "ok" });
      },
    },
  });
  return { fake, parked };
}

interface Office {
  srv: TestServer;
  ownerCookie: string;
  ownerId: string;
  spawn(name: string, agentType?: AgentInfo["agentType"]): Promise<AgentInfo>;
}

async function office(fake: FakeBackend): Promise<Office> {
  const srv = (server = await startTestServer({ fakeBackend: fake }));
  const owner = await srv.seedOwner("Morgan");
  const ownerId = getUserByName(owner.username)!.id;
  const room = srv.agentManager.getRooms()[0].id;
  // After the boot: the harness wipes STATE_ROOT when it starts.
  writeUserSkill();
  return {
    srv,
    ownerCookie: owner.rawSessionId,
    ownerId,
    async spawn(name, agentType = "claude") {
      const info = await srv.agentManager.spawn(
        name,
        srv.workDir,
        "default",
        undefined,
        undefined,
        room,
        undefined,
        undefined,
        undefined,
        owner.username,
        agentType,
        undefined,
        ownerId,
      );
      if (!info) throw new Error(`spawn ${name} returned null`);
      return info;
    },
  };
}

interface Res {
  status: number;
  body: {
    ran?: boolean;
    queued?: boolean;
    messageId?: string;
    // The executor puts a refusal's detail fields on `error` itself.
    error?: { code?: string; route?: string; engines?: string[] };
  };
}

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: { bearer?: string; cookie?: string },
  body?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
  const res = await srv.http(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    rawSessionId: auth.cookie,
  });
  let parsed: Res["body"] = {};
  try {
    parsed = (await res.json()) as Res["body"];
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
}

const run = (
  srv: TestServer,
  targetId: string,
  auth: { bearer?: string; cookie?: string },
  text: unknown,
) =>
  call(srv, "POST", `/api/agents/${targetId}/command`, auth, {
    text,
  } as unknown);

function sentTexts(srv: TestServer, agentId: string): string[] {
  return srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));
}

function queueOf(srv: TestServer, agentId: string) {
  return (
    srv.agentManager.getAllAgents().find((a) => a.id === agentId)?.queue ?? []
  );
}

async function makeBusy(o: Office, agent: AgentInfo): Promise<void> {
  void o.srv.agentManager.sendMessage(agent.id, "kickoff", "Morgan");
  await waitUntil(
    () => o.srv.agentManager.getAgent(agent.id)?.state === "thinking",
    "target busy",
  );
}

const routeString = (opId: string): string => {
  const r = API_ROUTES.find((x) => x.opId === opId);
  if (!r) throw new Error(`no route ${opId}`);
  return `${r.method} ${r.path}`;
};

describe("agents.runCommand: who may run a command", () => {
  it("a privileged agent runs a skill on a peer; the echo and the prompt name the agent, not a member", async () => {
    const o = await office(backend().fake);
    const operator = await o.spawn("Operator");
    const target = await o.spawn("Target");
    const bearer = mintAgentToken(operator.id, o.ownerId, true);

    const r = await run(o.srv, target.id, { bearer }, `/${SKILL} alpha beta`);
    expect(r.status).toBe(200);
    expect(r.body.ran).toBe(true);

    await waitUntil(() => sentTexts(o.srv, target.id).length >= 1, "a send");
    const prompt = sentTexts(o.srv, target.id)[0];
    expect(prompt).toContain(SKILL_MARKER);
    expect(prompt).toContain("alpha beta");
    // The agent label goes in front of the skill, never a member label.
    const label = prompt.indexOf(`agent id: ${operator.id}`);
    expect(label).toBeGreaterThanOrEqual(0);
    expect(label).toBeLessThan(prompt.indexOf(SKILL_MARKER));
    expect(prompt).not.toContain("[Morgan]");

    const echo = o.srv.agentManager
      .getAgentLogs(target.id)
      .find((e) => e.kind === "user_message");
    expect(echo?.content).toBe(`/${SKILL} alpha beta`);
    expect(echo?.metadata?.sender_agent_id).toBe(operator.id);
    expect(echo?.metadata?.username).toBeUndefined();

    // No member's skill-use count moves for an agent sender.
    expect(getSkillUseCounts(o.ownerId)[SKILL] ?? 0).toBe(0);
    // Enabling condition: a member run through the same route counts.
    const member = await run(
      o.srv,
      target.id,
      { cookie: o.ownerCookie },
      `/${SKILL}`,
    );
    expect(member.status).toBe(200);
    expect(getSkillUseCounts(o.ownerId)[SKILL] ?? 0).toBe(1);
  });

  it("an ordinary agent runs a skill on itself, and is refused on a peer with nothing sent", async () => {
    const o = await office(backend().fake);
    const self = await o.spawn("Self");
    const peer = await o.spawn("Peer");
    const bearer = mintAgentToken(self.id, o.ownerId);

    const own = await run(o.srv, self.id, { bearer }, `/${SKILL}`);
    expect(own.status).toBe(200);
    await waitUntil(() => sentTexts(o.srv, self.id).length >= 1, "self send");
    expect(sentTexts(o.srv, self.id)[0]).toContain(SKILL_MARKER);

    const other = await run(o.srv, peer.id, { bearer }, `/${SKILL}`);
    expect(other.status).toBe(403);
    await sleep(50);
    expect(sentTexts(o.srv, peer.id)).toHaveLength(0);
  });

  it("an engine command reaches an idle Claude agent exactly as typed", async () => {
    const o = await office(backend().fake);
    const operator = await o.spawn("Operator");
    const target = await o.spawn("Target");
    const bearer = mintAgentToken(operator.id, o.ownerId, true);

    const r = await run(o.srv, target.id, { bearer }, "/code-review low 79");
    expect(r.status).toBe(200);
    expect(r.body.ran).toBe(true);
    await waitUntil(() => sentTexts(o.srv, target.id).length >= 1, "a send");
    expect(sentTexts(o.srv, target.id)).toEqual(["/code-review low 79"]);
  });
});

describe("agents.runCommand: refusals", () => {
  // Fail closed: a handler added later is refused with no flag to set.
  it("refuses every supported Isomux handler with has_route, runs none, and names only routes that exist", async () => {
    const o = await office(backend().fake);
    const target = await o.spawn("Target");
    const handlerNames = Object.entries(commands)
      .filter(([, cfg]) => cfg.supported && cfg.handler)
      .map(([name]) => name);
    // Enabling condition: the set holds the commands this route must refuse.
    expect(handlerNames).toEqual(
      expect.arrayContaining(["clear", "handoff", "model", "help", "login"]),
    );
    const known = new Set(API_ROUTES.map((r) => `${r.method} ${r.path}`));
    const topicBefore = o.srv.agentManager.getAgent(target.id)?.topic;

    for (const name of handlerNames) {
      const r = await run(
        o.srv,
        target.id,
        { cookie: o.ownerCookie },
        `/${name} x`,
      );
      expect({ name, status: r.status, code: r.body.error?.code }).toEqual({
        name,
        status: 422,
        code: "has_route",
      });
      const route = r.body.error?.route;
      if (route !== undefined) expect(known.has(route as string)).toBe(true);
    }
    expect(
      (await run(o.srv, target.id, { cookie: o.ownerCookie }, "/clear")).body
        .error?.route,
    ).toBe(routeString("agents.newConversation"));
    expect(
      (await run(o.srv, target.id, { cookie: o.ownerCookie }, "/help")).body
        .error?.route,
    ).toBeUndefined();

    // Nothing ran: no turn, no picker, no member identity changed.
    await sleep(50);
    expect(sentTexts(o.srv, target.id)).toHaveLength(0);
    expect(
      o.srv.agentManager
        .getPendingInteractions()
        .filter((p) => p.agentId === target.id),
    ).toHaveLength(0);
    expect(o.srv.agentManager.getAgent(target.id)?.name).toBe("Target");
    expect(o.srv.agentManager.getAgent(target.id)?.topic).toBe(topicBefore);
  });

  it("answers invalid_text, unsupported_command, unknown_command and engine_unsupported", async () => {
    const o = await office(backend().fake);
    const claude = await o.spawn("Claude one");
    const codex = await o.spawn("Codex one", "codex");
    const auth = { cookie: o.ownerCookie };
    const code = async (id: string, text: unknown) => {
      const r = await run(o.srv, id, auth, text);
      return [r.status, r.body.error?.code];
    };

    expect(await code(claude.id, "hello")).toEqual([422, "invalid_text"]);
    expect(await code(claude.id, "")).toEqual([422, "invalid_text"]);
    // Enabling condition: Isomux knows /compact and does not support it.
    expect(commands.compact?.supported).toBe(false);
    expect(await code(claude.id, "/compact")).toEqual([
      422,
      "unsupported_command",
    ]);
    expect(await code(claude.id, "/zz-no-such-command")).toEqual([
      422,
      "unknown_command",
    ]);
    const wrong = await run(o.srv, codex.id, auth, "/code-review low");
    expect([wrong.status, wrong.body.error?.code]).toEqual([
      422,
      "engine_unsupported",
    ]);
    expect(wrong.body.error?.engines).toEqual(["claude"]);

    await sleep(50);
    expect(sentTexts(o.srv, claude.id)).toHaveLength(0);
    expect(sentTexts(o.srv, codex.id)).toHaveLength(0);
  });

  it("refuses with awaits_member_answer while a member's picker is open, and leaves it open", async () => {
    const o = await office(backend().fake);
    const operator = await o.spawn("Operator");
    const target = await o.spawn("Target");
    const bearer = mintAgentToken(operator.id, o.ownerId, true);
    const pending = () =>
      o.srv.agentManager
        .getPendingInteractions()
        .filter((p) => p.agentId === target.id);

    const picker = await call(
      o.srv,
      "POST",
      `/api/agents/${target.id}/messages`,
      { cookie: o.ownerCookie },
      { text: "/model" },
    );
    expect(picker.status).toBe(200);
    expect(pending()).toHaveLength(1);

    const r = await run(o.srv, target.id, { bearer }, `/${SKILL}`);
    expect([r.status, r.body.error?.code]).toEqual([
      409,
      "awaits_member_answer",
    ]);
    expect(pending()).toHaveLength(1);
    await sleep(50);
    expect(sentTexts(o.srv, target.id)).toHaveLength(0);
  });
});

describe("agents.runCommand: a busy target", () => {
  it("queues a skill and the caller takes it back", async () => {
    const park = new Set<string>();
    const { fake } = backend(park);
    const o = await office(fake);
    const operator = await o.spawn("Operator");
    const target = await o.spawn("Target");
    park.add(target.id);
    const bearer = mintAgentToken(operator.id, o.ownerId, true);
    await makeBusy(o, target);

    const r = await run(o.srv, target.id, { bearer }, `/${SKILL}`);
    expect(r.status).toBe(200);
    expect(r.body.queued).toBe(true);
    expect(typeof r.body.messageId).toBe("string");
    expect(queueOf(o.srv, target.id).map((m) => m.id)).toEqual([
      r.body.messageId!,
    ]);
    // Nothing superseded the running turn.
    expect(sentTexts(o.srv, target.id)).toHaveLength(1);

    const cancel = await call(
      o.srv,
      "DELETE",
      `/api/agents/${target.id}/queue/${r.body.messageId}`,
      { bearer },
    );
    expect(cancel.status).toBe(204);
    expect(queueOf(o.srv, target.id)).toHaveLength(0);
  });

  it("queues an engine command as a native item that goes alone and as typed", async () => {
    const park = new Set<string>();
    const { fake, parked } = backend(park);
    const o = await office(fake);
    const operator = await o.spawn("Operator");
    const target = await o.spawn("Target");
    park.add(target.id);
    const bearer = mintAgentToken(operator.id, o.ownerId, true);
    await makeBusy(o, target);

    const r = await run(o.srv, target.id, { bearer }, "/code-review low");
    expect(r.status).toBe(200);
    expect(r.body.queued).toBe(true);
    expect(queueOf(o.srv, target.id).map((m) => !!m.native)).toEqual([true]);

    parked.get(target.id)!.completeTurn({ text: "ok" });
    await waitUntil(() => sentTexts(o.srv, target.id).length >= 2, "flush");
    expect(sentTexts(o.srv, target.id)[1]).toBe("/code-review low");
  });

  // One prompt for one agent-sent skill, whether it runs now or after a turn.
  it("delivers the same skill prompt to an idle and to a busy target", async () => {
    const park = new Set<string>();
    const { fake, parked } = backend(park);
    const o = await office(fake);
    const operator = await o.spawn("Operator");
    const idle = await o.spawn("Idle");
    const busy = await o.spawn("Busy");
    park.add(busy.id);
    const bearer = mintAgentToken(operator.id, o.ownerId, true);
    const text = `/${SKILL} check @notes.md now`;

    const now = await run(o.srv, idle.id, { bearer }, text);
    expect(now.body.ran).toBe(true);
    await waitUntil(() => sentTexts(o.srv, idle.id).length >= 1, "idle send");

    await makeBusy(o, busy);
    const later = await run(o.srv, busy.id, { bearer }, text);
    expect(later.body.queued).toBe(true);
    parked.get(busy.id)!.completeTurn({ text: "ok" });
    await waitUntil(() => sentTexts(o.srv, busy.id).length >= 2, "flush");

    const idlePrompt = sentTexts(o.srv, idle.id)[0];
    const busyPrompt = sentTexts(o.srv, busy.id)[1];
    // Enabling condition: both carry the skill and the agent label.
    for (const p of [idlePrompt, busyPrompt]) {
      expect(p).toContain(SKILL_MARKER);
      expect(p).toContain(`agent id: ${operator.id}`);
    }
    // An agent's text names no file the engine reads by itself.
    expect(idlePrompt).toContain("\\@notes.md");
    // The flush may put its busy-turn note in front; the item is the same.
    expect({
      busyEndsWithIdle: busyPrompt.endsWith(idlePrompt),
      idlePrompt,
      busyPrompt,
    }).toMatchObject({ busyEndsWithIdle: true });
  });
});
