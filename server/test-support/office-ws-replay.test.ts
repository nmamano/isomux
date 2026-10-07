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
import { buildPublicOrigin, COOKIE_NAME } from "../auth.ts";
import { startTestServer, type TestServer } from "./harness.ts";

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

// Start the stalled reader and resolve once it has stalled.
async function startReader(
  srv: TestServer,
  rawSessionId: string,
  stallMs: number,
): Promise<{ done: Promise<{ closed: boolean; frames: ReaderFrame[] }> }> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "stalled-ws-reader.ts"),
      String(srv.port),
      `${COOKIE_NAME}=${rawSessionId}`,
      buildPublicOrigin().origin,
      String(stallMs),
    ],
    { stdout: "pipe", stderr: "pipe" },
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
  // The reader stalls after the 101, which the server writes before it runs
  // the open handler; a short wait covers the rest of that handler.
  await Bun.sleep(200);
  return {
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
    srv.stateRoot,
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
    const owner = await server.seedOwner("Boss");
    const roomId = server.agentManager.getRooms()[0].id;
    const agent = await spawnIn(server, "Big", roomId);
    server = await seedTranscripts(server, [agent.id]);

    // What the cache holds at connect: the seeded entries, plus whatever
    // the restore itself logged.
    const cached = server.agentManager.getAgentLogs(agent.id).map((e) => e.id);
    expect(cached.slice(0, ENTRIES)).toEqual(
      Array.from({ length: ENTRIES }, (_, k) => `${agent.id}-e${k}`),
    );
    const reader = await startReader(server, owner.rawSessionId, 3000);
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
    const owner = await server.seedOwner("Boss");
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

    const reader = await startReader(server, member.rawSessionId, 3000);
    await setAccess([r1]);

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
