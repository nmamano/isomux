// Member permission packs (task 134b8f77, part 2) through the real HTTP and WS
// server. An owner sets a member's pack with PUT /api/users/:username/access;
// every identity of the member (their session, their API tokens, their agents,
// their schedule runs and apps) is then capped to the pack's areas, read live
// from the user record. A member with a pack that counts follows the
// messaging rule of part 1 (pack-fit-rule.test.ts), opens the file panel only
// on agents that fit, offers browser tabs only to agents that fit, and has no
// terminal. The route-table side (every member route has an area, FILE_FIT
// covers the file panel) is routes-table.test.ts; the cut itself is
// server/identity/member-pack.test.ts.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHmac, randomUUID } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getUserByName } from "../users.ts";
import { acceptInvite, INVITE_TTL_MS, mintInvite } from "../auth.ts";
import {
  NAVIGATION_HEADERS,
  RELAY_UNREACHABLE,
  anOfficeWithAnApp,
  appHost,
  expectPlaceholder,
  raw,
  signIn,
  withAppCookie,
} from "./app-host-test-kit.ts";
import { getAgentTokenRaw, mintRunToken } from "../identity/tokens.ts";
import { appTokens } from "../app-tokens.ts";
import { mayReachExtension } from "../isomux-office.ts";
import { STATE_ROOT } from "../config.ts";
import { API_TOKEN_REPLIES_ONLY } from "../../shared/identity.ts";
import { MEMBER_PACK_PRESETS, type MemberPack } from "../../shared/pack-fit.ts";
import type { AgentInfo, TaskItem } from "../../shared/types.ts";
import type { ApiTokenCreateRes } from "../../shared/contract-shapes.ts";

// The error code of a refusal by the rule (a protocol value).
const NOT_FIT = "agent_does_not_fit";

let server: TestServer | null = null;
const clients: Client[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

function freshFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "member-pack-"));
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
const codeOf = (res: Res) => errorOf(res).code as string | undefined;
const outcome = (res: Res) => ({ status: res.status, code: codeOf(res) });
const REFUSED = { status: 403, code: NOT_FIT };
const limitedOf = (task: unknown) =>
  (task as Record<string, unknown>).limited === true;

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

// Casey's pack through the owner's access route: a pack sets it, null clears
// it, undefined leaves the field out (keeps it).
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
): Promise<AgentInfo> {
  const agent = await o.srv.agentManager.spawn(
    name,
    freshFolder(),
    "default",
    undefined,
    undefined,
    o.room,
    undefined,
    undefined,
    undefined,
    manager === "Morgan" ? o.ownerName : o.caseyName,
    "claude",
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
  access: "chat" | "office",
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

async function mintAsCasey(
  o: Office,
  limits?: unknown,
): Promise<{ bearer: string; id: string }> {
  const res = await asCasey(o, "POST", "/api/me/api-tokens", {
    name: "Script",
    expiresInDays: 30,
    ...(limits === undefined ? {} : { limits }),
  });
  expect(res.status).toBe(201);
  const created = res.body as ApiTokenCreateRes;
  return { bearer: created.token, id: created.apiToken.id };
}

function tokenOf(agentId: string): string {
  const token = getAgentTokenRaw(agentId);
  if (!token) throw new Error(`no live token for ${agentId}`);
  return token;
}

const sentTexts = (o: Office, agentId: string): string[] =>
  o.srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));

const received = (o: Office, agentId: string, text: string) =>
  sentTexts(o, agentId).find((t) => t.includes(text));

async function waitUntil(pred: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await Bun.sleep(10);
  }
}

const READ_TASKS: MemberPack = {
  areas: { tasks: "read" },
  agentCeiling: "chat",
};

describe("the pack on the member record", () => {
  it("an owner sets, keeps and clears it; the member sees it on their own record", async () => {
    const o = await office();
    expect(getUserByName(o.caseyName)?.pack).toBeUndefined();
    const set = await setPack(o, READ_TASKS);
    expect(set.status).toBe(200);
    expect((set.body as { user: { pack?: unknown } }).user.pack).toEqual(
      READ_TASKS,
    );
    // Absent keeps it, as a rooms-only change does.
    expect((await setPack(o, undefined)).status).toBe(200);
    expect(getUserByName(o.caseyName)?.pack).toEqual(READ_TASKS);
    // The member reads their own pack on their own record.
    const ws = await o.srv.connectWs(o.casey);
    const self = await ws.waitFor("user_self_updated");
    expect((self.user as { pack?: unknown }).pack).toEqual(READ_TASKS);
    ws.close();
    // It survives a restart.
    o.srv = await o.srv.restart();
    server = o.srv;
    expect(getUserByName(o.caseyName)?.pack).toEqual(READ_TASKS);
    await packCasey(o, null);
  });

  it("refuses a pack for an owner, and a pack that does not parse, storing nothing", async () => {
    const o = await office();
    const forOwner = await asOwner(
      o,
      "PUT",
      `/api/users/${o.ownerName}/access`,
      { allowedRooms: [o.room], pack: READ_TASKS },
    );
    expect(forOwner.status).toBeGreaterThanOrEqual(400);
    expect(forOwner.status).toBeLessThan(500);
    expect(forOwner.status).not.toBe(403);
    expect(getUserByName(o.ownerName)?.pack).toBeUndefined();
    for (const pack of [
      { areas: { tasks: "admin" }, agentCeiling: "chat" },
      { areas: { nowhere: "read" }, agentCeiling: "chat" },
      { areas: { tasks: "read" }, agentCeiling: "standard" },
      { areas: { tasks: "read" } },
    ]) {
      const res = await asOwner(o, "PUT", `/api/users/${o.caseyName}/access`, {
        allowedRooms: [o.room],
        pack,
      });
      expect({ pack, status: res.status >= 400 && res.status < 500 }).toEqual({
        pack,
        status: true,
      });
      expect(getUserByName(o.caseyName)?.pack).toBeUndefined();
    }
  });

  it("is dropped when the member becomes an owner, and when users.json holds one on an owner or a bad one", async () => {
    const o = await office();
    await packCasey(o, READ_TASKS);
    const promoted = await asOwner(o, "PATCH", `/api/users/${o.caseyName}`, {
      role: "owner",
    });
    expect(promoted.status).toBe(200);
    expect(getUserByName(o.caseyName)?.pack).toBeUndefined();

    // A hand-edited file: a pack on an owner and a pack that does not parse.
    await o.srv.seedMember("Drew");
    const file = join(STATE_ROOT, "users.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    const byName = (name: string) =>
      Object.values(raw).find((u) => u.name === name)!;
    byName(o.ownerName).pack = READ_TASKS;
    byName("Drew").pack = { areas: { tasks: "admin" }, agentCeiling: "chat" };
    writeFileSync(file, JSON.stringify(raw, null, 2));
    o.srv = await o.srv.restart();
    server = o.srv;
    expect(getUserByName(o.ownerName)?.pack).toBeUndefined();
    expect(getUserByName("Drew")?.pack).toBeUndefined();
    // The enabling condition: a good pack on a member loads.
    await o.srv.seedMember("Eden");
    const again = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    Object.values(again).find((u) => u.name === "Eden")!.pack = READ_TASKS;
    writeFileSync(file, JSON.stringify(again, null, 2));
    o.srv = await o.srv.restart();
    server = o.srv;
    expect(getUserByName("Eden")?.pack).toEqual(READ_TASKS);
  });
});

describe("every identity of the member is capped to the pack, read live", () => {
  it("the member's session: refused outside the pack, with the area, until the pack is cleared", async () => {
    const o = await office();
    expect((await asCasey(o, "GET", "/api/tasks")).status).toBe(200);
    expect(
      (await asCasey(o, "POST", "/api/tasks", { title: "before" })).status,
    ).toBe(201);

    await packCasey(o, READ_TASKS);
    // The session was made before the pack: the next call reads it.
    expect((await asCasey(o, "GET", "/api/tasks")).status).toBe(200);
    const write = await asCasey(o, "POST", "/api/tasks", { title: "after" });
    expect({ status: write.status, ...errorOf(write) }).toMatchObject({
      status: 403,
      code: "forbidden",
      area: "tasks",
      level: "write",
    });
    const memory = await asCasey(o, "GET", "/api/memory?scope=office");
    expect({ status: memory.status, area: errorOf(memory).area }).toEqual({
      status: 403,
      area: "memory",
    });
    // Its own pages stay open: preferences, tokens, sessions.
    expect((await asCasey(o, "GET", "/api/me/api-tokens")).status).toBe(200);

    // The member's refusal names the pack, not an API token: an API token
    // refused the same route gets other words.
    const token = await mintAsCasey(o, { areas: { tasks: "read" } });
    const byToken = await asBearer(o, token.bearer, "POST", "/api/tasks", {
      title: "by token",
    });
    expect(byToken.status).toBe(403);
    expect(typeof errorOf(write).message).toBe("string");
    expect(errorOf(write).message).not.toBe(errorOf(byToken).message);

    await packCasey(o, null);
    expect(
      (await asCasey(o, "POST", "/api/tasks", { title: "cleared" })).status,
    ).toBe(201);
  });

  it("the member's API tokens: a full token gets the pack, a wider one is cut, both live", async () => {
    const o = await office();
    const full = await mintAsCasey(o);
    const wide = await mintAsCasey(o, { areas: { tasks: "write" } });
    const roomsOnly = await mintAsCasey(o, { rooms: [o.room] });
    for (const t of [full, wide, roomsOnly])
      expect(
        (await asBearer(o, t.bearer, "POST", "/api/tasks", { title: "x" }))
          .status,
      ).toBe(201);

    await packCasey(o, READ_TASKS);
    for (const [label, t] of [
      ["full", full],
      ["wide", wide],
      ["rooms only", roomsOnly],
    ] as const) {
      const read = await asBearer(o, t.bearer, "GET", "/api/tasks");
      const write = await asBearer(o, t.bearer, "POST", "/api/tasks", {
        title: "y",
      });
      expect({
        label,
        read: read.status,
        write: write.status,
        area: errorOf(write).area,
      }).toEqual({ label, read: 200, write: 403, area: "tasks" });
    }

    await packCasey(o, null);
    expect(
      (await asBearer(o, full.bearer, "POST", "/api/tasks", { title: "z" }))
        .status,
    ).toBe(201);
  });

  it("the member's agent on /api and on /mcp", async () => {
    const o = await office();
    const standard = await spawn(o, "Mine", "Casey");
    const limited = await spawn(o, "MineLimited", "Casey");
    await lower(o, limited, "office", { tasks: "write", agents: "write" });
    expect(
      (await asBearer(o, tokenOf(standard.id), "GET", "/api/tasks")).status,
    ).toBe(200);
    const tools = async () => {
      const client = new Client({ name: "member-pack-test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${o.srv.baseUrl}/mcp`), {
          requestInit: {
            headers: { Authorization: `Bearer ${tokenOf(limited.id)}` },
          },
        }),
      );
      clients.push(client);
      return (await client.listTools()).tools.map((t) => t.name);
    };
    expect(await tools()).toContain("list_tasks");

    await packCasey(o, { areas: { agents: "write" }, agentCeiling: "office" });
    // The pack save moves the Standard agent down to the ceiling, with a new
    // token (member-ceiling.test.ts).
    await waitUntil(
      () => o.srv.agentManager.getAgent(standard.id)?.access === "office",
      "the Standard agent moved down",
    );
    const refused = await asBearer(
      o,
      tokenOf(standard.id),
      "GET",
      "/api/tasks",
    );
    expect({ status: refused.status, area: errorOf(refused).area }).toEqual({
      status: 403,
      area: "tasks",
    });
    expect(await tools()).not.toContain("list_tasks");
    // The enabling condition: the agent keeps what the pack grants.
    expect(await tools()).toContain("send_message");
  });

  it("the member's schedule runs and apps", async () => {
    const o = await office();
    const run = mintRunToken("cj-member-pack", "run-1", o.caseyId);
    expect((await asBearer(o, run, "GET", "/api/tasks")).status).toBe(200);

    const maker = await spawn(o, "AppMaker", "Casey");
    const reg = await asBearer(o, tokenOf(maker.id), "POST", "/api/apps", {
      name: "casey-app",
      command: "bun run serve.ts",
      cwd: o.srv.workDir,
    });
    expect(reg.status).toBe(201);
    const app = appTokens.mint("casey-app", o.caseyId);
    expect((await asBearer(o, app, "GET", "/api/tasks")).status).toBe(200);

    await packCasey(o, { areas: { agents: "read" }, agentCeiling: "chat" });
    for (const [label, bearer] of [
      ["run", run],
      ["app", app],
    ] as const) {
      const res = await asBearer(o, bearer, "GET", "/api/tasks");
      expect({ label, status: res.status, area: errorOf(res).area }).toEqual({
        label,
        status: 403,
        area: "tasks",
      });
    }
  });
});

describe("the messaging rule for a member with a pack", () => {
  const TALK: MemberPack = {
    areas: { agents: "write", asks: "write" },
    agentCeiling: "office",
  };

  it("the member writes only to agents that fit, in the member's rooms, without a marker; so do their tokens", async () => {
    const o = await office();
    const standard = await spawn(o, "Standard");
    const chat = await spawn(o, "Chat");
    await lower(o, chat, "chat");
    const fitting = await spawn(o, "Fitting");
    await lower(o, fitting, "office", { agents: "write" }, [o.room]);
    // Its pack reaches every room, also those Casey cannot access.
    const everywhere = await spawn(o, "Everywhere");
    await lower(o, everywhere, "office", { agents: "write" });
    const full = await mintAsCasey(o);
    const send = (who: "session" | string, toId: string, text: string) =>
      who === "session"
        ? asCasey(o, "POST", `/api/agents/${toId}/messages`, { text })
        : asBearer(o, who, "POST", `/api/agents/${toId}/messages`, { text });

    // Without a pack Casey reaches the Standard agent.
    expect((await send("session", standard.id, "before")).status).toBe(200);

    await packCasey(o, TALK);
    for (const who of ["session", full.bearer]) {
      const label = who === "session" ? "session" : "token";
      expect({
        label,
        ...outcome(await send(who, standard.id, "order")),
      }).toEqual({ label, ...REFUSED });
      expect({
        label,
        ...outcome(await send(who, everywhere.id, "to every room")),
      }).toEqual({ label, ...REFUSED });
      expect((await send(who, chat.id, `to chat by ${label}`)).status).toBe(
        200,
      );
      expect(
        (await send(who, fitting.id, `to fitting by ${label}`)).status,
      ).toBe(200);
    }
    await waitUntil(
      () => received(o, fitting.id, "to fitting by session") !== undefined,
      "the fitting agent got the member's message",
    );
    expect(received(o, fitting.id, "to fitting by session")).not.toContain(
      API_TOKEN_REPLIES_ONLY,
    );
    expect(sentTexts(o, standard.id).some((t) => t.includes("order"))).toBe(
      false,
    );
  });

  it("a member's token with rooms reaches only agents inside both its rooms and the member's", async () => {
    const o = await office();
    const other = o.srv.agentManager.createRoom("Other");
    const both = await spawn(o, "Both");
    await lower(o, both, "office", { agents: "write" }, [o.room, other]);
    const onlyHere = await spawn(o, "OnlyHere");
    await lower(o, onlyHere, "office", { agents: "write" }, [o.room]);
    const token = await mintAsCasey(o, { rooms: [o.room] });
    const res = await asOwner(o, "PUT", `/api/users/${o.caseyName}/access`, {
      allowedRooms: [o.room, other],
      pack: TALK,
    });
    expect(res.status).toBe(200);
    const send = (who: "session" | string, toId: string, text: string) =>
      who === "session"
        ? asCasey(o, "POST", `/api/agents/${toId}/messages`, { text })
        : asBearer(o, who, "POST", `/api/agents/${toId}/messages`, { text });
    // The member reaches both rooms, so the agent fits her session.
    expect((await send("session", both.id, "from the session")).status).toBe(
      200,
    );
    expect((await send(token.bearer, onlyHere.id, "inside")).status).toBe(200);
    expect(outcome(await send(token.bearer, both.id, "outside"))).toEqual(
      REFUSED,
    );
  });

  it("replies to an agent that opened an ask to the member, marked replies only; orders stay refused, and their tokens get no reply right", async () => {
    const o = await office();
    const standard = await spawn(o, "Standard");
    const other = await spawn(o, "Other");
    const full = await mintAsCasey(o);
    await packCasey(o, TALK);
    const send = (toId: string, text: string) =>
      asCasey(o, "POST", `/api/agents/${toId}/messages`, { text });
    expect(outcome(await send(standard.id, "too early"))).toEqual(REFUSED);

    const ask = await asBearer(
      o,
      tokenOf(standard.id),
      "POST",
      `/api/agents/${standard.id}/asks`,
      { prompt: "Which report do you want?", member: o.caseyName },
    );
    expect(ask.status).toBe(201);

    expect((await send(standard.id, "the weekly one")).status).toBe(200);
    await waitUntil(
      () => received(o, standard.id, "the weekly one") !== undefined,
      "the reply delivered",
    );
    expect(received(o, standard.id, "the weekly one")).toContain(
      API_TOKEN_REPLIES_ONLY,
    );
    // Only the agent that asked, and only replies.
    expect(outcome(await send(other.id, "and you"))).toEqual(REFUSED);
    expect(
      outcome(
        await asCasey(
          o,
          "POST",
          `/api/agents/${standard.id}/new-conversation`,
          {},
        ),
      ),
    ).toEqual(REFUSED);
    // The member's tokens keep their own reply right only.
    expect(
      outcome(
        await asBearer(
          o,
          full.bearer,
          "POST",
          `/api/agents/${standard.id}/messages`,
          {
            text: "by token",
          },
        ),
      ),
    ).toEqual(REFUSED);
  });

  it("the reply right survives a restart and ends when the agent is killed", async () => {
    const o = await office();
    const standard = await spawn(o, "Standard");
    await packCasey(o, TALK);
    const ask = await asBearer(
      o,
      tokenOf(standard.id),
      "POST",
      `/api/agents/${standard.id}/asks`,
      { prompt: "Ready?", member: o.caseyName },
    );
    expect(ask.status).toBe(201);
    o.srv = await o.srv.restart();
    server = o.srv;
    const send = (text: string) =>
      asCasey(o, "POST", `/api/agents/${standard.id}/messages`, { text });
    expect((await send("after the restart")).status).toBe(200);

    expect(
      (await asOwner(o, "DELETE", `/api/agents/${standard.id}`)).status,
    ).toBe(204);
    o.srv = await o.srv.restart();
    server = o.srv;
    expect(
      (
        await asOwner(o, "POST", `/api/agents/${standard.id}/revive`, {
          roomId: o.room,
        })
      ).status,
    ).toBe(200);
    expect(outcome(await send("still there?"))).toEqual(REFUSED);
  });

  it("a task the member creates or edits carries limited", async () => {
    const o = await office();
    const before = await asCasey(o, "POST", "/api/tasks", { title: "Open" });
    expect(before.status).toBe(201);
    expect(limitedOf(before.body)).toBe(false);

    await packCasey(o, { areas: { tasks: "write" }, agentCeiling: "chat" });
    const created = await asCasey(o, "POST", "/api/tasks", {
      title: "From the contractor",
    });
    expect(created.status).toBe(201);
    expect(limitedOf(created.body)).toBe(true);
    const task = before.body as TaskItem;
    const edited = await asCasey(o, "PATCH", `/api/tasks/${task.id}`, {
      version: task.version,
      description: "do it my way",
    });
    expect(edited.status).toBe(200);
    expect(limitedOf(edited.body)).toBe(true);
  });

  it("the member moves their own agent inside the pack, and cannot raise it out", async () => {
    const o = await office();
    const mine = await spawn(o, "Mine", "Casey");
    await packCasey(o, {
      areas: { agents: "write", agentManagement: "write" },
      agentCeiling: "office",
    });
    const move = (body: unknown) =>
      asCasey(o, "PUT", `/api/agents/${mine.id}/access`, body);
    // The pack save moved it down to the ceiling (member-ceiling.test.ts).
    await waitUntil(
      () => o.srv.agentManager.getAgent(mine.id)?.access === "office",
      "the agent moved down",
    );
    expect(
      (
        await move({
          access: "office",
          pack: { areas: { agents: "write" }, rooms: [o.room] },
        })
      ).status,
    ).toBe(200);
    // A wider pack at the same stop, and back to Standard: both outside.
    expect(
      outcome(
        await move({
          access: "office",
          pack: { areas: { agents: "write", memory: "read" }, rooms: [o.room] },
        }),
      ),
    ).toEqual(REFUSED);
    // Above the ceiling: the ceiling's refusal.
    expect(outcome(await move({ access: "standard" }))).toEqual({
      status: 403,
      code: "above_agent_ceiling",
    });
    expect(o.srv.agentManager.getAgent(mine.id)?.access).toBe("office");
  });
});

describe("the outbox of scheduled messages for a member with a pack", () => {
  it("the member cancels scheduled messages only in the outbox of an agent that fits", async () => {
    const o = await office();
    const receiver = await spawn(o, "Receiver");
    await lower(o, receiver, "chat");
    const standard = await spawn(o, "Standard");
    const fitting = await spawn(o, "Fitting");
    await lower(o, fitting, "office", { agents: "write" }, [o.room]);
    const deliverAt = new Date(Date.now() + 3_600_000).toISOString();
    const schedule = async (from: AgentInfo): Promise<string> => {
      const res = await asBearer(
        o,
        tokenOf(from.id),
        "POST",
        `/api/agents/${receiver.id}/messages`,
        { text: `later from ${from.name}`, deliverAt },
      );
      expect({ from: from.name, status: res.status }).toEqual({
        from: from.name,
        status: 200,
      });
      return (res.body as { scheduledId: string }).scheduledId;
    };
    const outbox = async (agent: AgentInfo): Promise<string[]> => {
      const res = await asBearer(
        o,
        tokenOf(agent.id),
        "GET",
        `/api/agents/${agent.id}/scheduled-messages`,
      );
      expect(res.status).toBe(200);
      return (res.body as { scheduled: Array<{ id: string }> }).scheduled.map(
        (e) => e.id,
      );
    };
    const cancel = (agent: AgentInfo, id: string) =>
      asCasey(o, "DELETE", `/api/agents/${agent.id}/scheduled-messages/${id}`);
    const fromStandard = await schedule(standard);
    const fromFitting = await schedule(fitting);

    await packCasey(o, MEMBER_PACK_PRESETS.workWithAgents);
    expect(outcome(await cancel(standard, fromStandard))).toEqual(REFUSED);
    expect(await outbox(standard)).toEqual([fromStandard]);
    expect((await cancel(fitting, fromFitting)).status).toBe(204);
    expect(await outbox(fitting)).toEqual([]);
  });
});

describe("the member's agents and answers under the pack", () => {
  it("a reply answers no prompt that waits for a member, where a fitting message does", async () => {
    const o = await office();
    const asker = await spawn(o, "Asker");
    const fitting = await spawn(o, "Fitting");
    await lower(o, fitting, "office", { agents: "write" }, [o.room]);
    // agentManagement: an answer to a model picker needs it
    // (slash-command-areas.test.ts).
    await packCasey(o, {
      areas: { agents: "write", asks: "write", agentManagement: "write" },
      agentCeiling: "office",
    });
    expect(
      (
        await asBearer(
          o,
          tokenOf(asker.id),
          "POST",
          `/api/agents/${asker.id}/asks`,
          {
            prompt: "Ready?",
            member: o.caseyName,
          },
        )
      ).status,
    ).toBe(201);
    const pending = (agentId: string) =>
      o.srv.agentManager
        .getPendingInteractions()
        .filter((item) => item.agentId === agentId);
    for (const agent of [asker, fitting]) {
      const opened = await asOwner(
        o,
        "POST",
        `/api/agents/${agent.id}/messages`,
        {
          text: "/model",
        },
      );
      expect(opened.status).toBe(200);
      expect(pending(agent.id)).toHaveLength(1);
    }
    const model = o.srv.agentManager.getAgent(asker.id)!.modelFamily;

    const refused = await asCasey(
      o,
      "POST",
      `/api/agents/${asker.id}/messages`,
      {
        text: "1",
      },
    );
    expect(outcome(refused)).toEqual({
      status: 409,
      code: "awaits_member_answer",
    });
    expect(pending(asker.id)).toHaveLength(1);
    expect(o.srv.agentManager.getAgent(asker.id)!.modelFamily).toBe(model);

    // A message that fits is the member's own: its typed choice settles it.
    expect(
      (
        await asCasey(o, "POST", `/api/agents/${fitting.id}/messages`, {
          text: "1",
        })
      ).status,
    ).toBe(200);
    expect(pending(fitting.id)).toHaveLength(0);
  });

  it("an answer to an ask is marked replies only when the asking agent does not fit", async () => {
    const o = await office();
    const standard = await spawn(o, "Standard");
    const fitting = await spawn(o, "Fitting");
    await lower(o, fitting, "office", { asks: "write" }, [o.room]);
    await packCasey(o, {
      areas: { agents: "write", asks: "write" },
      agentCeiling: "office",
    });
    const answer = async (agent: AgentInfo, text: string) => {
      const ask = await asBearer(
        o,
        tokenOf(agent.id),
        "POST",
        `/api/agents/${agent.id}/asks`,
        { prompt: `Question from ${agent.name}?`, member: o.caseyName },
      );
      expect(ask.status).toBe(201);
      const reply = await asCasey(
        o,
        "POST",
        `/api/asks/${(ask.body as { id: string }).id}/reply`,
        { text },
      );
      expect(reply.status).toBe(204);
      await waitUntil(
        () => received(o, agent.id, text) !== undefined,
        `${agent.name} got the answer`,
      );
      return received(o, agent.id, text)!;
    };
    expect(await answer(standard, "yes from Casey")).toContain(
      API_TOKEN_REPLIES_ONLY,
    );
    expect(await answer(fitting, "no from Casey")).not.toContain(
      API_TOKEN_REPLIES_ONLY,
    );
  });
});

describe("apps of a member whose pack has no apps area", () => {
  it("an app session made before the pack stops at the app's host", async () => {
    const { srv, label, rawSessionId } = await anOfficeWithAnApp((s) => {
      server = s;
    });
    const host = appHost(label);
    const value = await signIn(srv, label, rawSessionId);
    const visit = () =>
      raw(srv.port, {
        host,
        path: "/",
        headers: { ...NAVIGATION_HEADERS, ...withAppCookie(value) },
      });
    // Past the gate, into the relay (no process listens on the app's port).
    expectPlaceholder(await visit(), RELAY_UNREACHABLE, "before the pack");

    const owner = getUserByName("Morgan")!;
    const invite = await mintInvite({
      userId: owner.id,
      createdBy: null,
      ttlMs: INVITE_TTL_MS,
    });
    if (!invite.ok) throw new Error(invite.error);
    const accepted = await acceptInvite(invite.rawToken, { userAgent: "test" });
    if (!accepted.ok) throw new Error(accepted.error);
    const member = getUserByName("Member")!;
    const setMemberPack = async (pack: MemberPack) => {
      const res = await srv.http(`/api/users/${member.name}/access`, {
        method: "PUT",
        rawSessionId: accepted.rawSessionId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedRooms: member.allowedRooms, pack }),
      });
      expect(res.status).toBe(200);
    };

    await setMemberPack({ areas: { agents: "read" }, agentCeiling: "chat" });
    const stopped = await visit();
    expect({ status: stopped.status, body: stopped.body }).not.toEqual({
      status: RELAY_UNREACHABLE.status,
      body: RELAY_UNREACHABLE.body,
    });
    // With apps in the pack the same session goes on to the relay.
    await setMemberPack({ areas: { apps: "read" }, agentCeiling: "chat" });
    expectPlaceholder(await visit(), RELAY_UNREACHABLE, "apps in the pack");
  });
});

describe("the file panel, browser tabs and the terminal of a member with a pack", () => {
  it("opens the file panel only on an agent that fits", async () => {
    const o = await office();
    const standard = await spawn(o, "Standard");
    const chat = await spawn(o, "Chat");
    await lower(o, chat, "chat");
    const open = (agentId: string) =>
      asCasey(o, "GET", `/api/agents/${agentId}/file?path=notes.md`);
    // Without a pack the route goes on to the handler.
    expect(codeOf(await open(standard.id))).not.toBe(NOT_FIT);
    expect((await open(standard.id)).status).not.toBe(403);

    await packCasey(o, {
      areas: { agents: "write", files: "read" },
      agentCeiling: "office",
    });
    expect(outcome(await open(standard.id))).toEqual(REFUSED);
    const fits = await open(chat.id);
    expect({
      status: fits.status === 403,
      code: codeOf(fits) === NOT_FIT,
    }).toEqual({ status: false, code: false });
  });

  it("offers browser tabs only to an agent that fits", async () => {
    const o = await office();
    const standard = await spawn(o, "Standard");
    const chat = await spawn(o, "Chat");
    await lower(o, chat, "chat");
    expect(mayReachExtension(o.caseyId, standard.id)).toBe(true);
    await packCasey(o, { areas: { agents: "write" }, agentCeiling: "office" });
    expect(mayReachExtension(o.caseyId, standard.id)).toBe(false);
    expect(mayReachExtension(o.caseyId, chat.id)).toBe(true);
    // The owner keeps it.
    expect(mayReachExtension(o.ownerId, standard.id)).toBe(true);
  });

  it("refuses every terminal frame once a pack is saved", async () => {
    const o = await office();
    const agent = await spawn(o, "Standard");
    const am = o.srv.agentManager;
    const spies = {
      open: spyOn(am, "openTerminal").mockImplementation(() => false),
      input: spyOn(am, "terminalInput").mockImplementation(() => {}),
      status: spyOn(am, "terminalStatus").mockImplementation(() => {}),
      resize: spyOn(am, "terminalResize").mockImplementation(() => {}),
      close: spyOn(am, "closeTerminal").mockImplementation(() => {}),
      restart: spyOn(am, "restartTerminal").mockImplementation(() => false),
    };
    try {
      let ws = await o.srv.connectWs(o.casey);
      const frames = async () => {
        const id = agent.id;
        ws.send({ type: "terminal_open", agentId: id });
        ws.send({ type: "terminal_input", agentId: id, data: "ls\r" });
        ws.send({ type: "terminal_status_request", agentId: id });
        ws.send({ type: "terminal_resize", agentId: id, cols: 80, rows: 24 });
        ws.send({ type: "terminal_close", agentId: id });
        ws.send({ type: "terminal_restart", agentId: id });
        // Frames are handled in order: the pong comes after all six.
        ws.messages.splice(0);
        ws.send({ type: "ping" });
        await ws.waitFor("pong");
      };
      const counts = () =>
        Object.fromEntries(
          Object.entries(spies).map(([k, s]) => [k, s.mock.calls.length]),
        );
      await frames();
      const before = counts();
      // The enabling condition: without a pack each frame reached its verb.
      expect(before).toEqual({
        open: 1,
        input: 1,
        status: 1,
        resize: 1,
        close: 1,
        restart: 1,
      });

      // A pack change closes the socket (member-pack-ws.test.ts); the frames
      // go on a socket made after the save.
      const closed = new Promise<void>((resolve) =>
        ws.raw.addEventListener("close", () => resolve()),
      );
      await packCasey(o, {
        areas: { agents: "write" },
        agentCeiling: "office",
      });
      await closed;
      ws = await o.srv.connectWs(o.casey);
      await frames();
      expect(counts()).toEqual(before);
      ws.close();
    } finally {
      for (const s of Object.values(spies)) s.mockRestore();
    }
  });
});

describe("a schedule or a webhook of a member with a pack, at the fire", () => {
  it("a schedule run is refused once the target no longer fits the member's pack", async () => {
    const o = await office();
    const standard = await spawn(o, "Standard");
    const job = o.srv.cronjobManager.addCronjob({
      name: "Casey's nudge",
      schedule: { type: "none" },
      prompt: "nudge from the schedule",
      cwd: o.srv.workDir,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username: o.caseyName,
      userId: o.caseyId,
      roomId: o.room,
      target: { kind: "agent", agentId: standard.id },
    });
    const fire = async () => {
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
    };
    expect(await fire()).toBe("completed");
    const delivered = sentTexts(o, standard.id).length;
    expect(delivered).toBeGreaterThan(0);

    await packCasey(o, { areas: { agents: "write" }, agentCeiling: "office" });
    expect(await fire()).toBe("failed");
    expect(sentTexts(o, standard.id)).toHaveLength(delivered);
  });

  it("a webhook delivery is refused once the target no longer fits the member's pack", async () => {
    const o = await office();
    const standard = await spawn(o, "Standard");
    const hook = await asCasey(o, "POST", "/api/webhooks", {
      name: "casey-push",
      scheme: "github-hmac-sha256",
      rules: [{ event: "push" }],
      target: { kind: "agent", agentId: standard.id },
    });
    expect(hook.status).toBe(201);
    const hookId = (hook.body as { id: string }).id;
    const secret = (
      (await asCasey(o, "GET", `/api/webhooks/${hookId}/secret`)).body as {
        secret: string;
      }
    ).secret;
    const deliver = async (marker: string) => {
      const body = new TextEncoder().encode(
        JSON.stringify({ ref: marker, after: randomUUID() }),
      );
      const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      const res = await fetch(`${o.srv.baseUrl}/hooks/${hookId}`, {
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
    };
    const outcomes = async () =>
      (
        (await asOwner(o, "GET", `/api/webhooks/${hookId}/deliveries`))
          .body as {
          deliveries: Array<{ receivedAt: number; outcome: string }>;
        }
      ).deliveries
        .slice()
        .sort((x, y) => x.receivedAt - y.receivedAt)
        .map((d) => d.outcome);
    const settled = async (count: number) => {
      let seen: string[] = [];
      for (let i = 0; i < 150; i++) {
        seen = await outcomes();
        if (seen.length === count && seen[count - 1] !== "pending") break;
        await Bun.sleep(20);
      }
      return seen;
    };
    await deliver("first-push");
    await waitUntil(
      () => sentTexts(o, standard.id).length > 0,
      "the first delivery reached the agent",
    );
    expect(await settled(1)).toEqual(["dispatched"]);
    const delivered = sentTexts(o, standard.id).length;

    await packCasey(o, { areas: { agents: "write" }, agentCeiling: "office" });
    await deliver("second-push");
    expect(await settled(2)).toEqual(["dispatched", "target_unavailable"]);
    expect(sentTexts(o, standard.id)).toHaveLength(delivered);
  });
});
