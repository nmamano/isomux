import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName } from "../users.ts";
import { enqueueApiTokenInboxMessage, mintApiToken } from "../api-tokens.ts";
import type { ApiTokenInboxDrainRes } from "../../shared/contract-shapes.ts";
import { mintAgentToken } from "../identity/tokens.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function setup() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const userId = getUserByName(owner.username)!.id;
  const first = await mintApiToken({
    userId,
    name: "First",
    expiresInDays: 30,
  });
  const second = await mintApiToken({
    userId,
    name: "Second",
    expiresInDays: null,
  });
  const connect = (token: string, cookieHeader = "") =>
    srv.connectWs("", {
      cookieHeader,
      headers: { Authorization: `Bearer ${token}`, Origin: "" },
    });
  const append = (tokenId = first.apiToken.id, now?: number) =>
    enqueueApiTokenInboxMessage({
      tokenId,
      userId,
      text: "Ready",
      senderAgentId: "agent-1",
      senderAgentName: "Worker",
      senderRoomName: "Room",
      now,
    });
  return { srv, owner, userId, first, second, connect, append };
}

async function closed(ws: WebSocket) {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("socket did not close")),
      2000,
    );
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// Bounded poll for a socket to hold `count` messages. The arrival is the
// barrier; no assertion rests on an elapsed delay.
async function holds(socket: { messages: unknown[] }, count: number) {
  const deadline = Date.now() + 2000;
  while (socket.messages.length < count) {
    if (Date.now() > deadline)
      throw new Error(
        `socket holds ${socket.messages.length} of ${count} messages`,
      );
    await Bun.sleep(5);
  }
}

describe("API token live stream", () => {
  it("streams sends and replies with cursor entries, isolates same-owner tokens, and recovers after reconnect", async () => {
    const { srv, owner, userId, first, second, connect, append } =
      await setup();
    const a = await connect(first.token);
    const a2 = await connect(first.token);
    const b = await connect(second.token);
    const browser = await srv.connectWs(owner.rawSessionId);
    await browser.waitFor("full_state");
    const roomId = srv.agentManager.getRooms()[0].id;
    const agent = await srv.agentManager.spawn(
      "Worker",
      srv.stateRoot,
      "default",
      0,
      undefined,
      roomId,
      undefined,
      undefined,
      undefined,
      "Morgan",
      "claude",
      undefined,
      userId,
    );
    expect(agent).toBeTruthy();
    const post = (path: string, token: string, body: unknown) =>
      fetch(`${srv.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const sent = await post(`/api/agents/${agent!.id}/messages`, first.token, {
      text: "Check this",
    });
    expect(sent.status).toBe(200);
    const firstEvent = await a.waitFor("api_token_log_entry");
    expect(firstEvent).toMatchObject({
      tokenId: first.apiToken.id,
      entry: { sequence: 1, direction: "to_agent" },
    });
    expect(await a2.waitFor("api_token_log_entry")).toEqual(firstEvent);
    // The socket is receive-only: office commands sent on it get no answer.
    // The reply below is sent after these frames, so its entry is the barrier.
    a.send({ type: "ping" });
    a.send({ type: "terminal_open", agentId: agent!.id });
    const reply = await post(
      `/api/api-token-inboxes/${first.apiToken.id}/messages`,
      mintAgentToken(agent!.id, userId),
      { text: "Ready" },
    );
    expect(reply.status).toBe(200);
    const page = (await (
      await post("/api/me/api-token-inbox/drain", first.token, { after: 0 })
    ).json()) as ApiTokenInboxDrainRes;
    expect(page.entries.map((e) => e.direction)).toEqual([
      "to_agent",
      "from_agent",
    ]);
    await holds(a, page.entries.length);
    expect(a.messages).toEqual(
      page.entries.map((entry: unknown) => ({
        type: "api_token_log_entry",
        tokenId: first.apiToken.id,
        entry,
      })),
    );
    // Same owner, other token: b gets its own entry and none of the first
    // token's, which would have reached it before this one.
    await append(second.apiToken.id);
    await b.waitFor("api_token_log_entry");
    expect(b.messages).toEqual([
      expect.objectContaining({ tokenId: second.apiToken.id }),
    ]);
    // The owner's browser socket never carries a token's log: a room event
    // sent after every append above is the barrier.
    srv.agentManager.createRoom("Barrier");
    await browser.waitFor("room_created");
    expect(
      browser.messages.some(
        (m) => (m as { type: string }).type === "api_token_log_entry",
      ),
    ).toBe(false);
    // Still only the two entries: nothing answered the ping or terminal_open.
    expect(a.messages).toHaveLength(page.entries.length);

    a.close();
    await closed(a.raw);
    await append();
    const reconnect = await connect(first.token);
    const recovery = (await (
      await post("/api/me/api-token-inbox/drain", first.token, { after: 2 })
    ).json()) as ApiTokenInboxDrainRes;
    expect(recovery.entries.map((e) => e.sequence)).toEqual([3]);
    // No replay on connect: the first entry the new socket holds is the next
    // live one, never entry 3.
    await append();
    const live = await reconnect.waitFor("api_token_log_entry");
    expect(live).toMatchObject({ entry: { sequence: 4 } });
    expect(reconnect.messages).toEqual([live]);
  });

  it("refuses an invalid bearer with or without a valid cookie, and accepts no URL credential", async () => {
    const { srv, owner, connect, first } = await setup();
    for (const open of [
      () => connect("invalid"),
      () =>
        srv.connectWs(owner.rawSessionId, {
          headers: { Authorization: "Bearer invalid" },
        }),
    ]) {
      let rejected = false;
      try {
        await open();
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    }
    const response = await fetch(
      `${srv.baseUrl}/ws?token=${encodeURIComponent(first.token)}`,
    );
    expect(response.status).toBe(401);
  });

  it("rechecks expiry immediately before delivery and closes instead of sending", async () => {
    const { first, connect, append } = await setup();
    const socket = await connect(first.token);
    const beforeExpiry = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(
      first.apiToken.expiresAt! + 1,
    );
    try {
      // Admit the write with its earlier request time; delivery must check live time.
      expect(await append(first.apiToken.id, beforeExpiry)).toMatchObject({
        ok: true,
      });
    } finally {
      clock.mockRestore();
    }
    await closed(socket.raw);
    expect(socket.messages).toEqual([]);
  });
});
