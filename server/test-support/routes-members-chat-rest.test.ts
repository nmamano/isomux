// Members chat on the unified REST surface (opIds membersChat.*), through the
// in-process harness. What is pinned here is the ACCESS story as much as the
// behaviour: a cookie user, an API token and a privileged agent reach the chat;
// an ordinary agent, a cron run and an app get 403 on read and write alike.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { mintAgentToken, mintRunToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import type { AgentInfo, MembersChatMessage } from "../../shared/types.ts";
import type {
  ApiTokenCreateRes,
  MembersChatPageRes,
} from "../../shared/contract-shapes.ts";
import { MEMBERS_CHAT_MAX_CHARS } from "../members-chat.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}

async function api(
  srv: TestServer,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    rawSessionId?: string;
    bearer?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const post = (srv: TestServer, session: string, text: string) =>
  api(srv, "/api/members-chat", {
    method: "POST",
    body: { text },
    rawSessionId: session,
  });

const messagesOf = (s: TestSocket): MembersChatMessage[] =>
  s.messages
    .filter((m) => (m as { type?: string }).type === "members_chat_message")
    .map((m) => (m as { message: MembersChatMessage }).message);

async function spawnAgent(srv: TestServer, name: string): Promise<AgentInfo> {
  const roomId = srv.agentManager.getRooms()[0].id;
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
    "codex",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

async function upload(
  srv: TestServer,
  session: string,
  name: string,
  bytes: string,
  type = "text/plain",
) {
  const fd = new FormData();
  fd.append("files", new File([bytes], name, { type }));
  return srv.http("/api/members-chat/uploads", {
    method: "POST",
    body: fd,
    rawSessionId: session,
  });
}

describe("members chat REST: post, page, fan-out", () => {
  it("a post reaches every other socket and pages back with the caller's unread", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Nil");
    const member = await server.seedMember("Pau");
    const memberWs = await server.connectWs(member.rawSessionId);
    await memberWs.waitFor("full_state");

    const res = await post(server, owner.rawSessionId, "hello **members**");
    expect(res.status).toBe(201);
    const posted = res.body as MembersChatMessage;
    expect(posted.kind).toBe("user");
    expect(posted.userName).toBe("Nil");
    expect(posted.content).toBe("hello **members**");
    expect(posted.attachments).toEqual([]);

    const seen = await memberWs.waitFor("members_chat_message");
    expect((seen.message as MembersChatMessage).id).toBe(posted.id);

    const page = await api(server, "/api/members-chat", {
      rawSessionId: member.rawSessionId,
    });
    expect(page.status).toBe(200);
    const body = page.body as MembersChatPageRes;
    expect(body.messages.map((m) => m.id)).toEqual([posted.id]);
    expect(body.hasMore).toBe(false);
    expect(body.readPointer).toBeNull();
    expect(body.unread).toBe(1);
    memberWs.close();
  });

  it("pages newest-first in slices and follows the before cursor", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Nil");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await post(server, owner.rawSessionId, `m${i}`);
      ids.push((r.body as MembersChatMessage).id);
    }
    const p1 = (
      await api(server, "/api/members-chat?limit=2", {
        rawSessionId: owner.rawSessionId,
      })
    ).body as MembersChatPageRes;
    expect(p1.messages.map((m) => m.id)).toEqual(ids.slice(1));
    expect(p1.hasMore).toBe(true);
    const p2 = (
      await api(server, `/api/members-chat?limit=2&before=${ids[1]}`, {
        rawSessionId: owner.rawSessionId,
      })
    ).body as MembersChatPageRes;
    expect(p2.messages.map((m) => m.id)).toEqual([ids[0]]);
    expect(p2.hasMore).toBe(false);
  });

  it("refuses empty text and text over the cap, and a device label rides along", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Nil");
    expect((await post(server, owner.rawSessionId, "   ")).status).toBe(400);
    expect(
      (
        await post(
          server,
          owner.rawSessionId,
          "x".repeat(MEMBERS_CHAT_MAX_CHARS + 1),
        )
      ).status,
    ).toBe(400);
    const withDevice = await api(server, "/api/members-chat", {
      method: "POST",
      body: { text: "from my phone", device: "Phone" },
      rawSessionId: owner.rawSessionId,
    });
    expect(withDevice.status).toBe(201);
    expect((withDevice.body as MembersChatMessage).device).toBe("Phone");
  });
});

describe("members chat REST: edit and delete ownership", () => {
  it("edit is own-only; delete is own, or any for an office owner", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Nil");
    const member = await server.seedMember("Pau");
    const ownerWs = await server.connectWs(owner.rawSessionId);
    await ownerWs.waitFor("full_state");

    const mine = (await post(server, member.rawSessionId, "draft"))
      .body as MembersChatMessage;
    const theirs = (await post(server, owner.rawSessionId, "boss note"))
      .body as MembersChatMessage;

    // Member edits own: 200, and the edit fans out as an upsert.
    const edited = await api(server, `/api/members-chat/${mine.id}`, {
      method: "PATCH",
      body: { text: "final" },
      rawSessionId: member.rawSessionId,
    });
    expect(edited.status).toBe(200);
    expect((edited.body as MembersChatMessage).content).toBe("final");
    expect((edited.body as MembersChatMessage).editedAt).toBeGreaterThan(0);
    // The socket also receives both posts. Harness waitFor returns buffered
    // events by type without consuming them, so yield until this edit arrives.
    const sawEdit = () =>
      messagesOf(ownerWs).some((m) => m.id === mine.id && m.content === "final");
    const editDeadline = Date.now() + 2000;
    while (!sawEdit() && Date.now() < editDeadline) {
      await Bun.sleep(5);
    }
    expect(
      messagesOf(ownerWs).map((m) => ({ id: m.id, content: m.content })),
    ).toContainEqual({ id: mine.id, content: "final" });

    // Member edits the owner's: 403. Member deletes the owner's: 403.
    expect(
      (
        await api(server, `/api/members-chat/${theirs.id}`, {
          method: "PATCH",
          body: { text: "hijack" },
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(server, `/api/members-chat/${theirs.id}`, {
          method: "DELETE",
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(403);

    // Owner deletes the member's: 204 + members_chat_deleted; then 404.
    expect(
      (
        await api(server, `/api/members-chat/${mine.id}`, {
          method: "DELETE",
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(204);
    const gone = await ownerWs.waitFor("members_chat_deleted");
    expect(gone.id).toBe(mine.id);
    expect(
      (
        await api(server, `/api/members-chat/${mine.id}`, {
          method: "PATCH",
          body: { text: "zombie" },
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(404);
    ownerWs.close();
  });
});

describe("members chat REST: read pointer", () => {
  it("markRead advances the pointer, reports unread, and reaches the user's other socket", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Nil");
    const member = await server.seedMember("Pau");
    const laptop = await server.connectWs(member.rawSessionId);
    await laptop.waitFor("full_state");
    const ownerWs = await server.connectWs(owner.rawSessionId);
    await ownerWs.waitFor("full_state");

    const a = (await post(server, owner.rawSessionId, "a"))
      .body as MembersChatMessage;
    const b = (await post(server, owner.rawSessionId, "b"))
      .body as MembersChatMessage;

    const read = await api(server, "/api/members-chat/read", {
      method: "POST",
      body: { lastReadId: a.id },
      rawSessionId: member.rawSessionId,
    });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ readPointer: a.id, unread: 1 });
    const synced = await laptop.waitFor("members_chat_read");
    expect(synced).toMatchObject({ readPointer: a.id, unread: 1 });
    // The owner's socket is not told about the member's pointer.
    expect(
      ownerWs.messages.some(
        (m) => (m as { type?: string }).type === "members_chat_read",
      ),
    ).toBe(false);

    // A stale device cannot move the pointer back.
    await api(server, "/api/members-chat/read", {
      method: "POST",
      body: { lastReadId: b.id },
      rawSessionId: member.rawSessionId,
    });
    const back = await api(server, "/api/members-chat/read", {
      method: "POST",
      body: { lastReadId: a.id },
      rawSessionId: member.rawSessionId,
    });
    expect(back.body).toEqual({ readPointer: b.id, unread: 0 });
    laptop.close();
    ownerWs.close();
  });
});

describe("members chat REST: attachments", () => {
  it("uploads, posts with the attachment, serves the bytes, and refuses an unknown filename", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Nil");
    const member = await server.seedMember("Pau");

    const up = await upload(
      server,
      owner.rawSessionId,
      "notes.txt",
      "hi there",
    );
    expect(up.status).toBe(200);
    const { attachments } = (await up.json()) as {
      attachments: MembersChatMessage["attachments"];
    };
    expect(attachments).toHaveLength(1);
    expect(attachments[0].originalName).toBe("notes.txt");

    const posted = await api(server, "/api/members-chat", {
      method: "POST",
      body: { text: "", attachments },
      rawSessionId: owner.rawSessionId,
    });
    expect(posted.status).toBe(201);
    expect((posted.body as MembersChatMessage).attachments).toEqual(
      attachments,
    );

    // Any member can fetch the bytes.
    const got = await server.http(
      `/api/members-chat/files/${attachments[0].filename}`,
      { rawSessionId: member.rawSessionId },
    );
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("hi there");
    expect(got.headers.get("cache-control")).toContain("immutable");

    // A filename the chat does not hold is refused, and traversal is a 404.
    const bogus = await api(server, "/api/members-chat", {
      method: "POST",
      body: {
        text: "see file",
        attachments: [{ ...attachments[0], filename: "not-uploaded.txt" }],
      },
      rawSessionId: owner.rawSessionId,
    });
    expect(bogus.status).toBe(400);
    expect(
      (
        await server.http("/api/members-chat/files/..%2Freads.json", {
          rawSessionId: member.rawSessionId,
        })
      ).status,
    ).toBe(404);
  });
});

describe("members chat REST: who may enter", () => {
  it("an ordinary agent and a cron run get 403 on read and write; a privileged agent posts as itself", async () => {
    server = await startTestServer();
    await server.seedOwner("Nil");
    const ownerId = getUserByName("Nil")!.id;
    const bot = await spawnAgent(server, "Bot");
    const plain = mintAgentToken(bot.id, ownerId);
    for (const bearer of [plain, mintRunToken("job-1", "run-1", ownerId)]) {
      expect((await api(server, "/api/members-chat", { bearer })).status).toBe(
        403,
      );
      expect(
        (
          await api(server, "/api/members-chat", {
            method: "POST",
            body: { text: "let me in" },
            bearer,
          })
        ).status,
      ).toBe(403);
    }
    // Nothing landed.
    const owner = await server.seedMember("Pau");
    const empty = (
      await api(server, "/api/members-chat", {
        rawSessionId: owner.rawSessionId,
      })
    ).body as MembersChatPageRes;
    expect(empty.messages).toEqual([]);

    const privileged = mintAgentToken(bot.id, ownerId, true);
    const asAgent = await api(server, "/api/members-chat", {
      method: "POST",
      body: { text: "status: all green", device: "ignored" },
      bearer: privileged,
    });
    expect(asAgent.status).toBe(201);
    const m = asAgent.body as MembersChatMessage;
    expect(m.kind).toBe("agent");
    expect(m.userName).toBe("Bot");
    expect(m.userId).toBe(ownerId);
    expect(m.device).toBeUndefined();
    // The agent shares its boss's identity for ownership: the boss can edit it.
    const page = (
      await api(server, "/api/members-chat", { bearer: privileged })
    ).body as MembersChatPageRes;
    expect(page.messages.map((x) => x.id)).toEqual([m.id]);
  });

  it("an API token posts as its user with the token name as device; an app token gets 403", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Nil");
    const ownerId = getUserByName("Nil")!.id;
    const minted = await server.http("/api/me/api-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Phone", expiresInDays: 30 }),
      rawSessionId: owner.rawSessionId,
    });
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as ApiTokenCreateRes;
    const viaApi = await api(server, "/api/members-chat", {
      method: "POST",
      body: { text: "from the road", device: "ignored" },
      bearer: token,
    });
    expect(viaApi.status).toBe(201);
    const m = viaApi.body as MembersChatMessage;
    expect(m.kind).toBe("api");
    expect(m.userId).toBe(ownerId);
    expect(m.userName).toBe("Nil");
    expect(m.device).toBe("Phone");
    // Same person: the cookie session may edit what the token posted.
    expect(
      (
        await api(server, `/api/members-chat/${m.id}`, {
          method: "PATCH",
          body: { text: "from the road, edited" },
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(200);

    const bot = await spawnAgent(server, "AppBot");
    const agentToken = mintAgentToken(bot.id, ownerId);
    const reg = await api(server, "/api/apps", {
      method: "POST",
      body: {
        name: "lobbyapp",
        command: "bun run serve.ts",
        cwd: server.stateRoot,
      },
      bearer: agentToken,
    });
    expect(reg.status).toBe(201);
    const appToken = server.appSupervisor.tokenFiles.get("lobbyapp");
    if (!appToken) throw new Error("no app token file");
    expect(
      (await api(server, "/api/members-chat", { bearer: appToken })).status,
    ).toBe(403);
    expect(
      (
        await api(server, "/api/members-chat", {
          method: "POST",
          body: { text: "beep" },
          bearer: appToken,
        })
      ).status,
    ).toBe(403);
  });
});
