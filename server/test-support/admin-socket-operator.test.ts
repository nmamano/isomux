// Admin socket operator verbs (task 78733adf slice 5a): sign-in-link,
// message and revoke, for an operator who has root on the office's box and no
// browser session. The office starts its own socket with its real deps
// (StartServerOpts.adminSocket), so each case runs through the same wiring as
// production. The peer uid is injected; the server's own uid is refused.

import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { resetStateRoot } from "./temp-state.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  acceptInvite,
  INVITE_TTL_MS,
  listInvites,
  mintInvite,
  peekInvite,
  validateSession,
} from "../auth.ts";
import { STATE_ROOT } from "../config.ts";
import { createMember, getUserByName, updateUserById } from "../users.ts";
import { isRepliesOnlyDevice } from "../../shared/identity.ts";
import type { MemberPack } from "../../shared/pack-fit.ts";
import type { AgentInfo } from "../../shared/types.ts";
import type { ApiTokenCreateRes } from "../../shared/contract-shapes.ts";

const SERVER_UID = process.getuid?.() ?? -1;
const OWNER_TTL_MS = 15 * 60 * 1000;
const VERBS = ["/admin/sign-in-link", "/admin/message", "/admin/revoke"];

let server: TestServer | null = null;
const folders: string[] = [];
afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function freshFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "admin-op-"));
  folders.push(dir);
  return dir;
}

interface Office {
  srv: TestServer;
  peer: { uid: number | null };
  socketPath: string;
}

// An office whose own admin socket answers `peer.uid` (root by default). No
// owner is seeded: each case seeds what it needs.
async function office(): Promise<Office> {
  const peer: { uid: number | null } = { uid: 0 };
  const socketPath = join(freshFolder(), "admin.sock");
  const fakeBackend = new FakeBackend({
    storedSessionState: "durable",
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
  const srv = await startTestServer({
    fakeBackend,
    startServer: {
      adminSocket: { socketPath, readPeerUid: () => peer.uid },
    },
  });
  server = srv;
  // The socket starts in the background boot, after the HTTP listener.
  const deadline = Date.now() + 2_000;
  while (!existsSync(socketPath)) {
    if (Date.now() > deadline) throw new Error("admin socket did not start");
    await Bun.sleep(5);
  }
  return { srv, peer, socketPath };
}

async function admin(
  o: Office,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://localhost${path}`, {
    unix: o.socketPath,
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

const tokenOf = (url: unknown) => String(url).split("/i/")[1];
const idOf = (name: string) => getUserByName(name)!.id;
const liveLinksOf = (name: string) =>
  listInvites().filter((i) => i.username === name);

async function waitUntil(pred: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await Bun.sleep(5);
  }
}

async function auditRows(o: Office, ownerSession: string, operation: string) {
  const res = await o.srv.http("/api/audit-log", {
    rawSessionId: ownerSession,
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    items: { operation: string; targets: string[] }[];
  };
  return json.items
    .filter((row) => row.operation === operation)
    .map((row) => row.targets);
}

// The invites_list frames the socket received after index `from`.
function invitesFramesAfter(
  ws: { messages: unknown[] },
  from: number,
): { invites: { tokenPrefix: string; username: string }[] }[] {
  return ws.messages
    .slice(from)
    .filter((m) => (m as { type?: string }).type === "invites_list") as {
    invites: { tokenPrefix: string; username: string }[];
  }[];
}

// Morgan's agent, idle after one turn, in the first room.
async function ownedAgent(
  o: Office,
  name: string,
  owner: { name: string; id: string },
): Promise<AgentInfo> {
  const room = o.srv.agentManager.getRooms()[0].id;
  const agent = await o.srv.agentManager.spawn(
    name,
    freshFolder(),
    "default",
    undefined,
    undefined,
    room,
    undefined,
    undefined,
    undefined,
    owner.name,
    "claude",
    undefined,
    owner.id,
  );
  if (!agent) throw new Error("spawn failed");
  return agent;
}

const sentTo = (o: Office, agentId: string) =>
  o.srv.fakeBackend.sessionForAgent(agentId)?.sent.map((m) => m.text) ?? [];

describe("admin socket operator verbs: callers", () => {
  it("refuses the server's own uid on each verb and changes nothing", async () => {
    const o = await office();
    const owner = await o.srv.seedOwner("Morgan");
    const before = listInvites().length;
    o.peer.uid = SERVER_UID;
    for (const path of VERBS) {
      const res = await admin(o, path, {
        name: "Morgan",
        agent: "x",
        text: "continue",
      });
      expect({ path, status: res.status, ok: res.body.ok }).toEqual({
        path,
        status: 403,
        ok: false,
      });
    }
    expect(listInvites().length).toBe(before);
    expect(validateSession(owner.rawSessionId)).not.toBeNull();
  });
});

describe("POST /admin/sign-in-link", () => {
  it("mints a live 15-minute owner link and a 3-day link for a member who never signed in", async () => {
    const o = await office();
    await o.srv.seedOwner("Morgan");
    expect(createMember("Pat", { role: "member" }).ok).toBe(true);

    const ownerLink = await admin(o, "/admin/sign-in-link", { name: "Morgan" });
    expect(ownerLink.status).toBe(200);
    expect(ownerLink.body).toMatchObject({
      ok: true,
      role: "owner",
      ttlMs: OWNER_TTL_MS,
    });
    const [ownerRow] = liveLinksOf("Morgan");
    expect(ownerRow.expiresAt - ownerRow.createdAt).toBe(OWNER_TTL_MS);
    expect(ownerLink.body.expiresAt).toBe(ownerRow.expiresAt);

    const memberLink = await admin(o, "/admin/sign-in-link", { name: "Pat" });
    expect(memberLink.status).toBe(200);
    expect(memberLink.body).toMatchObject({
      ok: true,
      role: "member",
      ttlMs: INVITE_TTL_MS,
    });
    const [memberRow] = liveLinksOf("Pat");
    expect(memberRow.expiresAt - memberRow.createdAt).toBe(INVITE_TTL_MS);
    // The link signs the member in.
    const accepted = await acceptInvite(tokenOf(memberLink.body.url), {
      userAgent: "test",
    });
    expect(accepted.ok && accepted.username).toBe("Pat");
  });

  it("replaces the user's earlier unused link, shows the change in an open Invites pane, and audits it", async () => {
    const o = await office();
    const owner = await o.srv.seedOwner("Morgan");
    expect(createMember("Pat", { role: "member" }).ok).toBe(true);
    const earlier = await mintInvite({
      userId: idOf("Pat"),
      createdBy: "Morgan",
      ttlMs: INVITE_TTL_MS,
    });
    if (!earlier.ok) throw new Error("mint failed");
    const ws = await o.srv.connectWs(owner.rawSessionId);
    const from = ws.messages.length;

    const res = await admin(o, "/admin/sign-in-link", { name: "Pat" });
    expect(res.status).toBe(200);
    expect("error" in peekInvite(earlier.rawToken)).toBe(true);
    const live = liveLinksOf("Pat");
    expect(live.length).toBe(1);
    expect("error" in peekInvite(tokenOf(res.body.url))).toBe(false);

    await waitUntil(
      () => invitesFramesAfter(ws, from).length > 0,
      "invites_list after the mint",
    );
    const frames = invitesFramesAfter(ws, from);
    const shown = frames[frames.length - 1].invites
      .filter((i) => i.username === "Pat")
      .map((i) => i.tokenPrefix);
    expect(shown).toEqual([live[0].tokenPrefix]);
    ws.close();

    expect(await auditRows(o, owner.rawSessionId, "admin.signInLink")).toEqual([
      [idOf("Pat")],
    ]);
  });

  it("answers 404 for an unknown name and 400 before the office has an owner", async () => {
    const o = await office();
    expect(createMember("Pat", { role: "member" }).ok).toBe(true);
    const unclaimed = await admin(o, "/admin/sign-in-link", { name: "Pat" });
    expect(unclaimed.status).toBe(400);
    expect(liveLinksOf("Pat").length).toBe(0);

    await o.srv.seedOwner("Morgan");
    const unknown = await admin(o, "/admin/sign-in-link", { name: "Nobody" });
    expect(unknown.status).toBe(404);
    expect(listInvites().length).toBe(0);
  });
});

describe("POST /admin/message", () => {
  it("sends as the agent's current manager, from a device that is not the data marker, and audits it", async () => {
    const o = await office();
    const owner = await o.srv.seedOwner("Morgan");
    const casey = await o.srv.seedMember("Casey");
    const room = o.srv.agentManager.getRooms()[0].id;
    const access = await o.srv.http(`/api/users/Casey/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRooms: [room] }),
      rawSessionId: owner.rawSessionId,
    });
    expect(access.status).toBe(200);
    const agent = await ownedAgent(o, "Helper", {
      name: "Morgan",
      id: idOf("Morgan"),
    });
    // The manager changes after the spawn: the message is from Casey.
    const moved = await o.srv.http(`/api/agents/${agent.id}/manager`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: idOf("Casey") }),
      rawSessionId: owner.rawSessionId,
    });
    expect(moved.status).toBe(200);
    expect(o.srv.agentManager.getAgent(agent.id)?.userId).toBe(idOf("Casey"));
    // Then Casey is renamed: the agent keeps a stale name snapshot, and the
    // message names the manager as they are called now.
    const caseyId = idOf("Casey");
    expect(updateUserById(caseyId, { name: "Cass" }).ok).toBe(true);
    expect(o.srv.agentManager.getAgent(agent.id)?.manager).toBe("Casey");

    const res = await admin(o, "/admin/message", {
      agent: agent.id,
      text: "continue after the move",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, agentId: agent.id });
    await waitUntil(
      () => sentTo(o, agent.id).some((t) => t.includes("continue after")),
      "the message reaches the agent",
    );
    const text = sentTo(o, agent.id).find((t) => t.includes("continue after"))!;
    const label = text.slice(0, text.indexOf("continue after the move"));
    const match = /\[(\w+) \(([^)]+)\)\] $/.exec(label);
    expect(match?.[1]).toBe("Cass");
    expect(match?.[2]).toBeDefined();
    expect(isRepliesOnlyDevice(match![2])).toBe(false);
    expect(validateSession(casey.rawSessionId)).not.toBeNull();

    expect(await auditRows(o, owner.rawSessionId, "admin.message")).toEqual([
      [agent.id],
    ]);
  });

  // An agent with no manager exists only in legacy state (spawn always sets
  // one), and agent names are unique in the office (shared/office-state.ts),
  // so neither has a case here.
  it("finds an agent by its name, and refuses an unknown name and an empty text", async () => {
    const o = await office();
    await o.srv.seedOwner("Morgan");
    const morgan = { name: "Morgan", id: idOf("Morgan") };
    const solo = await ownedAgent(o, "Solo", morgan);
    const other = await ownedAgent(o, "Other", morgan);

    const byName = await admin(o, "/admin/message", {
      agent: "Solo",
      text: "hello",
    });
    expect({ status: byName.status, agentId: byName.body.agentId }).toEqual({
      status: 200,
      agentId: solo.id,
    });
    await waitUntil(
      () => sentTo(o, solo.id).some((t) => t.includes("hello")),
      "Solo got the message",
    );

    const unknown = await admin(o, "/admin/message", {
      agent: "Nobody",
      text: "hello",
    });
    expect(unknown.status).toBe(404);

    const empty = await admin(o, "/admin/message", {
      agent: solo.id,
      text: "  ",
    });
    expect(empty.status).toBe(400);
    expect(sentTo(o, other.id).some((t) => t.includes("hello"))).toBe(false);
  });

  it("never answers a prompt that waits for the member", async () => {
    const o = await office();
    const owner = await o.srv.seedOwner("Morgan");
    const agent = await ownedAgent(o, "Helper", {
      name: "Morgan",
      id: idOf("Morgan"),
    });
    const opened = await o.srv.http(`/api/agents/${agent.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "/model" }),
      rawSessionId: owner.rawSessionId,
    });
    expect(opened.status).toBe(200);
    const pending = () =>
      o.srv.agentManager
        .getPendingInteractions()
        .filter((item) => item.agentId === agent.id);
    await waitUntil(() => pending().length === 1, "the /model picker opens");
    const before = sentTo(o, agent.id).length;

    const res = await admin(o, "/admin/message", {
      agent: agent.id,
      text: "1",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("awaits_member_answer");
    expect(pending().length).toBe(1);
    expect(sentTo(o, agent.id).length).toBe(before);
  });

  it("keeps a pack member manager's limits on a command", async () => {
    const o = await office();
    const owner = await o.srv.seedOwner("Morgan");
    await o.srv.seedMember("Casey");
    const room = o.srv.agentManager.getRooms()[0].id;
    const setPack = async (areas: MemberPack["areas"]) => {
      const pack: MemberPack = { areas, agentCeiling: "chat" };
      const res = await o.srv.http(`/api/users/Casey/access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedRooms: [room], pack }),
        rawSessionId: owner.rawSessionId,
      });
      expect(res.status).toBe(200);
      expect(getUserByName("Casey")?.pack).toEqual(pack);
    };
    await setPack({ agents: "write", logs: "read" });
    const agent = await ownedAgent(o, "Helper", {
      name: "Casey",
      id: idOf("Casey"),
    });
    const lowered = await o.srv.http(`/api/agents/${agent.id}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access: "chat" }),
      rawSessionId: owner.rawSessionId,
    });
    expect(lowered.status).toBe(200);
    expect(o.srv.agentManager.getAgent(agent.id)?.userId).toBe(idOf("Casey"));

    // /rename (it sets the topic) needs agentManagement write, which Casey's
    // pack lacks.
    const refused = await admin(o, "/admin/message", {
      agent: agent.id,
      text: "/rename first try",
    });
    expect({ status: refused.status, code: refused.body.code }).toEqual({
      status: 403,
      code: "forbidden",
    });

    // With the area in the pack, the same command runs: the refusal above is
    // the pack, not the socket.
    await setPack({ agents: "write", logs: "read", agentManagement: "write" });
    const allowed = await admin(o, "/admin/message", {
      agent: agent.id,
      text: "/rename second try",
    });
    expect(allowed.status).toBe(200);
    await waitUntil(
      () => o.srv.agentManager.getAgent(agent.id)?.topic === "second try",
      "the rename runs",
    );
    // The refused command left no trace: no echo in the chat.
    const echoes = (text: string) =>
      o.srv.agentManager
        .getAgentLogs(agent.id)
        .filter((e) => e.kind === "user_message" && e.content === text).length;
    expect(echoes("/rename second try")).toBe(1);
    expect(echoes("/rename first try")).toBe(0);
  });
});

describe("POST /admin/revoke", () => {
  it("signs out every device of the last owner and removes their links, with no last-owner guard", async () => {
    const o = await office();
    const owner = await o.srv.seedOwner("Morgan");
    const casey = await o.srv.seedMember("Casey");
    const second = await mintInvite({
      userId: idOf("Morgan"),
      createdBy: "(admin-cli)",
      ttlMs: OWNER_TTL_MS,
    });
    if (!second.ok) throw new Error("mint failed");
    const laptop = await acceptInvite(second.rawToken, { userAgent: "test" });
    if (!laptop.ok) throw new Error("accept failed");
    const pending = await mintInvite({
      userId: idOf("Morgan"),
      createdBy: "(admin-cli)",
      ttlMs: OWNER_TTL_MS,
    });
    if (!pending.ok) throw new Error("mint failed");
    const ws = await o.srv.connectWs(owner.rawSessionId);

    const res = await admin(o, "/admin/revoke", { name: "Morgan" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sessions: 2, links: 1 });
    expect(validateSession(owner.rawSessionId)).toBeNull();
    expect(validateSession(laptop.rawSessionId)).toBeNull();
    expect("error" in peekInvite(pending.rawToken)).toBe(true);
    await waitUntil(
      () => ws.raw.readyState === WebSocket.CLOSED,
      "the owner's socket closes",
    );
    // Nobody else is signed out.
    expect(validateSession(casey.rawSessionId)).not.toBeNull();

    // Root signs the owner in again at once.
    const link = await admin(o, "/admin/sign-in-link", { name: "Morgan" });
    expect(link.status).toBe(200);
    const back = await acceptInvite(tokenOf(link.body.url), {
      userAgent: "test",
    });
    expect(back.ok).toBe(true);
  });

  it("leaves the member's API tokens working and counts them, shows the removed link in an open Invites pane, and audits it", async () => {
    const o = await office();
    const owner = await o.srv.seedOwner("Morgan");
    const casey = await o.srv.seedMember("Casey");
    const minted = await o.srv.http("/api/me/api-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Script", expiresInDays: null }),
      rawSessionId: casey.rawSessionId,
    });
    expect(minted.status).toBe(201);
    const token = ((await minted.json()) as ApiTokenCreateRes).token;
    const withToken = () =>
      fetch(`${o.srv.baseUrl}/agents`, {
        headers: { Authorization: `Bearer ${token}`, Connection: "close" },
      });
    expect((await withToken()).status).toBe(200);
    const link = await mintInvite({
      userId: idOf("Casey"),
      createdBy: "Morgan",
      ttlMs: INVITE_TTL_MS,
    });
    expect(link.ok).toBe(true);
    const ws = await o.srv.connectWs(owner.rawSessionId);
    const from = ws.messages.length;

    const res = await admin(o, "/admin/revoke", { name: "Casey" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      sessions: 1,
      links: 1,
      apiTokens: 1,
    });
    expect(validateSession(casey.rawSessionId)).toBeNull();
    expect((await withToken()).status).toBe(200);
    expect(validateSession(owner.rawSessionId)).not.toBeNull();

    await waitUntil(
      () => invitesFramesAfter(ws, from).length > 0,
      "invites_list after the revoke",
    );
    const frames = invitesFramesAfter(ws, from);
    expect(
      frames[frames.length - 1].invites.filter((i) => i.username === "Casey")
        .length,
    ).toBe(0);
    ws.close();

    expect(await auditRows(o, owner.rawSessionId, "admin.revoke")).toEqual([
      [idOf("Casey")],
    ]);
  });

  it("ends the sessions now, still removes the links, and answers 500 when the sessions file cannot be written", async () => {
    const o = await office();
    await o.srv.seedOwner("Morgan");
    const casey = await o.srv.seedMember("Casey");
    const link = await mintInvite({
      userId: idOf("Casey"),
      createdBy: "Morgan",
      ttlMs: INVITE_TTL_MS,
    });
    if (!link.ok) throw new Error("mint failed");
    const ws = await o.srv.connectWs(casey.rawSessionId);
    // A folder where the write puts its temp file: the write fails, the file
    // on disk keeps the session.
    const blocker = join(STATE_ROOT, "sessions.json.tmp");
    mkdirSync(blocker);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    let res: { status: number; body: Record<string, unknown> };
    try {
      res = await admin(o, "/admin/revoke", { name: "Casey" });
    } finally {
      errors.mockRestore();
      rmSync(blocker, { recursive: true, force: true });
    }
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, sessions: 1 });
    // Fail closed: the session is gone from memory and the socket closes, and
    // the links go too: a live link would sign the person in again.
    expect(validateSession(casey.rawSessionId)).toBeNull();
    expect("error" in peekInvite(link.rawToken)).toBe(true);
    await waitUntil(
      () => ws.raw.readyState === WebSocket.CLOSED,
      "Casey's socket closes",
    );
  });

  it("answers 500 and keeps the link when the invites file cannot be written, after the sessions end", async () => {
    const o = await office();
    await o.srv.seedOwner("Morgan");
    const casey = await o.srv.seedMember("Casey");
    const link = await mintInvite({
      userId: idOf("Casey"),
      createdBy: "Morgan",
      ttlMs: INVITE_TTL_MS,
    });
    if (!link.ok) throw new Error("mint failed");
    const blocker = join(STATE_ROOT, "invites.json.tmp");
    mkdirSync(blocker);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    let res: { status: number; body: Record<string, unknown> };
    try {
      res = await admin(o, "/admin/revoke", { name: "Casey" });
    } finally {
      errors.mockRestore();
      rmSync(blocker, { recursive: true, force: true });
    }
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(validateSession(casey.rawSessionId)).toBeNull();
    expect("error" in peekInvite(link.rawToken)).toBe(false);
  });
});

// Later files in the same bun process: none of this file's members or their
// files on disk (task 3a93528c).
afterAll(() => resetStateRoot(STATE_ROOT));
