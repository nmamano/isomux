// The office connect replay against a client that stops reading (task
// adeb1267). Bun drops a frame once its own send buffer passes 16 MB, so a
// replay bigger than that, sent in one burst to a slow client, lost its tail
// and its log_replay_complete fence. The office outbox
// (server/office-ws-outbox.ts) holds the frames until the socket drains.
//
// The client is a separate process (stalled-ws-reader.ts) that blocks its own
// event loop, so the kernel buffers fill and the server's socket backs up.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPublicOrigin, sessionCookieName } from "../auth.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  LOGS_ON_OPEN_WS_PARAM,
  LOGS_ON_OPEN_WS_VALUE,
} from "../../shared/log-stream.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

// 40 MB: more than Bun's 16 MB limit plus what the loopback kernel buffers
// hold for a client that reads nothing.
const ENTRIES = 400;
const ENTRY_BYTES = 100_000;

interface ReaderFrame {
  type: string;
  id?: string;
  agentId?: string;
  agentIds?: string[];
  requestId?: string;
  refused?: boolean;
}

// Give each agent a persisted transcript of ENTRIES entries with known ids,
// then cold-restart so the transcripts load into the log cache.
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
          timestamp: 1,
          kind: "text",
          content: "x".repeat(ENTRY_BYTES),
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

// Start the stalled reader and resolve once it has stalled. release() ends
// the stall; with an entry id, the reader stops once that entry has arrived
// after the replay fence.
async function startReader(
  srv: TestServer,
  rawSessionId: string,
  // A lazy socket (task 9ebe887d slice 2): its query, the messages it sends
  // before the stall, and the request id whose log_open_done ends the read.
  // It acks the lane after the stall as the office client does, unless ack
  // is false; sendAfter goes out as the stall ends, before any ack.
  lazy?: {
    query: string;
    send: unknown[];
    until?: string;
    ack?: boolean;
    sendAfter?: unknown[];
  },
): Promise<{
  release: (awaitedId?: string) => void;
  done: Promise<{ closed: boolean; frames: ReaderFrame[] }>;
}> {
  // Under the state root, which the harness removes.
  const releaseFile = join(srv.stateRoot, "stalled-ws-reader-release");
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "stalled-ws-reader.ts"),
      String(srv.port),
      `${sessionCookieName()}=${rawSessionId}`,
      buildPublicOrigin().origin,
      releaseFile,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        READER_QUERY: lazy?.query ?? "",
        READER_SEND: JSON.stringify(lazy?.send ?? []),
        READER_UNTIL: lazy?.until ?? "",
        READER_ACK: lazy && lazy.ack !== false ? "1" : "",
        READER_SEND_AFTER: JSON.stringify(lazy?.sendAfter ?? []),
      },
    },
  );
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let err = "";
  while (!err.includes("stalling")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`reader exited early: ${err}`);
    err += decoder.decode(value);
  }
  reader.releaseLock();
  return {
    release: (awaitedId = "") => writeFileSync(releaseFile, awaitedId),
    done: new Response(child.stdout)
      .text()
      .then(
        (out) => JSON.parse(out) as { closed: boolean; frames: ReaderFrame[] },
      ),
  };
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

describe("office connect replay to a client that stops reading", () => {
  it("arrives whole and in order, fence after the last entry, and a live entry from the stall after the fence, once", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Morgan");
    const roomId = server.agentManager.getRooms()[0].id;
    const agent = await spawnIn(server, "Big", roomId);
    server = await seedTranscripts(server, [agent.id]);

    // What the cache holds at connect: the seeded entries, plus whatever
    // the restore itself logged.
    const cached = server.agentManager.getAgentLogs(agent.id).map((e) => e.id);
    expect(cached.slice(0, ENTRIES)).toEqual(
      Array.from({ length: ENTRIES }, (_, k) => `${agent.id}-e${k}`),
    );
    const reader = await startReader(server, owner.rawSessionId);
    // A live entry while the replay waits in the outbox.
    const res = await server.http(`/api/agents/${agent.id}/messages`, {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "live-during-replay" }),
    });
    expect(res.status).toBeLessThan(300);
    const live = server.agentManager
      .getAgentLogs(agent.id)
      .slice(cached.length)
      .map((e) => e.id);
    // Enabling condition: the live entry exists, so the order below covers it.
    expect(live.length).toBeGreaterThan(0);
    reader.release(live.at(-1));

    const { closed, frames } = await reader.done;
    expect(closed).toBe(false);
    const fenceAt = frames.findIndex((f) => f.type === "log_replay_complete");
    expect(fenceAt).toBeGreaterThan(-1);
    const replayed = frames
      .slice(0, fenceAt)
      .filter((f) => f.type === "log_entry" && f.agentId === agent.id)
      .map((f) => f.id);
    expect(replayed).toEqual(cached);
    const afterFence = frames
      .slice(fenceAt + 1)
      .filter((f) => f.type === "log_entry" && f.agentId === agent.id)
      .map((f) => f.id);
    expect(afterFence).toEqual(live);
  }, 60_000);

  it("an access change while the socket is backed up closes it instead of sending the old projection", async () => {
    server = await startTestServer();
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const owner = await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const hidden = await spawnIn(server, "Hidden", r2);
    const setAccess = async (rooms: string[]) => {
      const res = await server!.http(
        `/api/users/${encodeURIComponent(member.username)}/access`,
        {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowedRooms: rooms }),
        },
      );
      expect(res.status).toBeLessThan(300);
    };
    await setAccess([r1, r2]);
    server = await seedTranscripts(server, [hidden.id]);

    const reader = await startReader(server, member.rawSessionId);
    // The access change closes the socket before the PUT answers.
    await setAccess([r1]);
    reader.release();

    const { closed, frames } = await reader.done;
    expect(closed).toBe(true);
    // The first full_state showed the agent; nothing after the change went out.
    const fullStates = frames.filter((f) => f.type === "full_state");
    expect(fullStates).toHaveLength(1);
    expect(fullStates[0].agentIds).toContain(hidden.id);
    expect(frames.some((f) => f.type === "log_replay_complete")).toBe(false);
    expect(frames.filter((f) => f.type === "log_entry").length).toBeLessThan(
      ENTRIES,
    );
  }, 60_000);
});

// Chats load when they open (task 9ebe887d slice 2). A lazy socket's replays
// run in the outbox's background lane: they wait for live frames, a full open
// goes ahead of a prefetch, a re-projection does not close the socket for
// them, and a clear restarts a replay from the new log.
describe("a lazy socket's chat loads to a client that stops reading", () => {
  const LAZY = `${LOGS_ON_OPEN_WS_PARAM}=${LOGS_ON_OPEN_WS_VALUE}`;
  const open = (agentId: string, requestId: string, tail?: number) => ({
    type: "open_log",
    agentId,
    requestId,
    ...(tail !== undefined ? { tail } : {}),
  });
  // A background prefetch (task 9ebe887d slice 3): behind every other load.
  const prefetch = (agentId: string, requestId: string, tail: number) => ({
    ...open(agentId, requestId, tail),
    prefetch: true,
  });
  const indexOf = (frames: ReaderFrame[], pred: (f: ReaderFrame) => boolean) =>
    frames.findIndex(pred);
  const doneAt = (frames: ReaderFrame[], requestId: string) =>
    indexOf(
      frames,
      (f) => f.type === "log_open_done" && f.requestId === requestId,
    );
  const replayedIds = (frames: ReaderFrame[], requestId: string) =>
    frames
      .filter((f) => f.type === "log_entry" && f.requestId === requestId)
      .map((f) => f.id);

  it("live entries of the agent and of another arrive before a big replay ends", async () => {
    server = await startTestServer();
    const roomId = server.agentManager.getRooms()[0].id;
    const owner = await server.seedOwner("Morgan");
    const big = await spawnIn(server, "Big", roomId);
    const small = await spawnIn(server, "Small", roomId);
    server = await seedTranscripts(server, [big.id]);
    const cached = server.agentManager.getAgentLogs(big.id).map((e) => e.id);

    const reader = await startReader(server, owner.rawSessionId, {
      query: LAZY,
      send: [open(small.id, "s1"), open(big.id, "b1")],
      until: "b1",
    });
    for (const agentId of [small.id, big.id]) {
      const res = await server.http(`/api/agents/${agentId}/messages`, {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "live-during-replay" }),
      });
      expect(res.status).toBeLessThan(300);
    }
    reader.release();

    const { closed, frames } = await reader.done;
    expect(closed).toBe(false);
    const done = doneAt(frames, "b1");
    expect(done).toBeGreaterThan(-1);
    expect(replayedIds(frames, "b1")).toEqual(cached);
    const liveOf = (agentId: string) =>
      indexOf(
        frames,
        (f) =>
          f.type === "log_entry" &&
          f.agentId === agentId &&
          f.requestId === undefined,
      );
    // Enabling condition: both live entries went out.
    expect(liveOf(small.id)).toBeGreaterThan(-1);
    expect(liveOf(big.id)).toBeGreaterThan(-1);
    // Well before the end: ahead of the replay's last quarter.
    const lastQuarter = indexOf(
      frames,
      (f) => f.id === cached[Math.floor(cached.length * 0.75)],
    );
    expect(liveOf(small.id)).toBeLessThan(lastQuarter);
    expect(liveOf(big.id)).toBeLessThan(lastQuarter);
  }, 60_000);

  it("a whole open goes ahead of a prefetch sent before it", async () => {
    server = await startTestServer();
    const roomId = server.agentManager.getRooms()[0].id;
    const owner = await server.seedOwner("Morgan");
    const big = await spawnIn(server, "Big", roomId);
    const other = await spawnIn(server, "Other", roomId);
    server = await seedTranscripts(server, [big.id, other.id]);

    // The prefetch is an eighth of the whole open: in send order it would
    // end long before it.
    const reader = await startReader(server, owner.rawSessionId, {
      query: LAZY,
      send: [prefetch(other.id, "p1", ENTRIES / 8), open(big.id, "f1")],
      until: "p1",
    });
    reader.release();
    const { closed, frames } = await reader.done;
    expect(closed).toBe(false);
    expect(doneAt(frames, "f1")).toBeGreaterThan(-1);
    expect(doneAt(frames, "p1")).toBeGreaterThan(doneAt(frames, "f1"));
    expect(replayedIds(frames, "p1")).toHaveLength(ENTRIES / 8);
  }, 60_000);

  it("a re-projection that keeps the agent leaves the socket open and the replay whole", async () => {
    server = await startTestServer();
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const owner = await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const big = await spawnIn(server, "Big", r1);
    const setAccess = async (rooms: string[]) => {
      const res = await server!.http(
        `/api/users/${encodeURIComponent(member.username)}/access`,
        {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowedRooms: rooms }),
        },
      );
      expect(res.status).toBeLessThan(300);
    };
    await setAccess([r1, r2]);
    server = await seedTranscripts(server, [big.id]);
    const cached = server.agentManager.getAgentLogs(big.id).map((e) => e.id);

    const reader = await startReader(server, member.rawSessionId, {
      query: LAZY,
      send: [open(big.id, "b1")],
      until: "b1",
    });
    // Room 2 goes; Big's room stays.
    await setAccess([r1]);
    reader.release();

    const { closed, frames } = await reader.done;
    expect(closed).toBe(false);
    expect(frames.filter((f) => f.type === "full_state")).toHaveLength(2);
    expect(replayedIds(frames, "b1")).toEqual(cached);
    expect(doneAt(frames, "b1")).toBeGreaterThan(-1);
  }, 60_000);

  it("losing the agent's room stops its replay and leaves the socket open", async () => {
    server = await startTestServer();
    const r1 = server.agentManager.getRooms()[0].id;
    const r2 = server.agentManager.createRoom("R2");
    const owner = await server.seedOwner("Morgan");
    const member = await server.seedMember("Mia");
    const big = await spawnIn(server, "Big", r2);
    const setAccess = async (rooms: string[]) => {
      const res = await server!.http(
        `/api/users/${encodeURIComponent(member.username)}/access`,
        {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowedRooms: rooms }),
        },
      );
      expect(res.status).toBeLessThan(300);
    };
    await setAccess([r1, r2]);
    server = await seedTranscripts(server, [big.id]);

    const reader = await startReader(server, member.rawSessionId, {
      query: LAZY,
      send: [open(big.id, "b1")],
    });
    await setAccess([r1]);
    reader.release();

    const { closed, frames } = await reader.done;
    expect(closed).toBe(false);
    expect(frames.filter((f) => f.type === "full_state")).toHaveLength(2);
    expect(replayedIds(frames, "b1").length).toBeLessThan(ENTRIES);
    expect(
      frames.some(
        (f) => f.type === "log_open_done" && f.requestId === "b1" && !f.refused,
      ),
    ).toBe(false);
  }, 60_000);

  it("a clear during the replay restarts it from the new log: no old entry after the clear", async () => {
    server = await startTestServer();
    const roomId = server.agentManager.getRooms()[0].id;
    const owner = await server.seedOwner("Morgan");
    const big = await spawnIn(server, "Big", roomId);
    server = await seedTranscripts(server, [big.id]);
    const old = new Set(
      server.agentManager.getAgentLogs(big.id).map((e) => e.id),
    );

    const reader = await startReader(server, owner.rawSessionId, {
      query: LAZY,
      send: [open(big.id, "b1")],
      until: "b1",
    });
    await server.agentManager.newConversation(big.id);
    const fresh = server.agentManager.getAgentLogs(big.id).map((e) => e.id);
    // Enabling condition: the clear replaced the log.
    expect(fresh.some((id) => old.has(id))).toBe(false);
    reader.release();

    const { closed, frames } = await reader.done;
    expect(closed).toBe(false);
    const clearAt = indexOf(
      frames,
      (f) => f.type === "clear_logs" && f.agentId === big.id,
    );
    expect(clearAt).toBeGreaterThan(-1);
    const done = doneAt(frames, "b1");
    expect(done).toBeGreaterThan(clearAt);
    const after = frames
      .slice(clearAt + 1, done)
      .filter((f) => f.type === "log_entry" && f.agentId === big.id)
      .map((f) => f.id!);
    expect(after.filter((id) => old.has(id))).toEqual([]);
    // Every entry of the new log is there after the clear (a live frame and
    // the restarted replay may both carry one; the client keeps one).
    for (const id of fresh)
      expect(after.filter((x) => x === id).length).toBeGreaterThan(0);
  }, 60_000);

  // Flow control (task 9ebe887d): Bun's buffer can be empty while the kernel
  // holds megabytes of lane frames, and those go out ahead of a chat the
  // member opens. The lane keeps at most one window in flight until the
  // client acks; one entry here (100 KB) is bigger than the floor, so it goes
  // alone.
  it("a reader that never acks gets one frame of a big prefetch, however much the kernel would take", async () => {
    server = await startTestServer();
    const roomId = server.agentManager.getRooms()[0].id;
    const owner = await server.seedOwner("Morgan");
    const big = await spawnIn(server, "Big", roomId);
    server = await seedTranscripts(server, [big.id]);

    const reader = await startReader(server, owner.rawSessionId, {
      query: LAZY,
      send: [open(big.id, "p1", ENTRIES)],
      ack: false,
    });
    reader.release();
    const { closed, frames } = await reader.done;
    expect(closed).toBe(false);
    expect(replayedIds(frames, "p1")).toHaveLength(1);
  }, 60_000);

  it("a chat opened while a big prefetch is in flight arrives after at most one prefetch frame", async () => {
    server = await startTestServer();
    const roomId = server.agentManager.getRooms()[0].id;
    const owner = await server.seedOwner("Morgan");
    const big = await spawnIn(server, "Big", roomId);
    const small = await spawnIn(server, "Small", roomId);
    server = await seedTranscripts(server, [big.id]);

    // The prefetch starts before the stall; the member opens Small as it ends.
    const reader = await startReader(server, owner.rawSessionId, {
      query: LAZY,
      send: [open(big.id, "p1", ENTRIES)],
      sendAfter: [open(small.id, "f1")],
      until: "f1",
    });
    reader.release();
    const { closed, frames } = await reader.done;
    expect(closed).toBe(false);
    const done = doneAt(frames, "f1");
    expect(done).toBeGreaterThan(-1);
    const prefetchedFirst = frames
      .slice(0, done)
      .filter((f) => f.type === "log_entry" && f.requestId === "p1");
    // Enabling condition: the prefetch was under way before the open.
    expect(prefetchedFirst.length).toBeGreaterThan(0);
    expect(prefetchedFirst.length).toBeLessThanOrEqual(1);
  }, 60_000);

  // The chat the member opens loads its recent entries (a tail) and goes to
  // the lane's front all the same; prefetches keep their send order behind it.
  it("an open with a tail goes ahead of the prefetches sent before it, and the prefetches keep their order", async () => {
    server = await startTestServer();
    const roomId = server.agentManager.getRooms()[0].id;
    const owner = await server.seedOwner("Morgan");
    const first = await spawnIn(server, "First", roomId);
    const second = await spawnIn(server, "Second", roomId);
    const opened = await spawnIn(server, "Opened", roomId);
    server = await seedTranscripts(server, [first.id, second.id, opened.id]);

    const reader = await startReader(server, owner.rawSessionId, {
      query: LAZY,
      send: [
        prefetch(first.id, "p1", ENTRIES / 4),
        prefetch(second.id, "p2", ENTRIES / 4),
        open(opened.id, "o1", ENTRIES / 4),
      ],
      until: "p2",
    });
    reader.release();
    const { closed, frames } = await reader.done;
    expect(closed).toBe(false);
    const order = ["o1", "p1", "p2"].map((rid) => doneAt(frames, rid));
    // Enabling condition: all three loads ended.
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 60_000);
});
