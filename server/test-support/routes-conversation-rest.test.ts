// The conversation routes (server/routes/handlers/conversation.ts): send, edit,
// resume, send-now, new conversation, sessions and handoff, over JSON and the
// plain-text form, from members, agents, API-token inboxes and schedule runs.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import type {
  SessionInfo,
  AgentInfo,
  ScheduledMessageEntry,
} from "../../shared/types.ts";
import {
  mintAgentToken,
  mintRunToken,
  _testResetTokens,
  getAgentTokenRaw,
} from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { readFileSync, rmSync } from "fs";
import type { ApiTokenCreateRes } from "../../shared/contract-shapes.ts";
import { join } from "path";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { blockAtomicFileReplacement } from "./temp-state.ts";
import { formatCronjobSenderPrefix } from "../../shared/identity.ts";

describe("conversation REST", () => {
  // Phase 3d slice 6a - conversation REST contract.
  //
  // HTTP-contract layer for the conversation cluster cut over from the WS command
  // bus (send/edit/cancel/sendNow/newConversation/resume/listSessions). Pins status
  // codes + ack shapes for the cores wired in server/routes/handlers/conversation.ts.
  //
  // COMPLEMENTS, not duplicates:
  //   - queue.test.ts deeply covers sendMessage's queue mechanics + the AGENT
  //     (inter-agent) sender-authority + dedupe/cap/error-state status codes.
  //   - projection.test.ts covers the listSessions + send-message room ACL (403).
  // This file pins the USER branch happy paths, the 204 mutations, and the
  // 400/422 malformed-body boundaries that those files don't exercise directly.
  //
  // Seam: startTestServer() - real auth + the /api executor. The default FakeBackend
  // auto-completes, so a USER send returns its immediate ack without a hung turn.

  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
    _testResetTokens();
  });

  interface Res {
    status: number;
    body: unknown;
  }

  async function req(
    srv: TestServer,
    method: string,
    path: string,
    init: { body?: unknown; rawSessionId?: string } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await srv.http(path, {
      method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      rawSessionId: init.rawSessionId,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  const errCode = (body: unknown): string | undefined =>
    (body as { error?: { code?: string } }).error?.code;

  async function spawnAt(srv: TestServer, name: string, roomId: string) {
    // spawn(name, cwd, permissionMode, desk, customInstructions, roomId, ...).
    const a = await srv.agentManager.spawn(
      name,
      srv.stateRoot,
      "default",
      0,
      undefined,
      roomId,
    );
    if (!a) throw new Error(`spawn failed: ${name}`);
    return a;
  }

  describe("agents.sendMessage REST - USER branch (Phase 3d slice 6a)", () => {
    it("owner send -> 200 with an empty MessageAck (the turn streams over WS)", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const r1 = srv.agentManager.getRooms()[0].id;
      const x = await spawnAt(srv, "X", r1);
      const res = await req(srv, "POST", `/api/agents/${x.id}/messages`, {
        rawSessionId: owner.rawSessionId,
        body: { text: "hello" },
      });
      expect(res.status).toBe(200);
      // The USER ack carries no queued id - the message echoes/streams over WS.
      expect((res.body as { messageId?: string }).messageId).toBe("");
      // And no `queued` flag either (task 425facdd): this branch is fire-and-forget
      // with no enqueue result to report, so it says nothing instead of guessing.
      expect("queued" in (res.body as object)).toBe(false);
    });

    it("no auth -> 401 (the /api wall rejects before the handler)", async () => {
      const srv = await startTestServer();
      server = srv;
      await srv.seedOwner("Morgan");
      const r1 = srv.agentManager.getRooms()[0].id;
      const x = await spawnAt(srv, "X", r1);
      const res = await req(srv, "POST", `/api/agents/${x.id}/messages`, {
        body: { text: "hello" },
      });
      expect(res.status).toBe(401);
    });

    it("refuses a malformed send body at the boundary; the agent is untouched", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const r1 = srv.agentManager.getRooms()[0].id;
      const x = await spawnAt(srv, "X", r1);
      const send = (body: unknown) =>
        req(srv, "POST", `/api/agents/${x.id}/messages`, {
          rawSessionId: owner.rawSessionId,
          body,
        });
      const missingText = await send({});
      expect(missingText.status).toBe(400);
      expect(errCode(missingText.body)).toBe("invalid_text");
      // Attachment fields flow into getFilePath(agentId, filename) (path.join
      // throws on a non-string) and the notice line's size formatter, and
      // {attachments:{}} is truthy but non-iterable: flushQueue would spread it.
      // A bad one would blow up mid-turn, so each is rejected at the boundary.
      const good = {
        filename: "a1b2c3.png",
        originalName: "photo.png",
        mediaType: "image/png",
        size: 1024,
      };
      const badBodies: unknown[] = [
        { text: "x", attachments: {} },
        { text: "x", device: { not: "a string" } },
        // One bad element poisons an otherwise-valid batch.
        { text: "x", attachments: [good, { ...good, size: -1 }] },
        ...[
          "not-an-object",
          null,
          [],
          {},
          { ...good, filename: 42 },
          { ...good, filename: "" },
          { ...good, originalName: null },
          { ...good, mediaType: { a: 1 } },
          { ...good, size: -1 },
          { ...good, size: 1.5 },
          { ...good, size: "1024" },
          { ...good, size: Number.MAX_SAFE_INTEGER + 1 },
          { filename: "a1b2c3.png" }, // missing the rest
        ].map((spec) => ({ text: "x", attachments: [spec] })),
      ];
      for (const body of badBodies) {
        const res = await send(body);
        expect({ body, status: res.status, code: errCode(res.body) }).toEqual({
          body,
          status: 422,
          code: "invalid_request",
        });
      }
      // Nothing reached the backend / queue.
      expect(srv.fakeBackend.sessionForAgent(x.id)?.sent.length ?? 0).toBe(0);
      // size 0 is legal (an empty upload), and a spec whose file is missing on
      // disk is a resolve-time skip, not a boundary rejection - the validator
      // must not tighten either.
      const legal = await send({
        text: "x",
        attachments: [{ ...good, filename: "gone.png", size: 0 }],
      });
      expect(legal.status).toBe(200);
    });
  });

  describe("agents.editMessage / resume REST (Phase 3d slice 6a)", () => {
    it("editMessage -> 200 empty ack (fire-and-forget; the corrected turn streams); no newText or a non-string device -> 422", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const r1 = srv.agentManager.getRooms()[0].id;
      const x = await spawnAt(srv, "X", r1);
      // A bogus logEntryId is tolerated (the WS path was fire-and-forget too); the
      // contract is the ack shape, not the edit landing.
      const res = await req(
        srv,
        "PATCH",
        `/api/agents/${x.id}/messages/entry-1`,
        { rawSessionId: owner.rawSessionId, body: { newText: "fixed" } },
      );
      expect(res.status).toBe(200);
      expect((res.body as { messageId?: string }).messageId).toBe("");
      for (const body of [{}, { newText: "fixed", device: 123 }]) {
        const bad = await req(
          srv,
          "PATCH",
          `/api/agents/${x.id}/messages/entry-1`,
          { rawSessionId: owner.rawSessionId, body },
        );
        expect([body, bad.status]).toEqual([body, 422]);
      }
    });

    it("resume -> 204; no sessionId -> 422", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const r1 = srv.agentManager.getRooms()[0].id;
      const x = await spawnAt(srv, "X", r1);
      const res = await req(srv, "POST", `/api/agents/${x.id}/resume`, {
        rawSessionId: owner.rawSessionId,
        body: { sessionId: "some-session" },
      });
      expect(res.status).toBe(204);
      const missing = await req(srv, "POST", `/api/agents/${x.id}/resume`, {
        rawSessionId: owner.rawSessionId,
        body: {},
      });
      expect(missing.status).toBe(422);
    });
  });

  // cancelQueued left this block with task e17989e0: a miss now answers 404
  // not_queued instead of 204, pinned in queue-read-retract.test.ts.
  describe("agents sendNow / newConversation REST (Phase 3d slice 6a)", () => {
    // Contract CHANGED by task 5dcb0a02: send-now with nothing to send used to
    // answer 204. The case that mattered was an agent whose backend had died,
    // where the flush is gated out and silently moves nothing - the 204 read as
    // a delivery. An empty queue is the same class of honest refusal.
    it("sendNow with an empty queue -> 409 queue_empty", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const r1 = srv.agentManager.getRooms()[0].id;
      const x = await spawnAt(srv, "X", r1);
      const res = await req(srv, "POST", `/api/agents/${x.id}/send-now`, {
        rawSessionId: owner.rawSessionId,
      });
      expect(res.status).toBe(409);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        "queue_empty",
      );
    });

    it("newConversation -> 204", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const r1 = srv.agentManager.getRooms()[0].id;
      const x = await spawnAt(srv, "X", r1);
      const res = await req(
        srv,
        "POST",
        `/api/agents/${x.id}/new-conversation`,
        {
          rawSessionId: owner.rawSessionId,
        },
      );
      expect(res.status).toBe(204);
    });
  });

  describe("agents.listSessions REST (Phase 3d slice 6a)", () => {
    it("ordinary agent reads its own sessions and a room peer's", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const roomId = srv.agentManager.getRooms()[0].id;
      const self = await spawnAt(srv, "Self", roomId);
      const peer = await spawnAt(srv, "Peer", roomId);
      const ownerId = getUserByName(owner.username)!.id;
      const token = mintAgentToken(self.id, ownerId);

      const own = await srv.http(`/api/agents/${self.id}/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(own.status).toBe(200);
      const listed = (await own.json()) as {
        sessions?: SessionInfo[];
        currentSessionId?: string | null;
      };
      expect(Array.isArray(listed.sessions)).toBe(true);
      expect("currentSessionId" in listed).toBe(true);

      // Same reach as /logs (Nil, 2026-09-16): a peer in an accessible room.
      const other = await srv.http(`/api/agents/${peer.id}/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(other.status).toBe(200);

      const ownerRead = await srv.http(`/api/agents/${peer.id}/sessions`, {
        rawSessionId: owner.rawSessionId,
      });
      expect(ownerRead.status).toBe(200);

      const privileged = mintAgentToken(self.id, ownerId, true);
      const privilegedRead = await srv.http(`/api/agents/${peer.id}/sessions`, {
        headers: { Authorization: `Bearer ${privileged}` },
      });
      expect(privilegedRead.status).toBe(200);

      const runRead = await srv.http(`/api/agents/${self.id}/sessions`, {
        headers: {
          Authorization: `Bearer ${mintRunToken("job-1", "run-1", ownerId)}`,
        },
      });
      expect(runRead.status).toBe(403);
    });
  });
});

describe("plain-text message form", () => {
  // The plain-text form of the message routes (task dbc546b5): a text/plain body
  // is the message text and steer, deliverAt and clientMessageId ride the query.
  // Drives the real HTTP server, auth and /api executor. The query parser's
  // edge cases are unit-tested in shared/plain-text-form.test.ts.

  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  // Quotes, backslashes, a tab, inner line breaks, non-ASCII and shell
  // metacharacters: everything a JSON body or shell quoting would mangle.
  const TEXT =
    'He said "ship it" \\o/ - C:\\new\\table\n\tsecond line ünï 日本 🚀\n$HOME `date` {"text":"not a field"}';

  async function setup(): Promise<{
    srv: TestServer;
    ownerSession: string;
    sender: AgentInfo;
    receiver: AgentInfo;
  }> {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Nil");
    const room = srv.agentManager.getRooms()[0].id;
    const spawn = async (name: string) => {
      const info = await srv.agentManager.spawn(
        name,
        srv.stateRoot,
        "default",
        undefined,
        undefined,
        room,
      );
      if (!info) throw new Error(`spawn ${name} returned null`);
      return info;
    };
    return {
      srv,
      ownerSession: owner.rawSessionId,
      sender: await spawn("Sender"),
      receiver: await spawn("Receiver"),
    };
  }

  type Sent = {
    status: number;
    headers: Headers;
    body: Record<string, unknown> & {
      error?: { code: string; message?: string };
    };
  };

  async function post(
    srv: TestServer,
    path: string,
    init: {
      agentId?: string;
      bearer?: string;
      rawSessionId?: string;
      contentType?: string;
      body: string;
      headers?: Record<string, string>;
    },
  ): Promise<Sent> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.contentType !== undefined)
      headers["Content-Type"] = init.contentType;
    const bearer =
      init.bearer ??
      (init.agentId
        ? (getAgentTokenRaw(init.agentId) ?? undefined)
        : undefined);
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
    // A Blob body keeps fetch from adding its own Content-Type, so a test can
    // send no Content-Type at all.
    const res = await srv.http(path, {
      method: "POST",
      headers,
      body: new Blob([init.body]),
      rawSessionId: init.rawSessionId,
    });
    let body: Sent["body"] = {};
    try {
      body = (await res.json()) as Sent["body"];
    } catch {
      body = {};
    }
    return { status: res.status, headers: res.headers, body };
  }

  function delivered(srv: TestServer, agentId: string): string[] {
    return (srv.fakeBackend.sessionForAgent(agentId)?.sent ?? []).map(
      (m) => m.text,
    );
  }

  async function waitForDelivery(
    srv: TestServer,
    agentId: string,
    count = 1,
  ): Promise<string[]> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const texts = delivered(srv, agentId);
      if (texts.length >= count) return texts;
      if (Date.now() > deadline) throw new Error("delivery timed out");
      await Bun.sleep(5);
    }
  }

  const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();

  describe("POST /api/agents/:id/messages with Content-Type: text/plain", () => {
    it("delivers the body verbatim, minus the heredoc's one trailing line break", async () => {
      const { srv, sender, receiver } = await setup();
      const r = await post(srv, `/api/agents/${receiver.id}/messages`, {
        agentId: sender.id,
        contentType: "text/plain; charset=utf-8",
        body: `${TEXT}\n`,
      });
      expect(r.status).toBe(200);
      expect(r.body.messageId).toBeString();
      // A plain send carries no steer outcome.
      expect("steered" in r.body).toBe(false);
      const [prompt] = await waitForDelivery(srv, receiver.id);
      // The sender label is a prefix; the message itself ends the prompt.
      expect(prompt.endsWith(` ${TEXT}`)).toBe(true);
    });

    it("delivers a member's text/plain message too", async () => {
      const { srv, ownerSession, receiver } = await setup();
      const r = await post(srv, `/api/agents/${receiver.id}/messages`, {
        rawSessionId: ownerSession,
        contentType: "text/plain",
        body: TEXT,
      });
      expect(r.status).toBe(200);
      const [prompt] = await waitForDelivery(srv, receiver.id);
      expect(prompt.endsWith(TEXT)).toBe(true);
    });

    it("schedules with deliverAt from the query, a raw + offset included", async () => {
      const { srv, sender, receiver } = await setup();
      const utc = new Date(Date.now() + 3_600_000);
      utc.setUTCMilliseconds(0);
      const offsetForm = new Date(utc.getTime() + 2 * 3_600_000)
        .toISOString()
        .replace("Z", "+02:00");
      expect(offsetForm).toContain("+");
      const r = await post(
        srv,
        `/api/agents/${receiver.id}/messages?deliverAt=${offsetForm}`,
        { agentId: sender.id, contentType: "text/plain", body: `${TEXT}\n` },
      );
      expect(r.status).toBe(200);
      expect(r.body.deliverAt).toBe(utc.toISOString());
      const persisted = JSON.parse(
        readFileSync(join(srv.stateRoot, "scheduled-messages.json"), "utf-8"),
      ) as ScheduledMessageEntry[];
      expect(persisted.map((e) => e.text)).toEqual([TEXT]);
    });

    it("dedupes a retry with the same clientMessageId from the query", async () => {
      const { srv, sender, receiver } = await setup();
      const send = () =>
        post(
          srv,
          `/api/agents/${receiver.id}/messages?clientMessageId=retry-1`,
          {
            agentId: sender.id,
            contentType: "text/plain",
            body: "once",
          },
        );
      const first = await send();
      expect(first.status).toBe(200);
      expect("queued" in first.body).toBe(true);
      await waitForDelivery(srv, receiver.id);
      const second = await send();
      expect(second.status).toBe(200);
      // A deduped retry touched no queue, so its ack reports no queued state.
      expect("queued" in second.body).toBe(false);
      await Bun.sleep(50);
      expect(delivered(srv, receiver.id)).toHaveLength(1);
    });

    it("applies the handler's field rules to query options as to JSON fields", async () => {
      const { srv, ownerSession, sender, receiver } = await setup();
      const path = `/api/agents/${receiver.id}/messages`;
      const asAgent = (query: string) =>
        post(srv, `${path}${query}`, {
          agentId: sender.id,
          contentType: "text/plain",
          body: "x",
        });
      const both = await asAgent(`?steer=1&deliverAt=${inOneHour()}`);
      expect(both.status).toBe(400);
      expect(both.body.error?.code).toBe("steer_with_deliver_at");
      const badTime = await asAgent("?deliverAt=tomorrow");
      expect(badTime.status).toBe(400);
      expect(badTime.body.error?.code).toBe("invalid_deliver_at");
      const memberSteer = await post(srv, `${path}?steer=1`, {
        rawSessionId: ownerSession,
        contentType: "text/plain",
        body: "x",
      });
      expect(memberSteer.status).toBe(400);
      expect(memberSteer.body.error?.code).toBe("steer_not_supported");
    });

    it("refuses a malformed query with 422 invalid_request before sending", async () => {
      const { srv, sender, receiver } = await setup();
      for (const query of [
        "?steer=yes",
        "?steer",
        "?steer=1&steer=1",
        "?stear=1",
        "?deliverAt=%ZZ",
      ]) {
        const r = await post(
          srv,
          `/api/agents/${receiver.id}/messages${query}`,
          {
            agentId: sender.id,
            contentType: "text/plain",
            body: "x",
          },
        );
        expect(r.status).toBe(422);
        expect(r.body.error?.code).toBe("invalid_request");
      }
      await Bun.sleep(50);
      expect(delivered(srv, receiver.id)).toHaveLength(0);
    });

    it("refuses an option in the query of a JSON, form-encoded or untyped request", async () => {
      const { srv, sender, receiver } = await setup();
      for (const contentType of [
        "application/json",
        "application/x-www-form-urlencoded",
        undefined,
      ]) {
        const r = await post(
          srv,
          `/api/agents/${receiver.id}/messages?steer=1`,
          {
            agentId: sender.id,
            contentType,
            body: JSON.stringify({ text: "x" }),
          },
        );
        expect(r.status).toBe(422);
        expect(r.body.error?.code).toBe("invalid_request");
        expect(r.body.error?.message).toContain("text/plain");
      }
      await Bun.sleep(50);
      expect(delivered(srv, receiver.id)).toHaveLength(0);
    });

    it("still ignores an undeclared query parameter on JSON", async () => {
      const { srv, sender, receiver } = await setup();
      const r = await post(srv, `/api/agents/${receiver.id}/messages?foo=1`, {
        agentId: sender.id,
        contentType: "application/json",
        body: JSON.stringify({ text: "json still works" }),
      });
      expect(r.status).toBe(200);
      const [prompt] = await waitForDelivery(srv, receiver.id);
      expect(prompt.endsWith("json still works")).toBe(true);
    });

    it("gives an empty text/plain body the same outcome as an empty JSON text", async () => {
      const { srv, ownerSession, sender, receiver } = await setup();
      const path = `/api/agents/${receiver.id}/messages`;
      // An agent's empty JSON text is a 400 invalid_text. A member's is accepted
      // (the composer sends an image with no caption), so the member pins the
      // other outcome: the two forms agree either way.
      for (const [auth, status] of [
        [{ agentId: sender.id }, 400],
        [{ rawSessionId: ownerSession }, 200],
      ] as const) {
        const json = await post(srv, path, {
          ...auth,
          contentType: "application/json",
          body: JSON.stringify({ text: "" }),
        });
        expect(json.status).toBe(status);
        if (status === 400) expect(json.body.error?.code).toBe("invalid_text");
        for (const body of ["", "\n", "\r\n"]) {
          const plain = await post(srv, path, {
            ...auth,
            contentType: "text/plain",
            body,
          });
          expect(plain.status).toBe(json.status);
          expect(plain.body.error?.code).toBe(json.body.error?.code);
        }
      }
    });

    it("reads JSON sent as text/plain (fetch's default type) as JSON", async () => {
      const { srv, sender, receiver } = await setup();
      const r = await post(srv, `/api/agents/${receiver.id}/messages`, {
        agentId: sender.id,
        contentType: "text/plain;charset=UTF-8",
        body: JSON.stringify({ text: "inner text", steer: true }),
      });
      expect(r.status).toBe(200);
      // Every JSON field reaches the handler, steer included.
      expect(r.body.steered).toBe(false);
      const [prompt] = await waitForDelivery(srv, receiver.id);
      expect(prompt.endsWith(" inner text")).toBe(true);
    });

    it("keeps a JSON-looking body verbatim when an option is in the query or text is not a string", async () => {
      const { srv, sender, receiver } = await setup();
      const withOption = JSON.stringify({ text: "inner" });
      const notString = JSON.stringify({ text: 5 });
      const a = await post(srv, `/api/agents/${receiver.id}/messages?steer=1`, {
        agentId: sender.id,
        contentType: "text/plain",
        body: withOption,
      });
      expect(a.status).toBe(200);
      const b = await post(srv, `/api/agents/${receiver.id}/messages`, {
        agentId: sender.id,
        contentType: "text/plain",
        body: notString,
      });
      expect(b.status).toBe(200);
      // The receiver may coalesce the two sends into one prompt or take them in
      // two turns: wait until both texts arrived either way.
      const deadline = Date.now() + 2_000;
      let all = "";
      while (
        !(all.includes(` ${withOption}`) && all.includes(` ${notString}`)) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(5);
        all = delivered(srv, receiver.id).join("\n");
      }
      expect(all).toContain(` ${withOption}`);
      expect(all).toContain(` ${notString}`);
    });

    it("fingerprints the options for Idempotency-Key: a changed steer conflicts, an identical request replays", async () => {
      const { srv, sender, receiver } = await setup();
      const send = (query: string) =>
        post(srv, `/api/agents/${receiver.id}/messages${query}`, {
          agentId: sender.id,
          contentType: "text/plain",
          body: "same text",
          headers: { "Idempotency-Key": "key-1" },
        });
      const first = await send("");
      expect(first.status).toBe(200);
      const changed = await send("?steer=1");
      expect(changed.status).toBe(409);
      expect(changed.body.error?.code).toBe("idempotency_conflict");
      const again = await send("");
      expect(again.status).toBe(200);
      expect(again.headers.get("Idempotency-Replayed")).toBe("true");
      expect(again.body.messageId).toBe(first.body.messageId);
    });
  });

  describe("POST /api/api-token-inboxes/:tokenId/messages with Content-Type: text/plain", () => {
    async function inboxSetup() {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const ownerId = getUserByName(owner.username)!.id;
      const room = srv.agentManager.getRooms()[0].id;
      const sender = await srv.agentManager.spawn(
        "Worker",
        srv.stateRoot,
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
        ownerId,
      );
      if (!sender) throw new Error("spawn failed");
      const minted = await srv.http("/api/me/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Phone", expiresInDays: null }),
        rawSessionId: owner.rawSessionId,
      });
      const token = ((await minted.json()) as ApiTokenCreateRes).apiToken.id;
      return {
        srv,
        sender,
        bearer: mintAgentToken(sender.id, ownerId),
        path: `/api/api-token-inboxes/${token}/messages`,
      };
    }

    it("delivers the body verbatim", async () => {
      const { srv, sender, bearer, path } = await inboxSetup();
      const r = await post(srv, path, {
        bearer,
        contentType: "text/plain",
        body: `${TEXT}\n`,
      });
      expect(r.status).toBe(200);
      expect(srv.agentManager.getAgentLogs(sender.id).at(-1)).toMatchObject({
        kind: "api_token_outbound",
        content: TEXT,
      });
    });

    it("refuses any query parameter, the route declares none", async () => {
      const { srv, bearer, path } = await inboxSetup();
      const r = await post(srv, `${path}?steer=1`, {
        bearer,
        contentType: "text/plain",
        body: "x",
      });
      expect(r.status).toBe(422);
      expect(r.body.error?.code).toBe("invalid_request");
    });

    it("gives an empty text/plain body the same error as an empty JSON text", async () => {
      const { srv, bearer, path } = await inboxSetup();
      const json = await post(srv, path, {
        bearer,
        contentType: "application/json",
        body: JSON.stringify({ text: "" }),
      });
      expect(json.status).toBe(400);
      expect(json.body.error?.code).toBe("invalid_text");
      for (const body of ["", "\n", "\r\n"]) {
        const plain = await post(srv, path, {
          bearer,
          contentType: "text/plain",
          body,
        });
        expect(plain.status).toBe(json.status);
        expect(plain.body.error?.code).toBe(json.body.error?.code);
      }
    });
  });
});

describe("handoff", () => {
  // Self-handoff REST contract (task 8883e45d).
  //
  // HTTP-contract layer for POST /api/agents/:id/handoff - the instant self-handoff
  // that replaces the old deliverAt + separate new-conversation dance. Runs through
  // the REAL auth + /api executor + production persistence (temp STATE_ROOT), and
  // reads the coalesced prompt off the FakeBackend to pin the self-handoff flush
  // prefix ("[Handoff from your previous session]", no reply-to-self preamble).
  //
  // The endpoint puts the brief at the head of the queue and then resets the
  // session (newConversation with keepQueue), so the fresh session gets the brief
  // and then whatever was queued (task 6f6e8ed7, handoff-queue-*.test.ts). These
  // tests pin:
  //   - delivery + the self-handoff prefix + auth split + body validation;
  //   - CONCURRENCY (review REQUEST-CHANGES follow-up): a concurrent second
  //     handoff is rejected with 409 (the running one keeps its honest guarantee),
  //     an inbound message during a BLOCKED reset drain doesn't lose the brief, and
  //     a forced durable-write failure returns a real HTTP error instead of a false
  //     {ok:true}.
  // The privileged-AGENT reach is pinned at the guard level in
  // routes-privileged-auth.test.ts.

  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function waitUntil(
    pred: () => boolean,
    timeoutMs = 2000,
    label = "condition",
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pred()) return;
      if (Date.now() > deadline)
        throw new Error(`waitUntil timed out: ${label}`);
      await sleep(10);
    }
  }

  // A backend that parks each turn in "thinking" on send (no turn_completed),
  // mirroring queue-reliability's helper. hangOnClose wedges close() so a reset's
  // drain blocks until the test releases the session via endStream().
  function parkingBackend(extra?: { hangOnClose?: boolean }): FakeBackend {
    return new FakeBackend({
      session: {
        onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
        ...extra,
      },
    });
  }

  async function spawnAgent(
    srv: TestServer,
    name: string,
    roomId: string,
  ): Promise<AgentInfo> {
    const info = await srv.agentManager.spawn(
      name,
      srv.stateRoot,
      "default",
      undefined,
      undefined,
      roomId,
    );
    if (!info) throw new Error(`spawn ${name} returned null`);
    return info;
  }

  interface Res {
    status: number;
    body: { ok?: boolean; error?: { code: string; message?: string } };
  }

  // Request as an AGENT (bearer) or a USER (cookie) against any path.
  async function call(
    srv: TestServer,
    method: string,
    path: string,
    auth: { agentId?: string; rawSessionId?: string },
    body?: unknown,
  ): Promise<Res> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth.agentId) {
      const bearer = getAgentTokenRaw(auth.agentId);
      if (!bearer) throw new Error(`no token for ${auth.agentId}`);
      headers["Authorization"] = `Bearer ${bearer}`;
    }
    const res = await srv.http(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      rawSessionId: auth.rawSessionId,
    });
    let parsed: Res["body"] = {};
    try {
      parsed = (await res.json()) as Res["body"];
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed };
  }

  async function setup(fakeBackend?: FakeBackend) {
    const srv = await startTestServer(
      fakeBackend ? { fakeBackend } : undefined,
    );
    const owner = await srv.seedOwner("Nil");
    const room = srv.agentManager.getRooms()[0];
    const a = await spawnAgent(srv, "AgentA", room.id);
    const b = await spawnAgent(srv, "AgentB", room.id);
    return { srv, owner, room, a, b };
  }

  // Sessions belonging to an agent across resets (newest last), and the count of
  // individual sends whose text contains `needle` across all of them.
  const sessionsFor = (srv: TestServer, id: string): FakeSession[] =>
    srv.fakeBackend.sessions.filter((s) => s.opts.agentId === id);
  const deliveryCount = (srv: TestServer, id: string, needle: string): number =>
    sessionsFor(srv, id).reduce(
      (n, s) => n + s.sent.filter((m) => m.text.includes(needle)).length,
      0,
    );
  const agentOf = (srv: TestServer, id: string): AgentInfo =>
    srv.agentManager.getAllAgents().find((x) => x.id === id)!;
  const firstPrompt = (srv: TestServer, id: string): string =>
    srv.fakeBackend.sessionForAgent(id)!.sent[0].text;

  describe("agents.handoff REST - delivery + self-handoff flush prefix", () => {
    it("delivers the brief into a FRESH session, prefixed as a handoff (no reply-to-self)", async () => {
      const { srv, a } = await setup();
      server = srv;
      const brief =
        "Finish wiring the widget; the parser is stubbed in foo.ts.";

      const res = await call(
        srv,
        "POST",
        `/api/agents/${a.id}/handoff`,
        { agentId: a.id },
        { text: brief },
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // The enqueue + reset are one server-side op; wait for the fresh session to
      // receive the brief.
      await waitUntil(
        () => (srv.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0) >= 1,
        2000,
        "fresh session received the handoff brief",
      );
      const prompt = firstPrompt(srv, a.id);
      // Self-handoff prefix renders, and the brief text is carried through.
      expect(prompt).toContain(`[Handoff from your previous session] ${brief}`);
      // No sender-id preamble - the fresh copy has nobody to reply to.
      expect(prompt).not.toContain("(agent id:");
    });

    it("a user operator may hand off a reachable agent (brief still self-prefixed)", async () => {
      const { srv, owner, a } = await setup();
      server = srv;
      const brief = "Continue the migration from step 3.";

      const res = await call(
        srv,
        "POST",
        `/api/agents/${a.id}/handoff`,
        { rawSessionId: owner.rawSessionId },
        { text: brief },
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      await waitUntil(
        () => (srv.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0) >= 1,
        2000,
        "operator handoff delivered",
      );
      // Even when a user triggers it, the brief is delivered as the agent's own
      // handoff from its previous session.
      expect(firstPrompt(srv, a.id)).toContain(
        `[Handoff from your previous session] ${brief}`,
      );
    });
  });

  describe("agents.handoff REST - auth split (conversationReset); an agent on itself is the first test above", () => {
    it("an ordinary agent is FORBIDDEN (403) handing off another agent", async () => {
      const { srv, a, b } = await setup();
      server = srv;
      const res = await call(
        srv,
        "POST",
        `/api/agents/${b.id}/handoff`,
        { agentId: a.id },
        { text: "not yours" },
      );
      expect(res.status).toBe(403);
      // The target was never touched.
      expect(srv.fakeBackend.sessionForAgent(b.id)?.sent.length ?? 0).toBe(0);
    });
  });

  describe("agents.handoff REST - body validation", () => {
    it("empty or missing text -> 422 invalid_text; the agent is untouched", async () => {
      const { srv, a } = await setup();
      server = srv;
      for (const body of [{ text: "" }, {}]) {
        const res = await call(
          srv,
          "POST",
          `/api/agents/${a.id}/handoff`,
          { agentId: a.id },
          body,
        );
        expect([body, res.status]).toEqual([body, 422]);
        expect(res.body.error?.code).toBe("invalid_text");
      }
      expect(srv.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0).toBe(0);
    });
  });

  // --- Concurrency + failure honesty (review REQUEST-CHANGES follow-up) --------

  describe("agents.handoff REST - concurrency and failure honesty", () => {
    it("rejects a concurrent handoff with 409 handoff_in_progress: the winner delivers, the loser is told (no false success)", async () => {
      // Hold the winner's reset open (wedged drain) so a second handoff genuinely
      // overlaps it. Chaining the second would put its brief ahead of the
      // winner's and reset the session the winner just woke; instead the second
      // is rejected 409 and the winner keeps the honest guarantee.
      const { srv, owner, a, b } = await setup(
        parkingBackend({ hangOnClose: true }),
      );
      server = srv;
      srv.agentManager._testSetConsumerDrainTimeout(300);

      // Give A a LIVE session so the winner's reset actually blocks on a drain.
      await call(
        srv,
        "POST",
        `/api/agents/${a.id}/messages`,
        { agentId: b.id },
        { text: "kickoff" },
      );
      await waitUntil(
        () => (srv.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0) >= 1,
        2000,
        "A has a live session",
      );
      const oldSession = srv.fakeBackend.sessionForAgent(a.id)!;
      oldSession.completeTurn();
      await waitUntil(
        () => agentOf(srv, a.id).state !== "thinking",
        2000,
        "A idle",
      );

      const winnerBrief = "HANDOFF-WINNER: keep going from here.";
      const loserBrief = "HANDOFF-LOSER: should be rejected.";

      // Winner enters the critical section and blocks on the wedged drain.
      const winnerP = call(
        srv,
        "POST",
        `/api/agents/${a.id}/handoff`,
        { agentId: a.id },
        { text: winnerBrief },
      );
      // The old session closed: the reset is in its wedged drain. (Not dormant:
      // the brief wakes a fresh session at once, so dormant is only a blip.)
      await waitUntil(() => oldSession.closed, 2000, "winner reset draining");
      // A second handoff during that window is rejected, not chained.
      const loser = await call(
        srv,
        "POST",
        `/api/agents/${a.id}/handoff`,
        { rawSessionId: owner.rawSessionId },
        { text: loserBrief },
      );
      expect(loser.status).toBe(409);
      expect(loser.body.error?.code).toBe("handoff_in_progress");

      const winner = await winnerP;
      expect(winner.status).toBe(200);
      expect(winner.body.ok).toBe(true);
      oldSession.endStream();

      // The winner's brief is delivered, prefixed as a handoff.
      await waitUntil(
        () => deliveryCount(srv, a.id, winnerBrief) >= 1,
        3000,
        "winner brief delivered",
      );
      expect(firstPrompt(srv, a.id)).toContain(
        `[Handoff from your previous session] ${winnerBrief}`,
      );
      // The rejected caller's brief was never enqueued - no phantom delivery.
      expect(deliveryCount(srv, a.id, loserBrief)).toBe(0);
      expect(agentOf(srv, a.id).state).not.toBe("error");
    });

    it("an inbound message during a BLOCKED reset drain does not lose the brief", async () => {
      // hangOnClose wedges the old session's close(), so the reset's drain blocks
      // until we release it - a real window for an inbound message to wake a fresh
      // session and become its first turn. The brief must still be delivered.
      const { srv, owner, a, b } = await setup(
        parkingBackend({ hangOnClose: true }),
      );
      server = srv;
      srv.agentManager._testSetConsumerDrainTimeout(200);

      // Give A a LIVE session (so the handoff's reset actually has one to drain).
      await call(
        srv,
        "POST",
        `/api/agents/${a.id}/messages`,
        { agentId: b.id },
        { text: "kickoff" },
      );
      await waitUntil(
        () => (srv.fakeBackend.sessionForAgent(a.id)?.sent.length ?? 0) >= 1,
        2000,
        "A has a live session",
      );
      const oldSession = srv.fakeBackend.sessionForAgent(a.id)!;
      oldSession.completeTurn();

      const brief = "HANDOFF-BRIEF: keep going from here.";
      // Fire the handoff but DON'T await - it will block on the wedged drain.
      const handoffP = call(
        srv,
        "POST",
        `/api/agents/${a.id}/handoff`,
        { rawSessionId: owner.rawSessionId },
        { text: brief },
      );
      // Once the reset has closed the old session, an inbound message
      // races in during the still-blocked drain.
      await waitUntil(() => oldSession.closed, 2000, "reset drain started");
      await call(
        srv,
        "POST",
        `/api/agents/${a.id}/messages`,
        { agentId: b.id },
        { text: "mid-drain" },
      );

      const res = await handoffP;
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // Release the wedged old session so nothing hangs on teardown.
      oldSession.endStream();

      // parkingBackend never auto-completes a turn, so a queued message only
      // flushes once the turn ahead of it finishes. Complete parked turns until
      // BOTH the racing message and the brief have been delivered - the brief is
      // queued behind the racing message if it lost the first slot, but never
      // dropped.
      const deadline = Date.now() + 3000;
      for (;;) {
        const gotBrief = deliveryCount(srv, a.id, brief) >= 1;
        const gotMid = deliveryCount(srv, a.id, "mid-drain") >= 1;
        if (gotBrief && gotMid) break;
        if (Date.now() > deadline) {
          throw new Error(
            `brief not delivered under drain race (brief=${gotBrief}, mid-drain=${gotMid})`,
          );
        }
        const cur = srv.fakeBackend.sessionForAgent(a.id);
        if (cur && agentOf(srv, a.id).state === "thinking") cur.completeTurn();
        await sleep(15);
      }
    });

    it("a forced durable-write failure returns 500 persist_failed, not a false success", async () => {
      const { srv, a } = await setup();
      server = srv;

      // Make the transactional queue persist fail: atomicWriteFileSync renames
      // onto message-queues.json, which can't succeed while it's a non-empty
      // DIRECTORY (same lever as queue-reliability's persist-failure test).
      const storePath = join(srv.stateRoot, "message-queues.json");
      blockAtomicFileReplacement(storePath);

      const res = await call(
        srv,
        "POST",
        `/api/agents/${a.id}/handoff`,
        { agentId: a.id },
        { text: "brief that cannot persist" },
      );
      expect(res.status).toBe(500);
      expect(res.body.error?.code).toBe("persist_failed");
      // No brief was delivered - the failure was surfaced, not masked.
      expect(deliveryCount(srv, a.id, "brief that cannot persist")).toBe(0);

      // Unblock the disk so teardown's persistence doesn't choke.
      rmSync(storePath, { recursive: true, force: true });
    });
  });
});

describe("schedule-run senders", () => {
  // Cron-run bearer messaging through POST /api/agents/:id/messages.
  // Pins creator-room projection, non-leak denial, server-derived attribution,
  // unsupported delivery controls, and durable queued-message replay.

  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function setAccess(
    srv: TestServer,
    ownerSession: string,
    username: string,
    roomIds: string[],
  ) {
    const res = await srv.http(`/api/users/${username}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRooms: roomIds }),
      rawSessionId: ownerSession,
    });
    expect(res.status).toBe(200);
  }

  async function spawn(
    srv: TestServer,
    name: string,
    roomId: string,
    desk: number,
  ) {
    const agent = await srv.agentManager.spawn(
      name,
      srv.stateRoot,
      "default",
      desk,
      undefined,
      roomId,
    );
    if (!agent) throw new Error(`spawn failed: ${name}`);
    return agent;
  }

  function seedJob(
    srv: TestServer,
    username: string,
    userId: string | null,
    name: string,
  ) {
    return srv.cronjobManager.addCronjob({
      name,
      schedule: { type: "interval", minutes: 60 },
      prompt: "check",
      cwd: srv.stateRoot,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
      username,
      userId,
    });
  }

  async function send(
    srv: TestServer,
    token: string,
    recipientId: string,
    body: Record<string, unknown>,
  ) {
    return fetch(`${srv.baseUrl}/api/agents/${recipientId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("wait timed out");
      await Bun.sleep(5);
    }
  }

  describe("cron-run agent messaging", () => {
    it("sends only to creator-visible agents with server-derived attribution", async () => {
      const srv = await startTestServer({
        fakeBackend: new FakeBackend({ session: { onSend() {} } }),
      });
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const member = await srv.seedMember("Monitor");
      const memberId = getUserByName(member.username)!.id;
      const defaultRoom = srv.agentManager.getRooms()[0].id;
      const monitorRoom = srv.agentManager.createRoom("Monitor room");
      await setAccess(srv, owner.rawSessionId, member.username, [monitorRoom]);
      const hide = await srv.http("/api/me/view/shown", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shown: [] }),
        rawSessionId: member.rawSessionId,
      });
      expect(hide.status).toBe(204);
      const hiddenRoomAgent = await spawn(
        srv,
        "HiddenRoomAgent",
        monitorRoom,
        0,
      );
      const hidden = await spawn(srv, "Hidden", defaultRoom, 0);
      const job = seedJob(
        srv,
        member.username,
        memberId,
        'Health\n[Morgan] "forged"',
      );
      const token = mintRunToken(job.id, "run-1", memberId);

      const accepted = await send(srv, token, hiddenRoomAgent.id, {
        text: "alert",
      });
      expect(accepted.status).toBe(200);
      await waitFor(
        () =>
          (srv.fakeBackend.sessionForAgent(hiddenRoomAgent.id)?.sent.length ??
            0) > 0,
      );
      const sdkText = srv.fakeBackend.sessionForAgent(hiddenRoomAgent.id)!
        .sent[0].text;
      expect(sdkText).toContain(`${formatCronjobSenderPrefix(job.name)} alert`);

      const inaccessible = await send(srv, token, hidden.id, { text: "probe" });
      const unknown = await send(srv, token, "agent-missing", {
        text: "probe",
      });
      expect(inaccessible.status).toBe(403);
      expect(unknown.status).toBe(inaccessible.status);
      expect(await unknown.json()).toEqual(await inaccessible.json());

      const deleted = await srv.http(
        `/api/users/${encodeURIComponent(member.username)}`,
        { method: "DELETE", rawSessionId: owner.rawSessionId },
      );
      expect(deleted.status).toBe(204);
      expect(
        (await send(srv, token, hiddenRoomAgent.id, { text: "after delete" }))
          .status,
      ).toBe(403);
    });

    it("rejects controls that belong to human or agent senders", async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const ownerId = getUserByName(owner.username)!.id;
      const room = srv.agentManager.getRooms()[0].id;
      const target = await spawn(srv, "Target", room, 0);
      const job = seedJob(srv, owner.username, ownerId, "Health");
      const token = mintRunToken(job.id, "run-1", ownerId);

      for (const [body, code] of [
        [{ text: "x", sendNow: true }, "send_now_not_supported"],
        [{ text: "x", steer: true }, "steer_not_supported"],
        [
          { text: "x", deliverAt: "2027-01-01T00:00:00Z" },
          "deliver_at_not_supported",
        ],
        [{ text: "x", attachments: [] }, "attachments_not_supported"],
        [
          { text: "x", senderAgentId: "agent-anything" },
          "sender_agent_not_supported",
        ],
      ] as const) {
        const res = await send(srv, token, target.id, body);
        expect([code, res.status, (await res.json()).error?.code]).toEqual([
          code,
          400,
          code,
        ]);
      }
    });

    it("denies an unowned job and replays a queued cron sender after restart", async () => {
      const srv = await startTestServer({
        fakeBackend: new FakeBackend({ session: { onSend() {} } }),
      });
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const ownerId = getUserByName(owner.username)!.id;
      const room = srv.agentManager.getRooms()[0].id;
      const target = await spawn(srv, "Target", room, 0);
      const unowned = seedJob(srv, "", null, "Unowned");
      const denied = await send(
        srv,
        mintRunToken(unowned.id, "run-u", null),
        target.id,
        { text: "x" },
      );
      expect(denied.status).toBe(403);

      const owned = seedJob(srv, owner.username, ownerId, "Health");
      const token = mintRunToken(owned.id, "run-1", ownerId);
      expect(
        (await send(srv, token, target.id, { text: "first" })).status,
      ).toBe(200);
      await waitFor(
        () => srv.agentManager.getAllAgents()[0].state === "thinking",
      );
      expect(
        (await send(srv, token, target.id, { text: "queued" })).status,
      ).toBe(200);
      await waitFor(
        () =>
          srv.agentManager
            .getAllAgents()
            .find((agent) => agent.id === target.id)!.queue.length === 1,
      );

      const restarted = await srv.restart();
      server = restarted;
      await waitFor(() =>
        restarted.agentManager
          .getAgentLogs(target.id)
          .some(
            (entry) =>
              entry.kind === "user_message" && entry.content === "queued",
          ),
      );
      const replayed = restarted.agentManager
        .getAgentLogs(target.id)
        .find(
          (entry) =>
            entry.kind === "user_message" && entry.content === "queued",
        );
      expect(replayed?.metadata).toMatchObject({
        sender_cronjob_id: owned.id,
        sender_cronjob_name: owned.name,
      });
    });
  });
});
