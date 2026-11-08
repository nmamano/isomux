// Chats load when they open (task 9ebe887d slice 2), through the real HTTP
// and WS server. A socket that asks with the logs flag gets no transcript
// replay at connect: it sends open_log for a chat, gets that agent's log as
// replay frames carrying its request id, then log_open_done, and from then on
// that agent's live entries. A socket without the flag (a tab from before)
// keeps the connect replay and every live entry. What happens when the link
// backs up is in office-ws-replay.test.ts; the queue itself in
// server/office-ws-outbox.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getUserByName } from "../users.ts";
import {
  LOGS_ON_OPEN_WS_PARAM,
  LOGS_ON_OPEN_WS_VALUE,
} from "../../shared/log-stream.ts";
import { MEMBER_PACK_PRESETS, type MemberPack } from "../../shared/pack-fit.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const LAZY = `${LOGS_ON_OPEN_WS_PARAM}=${LOGS_ON_OPEN_WS_VALUE}`;
const ENTRIES = 6;

type Msg = Record<string, unknown> & { type: string };
const msgs = (s: TestSocket) => s.messages as Msg[];
const entryFrames = (s: TestSocket, agentId: string) =>
  msgs(s).filter(
    (m) =>
      m.type === "log_entry" &&
      (m.entry as { agentId: string }).agentId === agentId,
  ) as (Msg & { entry: { id: string }; requestId?: string })[];
const doneFrames = (s: TestSocket, agentId: string) =>
  msgs(s).filter((m) => m.type === "log_open_done" && m.agentId === agentId);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

async function spawnIn(srv: TestServer, name: string, roomId: string) {
  const info = await srv.agentManager.spawn(
    name,
    srv.workDir,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
  );
  if (!info) throw new Error(`spawn failed: ${name}`);
  return info;
}

// Give each agent a persisted transcript with known ids and timestamps, then
// cold-restart so the transcripts load into the log cache.
async function seedTranscripts(
  srv: TestServer,
  agentIds: string[],
): Promise<TestServer> {
  const path = join(srv.stateRoot, "agents.json");
  const rooms = JSON.parse(readFileSync(path, "utf8")) as {
    agents: { id: string; lastSessionId?: string }[];
  }[];
  for (const room of rooms) {
    for (const agent of room.agents) {
      if (!agentIds.includes(agent.id)) continue;
      agent.lastSessionId = `sess-${agent.id}`;
      const lines = Array.from({ length: ENTRIES }, (_, k) =>
        JSON.stringify({
          id: `${agent.id}-e${k}`,
          agentId: agent.id,
          timestamp: 1_000 + k,
          kind: "text",
          content: `entry ${k}`,
        }),
      );
      mkdirSync(join(srv.stateRoot, "logs", agent.id), { recursive: true });
      writeFileSync(
        join(srv.stateRoot, "logs", agent.id, `${agent.lastSessionId}.jsonl`),
        lines.join("\n") + "\n",
      );
    }
  }
  writeFileSync(path, JSON.stringify(rooms));
  return srv.restart();
}

async function say(srv: TestServer, rawSessionId: string, agentId: string) {
  const res = await srv.http(`/api/agents/${agentId}/messages`, {
    method: "POST",
    rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `hello ${Date.now()}` }),
  });
  expect(res.status).toBeLessThan(300);
}

// The ids the cache holds now, in order: what a whole replay sends.
const cachedIds = (srv: TestServer, agentId: string) =>
  srv.agentManager.getAgentLogs(agentId).map((e) => e.id);

async function connected(srv: TestServer, rawSessionId: string, query: string) {
  const sock = await srv.connectWs(rawSessionId, { query });
  await sock.waitFor("full_state");
  await sock.waitFor("log_replay_complete");
  return sock;
}

async function opened(
  sock: TestSocket,
  agentId: string,
  requestId: string,
  tail?: number,
) {
  sock.send({
    type: "open_log",
    agentId,
    requestId,
    ...(tail !== undefined ? { tail } : {}),
  });
  await waitUntil(
    () => doneFrames(sock, agentId).some((m) => m.requestId === requestId),
    `log_open_done ${requestId}`,
  );
}

describe("chats load when they open", () => {
  it("a lazy socket's connect sends no transcript, says it is lazy, and dates each agent's last entry; a socket without the flag keeps the replay", async () => {
    server = await startTestServer();
    const roomId = server.agentManager.getRooms()[0].id;
    const owner = await server.seedOwner("Morgan");
    const agent = await spawnIn(server, "Big", roomId);
    server = await seedTranscripts(server, [agent.id]);
    const cached = cachedIds(server, agent.id);
    // Enabling condition: the agent has a log to replay.
    expect(cached.slice(0, ENTRIES)).toEqual(
      Array.from({ length: ENTRIES }, (_, k) => `${agent.id}-e${k}`),
    );

    const lazy = await connected(server, owner.rawSessionId, LAZY);
    expect(entryFrames(lazy, agent.id)).toHaveLength(0);
    const lazyState = msgs(lazy).find((m) => m.type === "full_state")!;
    expect(lazyState.logsOnOpen).toBe(true);
    const lastAt = server.agentManager.getAgentLogs(agent.id).at(-1)!.timestamp;
    expect(
      (lazyState.agents as { id: string; lastEntryAt?: number }[]).find(
        (a) => a.id === agent.id,
      )?.lastEntryAt,
    ).toBe(lastAt);

    const old = await connected(server, owner.rawSessionId, "");
    expect(entryFrames(old, agent.id).map((m) => m.entry.id)).toEqual(cached);
    expect(
      msgs(old).find((m) => m.type === "full_state")!.logsOnOpen,
    ).toBeUndefined();
  }, 30_000);

  it("open_log replays the log in order with its request id, then log_open_done; tail sends only the last entries", async () => {
    server = await startTestServer();
    const roomId = server.agentManager.getRooms()[0].id;
    const owner = await server.seedOwner("Morgan");
    const agent = await spawnIn(server, "Big", roomId);
    server = await seedTranscripts(server, [agent.id]);
    const cached = cachedIds(server, agent.id);
    const sock = await connected(server, owner.rawSessionId, LAZY);

    await opened(sock, agent.id, "r1");
    const whole = entryFrames(sock, agent.id);
    expect(whole.map((m) => m.entry.id)).toEqual(cached);
    expect(whole.every((m) => m.requestId === "r1")).toBe(true);
    const done = doneFrames(sock, agent.id);
    expect(done).toHaveLength(1);
    expect(done[0].refused).toBeUndefined();
    expect(done[0].tail).toBeUndefined();
    // The fence comes after the last replayed entry and its commands.
    const at = (m: Msg) => msgs(sock).indexOf(m);
    expect(at(done[0])).toBeGreaterThan(at(whole.at(-1)!));
    for (const cmds of msgs(sock).filter(
      (m) => m.type === "slash_commands" && m.agentId === agent.id,
    ))
      expect(at(cmds)).toBeLessThan(at(done[0]));

    const before = entryFrames(sock, agent.id).length;
    await opened(sock, agent.id, "r2", 3);
    const tail = entryFrames(sock, agent.id).slice(before);
    expect(tail.map((m) => m.entry.id)).toEqual(cached.slice(-3));
    expect(tail.every((m) => m.requestId === "r2")).toBe(true);
    expect(doneFrames(sock, agent.id).at(-1)!.tail).toBe(3);
  }, 30_000);

  it("refuses an agent the member cannot see, and sends a pack without logs no entry", async () => {
    server = await startTestServer();
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const owner = await server.seedOwner("Morgan");
    const mia = await server.seedMember("Mia");
    const casey = await server.seedMember("Casey");
    const hidden = await spawnIn(server, "Hidden", r2);
    const shown = await spawnIn(server, "Shown", r1);
    server = await seedTranscripts(server, [hidden.id, shown.id]);
    const access = async (username: string, body: Record<string, unknown>) => {
      const res = await server!.http(
        `/api/users/${encodeURIComponent(username)}/access`,
        {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(res.status).toBe(200);
    };
    await access(mia.username, { allowedRooms: [r1] });
    // Read only gives no logs (a transcript can hold secrets).
    const pack: MemberPack = MEMBER_PACK_PRESETS.readOnly;
    await access(casey.username, { allowedRooms: [r1], pack });
    // Enabling condition: Casey's pack gives no logs.
    expect(getUserByName(casey.username)?.pack?.areas.logs).toBeUndefined();

    const miaSock = await connected(server, mia.rawSessionId, LAZY);
    await opened(miaSock, hidden.id, "r1");
    expect(doneFrames(miaSock, hidden.id)[0].refused).toBe(true);
    expect(entryFrames(miaSock, hidden.id)).toHaveLength(0);

    const caseySock = await connected(server, casey.rawSessionId, LAZY);
    caseySock.send({ type: "open_log", agentId: shown.id, requestId: "r2" });
    // Neither the replay nor a live turn reaches a pack without logs.
    await say(server, owner.rawSessionId, shown.id);
    await sleep(300);
    expect(entryFrames(caseySock, shown.id)).toHaveLength(0);
  }, 30_000);

  // The replay goes through the same per-frame pack filter as every push: a
  // pack with logs but without agents gets the entries and not the commands.
  it("a pack with logs and without agents gets the replayed entries and not the agent's commands", async () => {
    server = await startTestServer();
    const r1 = server.agentManager.getRooms()[0].id;
    const owner = await server.seedOwner("Morgan");
    const casey = await server.seedMember("Casey");
    const agent = await spawnIn(server, "Shown", r1);
    server = await seedTranscripts(server, [agent.id]);
    const { agents: _agents, ...areas } = {
      ...MEMBER_PACK_PRESETS.readOnly.areas,
      logs: "read" as const,
    };
    const pack: MemberPack = { areas, agentCeiling: "chat" };
    const res = await server.http(
      `/api/users/${encodeURIComponent(casey.username)}/access`,
      {
        method: "PUT",
        rawSessionId: owner.rawSessionId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedRooms: [r1], pack }),
      },
    );
    expect(res.status).toBe(200);
    const stored = getUserByName(casey.username)?.pack?.areas;
    // Enabling condition: the stored pack has logs and not agents.
    expect(stored?.logs).toBe("read");
    expect(stored?.agents).toBeUndefined();

    const commandsOf = (sock: TestSocket) =>
      msgs(sock).filter(
        (m) => m.type === "slash_commands" && m.agentId === agent.id,
      );
    const ownerSock = await connected(server, owner.rawSessionId, LAZY);
    await opened(ownerSock, agent.id, "o1");
    // Enabling condition: the agent has commands, and a replay carries them.
    expect(commandsOf(ownerSock).some((m) => m.requestId === "o1")).toBe(true);

    const caseySock = await connected(server, casey.rawSessionId, LAZY);
    await opened(caseySock, agent.id, "c1");
    expect(doneFrames(caseySock, agent.id)[0].refused).toBeUndefined();
    expect(
      entryFrames(caseySock, agent.id).filter((m) => m.requestId === "c1"),
    ).toHaveLength(ENTRIES);
    expect(commandsOf(caseySock)).toHaveLength(0);
  }, 30_000);

  it("a lazy socket hears an agent's live entries only after open_log, and not after close_log; a socket without the flag hears them all", async () => {
    server = await startTestServer();
    const roomId = server.agentManager.getRooms()[0].id;
    const owner = await server.seedOwner("Morgan");
    const agent = await spawnIn(server, "Talker", roomId);
    const lazy = await connected(server, owner.rawSessionId, LAZY);
    const old = await connected(server, owner.rawSessionId, "");

    // One turn, waited out on the old socket (it hears everything), then a
    // barrier on the lazy one: an open_log of an agent that does not exist is
    // refused, and its answer comes after every frame queued before it.
    let barriers = 0;
    async function turn() {
      const from = old.messages.length;
      await say(server!, owner.rawSessionId, agent.id);
      await waitUntil(() => {
        const after = msgs(old).slice(from);
        return (
          after.some(
            (m) =>
              m.type === "log_entry" &&
              (m.entry as { agentId: string }).agentId === agent.id,
          ) &&
          after.some(
            (m) =>
              m.type === "agent_updated" &&
              m.agentId === agent.id &&
              !["thinking", "tool_executing"].includes(
                String((m.changes as { state?: string }).state ?? "thinking"),
              ),
          )
        );
      }, "the turn ended on the old socket");
      const id = `barrier-${++barriers}`;
      lazy.send({ type: "open_log", agentId: "no-such-agent", requestId: id });
      await waitUntil(
        () => doneFrames(lazy, "no-such-agent").some((m) => m.requestId === id),
        `barrier ${id}`,
      );
    }

    await turn();
    expect(entryFrames(lazy, agent.id)).toHaveLength(0);

    await opened(lazy, agent.id, "r1");
    const replayed = entryFrames(lazy, agent.id).length;
    await turn();
    const live = entryFrames(lazy, agent.id).slice(replayed);
    expect(live.length).toBeGreaterThan(0);
    // Live frames carry no request id.
    expect(live.every((m) => m.requestId === undefined)).toBe(true);

    lazy.send({ type: "close_log", agentId: agent.id, requestId: "r1" });
    const closedAt = entryFrames(lazy, agent.id).length;
    await turn();
    expect(entryFrames(lazy, agent.id)).toHaveLength(closedAt);
  }, 30_000);

  it("losing the agent's room drops the subscription", async () => {
    server = await startTestServer();
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const owner = await server.seedOwner("Morgan");
    const mia = await server.seedMember("Mia");
    const agent = await spawnIn(server, "Leaving", r2);
    const access = async (rooms: string[]) => {
      const res = await server!.http(
        `/api/users/${encodeURIComponent(mia.username)}/access`,
        {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowedRooms: rooms }),
        },
      );
      expect(res.status).toBe(200);
    };
    await access([r1, r2]);
    const sock = await connected(server, mia.rawSessionId, LAZY);
    await opened(sock, agent.id, "r1");
    const old = await connected(server, owner.rawSessionId, "");
    const heard = entryFrames(sock, agent.id).length;

    await access([r1]);
    const oldHeard = entryFrames(old, agent.id).length;
    await say(server, owner.rawSessionId, agent.id);
    await waitUntil(
      () => entryFrames(old, agent.id).length > oldHeard,
      "the owner heard the turn",
    );
    // A barrier: the answer to a later open_log comes after any frame queued
    // before it.
    sock.send({ type: "open_log", agentId: "no-such-agent", requestId: "b" });
    await waitUntil(
      () => doneFrames(sock, "no-such-agent").length > 0,
      "barrier",
    );
    expect(entryFrames(sock, agent.id)).toHaveLength(heard);
    // A re-projection on a fast socket closes nothing.
    expect(sock.raw.readyState).toBe(WebSocket.OPEN);
  }, 30_000);
});
