// The agent ceiling of member permission packs (task 134b8f77, part 3)
// through the real HTTP server. The agents a member with a pack manages sit
// at or below pack.agentCeiling: a request that would put one above it is
// refused, whoever asks (the member and their identities 403, an owner 409);
// a pack save, a manager change to the member, a revive and the boot move
// them down; an agent whose engine cannot run at the ceiling blocks the save
// and does not start. The member's agent sends as the member's pack (areas,
// rooms, ceiling) on /api and at the fire. A schedule with no target agent
// runs with a full shell, so a member with a pack has none; their apps run
// only while the pack gives apps write. Part 2's side is member-pack.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { getUserByName } from "../users.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { STATE_ROOT } from "../config.ts";
import type { MemberPack } from "../../shared/pack-fit.ts";
import type { AgentInfo, Cronjob } from "../../shared/types.ts";

// Protocol values: the refusal codes.
const ABOVE_AGENT_CEILING = "above_agent_ceiling";
const ABOVE_MEMBER_CEILING = "above_member_ceiling";
const CANNOT_MOVE_DOWN = "agents_cannot_move_down";
const NOT_FIT = "agent_does_not_fit";

let server: TestServer | null = null;
const folders: string[] = [];
afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

function freshFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "member-ceiling-"));
  folders.push(dir);
  return dir;
}

interface Res {
  status: number;
  body: unknown;
}

const errorOf = (res: Res) =>
  ((res.body as { error?: Record<string, unknown> } | null)?.error ??
    {}) as Record<string, unknown>;
const outcome = (res: Res) => ({
  status: res.status,
  code: errorOf(res).code as string | undefined,
});

// Morgan owns the office and Casey is a member with access to its first room.
async function office() {
  const fakeBackend = new FakeBackend({
    storedSessionState: "durable",
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
  const srv = await startTestServer({ fakeBackend });
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Casey");
  const o = {
    srv,
    owner: owner.rawSessionId,
    ownerName: owner.username,
    ownerId: getUserByName(owner.username)!.id,
    casey: member.rawSessionId,
    caseyName: member.username,
    caseyId: getUserByName(member.username)!.id,
    room: srv.agentManager.getRooms()[0].id,
  };
  expect((await setPack(o, undefined)).status).toBe(200);
  return o;
}
type Office = Awaited<ReturnType<typeof office>>;

async function asSession(
  o: Office,
  session: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await o.srv.http(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    rawSessionId: session,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const asOwner = (o: Office, method: string, path: string, body?: unknown) =>
  asSession(o, o.owner, method, path, body);
const asCasey = (o: Office, method: string, path: string, body?: unknown) =>
  asSession(o, o.casey, method, path, body);

async function asBearer(
  o: Office,
  bearer: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await fetch(`${o.srv.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      Connection: "close",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function setPack(o: Office, pack: MemberPack | null | undefined) {
  return asOwner(o, "PUT", `/api/users/${o.caseyName}/access`, {
    allowedRooms: [o.room],
    ...(pack !== undefined ? { pack } : {}),
  });
}

async function packCasey(o: Office, pack: MemberPack | null): Promise<void> {
  const res = await setPack(o, pack);
  expect({
    status: res.status,
    pack: getUserByName(o.caseyName)?.pack,
  }).toEqual({ status: 200, pack: pack ?? undefined });
}

async function spawn(
  o: Office,
  name: string,
  manager: "Morgan" | "Casey" = "Morgan",
  opts: { agentType?: AgentInfo["agentType"]; cwd?: string } = {},
): Promise<AgentInfo> {
  const agent = await o.srv.agentManager.spawn(
    name,
    opts.cwd ?? freshFolder(),
    "default",
    undefined,
    undefined,
    o.room,
    undefined,
    undefined,
    undefined,
    manager === "Morgan" ? o.ownerName : o.caseyName,
    opts.agentType ?? "claude",
    undefined,
    manager === "Morgan" ? o.ownerId : o.caseyId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

// Moves an agent with the owner's slider.
async function lower(
  o: Office,
  agent: AgentInfo,
  access: "chat" | "office" | "folder",
  areas?: Record<string, string>,
  rooms?: string[],
): Promise<void> {
  const res = await asOwner(o, "PUT", `/api/agents/${agent.id}/access`, {
    access,
    ...(areas ? { pack: { areas, ...(rooms ? { rooms } : {}) } } : {}),
  });
  expect({ agent: agent.name, status: res.status }).toEqual({
    agent: agent.name,
    status: 200,
  });
}

function tokenOf(agentId: string): string {
  const token = getAgentTokenRaw(agentId);
  if (!token) throw new Error(`no live token for ${agentId}`);
  return token;
}

const agentOf = (o: Office, id: string): AgentInfo => {
  const agent = o.srv.agentManager.getAgent(id);
  if (!agent) throw new Error(`no live agent ${id}`);
  return agent;
};
const isLive = (o: Office, id: string) =>
  o.srv.agentManager.getAllAgents().some((a) => a.id === id);

// The stop and pack areas an agent holds, for one comparison.
const grantOf = (o: Office, id: string) => {
  const agent = agentOf(o, id);
  return {
    access: agent.access ?? "standard",
    privileged: agent.privileged ?? false,
    areas: agent.pack?.areas,
  };
};

// The stops of the sessions the backend made for an agent after `mark`.
const stopsSince = (
  o: Office,
  agentId: string,
  mark: ReadonlySet<FakeSession>,
): string[] =>
  o.srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId && !mark.has(s))
    .map((s) => s.opts.access ?? "standard");
const markSessions = (o: Office) => new Set(o.srv.fakeBackend.sessions);

const sentTexts = (o: Office, agentId: string): string[] =>
  o.srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));

async function waitUntil(pred: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await Bun.sleep(10);
  }
}

// The owner talks to an agent, which makes its session.
async function talkTo(o: Office, agent: AgentInfo, text: string) {
  const res = await asOwner(o, "POST", `/api/agents/${agent.id}/messages`, {
    text,
  });
  expect({ agent: agent.name, status: res.status }).toEqual({
    agent: agent.name,
    status: 200,
  });
  await waitUntil(
    () => sentTexts(o, agent.id).some((t) => t.includes(text)),
    `${agent.name} got "${text}"`,
  );
}

// A pack that counts for the messaging rule, and one that does not (memory
// write reaches everything already): the ceiling binds both.
const COUNTED: MemberPack = {
  areas: { agents: "write", agentManagement: "write" },
  agentCeiling: "office",
};
const UNCOUNTED: MemberPack = {
  areas: { agents: "write", agentManagement: "write", memory: "write" },
  agentCeiling: "office",
};

describe("no request puts a member's agent above the member's ceiling", () => {
  for (const [label, pack] of [
    ["a pack that counts", COUNTED],
    ["a pack that does not count", UNCOUNTED],
  ] as const) {
    it(`the member, their agent and an owner, with ${label}`, async () => {
      const o = await office();
      const mine = await spawn(o, "Mine", "Casey");
      await lower(o, mine, "office", {
        agents: "write",
        agentManagement: "write",
      });
      await packCasey(o, pack);
      const refusedToCasey = { status: 403, code: ABOVE_AGENT_CEILING };

      // The member raises their agent, or spawns one above the ceiling.
      expect(
        outcome(
          await asCasey(o, "PUT", `/api/agents/${mine.id}/access`, {
            access: "standard",
          }),
        ),
      ).toEqual(refusedToCasey);
      const before = o.srv.agentManager.getAllAgents().length;
      for (const access of [undefined, "standard", "folder"] as const) {
        const res = await asCasey(o, "POST", "/api/agents", {
          name: `New ${access ?? "default"}`,
          cwd: freshFolder(),
          roomId: o.room,
          agentType: "claude",
          ...(access
            ? {
                access,
                ...(access === "folder"
                  ? { pack: { areas: { agents: "read" } } }
                  : {}),
              }
            : {}),
        });
        expect({ access, ...outcome(res) }).toEqual({
          access,
          ...refusedToCasey,
        });
      }
      // The member's agent spawns above the ceiling.
      const byAgent = await asBearer(
        o,
        tokenOf(mine.id),
        "POST",
        "/api/agents",
        {
          name: "By the agent",
          cwd: freshFolder(),
          roomId: o.room,
          agentType: "claude",
          access: "standard",
        },
      );
      expect(outcome(byAgent)).toEqual(refusedToCasey);
      expect(o.srv.agentManager.getAllAgents()).toHaveLength(before);
      // The enabling condition: a spawn at the ceiling passes.
      // No folder: the member's agent works in the room's folder (task
      // 329974fe).
      const atCeiling = await asCasey(o, "POST", "/api/agents", {
        name: "At the ceiling",
        roomId: o.room,
        agentType: "claude",
        access: "office",
        pack: { areas: { agents: "read" } },
      });
      expect(atCeiling.status).toBe(201);

      // An owner raises the member's agent: refused with the member's
      // ceiling as the reason; a lowering passes.
      const refusedToOwner = { status: 409, code: ABOVE_MEMBER_CEILING };
      expect(
        outcome(
          await asOwner(o, "PUT", `/api/agents/${mine.id}/access`, {
            access: "standard",
          }),
        ),
      ).toEqual(refusedToOwner);
      expect(grantOf(o, mine.id)).toMatchObject({
        access: "office",
        privileged: false,
      });
      await lower(o, mine, "chat");
      // An owner's own agent is not bound by Casey's ceiling.
      const ownAgent = await spawn(o, "Morgan's");
      await lower(o, ownAgent, "office", { agents: "read" });
      expect(
        (
          await asOwner(o, "PUT", `/api/agents/${ownAgent.id}/access`, {
            access: "standard",
          })
        ).status,
      ).toBe(200);
    });
  }
});

describe("a manager change and a revive move the agent down", () => {
  const PACK: MemberPack = {
    areas: { agents: "write", tasks: "read" },
    agentCeiling: "office",
  };

  it("an owner hands a Standard agent to a member with a pack: it lands at the ceiling with the member's areas", async () => {
    const o = await office();
    await packCasey(o, PACK);
    const given = await spawn(o, "Given");
    const oldToken = tokenOf(given.id);
    const res = await asOwner(o, "PUT", `/api/agents/${given.id}/manager`, {
      userId: o.caseyId,
    });
    expect(res.status).toBe(200);
    await waitUntil(
      () => agentOf(o, given.id).access === "office",
      "the agent moved down",
    );
    expect({
      manager: agentOf(o, given.id).userId,
      ...grantOf(o, given.id),
    }).toEqual({
      manager: o.caseyId,
      access: "office",
      privileged: false,
      areas: PACK.areas,
    });
    // The move rotated its token.
    expect(tokenOf(given.id)).not.toBe(oldToken);
    expect(
      (await asBearer(o, oldToken, "GET", "/api/tasks")).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("refuses to hand over an agent whose engine cannot run at the ceiling, and changes nothing", async () => {
    const o = await office();
    await packCasey(o, PACK);
    // Codex on its default model runs only at Standard.
    const codex = await spawn(o, "Codex-Unmovable", "Morgan", {
      agentType: "codex",
    });
    const res = await asOwner(o, "PUT", `/api/agents/${codex.id}/manager`, {
      userId: o.caseyId,
    });
    expect(outcome(res)).toEqual({ status: 409, code: CANNOT_MOVE_DOWN });
    expect(JSON.stringify(errorOf(res))).toContain(codex.name);
    expect({
      manager: agentOf(o, codex.id).userId,
      access: grantOf(o, codex.id).access,
    }).toEqual({ manager: o.ownerId, access: "standard" });
  });

  it("a revived agent of a member with a pack starts at the ceiling, never at its old stop", async () => {
    const o = await office();
    const old = await spawn(o, "Old", "Casey");
    await talkTo(o, old, "before the kill");
    expect(
      (await asOwner(o, "DELETE", `/api/agents/${old.id}`)).status,
    ).toBeLessThan(300);
    const codex = await spawn(o, "Codex-Unmovable", "Casey", {
      agentType: "codex",
    });
    expect(
      (await asOwner(o, "DELETE", `/api/agents/${codex.id}`)).status,
    ).toBeLessThan(300);
    await packCasey(o, PACK);

    const mark = markSessions(o);
    const revived = await asOwner(o, "POST", `/api/agents/${old.id}/revive`, {
      roomId: o.room,
    });
    expect(revived.status).toBe(200);
    expect(grantOf(o, old.id)).toEqual({
      access: "office",
      privileged: false,
      areas: PACK.areas,
    });
    await talkTo(o, agentOf(o, old.id), "after the revive");
    const stops = stopsSince(o, old.id, mark);
    // The enabling condition: the revive made a session, and each one the
    // agent got since is at the ceiling.
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.every((s) => s === "office")).toBe(true);

    // An engine that cannot run at the ceiling: the revive is refused.
    const refused = await asOwner(o, "POST", `/api/agents/${codex.id}/revive`, {
      roomId: o.room,
    });
    expect(outcome(refused)).toEqual({ status: 409, code: CANNOT_MOVE_DOWN });
    expect(isLive(o, codex.id)).toBe(false);
  });

  it("the member revives their own Standard agent: it comes back at the ceiling", async () => {
    const o = await office();
    const old = await spawn(o, "Old", "Casey");
    expect(
      (await asOwner(o, "DELETE", `/api/agents/${old.id}`)).status,
    ).toBeLessThan(300);
    // A pack that counts for the messaging rule.
    await packCasey(o, COUNTED);
    const revived = await asCasey(o, "POST", `/api/agents/${old.id}/revive`, {
      roomId: o.room,
    });
    expect(outcome(revived)).toEqual({ status: 200, code: undefined });
    expect(grantOf(o, old.id)).toEqual({
      access: "office",
      privileged: false,
      areas: COUNTED.areas,
    });
  });
});

describe("a pack save moves the member's agents down", () => {
  it("Standard and Privileged go to the ceiling with the member's areas; a folder the rules refuse lands at Office; the rest stays", async () => {
    const o = await office();
    // Under a pack, a Folder agent keeps its files in its room's folder
    // (task 329974fe).
    const roomFolder = freshFolder();
    expect(
      (await asOwner(o, "PATCH", `/api/rooms/${o.room}`, { cwd: roomFolder }))
        .status,
    ).toBeLessThan(300);
    const standard = await spawn(o, "Standard", "Casey", { cwd: roomFolder });
    const privileged = await spawn(o, "Privileged", "Casey", {
      cwd: roomFolder,
    });
    expect(
      (
        await asOwner(o, "PUT", `/api/agents/${privileged.id}/privileged`, {
          privileged: true,
        })
      ).status,
    ).toBe(200);
    // The office state is a folder the folder rules refuse.
    const inState = await spawn(o, "In the state", "Casey", {
      cwd: o.srv.workDir,
    });
    const atOffice = await spawn(o, "At office", "Casey");
    const wide = { agents: "write", tasks: "write" } as const;
    await lower(o, atOffice, "office", wide);
    const atChat = await spawn(o, "At chat", "Casey");
    await lower(o, atChat, "chat");
    // At the ceiling with a pack wider than the member's areas, in a folder
    // that is not the room's.
    const atFolder = await spawn(o, "At folder", "Casey");
    const wider = { agents: "write", tasks: "write", memory: "read" } as const;
    await lower(o, atFolder, "folder", wider);
    const others = await spawn(o, "Morgan's");
    const tokens = Object.fromEntries(
      [standard, privileged, inState, atOffice, atChat, others].map((a) => [
        a.name,
        tokenOf(a.id),
      ]),
    );

    const pack: MemberPack = {
      areas: { agents: "write", tasks: "read" },
      agentCeiling: "folder",
    };
    await packCasey(o, pack);
    await waitUntil(
      () =>
        [standard, privileged, inState, atFolder].every(
          (a) => (agentOf(o, a.id).access ?? "standard") !== "standard",
        ),
      "the moves landed",
    );
    expect({
      standard: grantOf(o, standard.id),
      privileged: grantOf(o, privileged.id),
      inState: grantOf(o, inState.id),
      atOffice: grantOf(o, atOffice.id),
      atChat: grantOf(o, atChat.id),
      atFolder: grantOf(o, atFolder.id),
      others: grantOf(o, others.id),
    }).toEqual({
      standard: { access: "folder", privileged: false, areas: pack.areas },
      privileged: { access: "folder", privileged: false, areas: pack.areas },
      inState: { access: "office", privileged: false, areas: pack.areas },
      // At or below the ceiling: its stored pack stays (the token is capped
      // live by the member's pack).
      atOffice: { access: "office", privileged: false, areas: wide },
      atChat: { access: "chat", privileged: false, areas: undefined },
      // Not in its room's folder: Office, its pack cut to the member's areas.
      atFolder: {
        access: "office",
        privileged: false,
        areas: { agents: "write", tasks: "read" },
      },
      others: { access: "standard", privileged: false, areas: undefined },
    });
    // A moved agent's token is rotated; the others keep theirs.
    expect({
      standard: tokenOf(standard.id) === tokens[standard.name],
      privileged: tokenOf(privileged.id) === tokens[privileged.name],
      inState: tokenOf(inState.id) === tokens[inState.name],
      atOffice: tokenOf(atOffice.id) === tokens[atOffice.name],
      atChat: tokenOf(atChat.id) === tokens[atChat.name],
      others: tokenOf(others.id) === tokens[others.name],
    }).toEqual({
      standard: false,
      privileged: false,
      inState: false,
      atOffice: true,
      atChat: true,
      others: true,
    });

    // A lower ceiling moves the agents at folder down again.
    const lowered: MemberPack = { ...pack, agentCeiling: "office" };
    await packCasey(o, lowered);
    await waitUntil(
      () => agentOf(o, standard.id).access === "office",
      "the second move landed",
    );
    expect(grantOf(o, privileged.id).access).toBe("office");
  });

  it("a save that would leave an agent on an engine that cannot run at the ceiling is refused, naming it, and writes nothing", async () => {
    const o = await office();
    const claude = await spawn(o, "Claude", "Casey");
    const codex = await spawn(o, "Codex-Unmovable", "Casey", {
      agentType: "codex",
    });
    const claudeToken = tokenOf(claude.id);
    const res = await setPack(o, COUNTED);
    expect(outcome(res)).toEqual({ status: 409, code: CANNOT_MOVE_DOWN });
    expect(JSON.stringify(errorOf(res))).toContain(codex.name);
    expect(JSON.stringify(errorOf(res))).not.toContain(claude.name);
    await Bun.sleep(50);
    expect({
      pack: getUserByName(o.caseyName)?.pack,
      claude: grantOf(o, claude.id).access,
      codex: grantOf(o, codex.id).access,
      claudeToken: tokenOf(claude.id) === claudeToken,
    }).toEqual({
      pack: undefined,
      claude: "standard",
      codex: "standard",
      claudeToken: true,
    });

    // The enabling condition: without the Codex agent the save passes.
    expect(
      (await asOwner(o, "DELETE", `/api/agents/${codex.id}`)).status,
    ).toBeLessThan(300);
    await packCasey(o, COUNTED);
    await waitUntil(
      () => agentOf(o, claude.id).access === "office",
      "the Claude agent moved",
    );
  });

  it("at boot, a pack in users.json moves the agents down before any session; one that cannot move does not start", async () => {
    const o = await office();
    const claude = await spawn(o, "Claude", "Casey");
    await talkTo(o, claude, "before the restart");
    const codex = await spawn(o, "Codex-Unmovable", "Casey", {
      agentType: "codex",
    });
    // A hand-edited file (or a crash between the save and the moves).
    const file = join(STATE_ROOT, "users.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    Object.values(raw).find((u) => u.name === o.caseyName)!.pack = COUNTED;
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const mark = markSessions(o);
    o.srv = await o.srv.restart();
    server = o.srv;

    await waitUntil(
      () => agentOf(o, claude.id).access === "office",
      "the boot moved the Claude agent",
    );
    expect(grantOf(o, claude.id)).toEqual({
      access: "office",
      privileged: false,
      areas: COUNTED.areas,
    });
    await talkTo(o, agentOf(o, claude.id), "after the restart");
    const stops = stopsSince(o, claude.id, mark);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.every((s) => s === "office")).toBe(true);

    // The Codex agent keeps its stop and gets no session: the message waits.
    expect(grantOf(o, codex.id).access).toBe("standard");
    const sent = await asOwner(o, "POST", `/api/agents/${codex.id}/messages`, {
      text: "to the unmovable agent",
    });
    expect(sent.status).toBeLessThan(300);
    await Bun.sleep(200);
    expect(stopsSince(o, codex.id, mark)).toEqual([]);
    expect(sentTexts(o, codex.id)).not.toContainEqual(
      expect.stringContaining("to the unmovable agent"),
    );
  });
});

describe("the member's agent sends as the member's pack", () => {
  it("on /api: it reaches no agent whose pack reaches rooms outside the member's", async () => {
    const o = await office();
    const mine = await spawn(o, "Mine", "Casey");
    // Its own pack has no room limit.
    await lower(o, mine, "office", { agents: "write" });
    const everywhere = await spawn(o, "Everywhere");
    await lower(o, everywhere, "office", { agents: "read" });
    const inRoom = await spawn(o, "In the room");
    await lower(o, inRoom, "office", { agents: "read" }, [o.room]);
    await packCasey(o, { areas: { agents: "write" }, agentCeiling: "office" });
    const send = (to: AgentInfo) =>
      asBearer(o, tokenOf(mine.id), "POST", `/api/agents/${to.id}/messages`, {
        text: `to ${to.name}`,
      });
    expect(outcome(await send(everywhere))).toEqual({
      status: 403,
      code: NOT_FIT,
    });
    expect((await send(inRoom)).status).toBe(200);
    // A write that does not go through the message queue: the request's own
    // check. The agent in the room passes it and has no turn to stop.
    const abort = (to: AgentInfo) =>
      asBearer(o, tokenOf(mine.id), "POST", `/api/agents/${to.id}/abort`, {});
    expect(outcome(await abort(everywhere))).toEqual({
      status: 403,
      code: NOT_FIT,
    });
    expect(outcome(await abort(inRoom))).toEqual({
      status: 409,
      code: "nothing_to_abort",
    });
  });

  it("at the fire: a message scheduled before a pack is refused when the target is outside the pack's areas, rooms or ceiling", async () => {
    const o = await office();
    const mine = await spawn(o, "Mine", "Casey");
    await lower(o, mine, "office", { agents: "write", tasks: "write" });
    const tasksAgent = await spawn(o, "Tasks");
    await lower(o, tasksAgent, "office", { agents: "read", tasks: "write" });
    const everywhere = await spawn(o, "Everywhere");
    await lower(o, everywhere, "office", { agents: "read" });
    const inRoom = await spawn(o, "In the room");
    await lower(o, inRoom, "office", { agents: "read" }, [o.room]);
    const deliverAt = new Date(Date.now() + 3_600_000).toISOString();
    for (const to of [tasksAgent, everywhere, inRoom]) {
      const res = await asBearer(
        o,
        tokenOf(mine.id),
        "POST",
        `/api/agents/${to.id}/messages`,
        { text: "later", deliverAt },
      );
      expect({ to: to.name, status: res.status }).toEqual({
        to: to.name,
        status: 200,
      });
    }

    // The pack has no tasks area and Casey's room only. Mine sits at the
    // ceiling, so no move touches it or its stored pack.
    await packCasey(o, { areas: { agents: "write" }, agentCeiling: "office" });
    expect(grantOf(o, mine.id).areas).toEqual({
      agents: "write",
      tasks: "write",
    });
    // The fire enqueues the entry as the agent's message
    // (scheduled-messages.ts tick).
    const fire = (to: AgentInfo) =>
      o.srv.agentManager.enqueueMessage(to.id, {
        sender: {
          kind: "agent",
          agentId: mine.id,
          agentName: mine.name,
          roomName: "Room",
        },
        text: `fired to ${to.name}`,
        scheduledFor: Date.now() - 1_000,
      });
    expect(fire(tasksAgent)).toMatchObject({ ok: false, status: 403 });
    expect(fire(everywhere)).toMatchObject({ ok: false, status: 403 });
    // The enabling condition: a target inside the pack gets it.
    expect(fire(inRoom)).toMatchObject({ ok: true });

    // The ceiling: at chat the member's agents reach no agent at Office.
    await packCasey(o, { areas: { agents: "write" }, agentCeiling: "chat" });
    expect(fire(inRoom)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("schedules of a member with a pack", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    name: "Nightly",
    schedule: { type: "interval", minutes: 60 },
    prompt: "do the thing",
    cwd: freshFolder(),
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    roomId: server!.agentManager.getRooms()[0].id,
    ...over,
  });

  async function fire(o: Office, job: Cronjob): Promise<string> {
    const seen = new Set(
      o.srv.cronjobManager.getRunsForCronjob(job.id).map((r) => r.id),
    );
    const res = await asOwner(o, "POST", `/api/cronjobs/${job.id}/runs`, {});
    expect(res.status).toBeLessThan(300);
    const fresh = () =>
      o.srv.cronjobManager
        .getRunsForCronjob(job.id)
        .find((r) => !seen.has(r.id));
    await waitUntil(
      () => fresh() !== undefined && fresh()!.status !== "running",
      "the run ended",
    );
    return fresh()!.status;
  }

  it("a schedule with no target agent is refused at create and edit, and fails at the fire while the pack holds", async () => {
    const o = await office();
    const created = await asCasey(o, "POST", "/api/cronjobs", body());
    expect(created.status).toBe(201);
    const job = created.body as Cronjob;
    expect(await fire(o, job)).toBe("completed");

    // The highest ceiling: a schedule with no target still runs at Standard.
    await packCasey(o, {
      areas: { schedules: "write", agents: "write" },
      agentCeiling: "web",
    });
    expect(
      outcome(await asCasey(o, "POST", "/api/cronjobs", body({ name: "New" }))),
    ).toEqual({ status: 403, code: ABOVE_AGENT_CEILING });
    expect(
      outcome(
        await asCasey(o, "PATCH", `/api/cronjobs/${job.id}`, {
          name: "Renamed",
        }),
      ),
    ).toEqual({ status: 403, code: ABOVE_AGENT_CEILING });
    const sessions = o.srv.fakeBackend.createSessionCount;
    expect(await fire(o, job)).toBe("failed");
    expect(o.srv.fakeBackend.createSessionCount).toBe(sessions);

    // The enabling condition: a schedule with a target agent is created.
    const target = await spawn(o, "Target");
    await lower(o, target, "office", { agents: "read" });
    const targeted = await asCasey(
      o,
      "POST",
      "/api/cronjobs",
      body({ name: "Targeted", target: { kind: "agent", agentId: target.id } }),
    );
    expect(targeted.status).toBe(201);

    // Read live: without the pack the schedule runs again.
    await packCasey(o, null);
    expect(await fire(o, job)).toBe("completed");
  });
});

describe("apps of a member with a pack", () => {
  it("a pack without apps write stops the member's apps, and they start only once the pack gives it", async () => {
    const o = await office();
    const maker = await spawn(o, "AppMaker", "Casey");
    const reg = await asBearer(o, tokenOf(maker.id), "POST", "/api/apps", {
      name: "casey-app",
      command: "bun run serve.ts",
      cwd: freshFolder(),
    });
    expect(reg.status).toBe(201);
    const ownReg = await asOwner(o, "POST", "/api/apps", {
      name: "morgan-app",
      command: "bun run serve.ts",
      cwd: freshFolder(),
    });
    expect(ownReg.status).toBe(201);
    const calls = o.srv.appSupervisor.calls;
    const mark = calls.length;
    const since = () => calls.slice(mark);

    // The first pack on a full member.
    await packCasey(o, { areas: { agents: "read" }, agentCeiling: "chat" });
    await waitUntil(
      () => since().includes("stop:casey-app"),
      "the member's app stopped",
    );
    expect(since()).not.toContain("stop:morgan-app");

    const start = await asOwner(o, "POST", "/api/apps/casey-app/start", {});
    expect(start.status).toBeGreaterThanOrEqual(400);
    expect(since()).not.toContain("start:casey-app");

    // The enabling condition: with apps write the app starts.
    await packCasey(o, { areas: { apps: "write" }, agentCeiling: "chat" });
    expect(
      (await asOwner(o, "POST", "/api/apps/casey-app/start", {})).status,
    ).toBeLessThan(300);
    expect(since()).toContain("start:casey-app");
  });
});

describe("apps of a member with a pack, at boot", () => {
  it("a pack in users.json without apps write stops the member's apps at boot", async () => {
    const o = await office();
    const maker = await spawn(o, "AppMaker", "Casey");
    const reg = await asBearer(o, tokenOf(maker.id), "POST", "/api/apps", {
      name: "casey-app",
      command: "bun run serve.ts",
      cwd: freshFolder(),
    });
    expect(reg.status).toBe(201);
    const ownReg = await asOwner(o, "POST", "/api/apps", {
      name: "morgan-app",
      command: "bun run serve.ts",
      cwd: freshFolder(),
    });
    expect(ownReg.status).toBe(201);
    // A hand-edited file, or a crash between the save and the stops. The
    // app's unit is enabled, so the box's next boot starts it again.
    const file = join(STATE_ROOT, "users.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    Object.values(raw).find((u) => u.name === o.caseyName)!.pack = {
      areas: { agents: "read" },
      agentCeiling: "chat",
    };
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const calls = o.srv.appSupervisor.calls;
    const mark = calls.length;
    o.srv = await o.srv.restart();
    server = o.srv;
    await waitUntil(
      () => calls.slice(mark).includes("stop:casey-app"),
      "the boot stopped the member's app",
    );
    expect(calls.slice(mark)).not.toContain("stop:morgan-app");
  });
});

describe("an owner creates a member with a pack", () => {
  it("in one request; refused for an owner and for a pack that does not parse, storing no user", async () => {
    const o = await office();
    const pack: MemberPack = {
      areas: { tasks: "read" },
      agentCeiling: "chat",
    };
    const created = await asOwner(o, "POST", "/api/users", {
      name: "Drew",
      role: "member",
      allowedRooms: [o.room],
      pack,
    });
    expect(created.status).toBe(201);
    expect(getUserByName("Drew")?.pack).toEqual(pack);

    for (const [name, role, p] of [
      ["Eden", "owner", pack],
      ["Finn", "member", { areas: { tasks: "admin" }, agentCeiling: "chat" }],
    ] as const) {
      const res = await asOwner(o, "POST", "/api/users", {
        name,
        role,
        ...(role === "member" ? { allowedRooms: [o.room] } : {}),
        pack: p,
      });
      expect({ name, status: res.status }).toEqual({ name, status: 400 });
      expect(getUserByName(name)).toBeUndefined();
    }
  });
});
