// Room chats (task 5b055cf3) through the real HTTP server: one group chat per
// room at /api/rooms/:roomId/chat, the lobby's being the old members chat.
// What is pinned here is the reach (who reads and posts in which room's chat,
// checked at each request), ownership, the lobby alias and its old state,
// the isolation of one room's chat from another's, the room-scoped events,
// and the read pointer at a room grant. The members chat behaviour (paging,
// pins, reactions, files) stays in routes-members-chat-rest.test.ts.
//
// Seam: startTestServer(). Zero LLM.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getAgentTokenRaw, mintRunToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { acceptInvite } from "../auth.ts";
import { mintMemberLink } from "./member-link.ts";
import { createMembersChatStore } from "../members-chat.ts";
import { LOBBY_ROOM_ID } from "../../shared/types.ts";
import type {
  AgentInfo,
  MembersChatMessage,
  MembersChatSummary,
} from "../../shared/types.ts";
import type {
  ApiTokenCreateRes,
  MembersChatPageRes,
} from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  code?: string;
  body: unknown;
}

// A caller: a cookie session or a bearer token.
type Who = { session: string } | { bearer: string };

async function api(
  srv: TestServer,
  who: Who,
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
    ...("session" in who ? { rawSessionId: who.session } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return {
    status: res.status,
    code: (parsed as { error?: { code?: string } } | null)?.error?.code,
    body: parsed,
  };
}

const chat = (roomId: string, rest = "") =>
  `/api/rooms/${encodeURIComponent(roomId)}/chat${rest}`;

const read = (srv: TestServer, who: Who, roomId: string) =>
  api(srv, who, "GET", chat(roomId));

const post = (srv: TestServer, who: Who, roomId: string, text: string) =>
  api(srv, who, "POST", chat(roomId), { text });

// Posts and returns the message, failing loudly on a refusal.
async function posted(
  srv: TestServer,
  who: Who,
  roomId: string,
  text: string,
): Promise<MembersChatMessage> {
  const res = await post(srv, who, roomId, text);
  expect({ text, status: res.status }).toEqual({ text, status: 201 });
  return res.body as MembersChatMessage;
}

async function pageOf(
  srv: TestServer,
  who: Who,
  roomId: string,
): Promise<MembersChatPageRes> {
  const res = await read(srv, who, roomId);
  expect({ roomId, status: res.status }).toEqual({ roomId, status: 200 });
  return res.body as MembersChatPageRes;
}

const contents = (page: MembersChatPageRes) =>
  page.messages.map((m) => m.content);

// The outcome of a read and a post, for a reach table.
async function reach(
  srv: TestServer,
  who: Who,
  roomId: string,
  label: string,
): Promise<{ read: number; post: number; code?: string }> {
  const r = await read(srv, who, roomId);
  const p = await post(srv, who, roomId, `${label} in ${roomId}`);
  return {
    read: r.status,
    post: p.status,
    ...(p.status >= 400 ? { code: p.code } : {}),
  };
}

const OPEN = { read: 200, post: 201 };
const FORBIDDEN = { read: 403, post: 403, code: "forbidden" };
const NOT_FOUND = { read: 404, post: 404, code: "not_found" };

async function spawn(
  srv: TestServer,
  name: string,
  roomId: string,
  manager?: { username: string; userId: string },
): Promise<AgentInfo> {
  const agent = await srv.agentManager.spawn(
    name,
    srv.workDir,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    manager?.username,
    "claude",
    undefined,
    manager?.userId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

function tokenOf(agentId: string): string {
  const token = getAgentTokenRaw(agentId);
  if (!token) throw new Error(`no live token for ${agentId}`);
  return token;
}

function agentOf(srv: TestServer, id: string): AgentInfo {
  const agent = srv.agentManager.getAllAgents().find((a) => a.id === id);
  if (!agent) throw new Error(`agent ${id} not found`);
  return agent;
}

async function waitUntil(pred: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await Bun.sleep(10);
  }
}

// Morgan owns the office. Mia is a member who reaches room A; Pau is a member
// with no room. Room B is reached by the owner only.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const mia = await srv.seedMember("Mia");
  const pau = await srv.seedMember("Pau");
  srv.agentManager.ensureLobby();
  const roomA = srv.agentManager.createRoom("Alpha");
  const roomB = srv.agentManager.createRoom("Beta");
  const asOwner = { session: owner.rawSessionId };
  const setRooms = async (username: string, allowedRooms: string[]) => {
    const res = await api(
      srv,
      asOwner,
      "PUT",
      `/api/users/${username}/access`,
      { allowedRooms },
    );
    expect({ username, status: res.status }).toEqual({ username, status: 200 });
  };
  await setRooms("Mia", [roomA]);
  return {
    srv,
    roomA,
    roomB,
    setRooms,
    owner: {
      who: asOwner,
      username: owner.username,
      userId: getUserByName(owner.username)!.id,
    },
    mia: {
      who: { session: mia.rawSessionId },
      username: mia.username,
      userId: getUserByName(mia.username)!.id,
    },
    pau: {
      who: { session: pau.rawSessionId },
      username: pau.username,
      userId: getUserByName(pau.username)!.id,
    },
  };
}
type Office = Awaited<ReturnType<typeof office>>;

// Moves an agent with its manager's slider (the real route).
async function setAccess(
  o: Office,
  manager: Who,
  agent: AgentInfo,
  access: "chat" | "office" | "standard" | "privileged",
) {
  const res = await api(
    o.srv,
    manager,
    "PUT",
    `/api/agents/${agent.id}/access`,
    {
      access,
    },
  );
  expect({ agent: agent.name, access, status: res.status }).toEqual({
    agent: agent.name,
    access,
    status: 200,
  });
}

async function mintApiToken(o: Office, who: Who, limits?: unknown) {
  const res = await api(o.srv, who, "POST", "/api/me/api-tokens", {
    name: "Script",
    expiresInDays: 30,
    ...(limits === undefined ? {} : { limits }),
  });
  expect(res.status).toBe(201);
  return (res.body as ApiTokenCreateRes).token;
}

describe("room chat reach: people and API tokens", () => {
  it("the lobby for every member; another room by room access; a room-limited token keeps the lobby", async () => {
    const o = await office();
    const miaToken = await mintApiToken(o, o.mia.who, { rooms: [o.roomA] });
    const table: Array<[string, Who, string, typeof OPEN | typeof FORBIDDEN]> =
      [
        ["owner lobby", o.owner.who, LOBBY_ROOM_ID, OPEN],
        ["owner A", o.owner.who, o.roomA, OPEN],
        ["owner B", o.owner.who, o.roomB, OPEN],
        ["Mia lobby", o.mia.who, LOBBY_ROOM_ID, OPEN],
        ["Mia A", o.mia.who, o.roomA, OPEN],
        ["Mia B", o.mia.who, o.roomB, FORBIDDEN],
        ["Pau lobby", o.pau.who, LOBBY_ROOM_ID, OPEN],
        ["Pau A", o.pau.who, o.roomA, FORBIDDEN],
        ["Mia's room-limited token A", { bearer: miaToken }, o.roomA, OPEN],
        [
          "Mia's room-limited token B",
          { bearer: miaToken },
          o.roomB,
          FORBIDDEN,
        ],
        [
          "Mia's room-limited token lobby",
          { bearer: miaToken },
          LOBBY_ROOM_ID,
          OPEN,
        ],
      ];
    for (const [label, who, roomId, expected] of table)
      expect({ label, ...(await reach(o.srv, who, roomId, label)) }).toEqual({
        label,
        ...expected,
      });
    // The room-limited token keeps the old members chat route too.
    expect(
      (await api(o.srv, { bearer: miaToken }, "GET", "/api/members-chat"))
        .status,
    ).toBe(200);
    // A refused post landed nowhere: B holds the owner's post only.
    expect(contents(await pageOf(o.srv, o.owner.who, o.roomB))).toEqual([
      `owner B in ${o.roomB}`,
    ]);
  });

  it("an unknown room and a closed room are 404, for an owner too; a closed room's files stay", async () => {
    const o = await office();
    const roomC = o.srv.agentManager.createRoom("Gamma");
    await posted(o.srv, o.owner.who, roomC, "before the close");
    const folder = join(o.srv.stateRoot, "room-chats", roomC);
    expect(existsSync(folder)).toBe(true);
    expect(o.srv.agentManager.closeRoom(roomC)).toBe(true);
    for (const [label, roomId] of [
      ["closed", roomC],
      ["unknown", "no-such-room"],
    ] as const)
      expect({
        label,
        ...(await reach(o.srv, o.owner.who, roomId, label)),
      }).toEqual({ label, ...NOT_FOUND });
    expect(existsSync(folder)).toBe(true);
  });

  it("a room's chat folder appears at its first post, not before", async () => {
    const o = await office();
    const folder = join(o.srv.stateRoot, "room-chats", o.roomA);
    await pageOf(o.srv, o.owner.who, o.roomA);
    expect(existsSync(folder)).toBe(false);
    await posted(o.srv, o.owner.who, o.roomA, "first");
    expect(existsSync(folder)).toBe(true);
  });

  it("an office with no lobby room yet still has the lobby chat", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const pau = await srv.seedMember("Pau");
    // The condition: no lobby room exists.
    expect(srv.agentManager.getRooms().map((r) => r.id)).not.toContain(
      LOBBY_ROOM_ID,
    );
    const m = await posted(
      srv,
      { session: owner.rawSessionId },
      LOBBY_ROOM_ID,
      "hi",
    );
    const viaAlias = await api(
      srv,
      { session: pau.rawSessionId },
      "GET",
      "/api/members-chat",
    );
    expect(viaAlias.status).toBe(200);
    expect(
      (viaAlias.body as MembersChatPageRes).messages.map((x) => x.id),
    ).toEqual([m.id]);
  });
});

describe("room chat reach: agents", () => {
  it("an agent that is not privileged reaches only its live room, while its manager reaches it", async () => {
    const o = await office();
    const owner = { username: o.owner.username, userId: o.owner.userId };
    const mia = { username: o.mia.username, userId: o.mia.userId };
    const inA = await spawn(o.srv, "In A", o.roomA, owner);
    const inLobby = await spawn(o.srv, "In lobby", LOBBY_ROOM_ID, owner);
    const miasInA = await spawn(o.srv, "Mia's in A", o.roomA, mia);
    const asInA = { bearer: tokenOf(inA.id) };
    const asMias = { bearer: tokenOf(miasInA.id) };

    const table: Array<[string, Who, string, typeof OPEN | typeof FORBIDDEN]> =
      [
        ["in A, A", asInA, o.roomA, OPEN],
        ["in A, B", asInA, o.roomB, FORBIDDEN],
        // Not in the lobby: the lobby is not its room.
        ["in A, lobby", asInA, LOBBY_ROOM_ID, FORBIDDEN],
        [
          "in lobby, lobby",
          { bearer: tokenOf(inLobby.id) },
          LOBBY_ROOM_ID,
          OPEN,
        ],
        ["in lobby, A", { bearer: tokenOf(inLobby.id) }, o.roomA, FORBIDDEN],
        ["Mia's in A, A", asMias, o.roomA, OPEN],
      ];
    for (const [label, who, roomId, expected] of table)
      expect({ label, ...(await reach(o.srv, who, roomId, label)) }).toEqual({
        label,
        ...expected,
      });
    // The old members chat route is the lobby's: refused out of the lobby.
    expect((await api(o.srv, asInA, "GET", "/api/members-chat")).status).toBe(
      403,
    );

    // The reach follows the live room.
    expect(o.srv.agentManager.moveAgent(inA.id, o.roomB)).toBe(true);
    expect(agentOf(o.srv, inA.id).roomId).toBe(o.roomB);
    expect({
      a: await reach(o.srv, asInA, o.roomA, "moved"),
      b: await reach(o.srv, asInA, o.roomB, "moved"),
    }).toEqual({ a: FORBIDDEN, b: OPEN });

    // Mia loses room A; her agent still sits there but reaches nothing.
    await o.setRooms("Mia", []);
    expect(agentOf(o.srv, miasInA.id).roomId).toBe(o.roomA);
    expect(await reach(o.srv, asMias, o.roomA, "revoked")).toEqual(FORBIDDEN);
  });

  it("an agent with no manager reaches its room only when that room is the lobby", async () => {
    const o = await office();
    const inA = await spawn(o.srv, "Stray in A", o.roomA);
    const inLobby = await spawn(o.srv, "Stray in lobby", LOBBY_ROOM_ID);
    // The condition: neither has a manager.
    expect([inA.userId ?? null, inLobby.userId ?? null]).toEqual([null, null]);
    expect({
      a: await reach(o.srv, { bearer: tokenOf(inA.id) }, o.roomA, "stray"),
      lobby: await reach(
        o.srv,
        { bearer: tokenOf(inLobby.id) },
        LOBBY_ROOM_ID,
        "stray",
      ),
    }).toEqual({ a: FORBIDDEN, lobby: OPEN });
  });

  it("a privileged agent reaches its manager's rooms and the lobby from any room", async () => {
    const o = await office();
    const ownersAgent = await spawn(o.srv, "Owner's aide", o.roomA, {
      username: o.owner.username,
      userId: o.owner.userId,
    });
    await setAccess(o, o.owner.who, ownersAgent, "privileged");
    const miasAgent = await spawn(o.srv, "Mia's aide", o.roomA, {
      username: o.mia.username,
      userId: o.mia.userId,
    });
    await setAccess(o, o.mia.who, miasAgent, "privileged");
    const asOwners = { bearer: tokenOf(ownersAgent.id) };
    const asMias = { bearer: tokenOf(miasAgent.id) };
    const table: Array<[string, Who, string, typeof OPEN | typeof FORBIDDEN]> =
      [
        ["owner's, A", asOwners, o.roomA, OPEN],
        ["owner's, B", asOwners, o.roomB, OPEN],
        ["owner's, lobby", asOwners, LOBBY_ROOM_ID, OPEN],
        ["Mia's, A", asMias, o.roomA, OPEN],
        ["Mia's, B", asMias, o.roomB, FORBIDDEN],
        ["Mia's, lobby", asMias, LOBBY_ROOM_ID, OPEN],
      ];
    for (const [label, who, roomId, expected] of table)
      expect({ label, ...(await reach(o.srv, who, roomId, label)) }).toEqual({
        label,
        ...expected,
      });
    expect((await api(o.srv, asMias, "GET", "/api/members-chat")).status).toBe(
      200,
    );
  });

  it("an agent at Chat has no room chat, and a scheduled run has none", async () => {
    const o = await office();
    const agent = await spawn(o.srv, "Chatter", o.roomA, {
      username: o.owner.username,
      userId: o.owner.userId,
    });
    await setAccess(o, o.owner.who, agent, "chat");
    const run = mintRunToken("job-1", "run-1", o.owner.userId);
    for (const [label, who, roomId] of [
      ["chat stop", { bearer: tokenOf(agent.id) }, o.roomA],
      ["run", { bearer: run }, LOBBY_ROOM_ID],
    ] as const) {
      const r = await reach(o.srv, who, roomId, label);
      expect({ label, read: r.read, post: r.post }).toEqual({
        label,
        read: 403,
        post: 403,
      });
    }
    expect(contents(await pageOf(o.srv, o.owner.who, o.roomA))).toEqual([]);
  });

  it("an agent at Office reads and posts in its room through /mcp, marked limited, and nowhere else", async () => {
    const o = await office();
    const agent = await spawn(o.srv, "Triage", o.roomA, {
      username: o.owner.username,
      userId: o.owner.userId,
    });
    await setAccess(o, o.owner.who, agent, "office");
    await posted(o.srv, o.owner.who, o.roomA, "owner says hi");
    const client = new Client({ name: "room-chat-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${o.srv.baseUrl}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${tokenOf(agent.id)}` },
        },
      }),
    );
    clients.push(client);
    type ToolResult = {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
    };
    const callTool = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as ToolResult;
    const jsonOf = <T>(r: ToolResult): T => {
      const text = (r.content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");
      expect({ isError: !!r.isError, text }).toMatchObject({ isError: false });
      return (r.structuredContent ?? JSON.parse(text)) as T;
    };

    const page = jsonOf<MembersChatPageRes>(
      await callTool("room_chat_read", { roomId: o.roomA }),
    );
    expect(contents(page)).toEqual(["owner says hi"]);
    const mine = jsonOf<MembersChatMessage>(
      await callTool("room_chat_post", {
        roomId: o.roomA,
        text: "on it",
        replyTo: page.messages[0].id,
      }),
    );
    expect({
      kind: mine.kind,
      agentId: mine.agentId,
      limited: mine.limited,
    }).toEqual({ kind: "agent", agentId: agent.id, limited: true });
    // The people see the marker too.
    const seen = (await pageOf(o.srv, o.owner.who, o.roomA)).messages.find(
      (m) => m.id === mine.id,
    );
    expect(seen?.limited).toBe(true);

    for (const roomId of [o.roomB, LOBBY_ROOM_ID]) {
      const refused = await callTool("room_chat_post", {
        roomId,
        text: "elsewhere",
      });
      expect({ roomId, isError: !!refused.isError }).toEqual({
        roomId,
        isError: true,
      });
    }
    expect(contents(await pageOf(o.srv, o.owner.who, o.roomB))).toEqual([]);
  });
});

describe("room chat ownership", () => {
  it("an agent edits and deletes only its own posts; owner reach is for people and privileged agents", async () => {
    const o = await office();
    const owner = { username: o.owner.username, userId: o.owner.userId };
    const agent = await spawn(o.srv, "Helper", o.roomA, owner);
    const sibling = await spawn(o.srv, "Sibling", o.roomA, owner);
    const asAgent = { bearer: tokenOf(agent.id) };
    const asSibling = { bearer: tokenOf(sibling.id) };

    const ownersPost = await posted(o.srv, o.owner.who, o.roomA, "owner");
    const miasPost = await posted(o.srv, o.mia.who, o.roomA, "mia");
    const agentsPost = await posted(o.srv, asAgent, o.roomA, "agent");
    expect({
      kind: agentsPost.kind,
      agentId: agentsPost.agentId,
      userId: agentsPost.userId,
      userName: agentsPost.userName,
      limited: agentsPost.limited,
    }).toEqual({
      kind: "agent",
      agentId: agent.id,
      userId: o.owner.userId,
      userName: "Helper",
      limited: undefined,
    });
    expect({
      agentId: ownersPost.agentId,
      limited: ownersPost.limited,
    }).toEqual({ agentId: undefined, limited: undefined });

    const edit = (who: Who, m: MembersChatMessage, text: string) =>
      api(o.srv, who, "PATCH", chat(o.roomA, `/${m.id}`), { text });
    const del = (who: Who, m: MembersChatMessage) =>
      api(o.srv, who, "DELETE", chat(o.roomA, `/${m.id}`));

    // Not its manager's post, not a sibling's, and no owner reach.
    expect({
      editManager: (await edit(asAgent, ownersPost, "x")).status,
      deleteManager: (await del(asAgent, ownersPost)).status,
      deleteMember: (await del(asAgent, miasPost)).status,
      siblingEdit: (await edit(asSibling, agentsPost, "x")).status,
      siblingDelete: (await del(asSibling, agentsPost)).status,
    }).toEqual({
      editManager: 403,
      deleteManager: 403,
      deleteMember: 403,
      siblingEdit: 403,
      siblingDelete: 403,
    });
    expect(
      (await pageOf(o.srv, o.owner.who, o.roomA)).messages.map((m) => [
        m.id,
        m.content,
      ]),
    ).toEqual([
      [ownersPost.id, "owner"],
      [miasPost.id, "mia"],
      [agentsPost.id, "agent"],
    ]);

    // Its own post: edit, then delete.
    const edited = await edit(asAgent, agentsPost, "agent, edited");
    expect(edited.status).toBe(200);
    expect((edited.body as MembersChatMessage).content).toBe("agent, edited");
    expect((await del(asAgent, agentsPost)).status).toBe(204);

    // The manager may edit what its agent posted, as today.
    const again = await posted(o.srv, asAgent, o.roomA, "agent again");
    expect((await edit(o.owner.who, again, "fixed by Morgan")).status).toBe(
      200,
    );

    // The owner's privileged agent has owner reach: it deletes Mia's post.
    const aide = await spawn(o.srv, "Aide", o.roomA, owner);
    await setAccess(o, o.owner.who, aide, "privileged");
    const aidePost = await posted(
      o.srv,
      { bearer: tokenOf(aide.id) },
      o.roomA,
      "aide",
    );
    expect(aidePost.agentId).toBe(aide.id);
    expect((await del({ bearer: tokenOf(aide.id) }, miasPost)).status).toBe(
      204,
    );
    expect(contents(await pageOf(o.srv, o.owner.who, o.roomA))).not.toContain(
      "mia",
    );
  });

  it("an agent's page carries no read pointer of its manager, and it cannot move one", async () => {
    const o = await office();
    const agent = await spawn(o.srv, "Reader", o.roomA, {
      username: o.owner.username,
      userId: o.owner.userId,
    });
    const asAgent = { bearer: tokenOf(agent.id) };
    const first = await posted(o.srv, o.mia.who, o.roomA, "one");
    await posted(o.srv, o.mia.who, o.roomA, "two");
    // The condition: the manager has unread posts in the room.
    expect((await pageOf(o.srv, o.owner.who, o.roomA)).unread).toBe(2);

    const page = await pageOf(o.srv, asAgent, o.roomA);
    expect(contents(page)).toEqual(["one", "two"]);
    expect({ readPointer: page.readPointer, unread: page.unread }).toEqual({
      readPointer: null,
      unread: 0,
    });
    const marked = await api(o.srv, asAgent, "POST", chat(o.roomA, "/read"), {
      lastReadId: first.id,
    });
    expect(marked.status).toBe(403);
    const managers = await pageOf(o.srv, o.owner.who, o.roomA);
    expect({
      readPointer: managers.readPointer,
      unread: managers.unread,
    }).toEqual({ readPointer: null, unread: 2 });
  });
});

describe("room chat stores", () => {
  it("the lobby chat is the old members chat: its history on disk, both routes, one store", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const ownerId = getUserByName(owner.username)!.id;
    // History an older release wrote to <state>/members-chat.
    const old = createMembersChatStore(join(srv.stateRoot, "members-chat"));
    const oldPost = old.post({
      kind: "user",
      userId: ownerId,
      userName: "Morgan",
      content: "from before room chats",
    });
    old.setPinned(oldPost.id, true);
    const restarted = await srv.restart();
    server = restarted;
    const who = { session: owner.rawSessionId };

    const page = await pageOf(restarted, who, LOBBY_ROOM_ID);
    expect(contents(page)).toEqual(["from before room chats"]);
    expect(page.pinned.map((m) => m.id)).toEqual([oldPost.id]);

    const viaRoom = await posted(restarted, who, LOBBY_ROOM_ID, "via room");
    const viaAlias = await api(restarted, who, "POST", "/api/members-chat", {
      text: "via alias",
    });
    expect(viaAlias.status).toBe(201);
    const aliasPage = (await api(restarted, who, "GET", "/api/members-chat"))
      .body as MembersChatPageRes;
    expect(aliasPage.messages.map((m) => m.id)).toEqual([
      oldPost.id,
      viaRoom.id,
      (viaAlias.body as MembersChatMessage).id,
    ]);
    expect(contents(await pageOf(restarted, who, LOBBY_ROOM_ID))).toEqual([
      "from before room chats",
      "via room",
      "via alias",
    ]);
  });

  it("one room's posts, pins, replies and files are not another's", async () => {
    const o = await office();
    const a = await posted(o.srv, o.owner.who, o.roomA, "in A");
    await posted(o.srv, o.owner.who, o.roomB, "in B");
    expect(
      (
        await api(o.srv, o.owner.who, "PUT", chat(o.roomA, `/${a.id}/pin`), {
          active: true,
        })
      ).status,
    ).toBe(200);
    const pageA = await pageOf(o.srv, o.owner.who, o.roomA);
    const pageB = await pageOf(o.srv, o.owner.who, o.roomB);
    const lobby = await pageOf(o.srv, o.owner.who, LOBBY_ROOM_ID);
    expect({
      a: contents(pageA),
      b: contents(pageB),
      lobby: contents(lobby),
      pinsA: pageA.pinned.length,
      pinsB: pageB.pinned.length,
    }).toEqual({ a: ["in A"], b: ["in B"], lobby: [], pinsA: 1, pinsB: 0 });

    // An id from A is unknown in B: no reply to it, no pin, no edit.
    const replyInB = await api(o.srv, o.owner.who, "POST", chat(o.roomB), {
      text: "reply across rooms",
      replyTo: a.id,
    });
    expect(replyInB.status).toBe(404);
    expect(
      (
        await api(o.srv, o.owner.who, "PATCH", chat(o.roomB, `/${a.id}`), {
          text: "x",
        })
      ).status,
    ).toBe(404);

    // A file uploaded to A is not served from B, nor attachable there.
    const fd = new FormData();
    fd.append(
      "files",
      new File(["alpha bytes"], "a.txt", { type: "text/plain" }),
    );
    const up = await o.srv.http(chat(o.roomA, "/uploads"), {
      method: "POST",
      body: fd,
      rawSessionId: (o.owner.who as { session: string }).session,
    });
    expect(up.status).toBe(200);
    const [file] = (
      (await up.json()) as {
        attachments: Array<{
          filename: string;
          originalName: string;
          mediaType: string;
          size: number;
        }>;
      }
    ).attachments;
    const fromA = await o.srv.http(chat(o.roomA, `/files/${file.filename}`), {
      rawSessionId: (o.owner.who as { session: string }).session,
    });
    expect(fromA.status).toBe(200);
    expect(await fromA.text()).toBe("alpha bytes");
    const fromB = await o.srv.http(chat(o.roomB, `/files/${file.filename}`), {
      rawSessionId: (o.owner.who as { session: string }).session,
    });
    expect(fromB.status).toBe(404);
    const attachInB = await api(o.srv, o.owner.who, "POST", chat(o.roomB), {
      text: "with A's file",
      attachments: [file],
    });
    expect({ status: attachInB.status, code: attachInB.code }).toEqual({
      status: 400,
      code: "unknown_attachment",
    });
  });
});

describe("room chat events", () => {
  const ofType = (s: TestSocket, type: string) =>
    s.messages.filter((m) => (m as { type?: string }).type === type) as Array<
      Record<string, unknown>
    >;
  const roomsOf = (s: TestSocket, type: string) =>
    ofType(s, type).map((m) => m.roomId);

  it("a post or a delete reaches only the sockets that reach the room", async () => {
    const o = await office();
    const miaWs = await o.srv.connectWs(
      (o.mia.who as { session: string }).session,
    );
    const pauWs = await o.srv.connectWs(
      (o.pau.who as { session: string }).session,
    );
    await miaWs.waitFor("full_state");
    await pauWs.waitFor("full_state");

    const inA = await posted(o.srv, o.owner.who, o.roomA, "for A");
    // A marker both reach, sent after: once Pau has it, A's event would have
    // come first.
    await posted(o.srv, o.owner.who, LOBBY_ROOM_ID, "for everyone");
    expect(
      (await api(o.srv, o.owner.who, "DELETE", chat(o.roomA, `/${inA.id}`)))
        .status,
    ).toBe(204);
    await posted(o.srv, o.owner.who, LOBBY_ROOM_ID, "marker after delete");
    await waitUntil(
      () =>
        ofType(miaWs, "room_chat_message").length === 3 &&
        ofType(pauWs, "room_chat_message").length >= 2 &&
        ofType(miaWs, "room_chat_deleted").length === 1,
      "events arrive",
    );
    const aMessage = ofType(miaWs, "room_chat_message")[0];
    expect({
      roomId: aMessage.roomId,
      id: (aMessage.message as MembersChatMessage).id,
    }).toEqual({ roomId: o.roomA, id: inA.id });
    expect(ofType(miaWs, "room_chat_deleted")[0]).toMatchObject({
      roomId: o.roomA,
      id: inA.id,
    });
    expect({
      pauMessages: roomsOf(pauWs, "room_chat_message"),
      pauDeleted: roomsOf(pauWs, "room_chat_deleted"),
    }).toEqual({
      pauMessages: [LOBBY_ROOM_ID, LOBBY_ROOM_ID],
      pauDeleted: [],
    });
    // The old events are gone.
    expect([
      ...ofType(miaWs, "members_chat_message"),
      ...ofType(pauWs, "members_chat_message"),
    ]).toHaveLength(0);
    miaWs.close();
    pauWs.close();
  });

  it("a read marker reaches the reader's other socket with its room", async () => {
    const o = await office();
    const m = await posted(o.srv, o.owner.who, o.roomA, "read me");
    const session = (o.mia.who as { session: string }).session;
    const other = await o.srv.connectWs(session);
    await other.waitFor("full_state");
    const res = await api(o.srv, o.mia.who, "POST", chat(o.roomA, "/read"), {
      lastReadId: m.id,
    });
    expect(res.status).toBe(200);
    const ev = await other.waitFor("room_chat_read");
    expect(ev).toMatchObject({ roomId: o.roomA, readPointer: m.id, unread: 0 });
    other.close();
  });

  it("full_state carries a summary for the lobby and each room the member reaches", async () => {
    const o = await office();
    await posted(o.srv, o.owner.who, o.roomA, "one in A");
    const summariesOf = async (who: Who) => {
      const ws = await o.srv.connectWs((who as { session: string }).session);
      const state = await ws.waitFor("full_state");
      ws.close();
      return (state.roomChats ?? {}) as Record<string, MembersChatSummary>;
    };
    const ownerRooms = [
      LOBBY_ROOM_ID,
      ...o.srv.agentManager.getOrdinaryRooms().map((r) => r.id),
    ].sort();
    const mia = await summariesOf(o.mia.who);
    expect({
      owner: Object.keys(await summariesOf(o.owner.who)).sort(),
      mia: Object.keys(mia).sort(),
      pau: Object.keys(await summariesOf(o.pau.who)).sort(),
    }).toEqual({
      owner: ownerRooms,
      mia: [LOBBY_ROOM_ID, o.roomA].sort(),
      pau: [LOBBY_ROOM_ID],
    });
    expect(mia[o.roomA].unread).toBe(1);
  });
});

describe("room chat read pointer at a grant", () => {
  it("a room newly reached opens with its old posts read; a room reached before keeps its unread", async () => {
    const o = await office();
    await posted(o.srv, o.owner.who, o.roomA, "A one");
    const oldInB = [
      await posted(o.srv, o.owner.who, o.roomB, "B one"),
      await posted(o.srv, o.owner.who, o.roomB, "B two"),
      await posted(o.srv, o.owner.who, o.roomB, "B three"),
    ];
    await o.setRooms("Mia", [o.roomA, o.roomB]);
    const b = await pageOf(o.srv, o.mia.who, o.roomB);
    expect({ readPointer: b.readPointer, unread: b.unread }).toEqual({
      readPointer: oldInB[2].id,
      unread: 0,
    });
    expect((await pageOf(o.srv, o.mia.who, o.roomA)).unread).toBe(1);
    // A new post after the grant is unread.
    await posted(o.srv, o.owner.who, o.roomB, "B four");
    expect((await pageOf(o.srv, o.mia.who, o.roomB)).unread).toBe(1);
  });

  it("a member made an owner opens every newly reached room with its old posts read", async () => {
    const o = await office();
    await posted(o.srv, o.owner.who, o.roomB, "B one");
    await posted(o.srv, o.owner.who, o.roomB, "B two");
    const res = await api(o.srv, o.owner.who, "PATCH", "/api/users/Pau", {
      role: "owner",
    });
    expect(res.status).toBe(200);
    expect(getUserByName("Pau")!.role).toBe("owner");
    expect((await pageOf(o.srv, o.pau.who, o.roomB)).unread).toBe(0);
  });
});

describe("room chat read pointer at a pack change", () => {
  it("a member pack that gains the room chats opens them with their old posts read", async () => {
    const o = await office();
    const setPau = (areas: Record<string, string>) =>
      api(o.srv, o.owner.who, "PUT", "/api/users/Pau/access", {
        allowedRooms: [o.roomA],
        pack: { areas, agentCeiling: "chat" },
      });
    expect((await setPau({ tasks: "read" })).status).toBe(200);
    // The condition: without the area, Pau has no room chat.
    expect((await read(o.srv, o.pau.who, LOBBY_ROOM_ID)).status).toBe(403);
    const old = [
      await posted(o.srv, o.owner.who, LOBBY_ROOM_ID, "lobby one"),
      await posted(o.srv, o.owner.who, LOBBY_ROOM_ID, "lobby two"),
      await posted(o.srv, o.owner.who, o.roomA, "A one"),
    ];
    expect((await setPau({ tasks: "read", membersChat: "read" })).status).toBe(
      200,
    );
    const lobby = await pageOf(o.srv, o.pau.who, LOBBY_ROOM_ID);
    const a = await pageOf(o.srv, o.pau.who, o.roomA);
    expect({
      lobby: [lobby.readPointer, lobby.unread],
      a: [a.readPointer, a.unread],
    }).toEqual({ lobby: [old[1].id, 0], a: [old[2].id, 0] });
  });
});

// Dan Test's case (task 8b8b6001): an owner creates a member with a room
// already granted, so no access change ever seeds a read pointer. The posts
// written before the member existed are not unread for them.
describe("room chat unread for a member created after the posts", () => {
  it("opens the lobby and a room granted at creation with no unread; a later post is unread", async () => {
    const o = await office();
    for (const text of ["lobby one", "lobby two"])
      await posted(o.srv, o.owner.who, LOBBY_ROOM_ID, text);
    await posted(o.srv, o.owner.who, o.roomA, "A one");
    // Post timestamps and createdAt are both Date.now(): keep them apart.
    await Bun.sleep(5);
    const created = await api(o.srv, o.owner.who, "POST", "/api/users", {
      name: "Dana",
      role: "member",
      allowedRooms: [o.roomA],
    });
    expect(created.status).toBe(201);
    const link = await mintMemberLink("Dana");
    const accepted = await acceptInvite(link.rawToken, { userAgent: "test" });
    if (!accepted.ok) throw new Error(`accept failed: ${accepted.error}`);
    const dana: Who = { session: accepted.rawSessionId };

    const ws = await o.srv.connectWs(accepted.rawSessionId);
    const state = await ws.waitFor("full_state");
    ws.close();
    const summaries = (state.roomChats ?? {}) as Record<
      string,
      MembersChatSummary
    >;
    const lobby = await pageOf(o.srv, dana, LOBBY_ROOM_ID);
    const a = await pageOf(o.srv, dana, o.roomA);
    // The condition: the old posts are in Dana's view, and no pointer is set.
    expect({
      lobby: [contents(lobby).length, lobby.readPointer, lobby.unread],
      a: [contents(a).length, a.readPointer, a.unread],
      fullState: {
        lobby: summaries[LOBBY_ROOM_ID]?.unread,
        a: summaries[o.roomA]?.unread,
      },
    }).toEqual({
      lobby: [2, null, 0],
      a: [1, null, 0],
      fullState: { lobby: 0, a: 0 },
    });

    await posted(o.srv, o.owner.who, LOBBY_ROOM_ID, "lobby three");
    await posted(o.srv, o.owner.who, o.roomA, "A two");
    expect({
      lobby: (await pageOf(o.srv, dana, LOBBY_ROOM_ID)).unread,
      a: (await pageOf(o.srv, dana, o.roomA)).unread,
    }).toEqual({ lobby: 1, a: 1 });
  });
});

describe("room chat limited marker", () => {
  // The marker follows the task board's rule (marksTask in
  // server/routes/handlers/tasks.ts): text from an agent below Standard, or
  // from a token whose pack the messaging rule bounds, is data to the agents
  // that read it.
  it("marks a post from a token with a pack, and not one from a token without limits or from a person", async () => {
    const o = await office();
    const packed = await mintApiToken(o, o.owner.who, {
      areas: { agents: "write", membersChat: "write" },
    });
    const full = await mintApiToken(o, o.owner.who);
    const fromPacked = await posted(o.srv, { bearer: packed }, o.roomA, "p");
    const fromFull = await posted(o.srv, { bearer: full }, o.roomA, "f");
    const fromPerson = await posted(o.srv, o.owner.who, o.roomA, "u");
    expect({
      packed: [fromPacked.kind, fromPacked.limited],
      full: [fromFull.kind, fromFull.limited],
      person: [fromPerson.kind, fromPerson.limited],
    }).toEqual({
      packed: ["api", true],
      full: ["api", undefined],
      person: ["user", undefined],
    });
  });
});
