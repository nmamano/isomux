// Ask history end to end on the real server (task ff590b5e): a closed ask
// stays readable with how it closed - by the agent by id, and in its history
// by anyone with the reach of its logs. FakeBackend only.

import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AskEntry, TaskItem } from "../../shared/types.ts";
import type {
  AskClosedWire,
  AskEventsRes,
  AskHistoryRes,
} from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

type Res = { status: number; code?: string; body: unknown };
type Auth = { bearer?: string; rawSessionId?: string };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: Auth,
  body?: { json?: unknown; text?: string },
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
  let payload: string | undefined;
  if (body?.text !== undefined) {
    headers["Content-Type"] = "text/plain";
    payload = body.text;
  } else if (body?.json !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.json);
  }
  const res = await srv.http(path, {
    method,
    headers,
    body: payload,
    rawSessionId: auth.rawSessionId,
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

// Every turn completes at once, except one whose text holds "hold".
function backend(): FakeBackend {
  return new FakeBackend({
    storedSessionState: "durable",
    session: {
      onSend: (text, _a, s) => {
        if (!text.includes("hold")) s.completeTurn({ text: "ok" });
      },
    },
  });
}

async function world() {
  server = await startTestServer({ fakeBackend: backend() });
  const srv = server;
  const owner = await srv.seedOwner("Nil");
  const ownerId = getUserByName(owner.username)!.id;
  const [room] = srv.agentManager.getRooms();
  const spawn = async (name: string, roomId: string, managerId: string) => {
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
      "claude",
      undefined,
      managerId,
    );
    if (!info) throw new Error(`spawn ${name} failed`);
    return info;
  };
  const asker = await spawn("Asker", room.id, ownerId);
  const other = await spawn("Other", room.id, ownerId);
  const as = (agentId: string): Auth => ({
    bearer: getAgentTokenRaw(agentId)!,
  });
  const ownerAuth: Auth = { rawSessionId: owner.rawSessionId };
  return { srv, owner, ownerId, room, asker, other, as, ownerAuth, spawn };
}
type W = Awaited<ReturnType<typeof world>>;

async function open(w: W, prompt: string, member?: string): Promise<AskEntry> {
  const q = member ? `?member=${encodeURIComponent(member)}` : "";
  const r = await call(
    w.srv,
    "POST",
    `/api/agents/${w.asker.id}/asks${q}`,
    w.as(w.asker.id),
    { text: prompt },
  );
  expect(r.status).toBe(201);
  return r.body as AskEntry;
}

const readOne = (w: W, id: string, agentId = w.asker.id) =>
  call(w.srv, "GET", `/api/agents/${agentId}/asks/${id}`, w.as(agentId));

const history = (w: W, auth: Auth, query = "", agentId = w.asker.id) =>
  call(w.srv, "GET", `/api/agents/${agentId}/asks/history${query}`, auth);

// A history page's ask ids; a page that is not a 200 fails here, by status.
const ids = (r: Res) => {
  expect([r.status, r.code]).toEqual([200, undefined]);
  return (r.body as AskHistoryRes).asks.map((a) => a.id);
};

describe("a closed ask", () => {
  it("keeps the member, the words and the time of each answer, read by id and in the history, newest first", async () => {
    const w = await world();
    // An agent with no closed ask: the history route, not a read by id.
    const empty = await history(w, w.as(w.asker.id));
    expect([empty.status, empty.body]).toEqual([
      200,
      { asks: [], nextBefore: null },
    ]);

    const replied = await open(w, "Pull the spend breakdown?");
    const reasoned = await open(w, "Rename the room?");
    const filed = await open(w, "Rotate the keys?");
    const withdrawn = await open(w, "Still need this?");
    const bare = await open(w, "Ping the team?");
    const before = Date.now();

    expect(
      (
        await call(
          w.srv,
          "POST",
          `/api/asks/${replied.id}/reply`,
          w.ownerAuth,
          { json: { text: "yes, per agent" } },
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await call(
          w.srv,
          "POST",
          `/api/asks/${reasoned.id}/dismiss`,
          w.ownerAuth,
          { json: { text: "not now" } },
        )
      ).status,
    ).toBe(204);
    const fileRes = await call(
      w.srv,
      "POST",
      `/api/asks/${filed.id}/file-task`,
      w.ownerAuth,
      { json: { text: "after the launch" } },
    );
    expect(fileRes.status).toBe(201);
    const task = fileRes.body as TaskItem;
    expect(
      (
        await call(
          w.srv,
          "DELETE",
          `/api/agents/${w.asker.id}/asks/${withdrawn.id}`,
          w.as(w.asker.id),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await call(w.srv, "POST", `/api/asks/${bare.id}/dismiss`, w.ownerAuth, {
          json: {},
        })
      ).status,
    ).toBe(204);
    // Every one is closed: none is on the open list.
    expect(
      (
        await call(
          w.srv,
          "GET",
          `/api/agents/${w.asker.id}/asks`,
          w.as(w.asker.id),
        )
      ).body,
    ).toEqual([]);

    const closedOf = async (entry: AskEntry) => {
      const r = await readOne(w, entry.id);
      expect([entry.id, r.status]).toEqual([entry.id, 200]);
      const body = r.body as AskClosedWire;
      expect(body.id).toBe(entry.id);
      expect(body.prompt).toBe(entry.prompt);
      expect(body.member).toBe(w.owner.username);
      expect(body.closed.at).toBeGreaterThanOrEqual(before);
      expect(body.closed.at).toBeLessThanOrEqual(Date.now());
      const { at: _at, ...rest } = body.closed;
      return rest;
    };
    expect(await closedOf(replied)).toEqual({
      outcome: "replied",
      by: w.owner.username,
      answer: "yes, per agent",
    });
    expect(await closedOf(reasoned)).toEqual({
      outcome: "dismissed",
      by: w.owner.username,
      answer: "not now",
    });
    expect(await closedOf(filed)).toEqual({
      outcome: "filed",
      by: w.owner.username,
      answer: "after the launch",
      taskId: task.id,
    });
    expect(await closedOf(withdrawn)).toEqual({
      outcome: "withdrawn",
      by: null,
    });
    expect(await closedOf(bare)).toEqual({
      outcome: "dismissed",
      by: w.owner.username,
    });

    const listed = await history(w, w.as(w.asker.id));
    expect(listed.status).toBe(200);
    expect(ids(listed)).toEqual(
      [bare, withdrawn, filed, reasoned, replied].map((e) => e.id),
    );
    expect((listed.body as AskHistoryRes).nextBefore).toBeNull();
    // The list carries the same closed ask as the read by id.
    expect((listed.body as AskHistoryRes).asks[4]).toEqual(
      (await readOne(w, replied.id)).body as AskClosedWire,
    );
  });

  it("keeps the opening session off the wire", async () => {
    const w = await world();
    await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      w.as(w.other.id),
      { text: "start a session" },
    );
    const deadline = Date.now() + 3000;
    while (w.srv.agentManager.getCurrentSessionId(w.asker.id) === null) {
      if (Date.now() > deadline) throw new Error("no session");
      await new Promise((r) => setTimeout(r, 10));
    }
    const entry = await open(w, "Which session?");
    // The store keeps the opening session, so the wire has one to leak.
    expect(
      (
        JSON.parse(
          readFileSync(join(w.srv.stateRoot, "asks.json"), "utf-8"),
        ) as AskEntry[]
      ).find((e) => e.id === entry.id)?.sessionId,
    ).toBeString();
    await call(
      w.srv,
      "DELETE",
      `/api/agents/${w.asker.id}/asks/${entry.id}`,
      w.as(w.asker.id),
    );
    const db = new Database(join(w.srv.stateRoot, "office.sqlite"), {
      readonly: true,
    });
    try {
      const rows = db
        .query("SELECT record FROM ask_history WHERE id = ?")
        .all(entry.id) as { record: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].record).toContain("sessionId");
    } finally {
      db.close();
    }
    const one = (await readOne(w, entry.id)).body as object;
    expect("sessionId" in one).toBe(false);
    const listed = (await history(w, w.as(w.asker.id))).body as AskHistoryRes;
    expect(listed.asks.map((a) => "sessionId" in a)).toEqual([false]);
  });

  it("is not recorded when the agent never got the answer, and stays open", async () => {
    const w = await world();
    const entry = await open(w, "Full?");
    await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/messages`,
      w.ownerAuth,
      { json: { text: "hold on" } },
    );
    const deadline = Date.now() + 3000;
    while (
      w.srv.agentManager.getAllAgents().find((a) => a.id === w.asker.id)
        ?.state !== "thinking"
    ) {
      if (Date.now() > deadline) throw new Error("not busy");
      await new Promise((r) => setTimeout(r, 10));
    }
    for (let i = 0; ; i++) {
      const r = w.srv.agentManager.enqueueMessage(w.asker.id, {
        sender: {
          kind: "agent",
          agentId: w.other.id,
          agentName: "Other",
          roomName: "r",
        },
        text: `filler ${i}`,
      });
      if (!r.ok) break;
    }
    const reply = await call(
      w.srv,
      "POST",
      `/api/asks/${entry.id}/reply`,
      w.ownerAuth,
      { json: { text: "yes" } },
    );
    expect(reply.status).toBe(429);
    const still = await readOne(w, entry.id);
    expect(still.status).toBe(200);
    expect("closed" in (still.body as object)).toBe(false);
    expect(ids(await history(w, w.as(w.asker.id)))).toEqual([]);
  });

  it("is 404 by id when the agent never had it, also when another agent closed it", async () => {
    const w = await world();
    const entry = await open(w, "Mine?");
    await call(
      w.srv,
      "DELETE",
      `/api/agents/${w.asker.id}/asks/${entry.id}`,
      w.as(w.asker.id),
    );
    expect((await readOne(w, entry.id)).status).toBe(200);
    expect((await readOne(w, entry.id, w.other.id)).status).toBe(404);
    expect((await readOne(w, "0123abcd")).status).toBe(404);
  });
});

describe("a secret request in the history", () => {
  const VALUE = "ghp_FAKEaskhistoryFAKEaskhistoryFAKEask0";
  const REQUEST = {
    name: "GH_TOKEN",
    hosts: ["api.github.com"],
    reason: "To open the pull request.",
  };

  it("is kept as saved or declined by the member, and no copy of the value is kept", async () => {
    const w = await world();
    const requestOf = async (name: string) => {
      const r = await call(
        w.srv,
        "POST",
        `/api/agents/${w.asker.id}/secret-requests`,
        w.as(w.asker.id),
        { json: { ...REQUEST, name } },
      );
      expect(r.status).toBe(200);
      return (r.body as { requestId: string }).requestId;
    };
    const saveId = await requestOf("GH_TOKEN");
    const declineId = await requestOf("NPM_TOKEN");
    const saved = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/secret-requests/${saveId}/save`,
      w.ownerAuth,
      { json: { value: VALUE } },
    );
    expect(saved.status).toBe(200);
    const declined = await call(
      w.srv,
      "POST",
      `/api/agents/${w.asker.id}/secret-requests/${declineId}/decline`,
      w.ownerAuth,
    );
    expect(declined.status).toBe(200);

    const listed = await history(w, w.as(w.asker.id));
    const asks = (listed.body as AskHistoryRes).asks;
    expect(
      asks.map((a) => [a.secret?.requestId, a.closed.outcome, a.closed.by]),
    ).toEqual([
      [declineId, "declined", w.owner.username],
      [saveId, "saved", w.owner.username],
    ]);
    expect(asks.every((a) => a.closed.answer === undefined)).toBe(true);
    expect(JSON.stringify(listed.body)).not.toContain(VALUE);
    const db = new Database(join(w.srv.stateRoot, "office.sqlite"), {
      readonly: true,
    });
    try {
      const rows = db.query("SELECT record FROM ask_history").all() as {
        record: string;
      }[];
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows)).not.toContain(VALUE);
    } finally {
      db.close();
    }
  });
});

describe("who reads the history", () => {
  it("the agent, a peer in a room its manager reaches, and the member; not a member or agent outside the room", async () => {
    const w = await world();
    const entry = await open(w, "Visible?");
    await call(
      w.srv,
      "DELETE",
      `/api/agents/${w.asker.id}/asks/${entry.id}`,
      w.as(w.asker.id),
    );
    const elsewhere = w.srv.agentManager.createRoom("Elsewhere");
    const quinn = await w.srv.seedMember("Quinn");
    const quinnId = getUserByName(quinn.username)!.id;
    expect(updateUserById(quinnId, { allowedRooms: [elsewhere] })).toBeTruthy();
    const far = await w.spawn("Far", elsewhere, quinnId);

    for (const [who, auth] of [
      ["self", w.as(w.asker.id)],
      ["peer", w.as(w.other.id)],
      ["owner", w.ownerAuth],
    ] as const) {
      const r = await history(w, auth);
      expect([who, r.status, ids(r)]).toEqual([who, 200, [entry.id]]);
    }
    for (const [who, auth] of [
      ["member outside", { rawSessionId: quinn.rawSessionId }],
      ["agent outside", w.as(far.id)],
    ] as const) {
      const r = await history(w, auth);
      expect([who, r.status]).toEqual([who, 403]);
      expect(JSON.stringify(r.body)).not.toContain(entry.id);
    }
  });

  it("keeps a killed agent's open asks as agent_removed, for its owner to read", async () => {
    const w = await world();
    const entry = await open(w, "Still there?");
    await w.srv.agentManager.kill(w.asker.id);
    const r = await history(w, w.ownerAuth);
    expect(r.status).toBe(200);
    const asks = (r.body as AskHistoryRes).asks;
    expect(asks.map((a) => [a.id, a.closed.outcome, a.closed.by])).toEqual([
      [entry.id, "agent_removed", null],
    ]);
  });
});

// GET /api/asks/:askId (task 03f5c534): any agent's ask by its id, for a
// caller with the reach of that agent's logs. The body is the asking agent's
// own read by id; no reach is the same 404 as an unknown id.
describe("an ask by its id alone", () => {
  const byId = (w: W, id: string, auth: Auth) =>
    call(w.srv, "GET", `/api/asks/${id}`, auth);

  // An agent and a member outside the asker's room.
  async function outsiders(w: W) {
    const elsewhere = w.srv.agentManager.createRoom("Elsewhere");
    const quinn = await w.srv.seedMember("Quinn");
    const quinnId = getUserByName(quinn.username)!.id;
    expect(updateUserById(quinnId, { allowedRooms: [elsewhere] })).toBeTruthy();
    const far = await w.spawn("Far", elsewhere, quinnId);
    return [
      ["member outside", { rawSessionId: quinn.rawSessionId }],
      ["agent outside", w.as(far.id)],
    ] as const;
  }

  it("reads an open ask for the agent, a peer and the member, and is the unknown id's 404 outside the room", async () => {
    const w = await world();
    const entry = await open(w, "Ship it?");
    const own = await readOne(w, entry.id);
    expect([own.status, (own.body as AskEntry).id]).toEqual([200, entry.id]);

    for (const [who, auth] of [
      ["self", w.as(w.asker.id)],
      ["peer", w.as(w.other.id)],
      ["owner", w.ownerAuth],
    ] as const) {
      const r = await byId(w, entry.id, auth);
      expect([who, r.status, r.body]).toEqual([who, 200, own.body]);
    }

    const unknown = await byId(w, "0".repeat(8), w.as(w.other.id));
    expect([unknown.status, unknown.code]).toEqual([404, "not_found"]);
    for (const [who, auth] of await outsiders(w)) {
      const r = await byId(w, entry.id, auth);
      // The same answer as for an id that does not exist.
      expect([who, r.status, r.body]).toEqual([who, 404, unknown.body]);
    }
  });

  it("reads a closed ask with its events, as the agent reads it", async () => {
    const w = await world();
    const entry = await open(w, "Pull the spend?");
    const base = `/api/agents/${w.asker.id}/asks/${entry.id}`;
    const edited = await call(w.srv, "PATCH", base, w.as(w.asker.id), {
      text: "Pull the spend per agent?",
    });
    expect(edited.status).toBe(200);
    const removed = await call(w.srv, "DELETE", base, w.as(w.asker.id));
    expect(removed.status).toBe(204);
    const own = await readOne(w, entry.id);
    expect(own.status).toBe(200);
    const closed = own.body as AskClosedWire;
    expect([closed.closed.outcome, closed.events.map((e) => e.kind)]).toEqual([
      "withdrawn",
      ["created", "edited"],
    ]);

    for (const [who, auth] of [
      ["peer", w.as(w.other.id)],
      ["owner", w.ownerAuth],
    ] as const) {
      const r = await byId(w, entry.id, auth);
      expect([who, r.status, r.body]).toEqual([who, 200, own.body]);
    }
    const unknown = await byId(w, "0".repeat(8), w.as(w.other.id));
    for (const [who, auth] of await outsiders(w)) {
      const r = await byId(w, entry.id, auth);
      expect([who, r.status, r.body]).toEqual([who, 404, unknown.body]);
    }
  });

  it("reads a killed agent's ask for an agent of its manager", async () => {
    const w = await world();
    const entry = await open(w, "Still there?");
    await w.srv.agentManager.kill(w.asker.id);
    const r = await byId(w, entry.id, w.as(w.other.id));
    expect(r.status).toBe(200);
    const closed = r.body as AskClosedWire;
    expect([closed.id, closed.agentId, closed.closed.outcome]).toEqual([
      entry.id,
      w.asker.id,
      "agent_removed",
    ]);
    const unknown = await byId(w, "0".repeat(8), w.as(w.other.id));
    for (const [who, auth] of await outsiders(w)) {
      const out = await byId(w, entry.id, auth);
      expect([who, out.status, out.body]).toEqual([who, 404, unknown.body]);
    }
  });
});

describe("the history's query", () => {
  it("filters by member, pages by its cursor, and refuses an unknown member or a bad cursor or limit", async () => {
    const w = await world();
    const pat = await w.srv.seedMember("Pat");
    const patId = getUserByName(pat.username)!.id;
    expect(updateUserById(patId, { allowedRooms: [w.room.id] })).toBeTruthy();
    const made: AskEntry[] = [];
    for (const [prompt, member] of [
      ["One?", undefined],
      ["Two?", pat.username],
      ["Three?", undefined],
      ["Four?", pat.username],
    ] as const) {
      const entry = await open(w, prompt, member);
      await call(
        w.srv,
        "DELETE",
        `/api/agents/${w.asker.id}/asks/${entry.id}`,
        w.as(w.asker.id),
      );
      made.push(entry);
    }
    const newest = made.map((e) => e.id).reverse();
    const self = w.as(w.asker.id);

    const forPat = await history(w, self, `?member=${pat.username}`);
    expect(ids(forPat)).toEqual([made[3].id, made[1].id]);
    expect((forPat.body as AskHistoryRes).asks.map((a) => a.member)).toEqual([
      pat.username,
      pat.username,
    ]);

    const first = await history(w, self, "?limit=3");
    expect(ids(first)).toEqual(newest.slice(0, 3));
    const cursor = (first.body as AskHistoryRes).nextBefore;
    expect(cursor).toBeNumber();
    const second = await history(w, self, `?limit=3&before=${cursor}`);
    expect(ids(second)).toEqual(newest.slice(3));
    expect((second.body as AskHistoryRes).nextBefore).toBeNull();
    // The default and the maximum page.
    expect(ids(await history(w, self))).toEqual(newest);
    expect(ids(await history(w, self, "?limit=200"))).toEqual(newest);

    const unknown = await history(w, self, "?member=nobody");
    expect([unknown.status, unknown.code]).toEqual([422, "unknown_member"]);
    for (const q of [
      "?limit=0",
      "?limit=201",
      "?limit=abc",
      "?limit=2.5",
      "?before=abc",
    ]) {
      const r = await history(w, self, q);
      expect([q, r.status]).toEqual([q, 400]);
    }
  });
});

// GET /api/agents/:id/asks/events (task 302e7ea4): the agent's ask log, each
// create, edit, simplify request, its withdrawal and close of its asks as it happens, newest
// first, with the history's reach.
describe("the agent's ask log", () => {
  const log = (w: W, auth: Auth, query = "", agentId = w.asker.id) =>
    call(w.srv, "GET", `/api/agents/${agentId}/asks/events${query}`, auth);
  // A log page; one that is not a 200 fails here, by status. Its seqs fall.
  const page = (r: Res) => {
    expect([r.status, r.code]).toEqual([200, undefined]);
    const body = r.body as AskEventsRes;
    for (let i = 1; i < body.events.length; i++)
      expect(body.events[i].seq).toBeLessThan(body.events[i - 1].seq);
    return body;
  };
  const kinds = (r: Res) => page(r).events.map((e) => [e.askId, e.kind]);

  it("follows an open ask through its edit and simplify request to its close, in the closed ask's wire, and keeps each entry's seq", async () => {
    const w = await world();
    const self = w.as(w.asker.id);
    expect(page(await log(w, self))).toEqual({ events: [], nextBefore: null });
    const a = await open(w, "Pull the spend?");
    const b = await open(w, "Rename the room?");
    const edited = await call(
      w.srv,
      "PATCH",
      `/api/agents/${w.asker.id}/asks/${a.id}`,
      self,
      { text: "Pull the spend per agent?" },
    );
    expect(edited.status).toBe(200);
    const simplify = await call(
      w.srv,
      "POST",
      `/api/asks/${a.id}/simplify`,
      w.ownerAuth,
      { json: {} },
    );
    expect(simplify.status).toBe(204);
    // Withdrawn (task fc2021b7).
    const undo = await call(
      w.srv,
      "POST",
      `/api/asks/${a.id}/simplify/undo`,
      w.ownerAuth,
      { json: {} },
    );
    expect(undo.status).toBe(204);

    // Readable while the ask is open.
    const openLog = page(await log(w, self)).events;
    expect(openLog.map((e) => [e.askId, e.kind])).toEqual([
      [a.id, "simplify_withdrawn"],
      [a.id, "simplify_requested"],
      [a.id, "edited"],
      [b.id, "created"],
      [a.id, "created"],
    ]);
    expect(openLog.slice(0, 2).map(({ seq: _seq, ...e }) => e)).toEqual([
      {
        askId: a.id,
        kind: "simplify_withdrawn",
        at: expect.any(Number),
        by: w.owner.username,
      },
      {
        askId: a.id,
        kind: "simplify_requested",
        at: expect.any(Number),
        by: w.owner.username,
      },
    ]);
    expect(kinds(await log(w, self, `?askId=${b.id}`))).toEqual([
      [b.id, "created"],
    ]);

    const reply = await call(
      w.srv,
      "POST",
      `/api/asks/${a.id}/reply`,
      w.ownerAuth,
      { json: { text: "yes, per agent" } },
    );
    expect(reply.status).toBe(204);
    const closedAsk = (await readOne(w, a.id)).body as AskClosedWire;
    const [close, ...rest] = page(await log(w, self, `?askId=${a.id}`)).events;
    expect(close).toEqual({
      seq: expect.any(Number),
      askId: a.id,
      kind: "closed",
      at: closedAsk.closed.at,
      outcome: "replied",
      by: w.owner.username,
      answer: "yes, per agent",
    });
    // The entries before the close are the ones read while the ask was open,
    // seqs included, so a reader can stop at the last seq it saw; and they
    // are the closed ask's events, newest first.
    expect(rest).toEqual(openLog.filter((e) => e.askId === a.id));
    expect(rest.map(({ seq: _seq, askId: _askId, ...e }) => e)).toEqual(
      [...closedAsk.events].reverse(),
    );
  });

  it("is read by the agent, a peer and the member, not outside the room; a killed agent's owner reads its closes; another agent's ask is an empty page", async () => {
    const w = await world();
    const entry = await open(w, "Visible?");
    const elsewhere = w.srv.agentManager.createRoom("Elsewhere");
    const quinn = await w.srv.seedMember("Quinn");
    const quinnId = getUserByName(quinn.username)!.id;
    expect(updateUserById(quinnId, { allowedRooms: [elsewhere] })).toBeTruthy();
    const far = await w.spawn("Far", elsewhere, quinnId);

    for (const [who, auth] of [
      ["self", w.as(w.asker.id)],
      ["peer", w.as(w.other.id)],
      ["owner", w.ownerAuth],
    ] as const)
      expect([who, kinds(await log(w, auth))]).toEqual([
        who,
        [[entry.id, "created"]],
      ]);
    for (const [who, auth] of [
      ["member outside", { rawSessionId: quinn.rawSessionId }],
      ["agent outside", w.as(far.id)],
    ] as const) {
      const r = await log(w, auth);
      expect([who, r.status]).toEqual([who, 403]);
      expect(JSON.stringify(r.body)).not.toContain(entry.id);
    }

    const other = w.as(w.other.id);
    for (const askId of [entry.id, "0123abcd"])
      expect([
        askId,
        page(await log(w, other, `?askId=${askId}`, w.other.id)),
      ]).toEqual([askId, { events: [], nextBefore: null }]);

    await w.srv.agentManager.kill(w.asker.id);
    const events = page(await log(w, w.ownerAuth)).events;
    expect(events.map((e) => [e.askId, e.kind])).toEqual([
      [entry.id, "closed"],
      [entry.id, "created"],
    ]);
    expect(events[0]).toMatchObject({ outcome: "agent_removed", by: null });
  });

  it("pages by its cursor and refuses another key, or a bad cursor or limit", async () => {
    const w = await world();
    const self = w.as(w.asker.id);
    for (const prompt of ["One?", "Two?", "Three?", "Four?"])
      await open(w, prompt);
    const all = page(await log(w, self)).events;
    expect(all).toHaveLength(4);

    const first = page(await log(w, self, "?limit=3"));
    expect(first.events).toEqual(all.slice(0, 3));
    expect(first.nextBefore).toBe(all[2].seq);
    expect(
      page(await log(w, self, `?limit=3&before=${first.nextBefore}`)),
    ).toEqual({ events: all.slice(3), nextBefore: null });
    expect(page(await log(w, self, "?limit=200")).events).toEqual(all);

    for (const q of [
      "?limit=0",
      "?limit=201",
      "?limit=abc",
      "?limit=2.5",
      "?before=abc",
      `?member=${w.owner.username}`,
      "?ask=0123abcd",
    ]) {
      const r = await log(w, self, q);
      expect([q, r.status, r.code]).toEqual([q, 400, "invalid_query"]);
    }
  });
});
