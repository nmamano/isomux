// The desktop sidebar's Pinned and Recent agent lists (task 5dac6b9b): two
// private fields of the member's record. Pinned is written through
// PUT /api/me/view/pinned and also holds pinned members (task b2889127);
// Recent moves when the member's own session sends a
// message to an agent. Both ride only the private record channels and survive
// a reboot. Driven through the real HTTP server, auth and users store.

import { afterEach, describe, expect, it } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { deleteUserById, getUserByName, getUserById } from "../users.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { mintApiToken } from "../api-tokens.ts";
import { PINNED_AGENTS_MAX } from "../sidebar-agents.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Frame = Record<string, unknown>;
const bagLen = (sock: TestSocket, type: string): number =>
  (sock.messages as Frame[]).filter((m) => m.type === type).length;

// A pong answers a ping sent after the write returned, so every frame the
// write sent to that socket arrived before it.
async function fence(...socks: TestSocket[]): Promise<void> {
  for (const sock of socks) {
    const before = bagLen(sock, "pong");
    sock.send({ type: "ping" });
    const deadline = Date.now() + 2000;
    while (bagLen(sock, "pong") <= before) {
      if (Date.now() > deadline) throw new Error("no pong");
      await sleep(5);
    }
  }
}

const framesAfter = (sock: TestSocket, mark: number): Frame[] =>
  (sock.messages as Frame[]).slice(mark).filter((m) => m.type !== "pong");

// waitFor matches any frame already in the bag; this one only frames after
// `mark`.
async function waitAfter(
  sock: TestSocket,
  mark: number,
  type: string,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!framesAfter(sock, mark).some((m) => m.type === type)) {
    if (Date.now() > deadline) throw new Error(`no ${type} after ${mark}`);
    await sleep(5);
  }
}

async function connectSettled(
  srv: TestServer,
  rawSessionId: string,
): Promise<TestSocket> {
  const sock = await srv.connectWs(rawSessionId);
  await sock.waitFor("presence_list");
  await sock.waitFor("provider_accounts_updated");
  return sock;
}

type World = {
  srv: TestServer;
  owner: { rawSessionId: string; id: string; username: string };
  member: { rawSessionId: string; id: string; username: string };
  agents: AgentInfo[];
};

// Every turn parks (no turn_completed), so a second send to the same agent is
// queued: a queued send is an accepted send too.
async function setup(names: string[]): Promise<World> {
  const srv = await startTestServer({
    fakeBackend: new FakeBackend({
      storedSessionState: "missing",
      session: {
        onSend: (_t, _a, s) => s.push({ kind: "assistant_text", text: "..." }),
      },
    }),
  });
  server = srv;
  const o = await srv.seedOwner("Morgan");
  const m = await srv.seedMember("Mia");
  const ownerId = getUserByName(o.username)!.id;
  const memberId = getUserByName(m.username)!.id;
  const room = srv.agentManager.getRooms()[0].id;
  const agents: AgentInfo[] = [];
  for (const name of names) {
    const a = await srv.agentManager.spawn(
      name,
      srv.workDir,
      "default",
      undefined,
      undefined,
      room,
      undefined,
      undefined,
      undefined,
      o.username,
      "claude",
      undefined,
      ownerId,
    );
    if (!a) throw new Error(`spawn ${name} failed`);
    agents.push(a);
  }
  return {
    srv,
    owner: { rawSessionId: o.rawSessionId, id: ownerId, username: o.username },
    member: {
      rawSessionId: m.rawSessionId,
      id: memberId,
      username: m.username,
    },
    agents,
  };
}

async function putPinned(
  srv: TestServer,
  rawSessionId: string,
  body: unknown,
): Promise<Response> {
  return srv.http("/api/me/view/pinned", {
    method: "PUT",
    rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function send(
  srv: TestServer,
  agentId: string,
  auth: { rawSessionId: string } | { bearer: string },
): Promise<void> {
  const res = await srv.http(`/api/agents/${agentId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...("bearer" in auth ? { Authorization: `Bearer ${auth.bearer}` } : {}),
    },
    body: JSON.stringify({ text: "hello" }),
    ...("rawSessionId" in auth ? { rawSessionId: auth.rawSessionId } : {}),
  });
  // Every send below is accepted: an unchanged Recent list is the rule
  // under test, never a refused send.
  expect(res.status).toBe(200);
}

const recentOf = (userId: string) => getUserById(userId)!.recentAgents ?? [];
const pinnedOf = (userId: string) => getUserById(userId)!.pinnedAgents ?? [];

describe("view.setPinned (task 5dac6b9b)", () => {
  it("stores the member's full list in order: dedupes (first place wins), drops unknown ids, unpin is a shorter list", async () => {
    const w = await setup(["A", "B", "C"]);
    const [a, b, c] = w.agents.map((x) => x.id);

    const first = await putPinned(w.srv, w.member.rawSessionId, {
      pinned: [c, a, c, "no-such-agent", b],
    });
    expect(first.status).toBe(204);
    expect(pinnedOf(w.member.id)).toEqual([c, a, b]);
    // Per member: the owner's list is untouched.
    expect(pinnedOf(w.owner.id)).toEqual([]);

    expect(
      (await putPinned(w.srv, w.member.rawSessionId, { pinned: [b, c] }))
        .status,
    ).toBe(204);
    expect(pinnedOf(w.member.id)).toEqual([b, c]);
    // Unpinning the last one empties the list.
    expect(
      (await putPinned(w.srv, w.member.rawSessionId, { pinned: [] })).status,
    ).toBe(204);
    expect(pinnedOf(w.member.id)).toEqual([]);
  });

  // Task b2889127 (Nil, 2026-11-12: "pinning makes sense"): a member pins
  // another member as the key "member:<userId>" in the same list, mixed with
  // agent ids in one order.
  it("keeps member:<userId> for another member that exists, in the list's order; drops self, unknown and removed members", async () => {
    const w = await setup(["A", "B"]);
    const [a, b] = w.agents.map((x) => x.id);
    const ola = getUserByName((await w.srv.seedMember("Ola")).username)!.id;
    const gone = getUserByName((await w.srv.seedMember("Gus")).username)!.id;
    expect(deleteUserById(gone)).toBe(true);

    const res = await putPinned(w.srv, w.member.rawSessionId, {
      pinned: [
        `member:${ola}`,
        a,
        `member:${w.member.id}`,
        `member:${w.owner.id}`,
        "member:no-such-user",
        `member:${gone}`,
        "member:",
        `member:${ola}`,
        b,
      ],
    });
    expect(res.status).toBe(204);
    expect(pinnedOf(w.member.id)).toEqual([
      `member:${ola}`,
      a,
      `member:${w.owner.id}`,
      b,
    ]);
    // A bare user id is not a member pin, and member:<agentId> is not an
    // agent pin.
    expect(
      (
        await putPinned(w.srv, w.member.rawSessionId, {
          pinned: [ola, `member:${a}`, b],
        })
      ).status,
    ).toBe(204);
    expect(pinnedOf(w.member.id)).toEqual([b]);
  });

  it("refuses a malformed or oversized list with 422 and keeps the stored list", async () => {
    const w = await setup(["A", "B"]);
    const [a, b] = w.agents.map((x) => x.id);
    await putPinned(w.srv, w.member.rawSessionId, { pinned: [a] });
    expect(pinnedOf(w.member.id)).toEqual([a]);

    const oversized = Array.from({ length: PINNED_AGENTS_MAX + 1 }, (_, i) =>
      i === 0 ? b : `x-${i}`,
    );
    for (const [body, code] of [
      [{ pinned: a }, "invalid_pinned"],
      [{ pinned: [b, 7] }, "invalid_pinned"],
      [{}, "invalid_pinned"],
      [{ pinned: oversized }, "too_many_pinned"],
    ] as const) {
      const res = await putPinned(w.srv, w.member.rawSessionId, body);
      expect(res.status).toBe(422);
      expect(
        ((await res.json()) as { error?: { code?: string } }).error?.code,
      ).toBe(code);
      expect(pinnedOf(w.member.id)).toEqual([a]);
    }
    // The bound itself is accepted (unknown ids then drop).
    const atBound = oversized.slice(0, PINNED_AGENTS_MAX);
    expect(
      (await putPinned(w.srv, w.member.rawSessionId, { pinned: atBound }))
        .status,
    ).toBe(204);
    expect(pinnedOf(w.member.id)).toEqual([b]);
  });

  it("sends the member's own record and the owners' admin record, no full_state and nothing to other members", async () => {
    const w = await setup(["A"]);
    const [a] = w.agents.map((x) => x.id);
    const other = await w.srv.seedMember("Ola");
    const sock = await connectSettled(w.srv, w.member.rawSessionId);
    const otherSock = await connectSettled(w.srv, other.rawSessionId);
    const ownerSock = await connectSettled(w.srv, w.owner.rawSessionId);
    const marks = [sock, otherSock, ownerSock].map((s) => s.messages.length);

    expect(
      (await putPinned(w.srv, w.member.rawSessionId, { pinned: [a] })).status,
    ).toBe(204);
    await waitAfter(ownerSock, marks[2], "user_admin_updated");
    await fence(sock, otherSock, ownerSock);

    const selfNew = framesAfter(sock, marks[0]);
    expect(selfNew.map((m) => m.type)).toEqual(["user_self_updated"]);
    expect((selfNew[0].user as Frame).pinnedAgents).toEqual([a]);
    expect(framesAfter(otherSock, marks[1])).toEqual([]);
    const ownerNew = framesAfter(ownerSock, marks[2]);
    expect(ownerNew.map((m) => m.type)).toEqual(["user_admin_updated"]);
    expect((ownerNew[0].user as Frame).pinnedAgents).toEqual([a]);
  });
});

describe("the Recent list (task 5dac6b9b)", () => {
  it("moves the agent the member's session sends to to the front, newest first, deduped; a queued send counts", async () => {
    const w = await setup(["A", "B", "C"]);
    const [a, b, c] = w.agents.map((x) => x.id);
    const me = { rawSessionId: w.owner.rawSessionId };

    await send(w.srv, a, me);
    expect(recentOf(w.owner.id)).toEqual([a]);
    await send(w.srv, b, me);
    await send(w.srv, c, me);
    expect(recentOf(w.owner.id)).toEqual([c, b, a]);
    // A is mid-turn (turns park), so this send is queued: it still counts.
    await send(w.srv, a, me);
    expect(recentOf(w.owner.id)).toEqual([a, c, b]);
  });

  it("a send to the agent already first writes and emits nothing; a change emits only on the private channels", async () => {
    const w = await setup(["A", "B"]);
    const [a, b] = w.agents.map((x) => x.id);
    const other = await w.srv.seedMember("Ola");
    const sock = await connectSettled(w.srv, w.owner.rawSessionId);
    const otherSock = await connectSettled(w.srv, other.rawSessionId);
    const me = { rawSessionId: w.owner.rawSessionId };

    // Enabling case: a change sends the self record with the new list.
    let mark = sock.messages.length;
    let otherMark = otherSock.messages.length;
    await send(w.srv, a, me);
    await waitAfter(sock, mark, "user_self_updated");
    await fence(sock, otherSock);
    const changed = framesAfter(sock, mark).filter(
      (m) => m.type === "user_self_updated",
    );
    expect(changed.length).toBe(1);
    expect((changed[0].user as Frame).recentAgents).toEqual([a]);
    expect(
      framesAfter(otherSock, otherMark).filter((m) =>
        String(m.type).startsWith("user_"),
      ).length,
    ).toBe(0);

    // The same agent again: the list does not change, so no record frame.
    mark = sock.messages.length;
    otherMark = otherSock.messages.length;
    await send(w.srv, a, me);
    await fence(sock, otherSock);
    expect(
      framesAfter(sock, mark).filter(
        (m) =>
          m.type === "user_self_updated" || m.type === "user_admin_updated",
      ).length,
    ).toBe(0);
    expect(framesAfter(otherSock, otherMark)).toEqual([]);
    expect(recentOf(w.owner.id)).toEqual([a]);

    // And a later change still emits (the no-op did not stop the channel).
    mark = sock.messages.length;
    await send(w.srv, b, me);
    await waitAfter(sock, mark, "user_self_updated");
    await fence(sock);
    const again = framesAfter(sock, mark).filter(
      (m) => m.type === "user_self_updated",
    );
    expect(again.length).toBe(1);
    expect((again[0].user as Frame).recentAgents).toEqual([b, a]);
  });

  it("only a member's own session counts: an agent token and an API token acting for that member leave the list as it was", async () => {
    const w = await setup(["A", "B", "C"]);
    const [a, b, c] = w.agents.map((x) => x.id);
    await send(w.srv, a, { rawSessionId: w.owner.rawSessionId });
    expect(recentOf(w.owner.id)).toEqual([a]);

    // Agent A (managed by the owner) messages B with its own token.
    await send(w.srv, b, { bearer: mintAgentToken(a, w.owner.id) });
    // The owner's API token (a script) messages C.
    const api = await mintApiToken({
      userId: w.owner.id,
      name: "Script",
      expiresInDays: 30,
    });
    await send(w.srv, c, { bearer: api.token });
    expect(recentOf(w.owner.id)).toEqual([a]);

    // The member's own session still moves it (the rule did not just stop).
    await send(w.srv, c, { rawSessionId: w.owner.rawSessionId });
    expect(recentOf(w.owner.id)).toEqual([c, a]);
  });

  it("the next change drops the ids of agents that no longer exist", async () => {
    const w = await setup(["A", "B", "C"]);
    const [a, b, c] = w.agents.map((x) => x.id);
    const me = { rawSessionId: w.owner.rawSessionId };
    await send(w.srv, a, me);
    await send(w.srv, b, me);
    expect(recentOf(w.owner.id)).toEqual([b, a]);

    await w.srv.agentManager.kill(a);
    await send(w.srv, c, me);
    expect(recentOf(w.owner.id)).toEqual([c, b]);
  });
});

describe("persistence (task 5dac6b9b)", () => {
  it("pinned and recent lists survive a reboot", async () => {
    const w = await setup(["A", "B"]);
    const [a, b] = w.agents.map((x) => x.id);
    await putPinned(w.srv, w.owner.rawSessionId, { pinned: [b, a] });
    await send(w.srv, a, { rawSessionId: w.owner.rawSessionId });
    expect(pinnedOf(w.owner.id)).toEqual([b, a]);
    expect(recentOf(w.owner.id)).toEqual([a]);

    server = await w.srv.restart();
    expect(pinnedOf(w.owner.id)).toEqual([b, a]);
    expect(recentOf(w.owner.id)).toEqual([a]);
  });
});
