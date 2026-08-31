// Personal API-token CRUD, authorization, legacy-wall reachability, and
// off-office message attribution. All requests drive the real HTTP server.

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  API_TOKEN_INBOX_CAPACITY,
  enqueueApiTokenInboxMessage,
  mintApiToken,
} from "../api-tokens.ts";
import { getUserByName, setUserRoleById } from "../users.ts";
import type { ApiTokenCreateRes } from "../../shared/contract-shapes.ts";
import { blockAtomicFileReplacement } from "./temp-state.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { APP_MESSAGE_MAX_CHARS } from "../app-message-limits.ts";
import { needsInterruptionMarker } from "../agent-manager.ts";
import { TIERS } from "../log-search.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function spawn(
  srv: TestServer,
  name: string,
  roomId: string,
  desk = 0,
  username?: string,
  userId?: string,
) {
  const agent = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    desk,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    username,
    "claude",
    undefined,
    userId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

async function mintThroughApi(
  srv: TestServer,
  session: string,
  name = "Laptop",
  expiresInDays: number | null = 30,
) {
  const response = await srv.http("/api/me/api-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, expiresInDays }),
    rawSessionId: session,
  });
  const body = (await response.json()) as ApiTokenCreateRes;
  return { response, body };
}

function bearer(
  srv: TestServer,
  token: string,
  path: string,
  init: RequestInit = {},
) {
  return fetch(`${srv.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("wait timed out");
    await Bun.sleep(5);
  }
}

describe("personal API tokens", () => {
  it("accepts agent replies, echoes them live, and drains at most once", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const ownerId = getUserByName(owner.username)!.id;
    const room = srv.agentManager.getRooms()[0].id;
    const sender = await spawn(srv, "Worker", room, 0, owner.username, ownerId);
    const agentToken = mintAgentToken(sender.id, ownerId);
    const minted = await mintThroughApi(
      srv,
      owner.rawSessionId,
      'Remote\n"Boss',
      null,
    );
    srv.agentManager.setTopic(sender.id, "Current work");
    const stateBeforeReply = srv.agentManager.getAgent(sender.id)!.state;
    const path = `/api/api-token-inboxes/${minted.body.apiToken.id}/messages`;
    const sent = await bearer(srv, agentToken, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "result ready" }),
    });
    expect(sent.status).toBe(200);
    const ack = await sent.json();
    expect(ack.lastDrainedAt).toBeNull();
    expect(ack.messageId).toBeString();
    const outbound = srv.agentManager.getAgentLogs(sender.id).at(-1);
    expect(outbound).toMatchObject({
      kind: "api_token_outbound",
      // The recipient lives in metadata, not the text: the UI renders it as
      // the card header, so baking it into content would double it.
      content: "result ready",
      metadata: { recipient_api_token_name: "Remote 'Boss" },
    });
    expect(srv.agentManager.getAgent(sender.id)).toMatchObject({
      state: stateBeforeReply,
      topicStale: false,
      turnHadHumanInput: false,
    });
    expect(needsInterruptionMarker(outbound)).toBe(false);

    expect(TIERS.prompts).not.toContain(outbound?.kind);

    const first = await bearer(
      srv,
      minted.body.token,
      "/api/me/api-token-inbox/drain",
      { method: "POST" },
    );
    expect(first.status).toBe(200);
    const drained = await first.json();
    expect(drained.previouslyDrainedAt).toBeNull();
    expect(drained.messages).toHaveLength(1);
    expect(drained.messages[0]).toMatchObject({
      id: ack.messageId,
      text: "result ready",
      senderAgentId: sender.id,
      senderAgentName: "Worker",
    });
    const second = await bearer(
      srv,
      minted.body.token,
      "/api/me/api-token-inbox/drain",
      { method: "POST" },
    );
    expect((await second.json()).messages).toEqual([]);

    for (let i = 0; i < API_TOKEN_INBOX_CAPACITY; i++) {
      await enqueueApiTokenInboxMessage({
        tokenId: minted.body.apiToken.id,
        userId: ownerId,
        text: `fill ${i}`,
        senderAgentId: sender.id,
        senderAgentName: "Worker",
        senderRoomName: "Room 1",
      });
    }
    const full = await bearer(srv, agentToken, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "retry me" }),
    });
    expect(full.status).toBe(429);
    expect((await full.json()).error).toMatchObject({
      code: "inbox_full",
      message: "The API token inbox is full because it has not been drained.",
    });

    const tooLong = await bearer(srv, agentToken, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(APP_MESSAGE_MAX_CHARS + 1) }),
    });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error.code).toBe("text_too_long");

    await srv.http(`/api/me/api-tokens/${minted.body.apiToken.id}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    const unavailable = await bearer(srv, agentToken, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "late" }),
    });
    expect(unavailable.status).toBe(404);
    expect((await unavailable.json()).error.code).toBe("api_token_unavailable");
  });

  it("mints, lists, sends as the human, and revokes through cookie-only routes", async () => {
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({ session: { manualSend: true } }),
    });
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0].id;
    const target = await spawn(srv, "Target", room);
    const minted = await mintThroughApi(
      srv,
      owner.rawSessionId,
      'Phone "alerts',
    );
    expect(minted.response.status).toBe(201);
    expect(minted.body.token).toStartWith("isomux_pat_");

    const list = await srv.http("/api/me/api-tokens", {
      rawSessionId: owner.rawSessionId,
    });
    const listed = (await list.json()) as {
      apiTokens: Array<{ id: string; lastUsedAt: number | null }>;
    };
    expect(listed.apiTokens.map((token) => token.id)).toEqual([
      minted.body.apiToken.id,
    ]);

    const manifest = await bearer(srv, minted.body.token, "/agents");
    expect(manifest.status).toBe(200);
    expect(((await manifest.json()) as Array<{ id: string }>)[0].id).toBe(
      target.id,
    );
    const sentPromise = bearer(
      srv,
      minted.body.token,
      `/api/agents/${target.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "off-office alert" }),
      },
    );
    await waitFor(
      () => (srv.fakeBackend.sessionForAgent(target.id)?.sent.length ?? 0) > 0,
    );
    const sent = await sentPromise;
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ messageId: "" });
    expect(srv.fakeBackend.sessionForAgent(target.id)!.sent[0].text).toContain(
      `[Boss (API token "Phone 'alerts" (${minted.body.apiToken.id}))] off-office alert`,
    );
    srv.fakeBackend.sessionForAgent(target.id)!.releaseSends();
    srv.fakeBackend.sessionForAgent(target.id)!.completeTurn();
    const used = await srv.http("/api/me/api-tokens", {
      rawSessionId: owner.rawSessionId,
    });
    expect(
      (
        (await used.json()) as {
          apiTokens: Array<{ lastUsedAt: number | null }>;
        }
      ).apiTokens[0].lastUsedAt,
    ).toBeNumber();

    expect(
      (await bearer(srv, minted.body.token, "/api/me/api-tokens")).status,
    ).toBe(403);
    const revoked = await srv.http(
      `/api/me/api-tokens/${minted.body.apiToken.id}`,
      { method: "DELETE", rawSessionId: owner.rawSessionId },
    );
    expect(revoked.status).toBe(204);
    expect((await bearer(srv, minted.body.token, "/agents")).status).toBe(401);
  });

  it("returns the enqueue failure status instead of acknowledging success", async () => {
    const srv = await startTestServer({
      fakeBackend: new FakeBackend({ session: { manualSend: true } }),
    });
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0].id;
    const target = await spawn(srv, "Target", room);
    const minted = await mintThroughApi(srv, owner.rawSessionId);
    const send = (text: string) =>
      bearer(srv, minted.body.token, `/api/agents/${target.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

    const first = await send("hold the turn");
    expect(first.status).toBe(200);
    await waitFor(
      () => (srv.fakeBackend.sessionForAgent(target.id)?.sent.length ?? 0) > 0,
    );

    const store = join(srv.stateRoot, "message-queues.json");
    blockAtomicFileReplacement(store);
    const persistFailed = await send("cannot persist");
    expect(persistFailed.status).toBe(500);
    expect((await persistFailed.json()).error.code).toBe("persist_failed");
    rmSync(store, { recursive: true, force: true });

    for (let i = 0; i < 50; i++) {
      expect((await send(`queued ${i}`)).status).toBe(200);
    }
    const queueFull = await send("one too many");
    expect(queueFull.status).toBe(429);
    expect((await queueFull.json()).error.code).toBe("queue_full");

    srv.fakeBackend.sessionForAgent(target.id)!.releaseSends();
    srv.fakeBackend.sessionForAgent(target.id)!.completeTurn();
  });

  it("allows both agent manifests while legacy file and UI surfaces stay blocked", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const minted = await mintThroughApi(srv, owner.rawSessionId);
    const token = minted.body.token;
    const roomId = srv.agentManager.getRooms()[0].id;
    const createdTask = await srv.http("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      rawSessionId: owner.rawSessionId,
      body: JSON.stringify({ title: "Room work", roomId }),
    });
    expect(createdTask.status).toBe(201);

    expect((await bearer(srv, token, "/agents")).status).toBe(200);
    expect((await bearer(srv, token, "/agents?killed=1")).status).toBe(200);
    for (const path of [
      "/api/files/agent-x/file.txt",
      "/api/images/agent-x/file.png",
      "/",
    ]) {
      expect((await bearer(srv, token, path)).status).toBe(403);
    }
    expect(
      (await bearer(srv, token, "/api/upload/agent-x", { method: "POST" }))
        .status,
    ).toBe(403);
    const tasks = await bearer(srv, token, "/api/tasks");
    expect(tasks.status).toBe(200);
    expect(
      ((await tasks.json()) as Array<{ title: string; roomId?: string }>).some(
        (task) => task.title === "Room work" && task.roomId === roomId,
      ),
    ).toBe(true);
    const createdRoom = await bearer(srv, token, "/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Remote room" }),
    });
    expect(createdRoom.status).toBe(201);
    const validCwd = await bearer(srv, token, "/api/validate/cwd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: srv.stateRoot }),
    });
    expect(validCwd.status).toBe(200);
    expect(
      (
        await bearer(srv, token, "/api/sessions/current", {
          method: "DELETE",
        })
      ).status,
    ).toBe(403);
  });

  it("accepts a never-expiring mint and rejects retired expiry presets", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const unlimited = await mintThroughApi(
      srv,
      owner.rawSessionId,
      "Keep",
      null,
    );
    expect(unlimited.response.status).toBe(201);
    expect(unlimited.body.apiToken.expiresAt).toBeNull();
    expect((await bearer(srv, unlimited.body.token, "/agents")).status).toBe(
      200,
    );
    const retired = await mintThroughApi(srv, owner.rawSessionId, "Old", 90);
    expect(retired.response.status).toBe(422);
    const missing = await srv.http("/api/me/api-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "NoExpiryField" }),
      rawSessionId: owner.rawSessionId,
    });
    expect(missing.status).toBe(422);
  });

  it("rejects expired, invalid, leaked-prefix, and API-attribution fields", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const ownerId = getUserByName(owner.username)!.id;
    const room = srv.agentManager.getRooms()[0].id;
    const target = await spawn(srv, "Target", room);
    const expired = await mintApiToken({
      userId: ownerId,
      name: "Expired",
      expiresInDays: 30,
      now: Date.now() - 31 * 24 * 60 * 60 * 1000,
    });
    expect((await bearer(srv, expired.token, "/agents")).status).toBe(401);
    expect((await bearer(srv, "isomux_pat_invalid", "/agents")).status).toBe(
      401,
    );
    expect(
      (await bearer(srv, expired.apiToken.tokenPrefix, "/agents")).status,
    ).toBe(401);

    const valid = await mintThroughApi(srv, owner.rawSessionId);
    for (const body of [
      { text: "x", device: "forged" },
      { text: "x", attachments: [] },
      { text: "x", senderAgentId: target.id },
      { text: "x", sendNow: true },
      { text: "x", steer: true },
      { text: "x", deliverAt: "2027-01-01T00:00:00Z" },
    ]) {
      const response = await bearer(
        srv,
        valid.body.token,
        `/api/agents/${target.id}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(400);
    }
  });

  it("uses accessible rooms despite view hiding and loses access on demotion or deletion", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Member");
    const memberId = getUserByName(member.username)!.id;
    const hiddenRoom = srv.agentManager.createRoom("Hidden by preference");
    const target = await spawn(srv, "HiddenRoomTarget", hiddenRoom);
    const grant = await srv.http(`/api/users/${member.username}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRooms: [hiddenRoom] }),
      rawSessionId: owner.rawSessionId,
    });
    expect(grant.status).toBe(200);
    const hide = await srv.http("/api/me/view/shown", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shown: [] }),
      rawSessionId: member.rawSessionId,
    });
    expect(hide.status).toBe(204);
    const memberToken = await mintThroughApi(srv, member.rawSessionId);
    expect(
      (
        await bearer(
          srv,
          memberToken.body.token,
          `/api/agents/${target.id}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "hidden but accessible" }),
          },
        )
      ).status,
    ).toBe(200);

    const ownerToken = await mintThroughApi(srv, owner.rawSessionId, "Owner");
    expect(setUserRoleById(memberId, "owner")).toBe(true);
    expect(setUserRoleById(getUserByName(owner.username)!.id, "member")).toBe(
      true,
    );
    expect(
      (
        await bearer(
          srv,
          ownerToken.body.token,
          `/api/agents/${target.id}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "after demotion" }),
          },
        )
      ).status,
    ).toBe(403);

    const deleted = await srv.http(
      `/api/users/${encodeURIComponent(owner.username)}`,
      { method: "DELETE", rawSessionId: member.rawSessionId },
    );
    expect(deleted.status).toBe(204);
    expect((await bearer(srv, ownerToken.body.token, "/agents")).status).toBe(
      401,
    );
  });
});
