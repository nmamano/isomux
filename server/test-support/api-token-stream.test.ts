import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName } from "../users.ts";
import { enqueueApiTokenInboxMessage, mintApiToken, revokeApiToken } from "../api-tokens.ts";
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
  const owner = await srv.seedOwner("Boss");
  const userId = getUserByName(owner.username)!.id;
  const first = await mintApiToken({ userId, name: "First", expiresInDays: 30 });
  const second = await mintApiToken({ userId, name: "Second", expiresInDays: null });
  const connect = (token: string, cookieHeader = "") => srv.connectWs("", {
    cookieHeader, headers: { Authorization: `Bearer ${token}`, Origin: "" },
  });
  const append = (tokenId = first.apiToken.id, now?: number) => enqueueApiTokenInboxMessage({
    tokenId, userId, text: "Ready", senderAgentId: "agent-1",
    senderAgentName: "Worker", senderRoomName: "Room", now,
  });
  return { srv, owner, userId, first, second, connect, append };
}

async function closed(ws: WebSocket) {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket did not close")), 2000);
    ws.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

describe("API token live stream", () => {
  it("streams sends and replies with cursor entries, isolates same-owner tokens, and recovers after reconnect", async () => {
    const { srv, owner, userId, first, second, connect, append } = await setup();
    const a = await connect(first.token);
    const a2 = await connect(first.token);
    const b = await connect(second.token);
    const browser = await srv.connectWs(owner.rawSessionId);
    await browser.waitFor("full_state");
    const roomId = srv.agentManager.getRooms()[0].id;
    const agent = await srv.agentManager.spawn("Worker", srv.stateRoot, "default", 0,
      undefined, roomId, undefined, undefined, undefined, "Boss", "claude", undefined, userId);
    expect(agent).toBeTruthy();
    const post = (path: string, token: string, body: unknown) => fetch(`${srv.baseUrl}${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const sent = await post(`/api/agents/${agent!.id}/messages`, first.token, { text: "Check this" });
    expect(sent.status).toBe(200);
    const firstEvent = await a.waitFor("api_token_log_entry");
    expect(firstEvent).toMatchObject({ tokenId: first.apiToken.id, entry: { sequence: 1, direction: "to_agent" } });
    expect(await a2.waitFor("api_token_log_entry")).toEqual(firstEvent);
    const reply = await post(`/api/api-token-inboxes/${first.apiToken.id}/messages`, mintAgentToken(agent!.id, userId), { text: "Ready" });
    expect(reply.status).toBe(200);
    const page = await (await post("/api/me/api-token-inbox/drain", first.token, { after: 0 })).json() as ApiTokenInboxDrainRes;
    // Drain is a barrier after both append callbacks; socket delivery still needs an event-loop turn.
    await Bun.sleep(30);
    expect(a.messages).toEqual(page.entries.map((entry: unknown) => ({ type: "api_token_log_entry", tokenId: first.apiToken.id, entry })));
    expect(b.messages).toEqual([]);
    expect(browser.messages.some((m) => (m as { type: string }).type === "api_token_log_entry")).toBe(false);
    a.send({ type: "ping" });
    a.send({ type: "terminal_open", agentId: agent!.id });
    await Bun.sleep(20);
    expect(a.messages).toHaveLength(2);
    a.close();
    await closed(a.raw);
    await append();
    const reconnect = await connect(first.token);
    await Bun.sleep(20);
    expect(reconnect.messages).toEqual([]);
    const recovery = await (await post("/api/me/api-token-inbox/drain", first.token, { after: 2 })).json() as ApiTokenInboxDrainRes;
    expect(recovery.entries.map((e) => e.sequence)).toEqual([3]);
    await append();
    expect(await reconnect.waitFor("api_token_log_entry")).toMatchObject({ entry: { sequence: 4 } });
  });

  it("refuses an invalid bearer with or without a valid cookie, and accepts no URL credential", async () => {
    const { srv, owner, connect, first } = await setup();
    for (const open of [
      () => connect("invalid"),
      () => srv.connectWs(owner.rawSessionId, { headers: { Authorization: "Bearer invalid" } }),
    ]) {
      let rejected = false;
      try { await open(); } catch { rejected = true; }
      expect(rejected).toBe(true);
    }
    const response = await fetch(`${srv.baseUrl}/ws?token=${encodeURIComponent(first.token)}`);
    expect(response.status).toBe(401);
  });

  it("closes on revoke without an incoming frame and delivers no later entry", async () => {
    const { userId, first, connect, append } = await setup();
    const socket = await connect(first.token);
    await revokeApiToken(userId, first.apiToken.id);
    await closed(socket.raw);
    expect(await append()).toMatchObject({ ok: false });
    expect(socket.messages).toEqual([]);
  });

  it("rechecks expiry immediately before delivery and closes instead of sending", async () => {
    const { first, connect, append } = await setup();
    const socket = await connect(first.token);
    const beforeExpiry = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(first.apiToken.expiresAt! + 1);
    try {
      // Admit the write with its earlier request time; delivery must check live time.
      expect(await append(first.apiToken.id, beforeExpiry)).toMatchObject({ ok: true });
    } finally { clock.mockRestore(); }
    await closed(socket.raw);
    expect(socket.messages).toEqual([]);
  });
});
