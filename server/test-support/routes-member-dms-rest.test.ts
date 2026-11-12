// 1:1 chats between two members on the REST surface (opIds memberDms.*, task
// 019e4d7c), through the in-process harness.
//
// Pins the access story first: only the two members of a pair reach its
// messages, files and events, on every route; an office owner outside the
// pair has no way in, and an owner inside it cannot delete the peer's
// message. A read never makes a chat. A removed peer is read-only until a
// restore, stays readable after its removed record expires, is addressed by
// id only, and a new member who takes the old name gets a new chat. A token
// or pack without the directMessages area is closed, even with membersChat.
// A new message pushes to the recipient's devices, never the sender's.
//
// Seam: startTestServer() with a stub webPushFetch. Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  startTestServer,
  type SeededIdentity,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { mintApiToken } from "../api-tokens.ts";
import { dropRemovedMember } from "../removed-members.ts";
import { getUserByName } from "../users.ts";
import type {
  AgentInfo,
  MemberDmSummary,
  MembersChatMessage,
} from "../../shared/types.ts";
import type {
  MemberDmListRes,
  MemberDmPageRes,
  MembersChatReadRes,
} from "../../shared/contract-shapes.ts";
import type { MemberPack } from "../../shared/pack-fit.ts";

const P256DH =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

let server: TestServer | null = null;
const sockets: TestSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}

type Caller = { session: string } | { bearer: string };

async function call(
  srv: TestServer,
  who: Caller,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if ("bearer" in who) headers["Authorization"] = `Bearer ${who.bearer}`;
  const res = await srv.http(path, {
    method,
    headers,
    rawSessionId: "session" in who ? who.session : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

async function waitUntil(cond: () => boolean, label: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await Bun.sleep(5);
  }
}

// An office: Nil owns it; Pau and Mia are members. pushed records each push
// endpoint the server sent to.
async function office() {
  const pushed: string[] = [];
  const srv = await startTestServer({
    startServer: {
      webPushFetch: async (url) => {
        pushed.push(url);
        return new Response(null, { status: 201 });
      },
    },
  });
  server = srv;
  const nil = await srv.seedOwner("Nil");
  const pau = await srv.seedMember("Pau");
  const mia = await srv.seedMember("Mia");
  const idOf = (s: SeededIdentity) => getUserByName(s.username)!.id;
  const m = (s: SeededIdentity) => ({
    session: s.rawSessionId,
    name: s.username,
    id: idOf(s),
  });
  return { srv, pushed, nil: m(nil), pau: m(pau), mia: m(mia) };
}
type Member = Awaited<ReturnType<typeof office>>["nil"];

const chat = (peer: string) => `/api/users/${encodeURIComponent(peer)}/chat`;

const say = (srv: TestServer, from: Caller, peer: string, text: string) =>
  call(srv, from, "POST", chat(peer), { text });

async function sayOk(
  srv: TestServer,
  from: Caller,
  peer: string,
  text: string,
): Promise<MembersChatMessage> {
  const r = await say(srv, from, peer, text);
  expect(r.status).toBe(201);
  return r.body as MembersChatMessage;
}

const pageOf = async (srv: TestServer, who: Caller, peer: string) => {
  const r = await call(srv, who, "GET", chat(peer));
  expect(r.status).toBe(200);
  return r.body as MemberDmPageRes;
};

const listOf = async (srv: TestServer, who: Caller) => {
  const r = await call(srv, who, "GET", "/api/member-chats");
  expect(r.status).toBe(200);
  return (r.body as MemberDmListRes).chats;
};

async function upload(
  srv: TestServer,
  who: Member,
  peer: string,
  name: string,
  bytes: string,
) {
  const fd = new FormData();
  fd.append("files", new File([bytes], name, { type: "text/plain" }));
  return srv.http(`${chat(peer)}/uploads`, {
    method: "POST",
    body: fd,
    rawSessionId: who.session,
  });
}

async function socketOf(srv: TestServer, who: Member): Promise<TestSocket> {
  const s = await srv.connectWs(who.session);
  sockets.push(s);
  await s.waitFor("full_state");
  return s;
}

const framesOf = (s: TestSocket, type: string) =>
  (s.messages as Record<string, unknown>[]).filter((m) => m.type === type);

// The pair directories under the state, whatever their names.
const pairDirs = (srv: TestServer): string[] => {
  const root = join(srv.stateRoot, "member-dms");
  return existsSync(root) ? readdirSync(root) : [];
};

async function spawnAgent(srv: TestServer, name: string): Promise<AgentInfo> {
  const roomId = srv.agentManager.getRooms()[0].id;
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
    "codex",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

describe("1:1 chats: post, page, list and events", () => {
  it("a post reaches only the two members' sockets, each copy naming the other member", async () => {
    const { srv, nil, pau, mia } = await office();
    const nilWs = await socketOf(srv, nil);
    const pauWs = await socketOf(srv, pau);
    const miaWs = await socketOf(srv, mia);

    // Addressed by name; the peer reads it back addressed by id.
    const sent = await sayOk(srv, pau, mia.name, "hello **mia**");
    expect(sent.userId).toBe(pau.id);
    expect(sent.kind).toBe("user");
    expect(sent.content).toBe("hello **mia**");

    await waitUntil(
      () =>
        framesOf(pauWs, "dm_message").length === 1 &&
        framesOf(miaWs, "dm_message").length === 1,
      "both members got the message",
    );
    expect(framesOf(pauWs, "dm_message")[0]).toMatchObject({
      peerId: mia.id,
      message: { id: sent.id },
    });
    expect(framesOf(miaWs, "dm_message")[0]).toMatchObject({
      peerId: pau.id,
      message: { id: sent.id },
    });

    // Fence: an all-audience members chat post after the 1:1 one. Once the
    // owner's socket has it, a 1:1 frame for the owner would have landed.
    await call(srv, nil, "POST", "/api/members-chat", { text: "fence" });
    await waitUntil(
      () => framesOf(nilWs, "members_chat_message").length === 1,
      "the fence reached the owner",
    );
    expect(framesOf(nilWs, "dm_message").length).toBe(0);
    expect(JSON.stringify(nilWs.messages)).not.toContain(sent.id);

    const miaPage = await pageOf(srv, mia, pau.id);
    expect(miaPage.messages.map((m) => m.id)).toEqual([sent.id]);
    expect(miaPage.readPointer).toBeNull();
    expect(miaPage.unread).toBe(1);
    expect((await pageOf(srv, pau, mia.id)).unread).toBe(0);

    const miaList = await listOf(srv, mia);
    expect(miaList).toEqual([
      {
        peerId: pau.id,
        peerName: pau.name,
        removed: false,
        readPointer: null,
        unread: 1,
        lastAt: sent.timestamp,
      } satisfies MemberDmSummary,
    ]);
    expect((await listOf(srv, pau)).map((c) => [c.peerId, c.unread])).toEqual([
      [mia.id, 0],
    ]);
    // The owner is in no chat.
    expect(await listOf(srv, nil)).toEqual([]);
  });

  it("full_state carries each member's own chats; the outsider's carries none", async () => {
    const { srv, nil, pau, mia } = await office();
    const sent = await sayOk(srv, pau, mia.id, "hi");
    const summaries = async (who: Member) =>
      (await socketOf(srv, who).then((s) => s.waitFor("full_state")))
        .memberDms as MemberDmSummary[] | undefined;
    expect(await summaries(mia)).toEqual([
      {
        peerId: pau.id,
        peerName: pau.name,
        removed: false,
        readPointer: null,
        unread: 1,
        lastAt: sent.timestamp,
      },
    ]);
    expect((await summaries(pau))?.map((c) => [c.peerId, c.unread])).toEqual([
      [mia.id, 0],
    ]);
    expect(await summaries(nil)).toEqual([]);
  });

  it("markRead reaches only the reader's sockets", async () => {
    const { srv, pau, mia } = await office();
    const sent = await sayOk(srv, pau, mia.name, "read me");
    const miaLaptop = await socketOf(srv, mia);
    const miaPhone = await socketOf(srv, mia);
    const pauWs = await socketOf(srv, pau);

    const r = await call(srv, mia, "POST", `${chat(pau.id)}/read`, {
      lastReadId: sent.id,
    });
    expect(r.status).toBe(200);
    expect(r.body as MembersChatReadRes).toEqual({
      readPointer: sent.id,
      unread: 0,
    });
    for (const s of [miaLaptop, miaPhone])
      await waitUntil(
        () => framesOf(s, "dm_read").length === 1,
        "the reader's socket got dm_read",
      );
    expect(framesOf(miaPhone, "dm_read")[0]).toMatchObject({
      peerId: pau.id,
      readPointer: sent.id,
      unread: 0,
    });
    // Fence: Pau's next post reaches Pau's socket after any read frame would.
    const next = await sayOk(srv, pau, mia.id, "fence");
    await waitUntil(
      () =>
        framesOf(pauWs, "dm_message").some(
          (f) => (f.message as MembersChatMessage).id === next.id,
        ),
      "the fence reached Pau",
    );
    expect(framesOf(pauWs, "dm_read").length).toBe(0);
    expect((await listOf(srv, mia))[0].unread).toBe(1);
  });
});

describe("1:1 chats: unread", () => {
  // Your own messages never count as unread, and posting reads nothing: a
  // post from your phone, a token or your privileged agent does not mark the
  // peer's messages read. Only markRead moves the pointer.
  it("a post leaves the poster's pointer and the peer's unread messages alone", async () => {
    const { srv, nil, pau } = await office();
    const first = await sayOk(srv, pau, nil.id, "one");
    await sayOk(srv, pau, nil.id, "two");
    expect((await pageOf(srv, pau, nil.id)).unread).toBe(0);

    const bot = await spawnAgent(srv, "Bot");
    const agent = { bearer: mintAgentToken(bot.id, nil.id, true) };
    await sayOk(srv, agent, pau.id, "on it");
    await sayOk(srv, nil, pau.id, "and me");
    const nilPage = await pageOf(srv, nil, pau.id);
    expect(nilPage.readPointer).toBeNull();
    expect(nilPage.unread).toBe(2);
    expect(await listOf(srv, nil)).toMatchObject([
      { peerId: pau.id, readPointer: null, unread: 2 },
    ]);
    expect((await pageOf(srv, pau, nil.id)).unread).toBe(2);

    // markRead still moves it.
    const read = await call(srv, nil, "POST", `${chat(pau.id)}/read`, {
      lastReadId: first.id,
    });
    expect(read.body).toEqual({ readPointer: first.id, unread: 1 });
  });
});

describe("1:1 chats: who is in the pair", () => {
  it("refuses a chat with yourself and an unknown member", async () => {
    const { srv, pau } = await office();
    for (const self of [pau.name, pau.id]) {
      expect((await call(srv, pau, "GET", chat(self))).status).toBe(400);
      expect((await say(srv, pau, self, "me")).status).toBe(400);
    }
    expect((await call(srv, pau, "GET", chat("Nobody"))).status).toBe(404);
    expect((await say(srv, pau, "Nobody", "hi")).status).toBe(404);
    expect(pairDirs(srv)).toEqual([]);
  });

  it("an owner outside the pair reaches none of its messages, files or reply snapshots", async () => {
    const { srv, nil, pau, mia } = await office();
    const up = await upload(srv, pau, mia.name, "notes.txt", "pair secret");
    expect(up.status).toBe(200);
    const { attachments } = (await up.json()) as {
      attachments: MembersChatMessage["attachments"];
    };
    const sent = (
      await call(srv, pau, "POST", chat(mia.name), {
        text: "only for mia",
        attachments,
      })
    ).body as MembersChatMessage;
    const file = attachments[0].filename;

    // The two members get the bytes.
    for (const [who, peer] of [
      [pau, mia],
      [mia, pau],
    ] as const) {
      const got = await srv.http(`${chat(peer.id)}/files/${file}`, {
        rawSessionId: who.session,
      });
      expect(got.status).toBe(200);
      expect(await got.text()).toBe("pair secret");
    }

    // The owner names either member: that is the owner's own pair with them,
    // which holds nothing of Pau and Mia's.
    for (const peer of [pau, mia]) {
      const page = await pageOf(srv, nil, peer.id);
      expect(page.messages).toEqual([]);
      expect(
        (
          await srv.http(`${chat(peer.id)}/files/${file}`, {
            rawSessionId: nil.session,
          })
        ).status,
      ).toBe(404);
      for (const [method, path, body] of [
        ["PATCH", `${chat(peer.id)}/${sent.id}`, { text: "hijack" }],
        ["DELETE", `${chat(peer.id)}/${sent.id}`, undefined],
        ["PUT", `${chat(peer.id)}/${sent.id}/thumbs-up`, { active: true }],
      ] as const)
        expect((await call(srv, nil, method, path, body)).status).toBe(404);
    }
    // A reply to their message from the owner's own chat leaks no snapshot.
    const reply = await call(srv, nil, "POST", chat(pau.id), {
      text: "re",
      replyTo: sent.id,
    });
    expect(reply.status).toBe(404);
    expect(JSON.stringify(reply.body)).not.toContain("only for mia");
    // A refused post makes no chat: only Pau and Mia's exists.
    expect(pairDirs(srv).length).toBe(1);

    // Traversal out of the pair's files is a 404, for a member too.
    const traversal = await srv.http(
      `${chat(mia.id)}/files/..%2F..%2Fmembers-chat%2Freads.json`,
      { rawSessionId: pau.session },
    );
    expect(traversal.status).toBe(404);

    // The message is intact.
    expect((await pageOf(srv, mia, pau.id)).messages.map((m) => m.id)).toEqual([
      sent.id,
    ]);
  });

  it("edit and delete are your own only; an owner in the pair cannot delete the peer's", async () => {
    const { srv, nil, pau } = await office();
    const nilWs = await socketOf(srv, nil);
    const pauWs = await socketOf(srv, pau);
    const fromPau = await sayOk(srv, pau, nil.id, "pau's");
    const fromNil = await sayOk(srv, nil, pau.id, "nil's");

    expect(
      (
        await call(srv, nil, "PATCH", `${chat(pau.id)}/${fromPau.id}`, {
          text: "hijack",
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(srv, nil, "DELETE", `${chat(pau.id)}/${fromPau.id}`)).status,
    ).toBe(403);
    expect(
      (await call(srv, pau, "DELETE", `${chat(nil.id)}/${fromNil.id}`)).status,
    ).toBe(403);
    expect(
      (await pageOf(srv, pau, nil.id)).messages.map((m) => m.content).sort(),
    ).toEqual(["nil's", "pau's"]);

    const edited = await call(
      srv,
      pau,
      "PATCH",
      `${chat(nil.id)}/${fromPau.id}`,
      {
        text: "pau's, edited",
      },
    );
    expect(edited.status).toBe(200);
    expect((edited.body as MembersChatMessage).content).toBe("pau's, edited");

    expect(
      (await call(srv, pau, "DELETE", `${chat(nil.id)}/${fromPau.id}`)).status,
    ).toBe(204);
    await waitUntil(
      () =>
        framesOf(nilWs, "dm_deleted").length === 1 &&
        framesOf(pauWs, "dm_deleted").length === 1,
      "both members got the deletion",
    );
    expect(framesOf(nilWs, "dm_deleted")[0]).toMatchObject({
      peerId: pau.id,
      id: fromPau.id,
    });
    expect(framesOf(pauWs, "dm_deleted")[0]).toMatchObject({
      peerId: nil.id,
      id: fromPau.id,
    });
    expect((await pageOf(srv, nil, pau.id)).messages.map((m) => m.id)).toEqual([
      fromNil.id,
    ]);
  });
});

describe("1:1 chats: a read never makes a chat", () => {
  it("page, list, markRead, getFile, edit and delete on a pair with no chat write nothing", async () => {
    const { srv, pau, mia } = await office();
    const page = await pageOf(srv, pau, mia.id);
    expect(page.messages).toEqual([]);
    expect(page.unread).toBe(0);
    expect(await listOf(srv, pau)).toEqual([]);
    const read = await call(srv, pau, "POST", `${chat(mia.id)}/read`, {
      lastReadId: "202611-aaaaaaaa",
    });
    expect(read.status).toBeLessThan(500);
    expect(
      (
        await srv.http(`${chat(mia.id)}/files/notes.txt`, {
          rawSessionId: pau.session,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(srv, pau, "PATCH", `${chat(mia.id)}/202611-aaaaaaaa`, {
          text: "x",
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(srv, pau, "DELETE", `${chat(mia.id)}/202611-aaaaaaaa`))
        .status,
    ).toBe(404);
    expect(pairDirs(srv)).toEqual([]);
    // Neither side lists a chat.
    expect(await listOf(srv, mia)).toEqual([]);

    // The first upload makes it; the post after it adds no second one.
    expect((await upload(srv, pau, mia.id, "a.txt", "a")).status).toBe(200);
    expect(pairDirs(srv).length).toBe(1);
    await sayOk(srv, mia, pau.id, "hi");
    expect(pairDirs(srv).length).toBe(1);
  });
});

describe("1:1 chats: a removed peer", () => {
  async function removeMember(srv: TestServer, owner: Member, name: string) {
    expect(
      (await call(srv, owner, "DELETE", `/api/users/${name}`)).status,
    ).toBe(204);
  }

  it("is read-only for the other member until a restore, and is addressed by id only", async () => {
    const { srv, pushed, nil, pau } = await office();
    const fromNil = await sayOk(srv, nil, pau.name, "before");
    const fromPau = await sayOk(srv, pau, nil.name, "reply");
    await removeMember(srv, nil, pau.name);

    // The history reads; the row says removed.
    expect((await pageOf(srv, nil, pau.id)).messages.map((m) => m.id)).toEqual([
      fromNil.id,
      fromPau.id,
    ]);
    expect(await listOf(srv, nil)).toMatchObject([
      { peerId: pau.id, peerName: pau.name, removed: true },
    ]);
    // A removed name never resolves: two removed members may share one.
    expect((await call(srv, nil, "GET", chat(pau.name))).status).toBe(404);

    // Posting, uploading and reacting wait for a restore.
    const blocked = await say(srv, nil, pau.id, "are you there");
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: { code: "peer_removed" } });
    expect((await upload(srv, nil, pau.id, "x.txt", "x")).status).toBe(409);
    expect(
      (
        await call(srv, nil, "PUT", `${chat(pau.id)}/${fromPau.id}/thumbs-up`, {
          active: true,
        })
      ).status,
    ).toBe(409);
    // Your own messages and the read pointer still work.
    expect(
      (
        await call(srv, nil, "PATCH", `${chat(pau.id)}/${fromNil.id}`, {
          text: "before, edited",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(srv, nil, "POST", `${chat(pau.id)}/read`, {
          lastReadId: fromPau.id,
        })
      ).status,
    ).toBe(200);
    expect(pushed).toEqual([]);

    const restored = await call(
      srv,
      nil,
      "POST",
      `/api/removed-members/${pau.id}/restore`,
      {},
    );
    expect(restored.status).toBe(200);
    expect(getUserByName(pau.name)?.id).toBe(pau.id);
    await sayOk(srv, nil, pau.name, "welcome back");
    expect(await listOf(srv, nil)).toMatchObject([
      { peerId: pau.id, removed: false },
    ]);
  });

  it("stays readable under its old name after the removed record expires", async () => {
    const { srv, nil, pau } = await office();
    const sent = await sayOk(srv, pau, nil.id, "last words");
    await removeMember(srv, nil, pau.name);
    dropRemovedMember(pau.id);

    expect(await listOf(srv, nil)).toMatchObject([
      { peerId: pau.id, peerName: pau.name, removed: true },
    ]);
    expect((await pageOf(srv, nil, pau.id)).messages.map((m) => m.id)).toEqual([
      sent.id,
    ]);
    expect((await say(srv, nil, pau.id, "hello?")).status).toBe(409);
  });

  it("a new member who takes the old name gets a new chat, never the old one", async () => {
    const { srv, nil, pau } = await office();
    const old = await sayOk(srv, pau, nil.id, "old pau");
    await removeMember(srv, nil, pau.name);
    // A removed member keeps the name until the record expires (or Delete
    // now); only then can a new member take it.
    dropRemovedMember(pau.id);
    const second = await srv.seedMember(pau.name);
    const newPau = {
      session: second.rawSessionId,
      name: second.username,
      id: getUserByName(second.username)!.id,
    };
    expect(newPau.id).not.toBe(pau.id);

    // The name now means the new member, whose chat with Nil is empty.
    expect((await pageOf(srv, nil, pau.name)).messages).toEqual([]);
    expect((await pageOf(srv, newPau, nil.id)).messages).toEqual([]);
    const fresh = await sayOk(srv, nil, pau.name, "hi new pau");

    const rows = await listOf(srv, nil);
    expect(rows.length).toBe(2);
    expect(
      rows
        .map((r) => [r.peerId, r.removed])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual(
      [
        [pau.id, true],
        [newPau.id, false],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect((await pageOf(srv, nil, pau.id)).messages.map((m) => m.id)).toEqual([
      old.id,
    ]);
    expect(
      (await pageOf(srv, newPau, nil.id)).messages.map((m) => m.id),
    ).toEqual([fresh.id]);
  });
});

describe("1:1 chats: tokens, packs and agents", () => {
  it("a token needs the directMessages area: membersChat alone stays closed", async () => {
    const { srv, nil, pau } = await office();
    await sayOk(srv, pau, nil.id, "hi");
    const token = async (areas?: Record<string, "read" | "write">) => ({
      bearer: (
        await mintApiToken({
          userId: nil.id,
          name: "Phone",
          expiresInDays: null,
          ...(areas ? { limits: { areas } } : {}),
        })
      ).token,
    });

    const membersOnly = await token({ membersChat: "write" });
    for (const [method, path, body] of [
      ["GET", "/api/member-chats", undefined],
      ["GET", chat(pau.id), undefined],
      ["POST", chat(pau.id), { text: "let me in" }],
    ] as const)
      expect((await call(srv, membersOnly, method, path, body)).status).toBe(
        403,
      );

    const readOnly = await token({ directMessages: "read" });
    expect((await call(srv, readOnly, "GET", chat(pau.id))).status).toBe(200);
    expect((await say(srv, readOnly, pau.id, "no")).status).toBe(403);

    const full = await token();
    const viaToken = await sayOk(srv, full, pau.id, "from my phone");
    expect(viaToken.kind).toBe("api");
    expect(viaToken.userId).toBe(nil.id);
    expect((await pageOf(srv, pau, nil.id)).messages.length).toBe(2);
  });

  it("a member pack without directMessages gets no summaries, frames or routes", async () => {
    const { srv, nil, pau } = await office();
    const room = srv.agentManager.getRooms()[0].id;
    const pack = async (p: MemberPack) =>
      expect(
        (
          await call(srv, nil, "PUT", `/api/users/${pau.name}/access`, {
            allowedRooms: [room],
            pack: p,
          })
        ).status,
      ).toBe(200);

    await pack({ areas: { membersChat: "write" }, agentCeiling: "chat" });
    const pauWs = await socketOf(srv, pau);
    const full = await pauWs.waitFor("full_state");
    expect(full.membersChat).toBeDefined();
    expect("memberDms" in full).toBe(false);
    const sent = await sayOk(srv, nil, pau.id, "behind the pack");
    // Fence: a members chat post, which the pack lets through.
    await call(srv, nil, "POST", "/api/members-chat", { text: "fence" });
    await waitUntil(
      () => framesOf(pauWs, "members_chat_message").length === 1,
      "the fence reached Pau",
    );
    expect(framesOf(pauWs, "dm_message").length).toBe(0);
    expect(JSON.stringify(pauWs.messages)).not.toContain(sent.id);
    expect((await call(srv, pau, "GET", chat(nil.id))).status).toBe(403);

    await pack({
      areas: { membersChat: "write", directMessages: "write" },
      agentCeiling: "chat",
    });
    const opened = await socketOf(srv, pau);
    expect(
      ((await opened.waitFor("full_state")).memberDms as MemberDmSummary[]).map(
        (c) => [c.peerId, c.unread],
      ),
    ).toEqual([[nil.id, 1]]);
  });

  // The ordinary agent, run and app refusals are the capability's, pinned
  // per route in routes-table.test.ts.
  it("a privileged agent reads and posts its member's chats, and the peer sees the member's name", async () => {
    const { srv, nil, pau } = await office();
    const bot = await spawnAgent(srv, "Bot");
    const privileged = { bearer: mintAgentToken(bot.id, nil.id, true) };
    const m = await sayOk(srv, privileged, pau.name, "status: all green");
    expect(m.kind).toBe("agent");
    expect(m.userId).toBe(nil.id);
    expect(m.userName).toBe("Bot");
    expect((await pageOf(srv, pau, nil.id)).messages.map((x) => x.id)).toEqual([
      m.id,
    ]);
    // The peer's name in the summary is the member's, not the agent's.
    expect(await listOf(srv, pau)).toMatchObject([
      { peerId: nil.id, peerName: nil.name },
    ]);
    expect(
      (await listOf(srv, privileged)).map((c) => [c.peerId, c.peerName]),
    ).toEqual([[pau.id, pau.name]]);
  });
});

describe("1:1 chats: push", () => {
  it("a new message pushes to the recipient's devices only; an edit or a reaction pushes nothing", async () => {
    const { srv, pushed, pau, mia } = await office();
    const device = async (who: Member, endpoint: string) =>
      expect(
        (
          await call(srv, who, "POST", `/api/users/${who.name}/push-devices`, {
            endpoint,
            keys: { p256dh: P256DH, auth: AUTH },
          })
        ).status,
      ).toBe(200);
    const PAU = "https://web.push.apple.com/pau-phone";
    const MIA = "https://web.push.apple.com/mia-phone";
    await device(pau, PAU);
    await device(mia, MIA);

    const sent = await sayOk(srv, pau, mia.id, "ping");
    await waitUntil(() => pushed.length === 1, "the first push");
    expect(pushed).toEqual([MIA]);

    expect(
      (
        await call(srv, pau, "PATCH", `${chat(mia.id)}/${sent.id}`, {
          text: "ping!",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(srv, mia, "PUT", `${chat(pau.id)}/${sent.id}/thumbs-up`, {
          active: true,
        })
      ).status,
    ).toBe(200);
    // Fence: Mia's answer pushes to Pau after any push the edit or the
    // reaction would have sent.
    await sayOk(srv, mia, pau.id, "pong");
    await waitUntil(() => pushed.length >= 2, "the second push");
    await Bun.sleep(50);
    expect(pushed).toEqual([MIA, PAU]);
  });
});
