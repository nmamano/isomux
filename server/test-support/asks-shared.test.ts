// A shared ask end to end on the real server (task 9461c464): an agent opens
// one ask for several named members, or for everyone who reaches its room and
// does not hide it. Any of them answers it; the first answer closes it for
// all and names who answered. FakeBackend only.

import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AskEntry, AskMemberWire } from "../../shared/types.ts";
import type {
  AskAgentWire,
  AskClosedWire,
  AskHistoryRes,
  MeRoomsRes,
} from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

type Res = {
  status: number;
  code?: string;
  by?: unknown;
  body: unknown;
};
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
  const error = (parsed as { error?: { code?: string; by?: unknown } } | null)
    ?.error;
  return { status: res.status, code: error?.code, by: error?.by, body: parsed };
}

// Every turn completes at once.
function backend(): FakeBackend {
  return new FakeBackend({
    storedSessionState: "durable",
    session: {
      onSend: (_text, _a, s) => {
        s.completeTurn({ text: "ok" });
      },
    },
  });
}

function sentTexts(srv: TestServer, agentId: string): string[] {
  return srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));
}

// Nil owns the office and manages Asker. Pat and Kim reach Asker's room; Sam
// reaches no room.
async function world() {
  server = await startTestServer({ fakeBackend: backend() });
  const srv = server;
  const owner = await srv.seedOwner("Nil");
  const ownerId = getUserByName(owner.username)!.id;
  const [room] = srv.agentManager.getRooms();
  const asker = await srv.agentManager.spawn(
    "Asker",
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    room.id,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
    undefined,
    ownerId,
  );
  if (!asker) throw new Error("spawn Asker failed");
  const seed = async (name: string, rooms: string[]) => {
    const m = await srv.seedMember(name);
    const id = getUserByName(m.username)!.id;
    expect(updateUserById(id, { allowedRooms: rooms })).toBeTruthy();
    return { ...m, id, auth: { rawSessionId: m.rawSessionId } as Auth };
  };
  const pat = await seed("Pat", [room.id]);
  const kim = await seed("Kim", [room.id]);
  const sam = await seed("Sam", []);
  const nil = {
    ...owner,
    id: ownerId,
    auth: { rawSessionId: owner.rawSessionId } as Auth,
  };
  const agentAuth: Auth = { bearer: getAgentTokenRaw(asker.id)! };
  const base = `/api/agents/${asker.id}/asks`;
  return { srv, room, asker, nil, pat, kim, sam, agentAuth, base };
}
type W = Awaited<ReturnType<typeof world>>;
type Who = W["nil"];

const create = (w: W, json: Record<string, unknown>) =>
  call(w.srv, "POST", w.base, w.agentAuth, { json });
const createText = (w: W, query: string, text: string) =>
  call(w.srv, "POST", `${w.base}?${query}`, w.agentAuth, { text });

async function opened(w: W, json: Record<string, unknown>) {
  const r = await create(w, json);
  expect([r.status, r.code]).toEqual([201, undefined]);
  return r.body as AskAgentWire;
}

// The ids of the open asks a member sees.
async function mine(w: W, who: Who): Promise<string[]> {
  const r = await call(w.srv, "GET", "/api/asks", who.auth);
  expect(r.status).toBe(200);
  return (r.body as AskMemberWire[]).map((e) => e.id);
}

const answer = (w: W, who: Who, id: string, verb: string, json = {}) =>
  call(w.srv, "POST", `/api/asks/${id}/${verb}`, who.auth, { json });

const agentRead = (w: W, id: string) =>
  call(w.srv, "GET", `${w.base}/${id}`, w.agentAuth);

const openCount = async (w: W) =>
  ((await call(w.srv, "GET", w.base, w.agentAuth)).body as AskEntry[]).length;

// Hide (or show again) the agent's room through the member's own view route.
async function setHidden(w: W, who: Who, hidden: boolean) {
  const rooms = await call(w.srv, "GET", "/api/me/rooms", who.auth);
  expect(rooms.status).toBe(200);
  const all = (rooms.body as MeRoomsRes).rooms.map((r) => r.id);
  expect(all).toContain(w.room.id);
  const shown = hidden ? all.filter((id) => id !== w.room.id) : all;
  const r = await call(w.srv, "PUT", "/api/me/view/shown", who.auth, {
    json: { shown },
  });
  expect(r.status).toBe(204);
}

const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();

describe("an ask for named members", () => {
  it("opens for every member named, as a JSON list or repeated member=; each sees it, others do not, and the wire names them all", async () => {
    const w = await world();
    const made = await opened(w, {
      text: "Who takes the release notes?",
      member: [w.pat.username, w.nil.username],
    });
    expect([made.member, made.members, made.room ?? null]).toEqual([
      w.pat.username,
      [w.pat.username, w.nil.username],
      null,
    ]);
    expect([made.memberUserId, made.otherMemberUserIds]).toEqual([
      w.pat.id,
      [w.nil.id],
    ]);
    const viaText = await createText(
      w,
      `member=${w.kim.username}&member=${w.pat.username}`,
      "Who reviews?",
    );
    expect(viaText.status).toBe(201);
    expect((viaText.body as AskAgentWire).members).toEqual([
      w.kim.username,
      w.pat.username,
    ]);
    const second = (viaText.body as AskAgentWire).id;
    expect(await mine(w, w.pat)).toEqual([made.id, second]);
    expect(await mine(w, w.nil)).toEqual([made.id]);
    expect(await mine(w, w.kim)).toEqual([second]);
    expect(await mine(w, w.sam)).toEqual([]);
    // Each member's own list carries every member's name.
    const kims = (await call(w.srv, "GET", "/api/asks", w.kim.auth))
      .body as AskMemberWire[];
    expect(kims[0].members).toEqual([w.kim.username, w.pat.username]);
  });

  it("refuses a bad list with its own code, and opens nothing", async () => {
    const w = await world();
    const many = Array.from({ length: 21 }, (_, i) => `someone${i}`);
    const outcomes: string[] = [];
    for (const [label, member] of [
      ["empty", []],
      ["21 names", many],
      [
        "the same name twice, any case",
        [w.pat.username, w.pat.username.toUpperCase()],
      ],
      ["a non-string", [w.pat.username, 3]],
      ["an unknown name", [w.pat.username, "nobody"]],
      ["a member outside the room", [w.pat.username, w.sam.username]],
    ] as const) {
      const r = await create(w, { text: "Who?", member });
      outcomes.push(`${label}: ${r.status} ${r.code}`);
    }
    // A list is for a plain ask only.
    const step = await create(w, {
      text: "Pair?",
      member: [w.pat.username, w.nil.username],
      step: { kind: "browser-pairing" },
    });
    outcomes.push(`with a step: ${step.status} ${step.code}`);
    expect(outcomes).toEqual([
      "empty: 422 invalid_members",
      "21 names: 422 invalid_members",
      "the same name twice, any case: 422 invalid_members",
      "a non-string: 422 invalid_members",
      "an unknown name: 422 unknown_member",
      "a member outside the room: 422 member_no_access",
      "with a step: 422 invalid_members",
    ]);
    expect(await openCount(w)).toBe(0);
  });

  it("takes 20 names", async () => {
    const w = await world();
    // Twenty distinct names, the room's three members among them; the rest
    // are refused by name, after the bound.
    const three = [w.nil.username, w.pat.username, w.kim.username];
    const ok = await create(w, { text: "Anyone?", member: three });
    expect(ok.status).toBe(201);
    const twenty = [
      ...three,
      ...Array.from({ length: 17 }, (_, i) => `someone${i}`),
    ];
    const r = await create(w, { text: "Anyone?", member: twenty });
    expect([r.status, r.code]).toEqual([422, "unknown_member"]);
  });

  it("checks a link to an agent's chat against every member, on create and on edit", async () => {
    const w = await world();
    const elsewhere = w.srv.agentManager.createRoom("Elsewhere");
    const far = await w.srv.agentManager.spawn(
      "Far",
      w.srv.stateRoot,
      "default",
      undefined,
      undefined,
      elsewhere,
      undefined,
      undefined,
      undefined,
      undefined,
      "claude",
      undefined,
      w.nil.id,
    );
    if (!far) throw new Error("spawn Far failed");
    // Nil reaches Far's room; Pat does not.
    const both = [w.nil.username, w.pat.username];
    const refused = await create(w, {
      text: "Look at Far?",
      member: both,
      link: `/agents/${far.id}`,
    });
    expect([refused.status, refused.code]).toEqual([422, "invalid_link"]);
    const made = await opened(w, {
      text: "Look at Asker?",
      member: both,
      link: `/agents/${w.asker.id}`,
    });
    const edit = await call(
      w.srv,
      "PATCH",
      `${w.base}/${made.id}`,
      w.agentAuth,
      {
        json: { link: `/agents/${far.id}` },
      },
    );
    expect([edit.status, edit.code]).toEqual([422, "invalid_link"]);
    expect(((await agentRead(w, made.id)).body as AskEntry).link).toBe(
      `/agents/${w.asker.id}`,
    );
  });

  it("keeps its members through an edit: the edit does not take member", async () => {
    const w = await world();
    const made = await opened(w, {
      text: "Who?",
      member: [w.pat.username, w.kim.username],
    });
    const edit = await call(
      w.srv,
      "PATCH",
      `${w.base}/${made.id}`,
      w.agentAuth,
      {
        json: { text: "Who now?", member: [w.nil.username] },
      },
    );
    expect(edit.status).toBeGreaterThanOrEqual(400);
    expect(edit.status).toBeLessThan(500);
    const after = (await agentRead(w, made.id)).body as AskAgentWire;
    expect([after.prompt, after.members]).toEqual([
      "Who?",
      [w.pat.username, w.kim.username],
    ]);
  });

  it("closes for all at the first answer: a later reply, dismiss or filed task is 409 ask_closed naming who answered, and the agent gets one answer", async () => {
    const w = await world();
    const made = await opened(w, {
      text: "Ship it?",
      member: [w.nil.username, w.pat.username, w.kim.username],
    });
    const nilWs = await w.srv.connectWs(w.nil.rawSessionId);
    const kimWs = await w.srv.connectWs(w.kim.rawSessionId);
    // The answerer's own socket, as the tab that sent the answer.
    const patWs = await w.srv.connectWs(w.pat.rawSessionId);
    const first = await answer(w, w.pat, made.id, "reply", {
      text: "yes, ship",
    });
    expect(first.status).toBe(204);
    const late: string[] = [];
    for (const [who, verb, json] of [
      [w.nil, "reply", { text: "no, wait" }],
      [w.kim, "dismiss", {}],
      [w.nil, "file-task", {}],
    ] as const) {
      const r = await answer(w, who, made.id, verb, json);
      late.push(`${verb} ${r.status} ${r.code} ${String(r.by)}`);
    }
    expect(late).toEqual([
      `reply 409 ask_closed ${w.pat.username}`,
      `dismiss 409 ask_closed ${w.pat.username}`,
      `file-task 409 ask_closed ${w.pat.username}`,
    ]);
    const texts = sentTexts(w.srv, w.asker.id);
    expect(texts.filter((t) => t.includes("yes, ship"))).toHaveLength(1);
    expect(texts.some((t) => t.includes("no, wait"))).toBe(false);
    expect(w.srv.agentManager.getTasks()).toEqual([]);
    // Every member's sockets drop the card; the other members are told who
    // answered, and the answerer's own tab is not (it would read "<you>
    // answered first" while its own answer was in flight).
    for (const [ws, by] of [
      [nilWs, w.pat.username],
      [kimWs, w.pat.username],
      [patWs, undefined],
    ] as const) {
      await waitUntil(
        () =>
          ws.messages.some(
            (m) =>
              (m as { type?: string }).type === "ask_removed" &&
              (m as { id?: string }).id === made.id,
          ),
        "ask_removed",
      );
      const removed = ws.messages.find(
        (m) =>
          (m as { type?: string }).type === "ask_removed" &&
          (m as { id?: string }).id === made.id,
      ) as { by?: string };
      expect(removed.by).toBe(by);
    }
    for (const who of [w.nil, w.pat, w.kim])
      expect(await mine(w, who)).toEqual([]);
  });

  it("any member dismisses it, asks to simplify it, and the history finds it under every member and the closer", async () => {
    const w = await world();
    const made = await opened(w, {
      text: "Rename the room?",
      member: [w.nil.username, w.pat.username],
    });
    // Pat, the second member, asks to simplify; Nil sees the mark.
    expect((await answer(w, w.pat, made.id, "simplify")).status).toBe(204);
    const nils = (await call(w.srv, "GET", "/api/asks", w.nil.auth))
      .body as AskMemberWire[];
    expect(typeof nils[0].simplifyRequestedAt).toBe("number");
    expect((await answer(w, w.pat, made.id, "dismiss")).status).toBe(204);
    // A late answer names the closer only to a member it was for: Kim reaches
    // the room but was not named, and Pat closed it.
    for (const who of [w.kim, w.pat]) {
      const r = await answer(w, who, made.id, "reply", { text: "late" });
      expect([r.status, r.code, r.by]).toEqual([404, "not_found", undefined]);
    }
    const closed = (await agentRead(w, made.id)).body as AskClosedWire;
    expect([closed.closed?.outcome, closed.closed?.by]).toEqual([
      "dismissed",
      w.pat.username,
    ]);
    const found = async (name: string) => {
      const r = await call(
        w.srv,
        "GET",
        `${w.base}/history?member=${name}`,
        w.agentAuth,
      );
      expect(r.status).toBe(200);
      return (r.body as AskHistoryRes).asks.map((a) => a.id);
    };
    expect(await found(w.nil.username)).toEqual([made.id]);
    expect(await found(w.pat.username)).toEqual([made.id]);
    expect(await found(w.kim.username)).toEqual([]);
  });

  it("shows an office owner a shared ask they are not named in once, with every member", async () => {
    const w = await world();
    const made = await opened(w, {
      text: "Who?",
      member: [w.pat.username, w.kim.username],
    });
    const others = await call(w.srv, "GET", "/api/asks/others", w.nil.auth);
    expect(others.status).toBe(200);
    const listed = others.body as AskAgentWire[];
    expect(listed.map((e) => [e.id, e.members])).toEqual([
      [made.id, [w.pat.username, w.kim.username]],
    ]);
    // The owner answers it: the history finds it under the closer too.
    expect(
      (await answer(w, w.nil, made.id, "reply", { text: "mine" })).status,
    ).toBe(204);
    const history = await call(
      w.srv,
      "GET",
      `${w.base}/history?member=${w.nil.username}`,
      w.agentAuth,
    );
    expect((history.body as AskHistoryRes).asks.map((a) => a.id)).toEqual([
      made.id,
    ]);
  });
});

// Task 3277082b: a named member who hides the agent's room gets no ask,
// read live, as for a room ask.
describe("an ask to a member who hides the room", () => {
  it("skips them at create, keeps them out while they hide it and gives it back when they show it", async () => {
    const w = await world();
    await setHidden(w, w.kim, true);
    const made = await opened(w, {
      text: "Who takes the demo?",
      member: [w.kim.username, w.pat.username],
    });
    expect(made.members).toEqual([w.pat.username]);
    expect(await mine(w, w.pat)).toEqual([made.id]);
    expect(await mine(w, w.kim)).toEqual([]);
    const refused = await answer(w, w.kim, made.id, "reply", { text: "me" });
    expect(refused.status).toBe(404);
    // Kim shows the room again: the ask is hers too.
    await setHidden(w, w.kim, false);
    expect(await mine(w, w.kim)).toEqual([made.id]);
    expect(
      ((await agentRead(w, made.id)).body as AskAgentWire).members,
    ).toEqual([w.kim.username, w.pat.username]);
    // Pat hides it after it opened: out of the members, and cannot answer.
    await setHidden(w, w.pat, true);
    expect(await mine(w, w.pat)).toEqual([]);
    expect(
      (await answer(w, w.pat, made.id, "reply", { text: "me" })).status,
    ).toBe(404);
    expect(
      ((await agentRead(w, made.id)).body as AskAgentWire).members,
    ).toEqual([w.kim.username]);
    expect(
      (await answer(w, w.kim, made.id, "reply", { text: "me" })).status,
    ).toBe(204);
  });

  it("refuses with 422 no_audience when every member it names hides the room, the manager by default too and before a step's check; opens nothing", async () => {
    const w = await world();
    for (const who of [w.nil, w.pat, w.kim]) await setHidden(w, who, true);
    const outcomes: string[] = [];
    for (const [label, json] of [
      ["a list", { member: [w.pat.username, w.kim.username] }],
      ["one member", { member: w.pat.username }],
      ["the manager by default", {}],
      ["the manager with a step", { step: { kind: "browser-pairing" } }],
    ] as const) {
      const r = await create(w, { text: "Who?", ...json });
      outcomes.push(`${label}: ${r.status} ${r.code}`);
    }
    const viaText = await createText(w, `member=${w.kim.username}`, "Who?");
    outcomes.push(`member= as text: ${viaText.status} ${viaText.code}`);
    expect(outcomes).toEqual([
      "a list: 422 no_audience",
      "one member: 422 no_audience",
      "the manager by default: 422 no_audience",
      "the manager with a step: 422 no_audience",
      "member= as text: 422 no_audience",
    ]);
    expect(await openCount(w)).toBe(0);
    // One member who shows the room is enough.
    const r = await create(w, {
      text: "Who?",
      member: [w.pat.username, w.kim.username],
    });
    expect(r.status).toBe(422);
    await setHidden(w, w.kim, false);
    const made = await opened(w, {
      text: "Who?",
      member: [w.pat.username, w.kim.username],
    });
    expect(made.members).toEqual([w.kim.username]);
  });

  it("an office owner who hides the room sees none of its asks, as their own or as another member's", async () => {
    const w = await world();
    const named = await opened(w, {
      text: "Mine?",
      member: [w.nil.username, w.pat.username],
    });
    const other = await opened(w, { text: "Theirs?", member: w.pat.username });
    const others = async () =>
      (
        (await call(w.srv, "GET", "/api/asks/others", w.nil.auth))
          .body as AskAgentWire[]
      ).map((e) => e.id);
    // The condition: shown, Nil has the named ask and sees the other one.
    expect(await mine(w, w.nil)).toEqual([named.id]);
    expect(await others()).toEqual([other.id]);
    await setHidden(w, w.nil, true);
    expect(await mine(w, w.nil)).toEqual([]);
    expect(await others()).toEqual([]);
    for (const id of [named.id, other.id])
      expect((await answer(w, w.nil, id, "reply", { text: "me" })).status).toBe(
        404,
      );
  });
});

describe("an ask for everyone in the room", () => {
  it("opens for every member who reaches the room and does not hide it, as JSON room: true or text room=1; the wire marks it", async () => {
    const w = await world();
    await setHidden(w, w.pat, true);
    const made = await opened(w, { text: "Who has the keys?", room: true });
    expect([made.room, sorted(made.members)]).toEqual([
      true,
      sorted([w.nil.username, w.kim.username]),
    ]);
    // The manager is in the audience: the stored member is the manager.
    expect(made.memberUserId).toBe(w.nil.id);
    expect(made.otherMemberUserIds).toBeUndefined();
    expect(await mine(w, w.nil)).toEqual([made.id]);
    expect(await mine(w, w.kim)).toEqual([made.id]);
    expect(await mine(w, w.pat)).toEqual([]);
    expect(await mine(w, w.sam)).toEqual([]);
    const viaText = await createText(w, "room=1", "Anyone free?");
    expect(viaText.status).toBe(201);
    expect((viaText.body as AskAgentWire).room).toBe(true);
    // Stored with the room mark, for the next boot.
    const file = JSON.parse(
      readFileSync(join(w.srv.stateRoot, "asks.json"), "utf-8"),
    ) as AskEntry[];
    expect(file.find((e) => e.id === made.id)?.room).toBe(true);
  });

  it("stores the first audience member by id when the manager hides the room, and an owner who hides it gets it nowhere", async () => {
    const w = await world();
    await setHidden(w, w.nil, true);
    const made = await opened(w, { text: "Anyone?", room: true });
    expect(made.memberUserId).toBe([w.pat.id, w.kim.id].sort()[0]);
    expect(sorted(made.members)).toEqual(
      sorted([w.pat.username, w.kim.username]),
    );
    expect(await mine(w, w.nil)).toEqual([]);
    const others = await call(w.srv, "GET", "/api/asks/others", w.nil.auth);
    expect((others.body as AskAgentWire[]).map((e) => e.id)).toEqual([]);
    expect(
      (await answer(w, w.nil, made.id, "reply", { text: "me" })).status,
    ).toBe(404);
  });

  it("is live: a member who joins or shows the room gets it, one who hides it loses it and cannot answer; open for nobody, it stays open with no members", async () => {
    const w = await world();
    await setHidden(w, w.pat, true);
    const made = await opened(w, { text: "Who is around?", room: true });
    // Sam joins the room; Pat shows it again.
    expect(
      updateUserById(w.sam.id, { allowedRooms: [w.room.id] }),
    ).toBeTruthy();
    // Showing the room again re-projects Pat's other devices (full_state),
    // which read GET /api/asks again.
    const patWs = await w.srv.connectWs(w.pat.rawSessionId);
    await patWs.waitFor("full_state");
    const states = () =>
      patWs.messages.filter(
        (m) => (m as { type?: string }).type === "full_state",
      ).length;
    const before = states();
    await setHidden(w, w.pat, false);
    await waitUntil(
      () => states() > before,
      "full_state after the view change",
    );
    expect(await mine(w, w.sam)).toEqual([made.id]);
    expect(await mine(w, w.pat)).toEqual([made.id]);
    // Kim hides it: gone from her list, and her answer is refused.
    await setHidden(w, w.kim, true);
    expect(await mine(w, w.kim)).toEqual([]);
    expect(
      (await answer(w, w.kim, made.id, "reply", { text: "me" })).status,
    ).toBe(404);
    expect(
      sorted(((await agentRead(w, made.id)).body as AskAgentWire).members),
    ).toEqual(sorted([w.nil.username, w.pat.username, w.sam.username]));
    // Everyone else hides it too: the agent reads it open, for nobody.
    for (const who of [w.nil, w.pat, w.sam]) await setHidden(w, who, true);
    const read = await agentRead(w, made.id);
    expect([read.status, (read.body as AskAgentWire).members]).toEqual([
      200,
      [],
    ]);
    expect(await openCount(w)).toBe(1);
  });

  it("refuses room with member, a room value other than true or 1, a step, and an empty audience; opens nothing", async () => {
    const w = await world();
    const outcomes: string[] = [];
    for (const [label, json] of [
      ["with member", { room: true, member: w.pat.username }],
      ["with a list", { room: true, member: [w.pat.username] }],
      ["false", { room: false }],
      ["the string true", { room: "true" }],
      ["1 as JSON", { room: 1 }],
      ["with a step", { room: true, step: { kind: "browser-pairing" } }],
    ] as const) {
      const r = await create(w, { text: "Who?", ...json });
      outcomes.push(`${label}: ${r.status} ${r.code}`);
    }
    for (const query of ["room=true", "room=0", "room=1&room=1"]) {
      const r = await createText(w, query, "Who?");
      outcomes.push(`${query}: ${r.status} ${r.code}`);
    }
    for (const who of [w.nil, w.pat, w.kim]) await setHidden(w, who, true);
    const empty = await create(w, { text: "Anyone at all?", room: true });
    outcomes.push(`nobody: ${empty.status} ${empty.code}`);
    expect(outcomes).toEqual([
      "with member: 422 invalid_members",
      "with a list: 422 invalid_members",
      "false: 422 invalid_members",
      "the string true: 422 invalid_members",
      "1 as JSON: 422 invalid_members",
      "with a step: 422 invalid_members",
      "room=true: 422 invalid_members",
      "room=0: 422 invalid_members",
      "room=1&room=1: 422 invalid_members",
      "nobody: 422 no_audience",
    ]);
    expect(await openCount(w)).toBe(0);
  });

  it("drops the card on every signed-in socket at the close: who answered goes only to members who reach the room", async () => {
    const w = await world();
    const made = await opened(w, { text: "Who locks up?", room: true });
    const sockets = {
      nil: await w.srv.connectWs(w.nil.rawSessionId),
      pat: await w.srv.connectWs(w.pat.rawSessionId),
      sam: await w.srv.connectWs(w.sam.rawSessionId),
    };
    // Nil hides the room after the card came; Pat loses the room.
    await setHidden(w, w.nil, true);
    expect(updateUserById(w.pat.id, { allowedRooms: [] })).toBeTruthy();
    expect(
      (await answer(w, w.kim, made.id, "reply", { text: "me" })).status,
    ).toBe(204);
    const removal = async (ws: (typeof sockets)["nil"]) => {
      await waitUntil(
        () =>
          ws.messages.some(
            (m) =>
              (m as { type?: string }).type === "ask_removed" &&
              (m as { id?: string }).id === made.id,
          ),
        "ask_removed",
      );
      return ws.messages.find(
        (m) =>
          (m as { type?: string }).type === "ask_removed" &&
          (m as { id?: string }).id === made.id,
      ) as { by?: string };
    };
    expect((await removal(sockets.nil)).by).toBe(w.kim.username);
    expect("by" in (await removal(sockets.pat))).toBe(false);
    expect("by" in (await removal(sockets.sam))).toBe(false);
  });

  it("keeps in the history everyone it was for at the close, and the closer", async () => {
    const w = await world();
    await setHidden(w, w.pat, true);
    const made = await opened(w, { text: "Who orders lunch?", room: true });
    expect(
      (await answer(w, w.kim, made.id, "reply", { text: "me" })).status,
    ).toBe(204);
    const found = async (name: string) =>
      (
        (
          await call(
            w.srv,
            "GET",
            `${w.base}/history?member=${name}`,
            w.agentAuth,
          )
        ).body as AskHistoryRes
      ).asks.map((a) => a.id);
    expect(await found(w.kim.username)).toEqual([made.id]);
    expect(await found(w.nil.username)).toEqual([made.id]);
    // Pat hid the room: the ask was not for Pat.
    expect(await found(w.pat.username)).toEqual([]);
    expect(await found(w.sam.username)).toEqual([]);
  });
});
