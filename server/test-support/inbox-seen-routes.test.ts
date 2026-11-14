// The Inbox seen marks (task 64d3950a): POST /api/me/view/inbox-seen adds
// the ask ids and agent item keys the member's Asks tab showed to a private
// field of their record, so the badge clears on every device of the member.
// The write only adds (a grow-only set with a cap that drops the oldest), so
// two devices that mark at once cannot undo each other. Driven through the
// real HTTP server, auth and users store.

import { afterEach, describe, expect, it } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getUserByName, getUserById, updateUserById } from "../users.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { mintApiToken } from "../api-tokens.ts";
// A namespace import: the cap is read where a test uses it.
import * as shapes from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const PATH = "/api/me/view/inbox-seen";
const cap = (): number =>
  (shapes as unknown as { INBOX_SEEN_MAX: number }).INBOX_SEEN_MAX;

type Auth = { rawSessionId: string } | { bearer: string };
async function mark(
  srv: TestServer,
  auth: Auth,
  body: unknown,
): Promise<Response> {
  return srv.http(PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...("bearer" in auth ? { Authorization: `Bearer ${auth.bearer}` } : {}),
    },
    body: JSON.stringify(body),
    ...("rawSessionId" in auth ? { rawSessionId: auth.rawSessionId } : {}),
  });
}

const seenOf = (userId: string): string[] =>
  (getUserById(userId) as { inboxSeen?: string[] } | undefined)?.inboxSeen ??
  [];

async function setup() {
  const srv = await startTestServer();
  server = srv;
  const o = await srv.seedOwner("Morgan");
  const m = await srv.seedMember("Mia");
  return {
    srv,
    owner: { ...o, id: getUserByName(o.username)!.id },
    member: { ...m, id: getUserByName(m.username)!.id },
  };
}

type Frame = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
const userFramesAfter = (sock: TestSocket, mark: number): Frame[] =>
  (sock.messages as Frame[])
    .slice(mark)
    .filter((m) => String(m.type).startsWith("user"));
async function connectSettled(
  srv: TestServer,
  rawSessionId: string,
): Promise<TestSocket> {
  const sock = await srv.connectWs(rawSessionId);
  await sock.waitFor("presence_list");
  await sock.waitFor("provider_accounts_updated");
  return sock;
}

describe("view.markInboxSeen (task 64d3950a)", () => {
  it("adds to the member's list: new keys go last in request order, a key already there keeps its place, an empty list changes nothing", async () => {
    const w = await setup();
    expect((await mark(w.srv, w.member, { keys: ["q1", "q2"] })).status).toBe(
      204,
    );
    expect(seenOf(w.member.id)).toEqual(["q1", "q2"]);

    // Another device marks what it showed: a key it repeats and one already
    // stored are not added again, and nothing it left out is removed.
    expect(
      (
        await mark(w.srv, w.member, {
          keys: ["q3", "q1", "q3", "permission:p"],
        })
      ).status,
    ).toBe(204);
    expect(seenOf(w.member.id)).toEqual(["q1", "q2", "q3", "permission:p"]);

    expect((await mark(w.srv, w.member, { keys: [] })).status).toBe(204);
    expect(seenOf(w.member.id)).toEqual(["q1", "q2", "q3", "permission:p"]);
    // Per member: the owner's list is untouched.
    expect(seenOf(w.owner.id)).toEqual([]);
  });

  it("two devices that mark at the same moment both keep their marks", async () => {
    const w = await setup();
    await mark(w.srv, w.member, { keys: ["q0"] });
    const [a, b] = await Promise.all([
      mark(w.srv, w.member, { keys: ["q0", "laptop"] }),
      mark(w.srv, w.member, { keys: ["phone"] }),
    ]);
    expect([a.status, b.status]).toEqual([204, 204]);
    expect([...seenOf(w.member.id)].sort()).toEqual(["laptop", "phone", "q0"]);
  });

  it("keeps the newest marks at the cap: an add over it drops the oldest", async () => {
    const w = await setup();
    const max = cap();
    expect(max).toBeGreaterThan(2);
    const full = Array.from({ length: max }, (_, i) => `k${i}`);
    // A request of exactly the cap is accepted.
    expect((await mark(w.srv, w.member, { keys: full })).status).toBe(204);
    expect(seenOf(w.member.id)).toEqual(full);

    expect(
      (await mark(w.srv, w.member, { keys: ["new1", "k5", "new2"] })).status,
    ).toBe(204);
    const after = seenOf(w.member.id);
    expect(after.length).toBe(max);
    expect(after.slice(0, 2)).toEqual(["k2", "k3"]);
    expect(after.slice(-2)).toEqual(["new1", "new2"]);
    expect(after.includes("k0") || after.includes("k1")).toBe(false);
    expect(after.includes("k5")).toBe(true);
  });

  it("refuses a bad shape with 422 invalid_inbox_seen and keeps the stored list", async () => {
    const w = await setup();
    await mark(w.srv, w.member, { keys: ["q1"] });
    const tooMany = Array.from({ length: cap() + 1 }, (_, i) => `k${i}`);
    for (const body of [
      {},
      { keys: "q2" },
      { keys: ["q2", 7] },
      { keys: ["q2", ""] },
      { keys: ["x".repeat(201)] },
      { keys: tooMany },
    ]) {
      const res = await mark(w.srv, w.member, body);
      const code = ((await res.json()) as { error?: { code?: string } }).error
        ?.code;
      expect({ status: res.status, code }).toEqual({
        status: 422,
        code: "invalid_inbox_seen",
      });
      expect(seenOf(w.member.id)).toEqual(["q1"]);
    }
    // The key length bound itself is accepted.
    const longest = "y".repeat(200);
    expect((await mark(w.srv, w.member, { keys: [longest] })).status).toBe(204);
    expect(seenOf(w.member.id)).toEqual(["q1", longest]);
  });

  it("neither an agent nor an API token marks the member's asks seen; their own session does", async () => {
    const w = await setup();
    await mark(w.srv, w.member, { keys: ["q1"] });
    // A privileged agent of the member: user:self is not an agent capability.
    const agent = mintAgentToken("agent-x", w.member.id, true);
    const refused = await mark(w.srv, { bearer: agent }, { keys: ["q2"] });
    expect(refused.status).toBe(403);
    expect(seenOf(w.member.id)).toEqual(["q1"]);

    // An API token has no user:self either, as on prefs.update.
    const api = await mintApiToken({
      userId: w.member.id,
      name: "Script",
      expiresInDays: 30,
    });
    expect(
      (await mark(w.srv, { bearer: api.token }, { keys: ["q2"] })).status,
    ).toBe(403);
    expect(seenOf(w.member.id)).toEqual(["q1"]);
    // Anchor: the member's own session still marks.
    expect((await mark(w.srv, w.member, { keys: ["q2"] })).status).toBe(204);
    expect(seenOf(w.member.id)).toEqual(["q1", "q2"]);
  });

  it("sends the record to every device of the member and the owners' admin copy, nothing to other members, and nothing on a no-op", async () => {
    const w = await setup();
    const other = await w.srv.seedMember("Ola");
    const laptop = await connectSettled(w.srv, w.member.rawSessionId);
    const phone = await connectSettled(w.srv, w.member.rawSessionId);
    const otherSock = await connectSettled(w.srv, other.rawSessionId);
    const ownerSock = await connectSettled(w.srv, w.owner.rawSessionId);
    const socks = [laptop, phone, otherSock, ownerSock];
    let marks = socks.map((s) => s.messages.length);

    expect((await mark(w.srv, w.member, { keys: ["q1"] })).status).toBe(204);
    await fence(...socks);
    for (const device of [laptop, phone]) {
      const frames = userFramesAfter(device, marks[socks.indexOf(device)]);
      expect(frames.map((f) => f.type)).toEqual(["user_self_updated"]);
      expect((frames[0].user as Frame).inboxSeen).toEqual(["q1"]);
    }
    expect(userFramesAfter(otherSock, marks[2]).length).toBe(0);
    const admin = userFramesAfter(ownerSock, marks[3]);
    expect(admin.map((f) => f.type)).toEqual(["user_admin_updated"]);
    expect((admin[0].user as Frame).inboxSeen).toEqual(["q1"]);

    // Every key already stored: no record frame anywhere.
    marks = socks.map((s) => s.messages.length);
    expect((await mark(w.srv, w.member, { keys: ["q1"] })).status).toBe(204);
    await fence(...socks);
    socks.forEach((s, i) =>
      expect(userFramesAfter(s, marks[i]).length).toBe(0),
    );

    // A later change still sends (the no-op did not stop the channel).
    marks = socks.map((s) => s.messages.length);
    await mark(w.srv, w.member, { keys: ["q2"] });
    await fence(...socks);
    expect(
      (userFramesAfter(phone, marks[1])[0]?.user as Frame | undefined)
        ?.inboxSeen,
    ).toEqual(["q1", "q2"]);
  });

  // users.json is hand-editable, and the load keeps a repeated key.
  it("a stored list with a repeated key still takes a new key", async () => {
    const w = await setup();
    expect(updateUserById(w.member.id, { inboxSeen: ["q1", "q1"] }).ok).toBe(
      true,
    );
    expect((await mark(w.srv, w.member, { keys: ["q2"] })).status).toBe(204);
    expect(seenOf(w.member.id)).toContain("q2");
  });

  it("the list survives a reboot", async () => {
    const w = await setup();
    await mark(w.srv, w.member, { keys: ["q1", "permission:p"] });
    server = await w.srv.restart();
    expect(seenOf(w.member.id)).toEqual(["q1", "permission:p"]);
  });
});
