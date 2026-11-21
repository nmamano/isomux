// Task 9a828336: lines an agent writes while it has no session id (a start
// that fails, the first message before system_init) live in a per-agent
// pre-session file, and the logs API lists them as the pseudo session
// PRE_SESSION_LOG_ID until the agent's next session takes them.
//
// Seams: the DI manager with a FakeBackend (createAgentManager), the logs
// source the route and the search child read (fileLogSource), and the route
// itself over HTTP (startTestServer). A start failure is a createSession that
// throws; a session with no id yet is a FakeSession with autoSystemInit off.
//
// What each test pins, and the mutant it was seen red on, is named above it.

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeBackend, type FakeSessionConfig } from "./fake-backend.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { LogEntry, RoomWire } from "../../shared/types.ts";
import {
  PRE_SESSION_LOG_ID,
  type LogRetrieveResp,
  type LogSearchResp,
  type LogSessionIndexResp,
} from "../../shared/contract-shapes.ts";
import { STATE_ROOT } from "../config.ts";
import { createAgentManager } from "../agent-manager.ts";
import { loadLog } from "../persistence.ts";
import { fileLogSource } from "../log-source.ts";
import { preSessionLogPath } from "../transcript-files.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { _testResetSearchAdmission } from "../log-search-runner.ts";

type Manager = ReturnType<typeof createAgentManager>;

const LOGS = join(STATE_ROOT, "logs");
const source = () => fileLogSource(LOGS);

const fakes: FakeBackend[] = [];
let server: TestServer | null = null;
afterEach(async () => {
  for (const f of fakes) f.sessions.forEach((s) => s.close());
  fakes.length = 0;
  await server?.stop();
  server = null;
});

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: i > 0,
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

// A backend whose sessions answer every send. `failStart` makes each
// createSession throw until it is set false.
function backend(
  session: FakeSessionConfig = {},
  opts: { newSessionId?: () => string } = {},
): { fake: FakeBackend; control: { failStart: boolean } } {
  const control = { failStart: false };
  const fake = new FakeBackend({
    session: {
      onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }),
      ...session,
    },
    ...opts,
  });
  const create = fake.createSession.bind(fake);
  fake.createSession = (o) => {
    if (control.failStart) {
      fake.createSessionCount++;
      throw new Error("start-boom-quokka");
    }
    return create(o);
  };
  fakes.push(fake);
  return { fake, control };
}

function manager(fake: FakeBackend, room: string, initialRooms = []) {
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms(room) }),
    initialRooms,
  });
  mgr.configureAgentTurnDeps();
  return mgr;
}

async function spawn(mgr: Manager, room: string): Promise<string> {
  const info = await mgr.spawn(
    room,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    room,
    undefined,
    "opencode/fake",
    "high",
    undefined,
    "opencode",
  );
  if (!info) throw new Error("spawn returned null");
  return info.id;
}

function send(mgr: Manager, id: string, text: string) {
  return mgr.enqueueMessage(id, {
    sender: { kind: "user", username: "tester" },
    text,
  });
}

const durableIds = (entries: LogEntry[]) =>
  entries.filter((e) => !e.ephemeral).map((e) => e.id);

async function preSessionIds(id: string): Promise<string[]> {
  return (await source().readEntries(id, PRE_SESSION_LOG_ID)).map((e) => e.id);
}

async function listed(id: string): Promise<string[]> {
  return (await source().listSessions(id)).map((s) => s.sessionId);
}

// An agent whose first start failed: its chat holds the member's message and
// the start error, and it has no session id.
async function failedStart(room: string) {
  const { fake, control } = backend();
  control.failStart = true;
  const mgr = manager(fake, room);
  const id = await spawn(mgr, room);
  expect(send(mgr, id, "hello before any session").ok).toBe(true);
  await waitUntil(
    () => mgr.getAgentLogs(id).some((e) => e.kind === "error"),
    "start error in chat",
  );
  expect(mgr.getCurrentSessionId(id)).toBe(null);
  const error = mgr.getAgentLogs(id).find((e) => e.kind === "error")!;
  return { fake, control, mgr, id, error };
}

describe("lines written with no session", () => {
  // The task's case: a start that fails leaves its error where the logs API
  // reads. RED on today's code: no pre-session session is listed and its read
  // is empty.
  it("are on disk as the pre-session pseudo session, exactly the chat's durable lines", async () => {
    const { id, mgr, error } = await failedStart("room-pre-fail");
    expect(await listed(id)).toEqual([PRE_SESSION_LOG_ID]);
    const onDisk = await preSessionIds(id);
    expect(onDisk).toContain(error.id);
    expect(onDisk).toEqual(durableIds(mgr.getAgentLogs(id)));
  });

  // MUTANT: the system_init backfill without the pre-session delete (dies on
  // the listing); the backfill skipped (dies on the transcript check).
  it("go to the first session that starts, and the pre-session file goes away", async () => {
    const { id, mgr, control, fake, error } =
      await failedStart("room-pre-taken");
    control.failStart = false;
    expect(send(mgr, id, "again").ok).toBe(true);
    await waitUntil(() => mgr.getCurrentSessionId(id) !== null, "session id");
    const sessionId = mgr.getCurrentSessionId(id)!;
    await waitUntil(
      () => (fake.sessions[0]?.sent.length ?? 0) > 0,
      "the new session got a send",
    );
    expect(loadLog(id, sessionId).map((e) => e.id)).toContain(error.id);
    expect(await listed(id)).toEqual([sessionId]);
    expect(existsSync(preSessionLogPath(join(LOGS, id)))).toBe(false);
  });

  // A new conversation writes lines of its own after the reset (its note, the
  // still-queued message, a second failed start), so the file is not gone:
  // it holds those, and none from before. MUTANT: resetChat without
  // syncPreSessionLog (dies on the old-line check).
  it("go away with the chat on a new conversation", async () => {
    const { id, mgr } = await failedStart("room-pre-clear");
    const before = durableIds(mgr.getAgentLogs(id));
    expect(await preSessionIds(id)).toEqual(before);
    await mgr.newConversation(id);
    const chat = durableIds(mgr.getAgentLogs(id));
    const onDisk = await preSessionIds(id);
    for (const old of before) {
      expect(chat).not.toContain(old);
      expect(onDisk).not.toContain(old);
    }
    expect(onDisk).toEqual(chat);
  });

  // Ephemeral lines (an unknown slash command's echo and answer) stay out of
  // the file, also when a reset rewrites it from a chat that holds them: an
  // edit of the second command's echo trims the chat back to the first
  // command's lines. MUTANT: writePreSessionLog without the ephemeral filter
  // (dies on the ephemeral check).
  it("never include an ephemeral line", async () => {
    // An agent whose session answers but never reports its id: it waits for
    // a response (an edit needs that state), with no session id.
    const room = "room-pre-ephemeral";
    const { fake } = backend({ autoSystemInit: false });
    const mgr = manager(fake, room);
    const id = await spawn(mgr, room);
    expect(send(mgr, id, "hello").ok).toBe(true);
    await waitUntil(
      () => mgr.getAgent(id)?.state === "waiting_for_response",
      "turn answered",
    );
    expect(mgr.getCurrentSessionId(id)).toBe(null);
    expect((await preSessionIds(id)).length).toBeGreaterThan(0);
    await mgr.sendMessage(id, "/nosuchcommandquokka", "tester");
    const firstEphemeral = mgr
      .getAgentLogs(id)
      .filter((e) => e.ephemeral)
      .map((e) => e.id);
    // The enabling condition: the chat does hold an ephemeral line.
    expect(firstEphemeral.length).toBeGreaterThan(0);
    await mgr.sendMessage(id, "/nosuchcommandwombat", "tester");
    const echo = mgr
      .getAgentLogs(id)
      .find((e) => e.ephemeral && e.content === "/nosuchcommandwombat");
    expect(echo).toBeDefined();
    await mgr.editMessage(id, echo!.id, "/nosuchcommandnumbat");
    const chat = mgr.getAgentLogs(id);
    // The trim kept the first command's ephemeral lines.
    for (const e of firstEphemeral) expect(chat.map((c) => c.id)).toContain(e);
    expect(chat.some((e) => e.content === "/nosuchcommandwombat")).toBe(false);
    const onDisk = await preSessionIds(id);
    for (const e of chat.filter((c) => c.ephemeral))
      expect(onDisk).not.toContain(e.id);
    expect(onDisk).toEqual(durableIds(chat));
  });
});

// The entries in the agent's chat written from one catalog key.
function entriesWithKey(mgr: Manager, id: string, key: string): number {
  return mgr
    .getAgentLogs(id)
    .filter((entry) =>
      (entry.message ?? []).some(
        (part) => typeof part !== "string" && part.key.startsWith(key),
      ),
    ).length;
}

// A second manager over the same state: the restart.
async function restart(
  mgr: Manager,
  id: string,
  room: string,
  fake: FakeBackend,
): Promise<Manager> {
  const persisted = mgr.getAgent(id)!;
  const after = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: rooms(room) }),
    initialRooms: [
      {
        id: room,
        name: room,
        prompt: null,
        agents: [
          {
            id,
            name: persisted.name,
            desk: 0,
            cwd: STATE_ROOT,
            outfit: persisted.outfit,
            permissionMode: "default",
            modelFamily: "opencode/fake",
            agentType: "opencode",
            lastSessionId: null,
            topic: null,
            customInstructions: null,
            userId: null,
          },
        ],
      },
    ],
  });
  after.configureAgentTurnDeps();
  await after.restoreAgents();
  return after;
}

describe("after a restart with no session", () => {
  // The chat shows the lines again, and the API still has them. A torn last
  // line (a crash mid-append) costs only that line. RED on today's code: the
  // restored chat is empty. MUTANT: loadPreSessionLog that throws or returns
  // [] on a bad line (dies on the chat check).
  it("the chat shows the lines from before, and the API still lists them", async () => {
    const room = "room-pre-restart";
    const { id, mgr, error } = await failedStart(room);
    const before = durableIds(mgr.getAgentLogs(id));
    writeFileSync(preSessionLogPath(join(LOGS, id)), '{"id":"torn', {
      flag: "a",
    });
    const { fake: next, control } = backend();
    control.failStart = true;
    const after = await restart(mgr, id, room, next);
    const chat = durableIds(after.getAgentLogs(id));
    expect(chat.slice(0, before.length)).toEqual(before);
    expect(chat).toContain(error.id);
    expect(await listed(id)).toEqual([PRE_SESSION_LOG_ID]);
    expect(await preSessionIds(id)).toContain(error.id);
  });

  // A message the dead process accepted before it reported a session id is
  // sent again at boot. Its chat line is in the pre-session file, so the
  // restored chat already shows it: the resend writes no second line. RED on
  // today's code: the line is a new one (another id). MUTANT: restore passing
  // echoed=false for a no-id record (dies on the count).
  it("a message sent again is in the chat once, as the line from before", async () => {
    const room = "room-pre-resend";
    const { fake: first } = backend({
      autoSystemInit: false,
      onSend: () => {},
    });
    const mgr = manager(first, room);
    const id = await spawn(mgr, room);
    expect(send(mgr, id, "the brief").ok).toBe(true);
    await waitUntil(
      () => (first.sessions[0]?.sent.length ?? 0) > 0,
      "brief accepted",
    );
    expect(mgr.getCurrentSessionId(id)).toBe(null);
    const brief = mgr
      .getAgentLogs(id)
      .find((e) => e.kind === "user_message" && e.content === "the brief")!;
    expect(brief).toBeDefined();

    const { fake: next } = backend();
    const after = await restart(mgr, id, room, next);
    await waitUntil(
      () =>
        (next.lastSession?.sent ?? []).some((m) =>
          m.text.includes("the brief"),
        ),
      "the brief sent again",
    );
    await waitUntil(() => after.getCurrentSessionId(id) !== null, "session id");
    const briefs = (entries: LogEntry[]) =>
      entries.filter(
        (e) => e.kind === "user_message" && e.content === "the brief",
      );
    expect(briefs(after.getAgentLogs(id)).map((e) => e.id)).toEqual([brief.id]);
    const sessionId = after.getCurrentSessionId(id)!;
    expect(briefs(loadLog(id, sessionId)).map((e) => e.id)).toEqual([brief.id]);
    // No session was interrupted: there was none.
    expect(entriesWithKey(after, id, "systemEntries.previousInterrupted")).toBe(
      0,
    );
  });
});

// A turn that ended with no reply text leaves the member's message as the
// last line. After a restart the chat shows it again (pre-session), but no
// session was interrupted: the next message, by the queue's wake or by a
// member's direct send, writes no interruption line. MUTANTS: the flushQueue
// wake check without the session id (dies on the queue case); the sendMessage
// check without it (dies on the direct case).
describe("after a restart, a turn that ended with no reply", () => {
  for (const via of ["queue", "direct"] as const) {
    it(`writes no interruption line at the next message (${via})`, async () => {
      const room = `room-pre-marker-${via}`;
      const { fake: first } = backend({
        autoSystemInit: false,
        onSend: (_t, _a, s) => s.completeTurn({}),
      });
      const mgr = manager(first, room);
      const id = await spawn(mgr, room);
      expect(send(mgr, id, "no reply").ok).toBe(true);
      await waitUntil(
        () => mgr.getAgent(id)?.state === "waiting_for_response",
        "turn ended",
      );
      expect(mgr.getCurrentSessionId(id)).toBe(null);

      const { fake: next } = backend();
      const after = await restart(mgr, id, room, next);
      // The enabling condition: the restored chat ends with the message.
      expect(after.getAgentLogs(id).at(-1)?.kind).toBe("user_message");
      if (via === "queue") expect(send(after, id, "next").ok).toBe(true);
      else void after.sendMessage(id, "next", "tester").catch(() => {});
      await waitUntil(
        () =>
          (next.lastSession?.sent ?? []).some((m) => m.text.includes("next")),
        "next sent",
      );
      expect(
        entriesWithKey(after, id, "systemEntries.previousInterrupted"),
      ).toBe(0);
    });
  }
});

describe("the pre-session file follows the chat", () => {
  // A first-message-style edit that the backend answers with a fresh session
  // (forkResult kind "fresh") leaves the agent with no session id and the
  // parent's lines back in the chat. RED on a sync that runs when clear_logs
  // goes out (before the refill): the file then lacks the parent lines.
  it("after an edit into a fresh session that has no id yet, holds the chat's durable lines", async () => {
    const room = "room-pre-fork";
    const sessionCfg: FakeSessionConfig = {
      onSend: (_t, _a, s) => s.completeTurn({ text: "reply" }),
    };
    const fake = new FakeBackend({
      session: sessionCfg,
      sessionMessages: [
        { uuid: "u-first", role: "user", text: "first" },
        { uuid: "a-1", role: "assistant", text: "reply" },
        { uuid: "u-second", role: "user", text: "second" },
        { uuid: "a-2", role: "assistant", text: "reply" },
      ],
    });
    fakes.push(fake);
    const mgr = manager(fake, room);
    const info = (await mgr.spawn(
      "A",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      room,
    ))!;
    await mgr.sendMessage(info.id, "first");
    await mgr.sendMessage(info.id, "second");
    const parent = fake.sessionForAgent(info.id)!.sessionId;
    await waitUntil(
      () =>
        loadLog(info.id, parent).filter((e) => e.kind === "user_message")
          .length === 2 &&
        mgr.getAgent(info.id)?.state === "waiting_for_response",
      "two turns settled",
    );
    const second = loadLog(info.id, parent).find(
      (e) => e.kind === "user_message" && e.content === "second",
    )!;
    sessionCfg.autoSystemInit = false;
    await mgr.editMessage(info.id, second.id, "edited second");
    await waitUntil(
      () => fake.sessions.length === 2,
      "the fresh session started",
    );
    expect(mgr.getCurrentSessionId(info.id)).toBe(null);
    const chat = durableIds(mgr.getAgentLogs(info.id));
    // The enabling condition: the parent's first line is back in the chat.
    const firstLine = loadLog(info.id, parent).find(
      (e) => e.kind === "user_message" && e.content === "first",
    )!;
    expect(chat).toContain(firstLine.id);
    expect(await preSessionIds(info.id)).toEqual(chat);
  });

  // The first session's backfill fails (its transcript path is a folder): the
  // lines stay in the pre-session file rather than being lost. MUTANT: the
  // backfill with the non-throwing appendLog (dies on the listing).
  it("is kept when the first session's backfill cannot write", async () => {
    const room = "room-pre-backfill";
    const { fake, control } = backend(
      {},
      { newSessionId: () => "sid-blocked" },
    );
    control.failStart = true;
    const mgr = manager(fake, room);
    const id = await spawn(mgr, room);
    expect(send(mgr, id, "hello").ok).toBe(true);
    await waitUntil(
      () => mgr.getAgentLogs(id).some((e) => e.kind === "error"),
      "start error in chat",
    );
    const error = mgr.getAgentLogs(id).find((e) => e.kind === "error")!;
    mkdirSync(join(LOGS, id, "sid-blocked.jsonl"), { recursive: true });
    control.failStart = false;
    expect(send(mgr, id, "again").ok).toBe(true);
    await waitUntil(() => mgr.getCurrentSessionId(id) !== null, "session id");
    await sleep(20);
    expect(await listed(id)).toContain(PRE_SESSION_LOG_ID);
    expect(await preSessionIds(id)).toContain(error.id);
  });

  // A revive whose start fails is rolled back (the agent stays killed and
  // its chat is dropped), but its error line is on disk, so the logs API of
  // the killed agent says why (agent-restore restoreOnStartupFailed). RED on
  // today's code.
  it("holds the error of a revive whose start failed", async () => {
    const room = "room-pre-revive";
    const { fake, control } = backend();
    const mgr = manager(fake, room);
    const id = await spawn(mgr, room);
    await mgr.kill(id);
    control.failStart = true;
    const revived = await mgr.revive(id, room, 0);
    // The enabling condition: the start did fail.
    expect(revived.ok).toBe(false);
    const onDisk = await source().readEntries(id, PRE_SESSION_LOG_ID);
    expect(
      onDisk.some((e) => e.kind === "error" && e.content.includes("quokka")),
    ).toBe(true);
  });
});

describe("fileLogSource and the pre-session file", () => {
  const entry = (agentId: string, id: string, content: string): LogEntry => ({
    id,
    agentId,
    kind: "error",
    content,
    timestamp: 1,
  });
  const lines = (entries: LogEntry[]) =>
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

  // An empty file is not a session; a real session reads as before beside it.
  it("lists the pseudo session only for a non-empty file, and reads it", async () => {
    const id = "agent-pre-source";
    const dir = join(LOGS, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s-real.jsonl"), lines([entry(id, "r1", "real")]));
    writeFileSync(preSessionLogPath(dir), "");
    expect(await listed(id)).toEqual(["s-real"]);

    writeFileSync(preSessionLogPath(dir), lines([entry(id, "p1", "early")]));
    expect((await listed(id)).sort()).toEqual(
      [PRE_SESSION_LOG_ID, "s-real"].sort(),
    );
    expect(await preSessionIds(id)).toEqual(["p1"]);
    const streamed: string[] = [];
    for await (const l of source().streamLines(id, PRE_SESSION_LOG_ID))
      streamed.push(l);
    expect(streamed.map((l) => (JSON.parse(l) as LogEntry).id)).toEqual(["p1"]);
    expect((await source().readEntries(id, "s-real")).map((e) => e.id)).toEqual(
      ["r1"],
    );
  });
});

describe("the logs route", () => {
  beforeEachReset();

  // The task's case over HTTP: index, search and retrieve all see the start
  // error, and its next session takes it. RED on today's code.
  it("index, search and retrieve show a failed start's error, until the next session takes it", async () => {
    const { fake, control } = backend();
    control.failStart = true;
    const srv = await startTestServer({ fakeBackend: fake });
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const room = srv.agentManager.getRooms()[0].id;
    const user = getUserByName(owner.username)!;
    const agent = (await srv.agentManager.spawn(
      "Alpha",
      srv.workDir,
      "default",
      0,
      undefined,
      room,
      undefined,
      undefined,
      undefined,
      owner.username,
      "claude",
      undefined,
      user.id,
    ))!;
    const bearer = mintAgentToken(agent.id, user.id);
    const get = async <T>(qs: string): Promise<T> => {
      const res = await srv.http(`/api/agents/${agent.id}/logs${qs}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as T;
    };
    const sent = await srv.http(`/api/agents/${agent.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
      rawSessionId: owner.rawSessionId,
    });
    expect(sent.status).toBe(200);
    await waitUntil(
      () =>
        srv.agentManager.getAgentLogs(agent.id).some((e) => e.kind === "error"),
      "start error in chat",
    );
    const error = srv.agentManager
      .getAgentLogs(agent.id)
      .find((e) => e.kind === "error")!;

    const index = await get<LogSessionIndexResp>("");
    expect(index.sessions.map((s) => s.sessionId)).toEqual([
      PRE_SESSION_LOG_ID,
    ]);
    const search = await get<LogSearchResp>("?q=quokka&tier=full");
    expect(search.results.map((h) => [h.sessionId, h.entryId])).toContainEqual([
      PRE_SESSION_LOG_ID,
      error.id,
    ]);
    const retrieve = await get<LogRetrieveResp>(
      `?session=${PRE_SESSION_LOG_ID}&tier=full`,
    );
    expect(retrieve.entries.map((e) => e.entryId)).toContain(error.id);

    control.failStart = false;
    const again = await srv.http(`/api/agents/${agent.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "again" }),
      rawSessionId: owner.rawSessionId,
    });
    expect(again.status).toBe(200);
    await waitUntil(
      () => srv.agentManager.getCurrentSessionId(agent.id) !== null,
      "session id",
    );
    const sessionId = srv.agentManager.getCurrentSessionId(agent.id)!;
    await waitUntil(
      () => (fake.sessions[0]?.sent.length ?? 0) > 0,
      "the new session got a send",
    );
    const later = await get<LogSessionIndexResp>("");
    expect(later.sessions.map((s) => s.sessionId)).toEqual([sessionId]);
    const moved = await get<LogSearchResp>("?q=quokka&tier=full");
    expect(moved.results.map((h) => [h.sessionId, h.entryId])).toContainEqual([
      sessionId,
      error.id,
    ]);
  });
});

function beforeEachReset() {
  // Search admission counters are process-global (routes-logs-rest.test.ts).
  beforeEach(_testResetSearchAdmission);
}
