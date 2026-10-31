// Other members' open asks for an office owner (task a49856f7,
// internal-docs/asks-design.md): GET /api/asks/others lists them, the
// others_ask_* events keep them live, and the owner answers them on the
// addressee's routes, as themself (task d555a32e). A member who is not an
// owner still gets 404 there ("is only for the member it names" in
// asks.test.ts). FakeBackend only, on the real server.

import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, setUserRoleById, updateUserById } from "../users.ts";
import { askReplyNote } from "../asks.ts";
import {
  ASK_DISMISSED_TEXT,
  ASK_SIMPLIFY_TEXT,
  ASK_SIMPLIFY_UNDO_TEXT,
  type AskEntry,
  type AgentInfo,
} from "../../shared/types.ts";
import type {
  AskAgentWire,
  AskClosedWire,
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

type Res = { status: number; code?: string; body: unknown };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  auth: { bearer?: string; rawSessionId?: string },
  json?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers["Authorization"] = `Bearer ${auth.bearer}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
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

function agentOf(srv: TestServer, id: string): AgentInfo {
  const a = srv.agentManager.getAllAgents().find((x) => x.id === id);
  if (!a) throw new Error(`agent ${id} not found`);
  return a;
}

function sentTexts(srv: TestServer, agentId: string): string[] {
  return srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));
}

// Nil owns the office and manages Asker. Pat is a member who reaches the
// room and manages Pats, so a personal secret request from Pats is Pat's.
// Sam is a member who reaches the room and is asked nothing.
async function world() {
  server = await startTestServer({
    fakeBackend: new FakeBackend({
      storedSessionState: "durable",
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    }),
  });
  const owner = await server.seedOwner("Nil");
  const ownerId = getUserByName(owner.username)!.id;
  const [room] = server.agentManager.getRooms();
  const member = async (name: string) => {
    const seeded = await server!.seedMember(name);
    const id = getUserByName(seeded.username)!.id;
    expect(updateUserById(id, { allowedRooms: [room.id] })).toBeTruthy();
    return { ...seeded, id };
  };
  const pat = await member("Pat");
  const sam = await member("Sam");
  const spawn = async (name: string, managerId: string) => {
    const info = await server!.agentManager.spawn(
      name,
      server!.stateRoot,
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
      managerId,
    );
    if (!info) throw new Error(`spawn ${name} failed`);
    return info;
  };
  const asker = await spawn("Asker", ownerId);
  const pats = await spawn("Pats", pat.id);
  const as = (agentId: string) => ({ bearer: getAgentTokenRaw(agentId)! });
  return { srv: server, owner, ownerId, pat, sam, room, asker, pats, as };
}

type World = Awaited<ReturnType<typeof world>>;

// An ask from Asker; for `member` when named, else for its manager (Nil).
async function open(
  w: World,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<AskEntry> {
  const r = await call(
    w.srv,
    "POST",
    `/api/agents/${w.asker.id}/asks`,
    w.as(w.asker.id),
    { text, ...extra },
  );
  expect(r.status).toBe(201);
  return r.body as AskEntry;
}

async function secretRequest(
  w: World,
  agentId: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const r = await call(
    w.srv,
    "POST",
    `/api/agents/${agentId}/secret-requests`,
    w.as(agentId),
    {
      name: "GH_TOKEN",
      hosts: ["api.github.com"],
      reason: "To open the pull request.",
      ...body,
    },
  );
  expect(r.status).toBe(200);
  return (r.body as { requestId: string }).requestId;
}

const session = (s: { rawSessionId: string }) => ({
  rawSessionId: s.rawSessionId,
});

async function others(w: World, who: { rawSessionId: string }) {
  return call(w.srv, "GET", "/api/asks/others", session(who));
}

async function mine(w: World, who: { rawSessionId: string }) {
  const r = await call(w.srv, "GET", "/api/asks", session(who));
  expect(r.status).toBe(200);
  return r.body as AskEntry[];
}

const frames = (ws: { messages: unknown[] }, type: string) =>
  ws.messages.filter((m) => (m as { type?: string }).type === type) as {
    entry?: AskAgentWire;
    id?: string;
  }[];

describe("GET /api/asks/others", () => {
  it("lists another member's open asks for an owner, naming the member, and none the owner has in GET /api/asks", async () => {
    const w = await world();
    const own = await open(w, "Nil's?");
    const forPat = await open(w, "Pat's?", { member: w.pat.username });
    const forSam = await open(w, "Sam's?", { member: w.sam.username });
    // Enabling: each ask is open for the member it names.
    expect((await mine(w, w.owner)).map((e) => e.id)).toEqual([own.id]);
    expect((await mine(w, w.pat)).map((e) => e.id)).toEqual([forPat.id]);

    const r = await others(w, w.owner);
    expect(r.status).toBe(200);
    const listed = r.body as AskAgentWire[];
    expect(
      listed
        .map((e) => [e.id, e.agentId, e.member, e.prompt])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual(
      [
        [forPat.id, w.asker.id, w.pat.username, "Pat's?"],
        [forSam.id, w.asker.id, w.sam.username, "Sam's?"],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    // The two lists never share an id.
    const ownIds = new Set((await mine(w, w.owner)).map((e) => e.id));
    expect(listed.filter((e) => ownIds.has(e.id))).toEqual([]);

    // A closed ask leaves the list.
    const replied = await call(
      w.srv,
      "POST",
      `/api/asks/${forSam.id}/reply`,
      session(w.sam),
      { text: "done" },
    );
    expect(replied.status).toBe(204);
    expect(
      ((await others(w, w.owner)).body as AskAgentWire[]).map((e) => e.id),
    ).toEqual([forPat.id]);
  });

  it("is refused to a member who is not an owner", async () => {
    const w = await world();
    await open(w, "Nil's?");
    await open(w, "Sam's?", { member: w.sam.username });
    const r = await others(w, w.pat);
    expect(`${r.status} ${r.code}`).toBe("403 forbidden");
    expect(JSON.stringify(r.body)).not.toContain("Sam's?");
  });

  it("leaves out every secret request: a member's personal one and an office one for another owner", async () => {
    const w = await world();
    // Sam becomes a second owner, so an office request can name Sam alone.
    expect(setUserRoleById(w.sam.id, "owner")).toBe(true);
    const personal = await secretRequest(w, w.pats.id);
    const forSam = await secretRequest(w, w.pats.id, {
      name: "OFFICE_TOKEN",
      scope: "office",
      member: w.sam.username,
    });
    const plain = await open(w, "Pat's?", { member: w.pat.username });
    // Enabling: each request is open for the member it names, not for Nil.
    const ids = (entries: AskEntry[]) =>
      entries.map((e) => e.secret?.requestId ?? e.id);
    expect(ids(await mine(w, w.pat))).toEqual([personal, plain.id]);
    expect(ids(await mine(w, w.sam))).toEqual([forSam]);
    expect(ids(await mine(w, w.owner))).toEqual([]);

    const r = await others(w, w.owner);
    expect(r.status).toBe(200);
    expect((r.body as AskAgentWire[]).map((e) => e.id)).toEqual([plain.id]);
  });
});

describe("an owner answers another member's ask", () => {
  it("replies, dismisses and files a task as the owner: the agent reads the owner's name, the ask closes for the member, and the record names the owner", async () => {
    const w = await world();
    const replied = await open(w, "Ship it?", { member: w.pat.username });
    const dismissed = await open(w, "Rename it?", { member: w.pat.username });
    const filed = await open(w, "Refactor it?", { member: w.pat.username });
    const all = [replied.id, dismissed.id, filed.id].sort();
    // Enabling: the three are Pat's, and Nil lists them as another member's.
    expect((await mine(w, w.pat)).map((e) => e.id).sort()).toEqual(all);
    expect(
      ((await others(w, w.owner)).body as AskAgentWire[])
        .map((e) => e.id)
        .sort(),
    ).toEqual(all);

    const answers = [
      [replied.id, "reply", { text: "Nil says yes" }, 204],
      [dismissed.id, "dismiss", {}, 204],
      [filed.id, "file-task", { text: "After the launch." }, 201],
    ] as const;
    for (const [id, verb, json, status] of answers) {
      const r = await call(
        w.srv,
        "POST",
        `/api/asks/${id}/${verb}`,
        session(w.owner),
        json,
      );
      expect(`${verb} ${r.status}`).toBe(`${verb} ${status}`);
    }
    const [task] = w.srv.agentManager.getTasks();
    expect(task?.roomId).toBe(w.room.id);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).length === 3,
      "the three answers delivered",
    );
    // Under Nil's name, not Pat's.
    const by = `[${w.owner.username}] `;
    expect(sentTexts(w.srv, w.asker.id)).toEqual([
      `${by}${askReplyNote(replied)}Nil says yes`,
      `${by}${askReplyNote({ ...dismissed, dismissed: true })}${ASK_DISMISSED_TEXT}`,
      `${by}${askReplyNote({ ...filed, taskId: task.id })}After the launch.`,
    ]);
    expect(await mine(w, w.pat)).toEqual([]);
    expect((await others(w, w.owner)).body).toEqual([]);
    for (const [id, outcome] of [
      [replied.id, "replied"],
      [dismissed.id, "dismissed"],
      [filed.id, "filed"],
    ]) {
      const r = await call(
        w.srv,
        "GET",
        `/api/agents/${w.asker.id}/asks/${id}`,
        w.as(w.asker.id),
      );
      const closed = (r.body as AskClosedWire).closed;
      expect([id, closed?.outcome, closed?.by]).toEqual([
        id,
        outcome,
        w.owner.username,
      ]);
    }
  });

  it("asks for a simpler wording and withdraws that request as the owner, and the ask stays open for the member", async () => {
    const w = await world();
    const forPat = await open(w, "Pat's?", { member: w.pat.username });
    const post = (verb: string) =>
      call(
        w.srv,
        "POST",
        `/api/asks/${forPat.id}/${verb}`,
        session(w.owner),
        {},
      );
    const mark = async () =>
      (await mine(w, w.pat)).map((e) => [e.id, typeof e.simplifyRequestedAt]);

    expect((await post("simplify")).status).toBe(204);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).length === 1,
      "simplify delivered",
    );
    expect(await mark()).toEqual([[forPat.id, "number"]]);
    expect((await post("simplify/undo")).status).toBe(204);
    await waitUntil(
      () => sentTexts(w.srv, w.asker.id).length === 2,
      "withdrawal delivered",
    );
    expect(await mark()).toEqual([[forPat.id, "undefined"]]);
    const by = `[${w.owner.username}] `;
    expect(sentTexts(w.srv, w.asker.id)).toEqual([
      `${by}${askReplyNote({ ...forPat, simplify: true })}${ASK_SIMPLIFY_TEXT}`,
      `${by}${askReplyNote({ ...forPat, simplifyUndone: true })}${ASK_SIMPLIFY_UNDO_TEXT}`,
    ]);
  });

  it("still refuses an owner another member's personal secret request, as for an unknown id", async () => {
    const w = await world();
    const requestId = await secretRequest(w, w.pats.id);
    const entry = (await mine(w, w.pat)).find(
      (e) => e.secret?.requestId === requestId,
    );
    // Enabling: Pat has it open, so a refusal is not for an unknown id.
    expect(entry).toBeDefined();
    for (const [verb, json] of [
      ["reply", { text: "s3cret" }],
      ["dismiss", {}],
      ["file-task", {}],
      ["simplify", {}],
    ] as const) {
      const r = await call(
        w.srv,
        "POST",
        `/api/asks/${entry!.id}/${verb}`,
        session(w.owner),
        json,
      );
      expect(`${verb} ${r.status} ${r.code}`).toBe(`${verb} 404 not_found`);
    }
    expect(w.srv.agentManager.getTasks()).toEqual([]);
    expect(sentTexts(w.srv, w.pats.id)).toEqual([]);
    expect((await mine(w, w.pat)).map((e) => e.id)).toEqual([entry!.id]);
  });
});

describe("another member's ask: files", () => {
  it("serves an owner a file another member's ask references in place, and still not a member it is not for", async () => {
    const w = await world();
    const cwd = agentOf(w.srv, w.asker.id).cwd;
    const VIDEO = Buffer.from([1, 2, 3, 4, 5]);
    writeFileSync(join(cwd, "clip.mp4"), VIDEO);
    const forPat = await open(w, "Publish?", {
      member: w.pat.username,
      readFiles: ["clip.mp4"],
    });
    const [ref] = forPat.readFiles ?? [];
    // Enabling: the file is referenced where it is (a path, no copy), so it
    // is served through the ask's own file route.
    expect(ref?.path).toBe(join(cwd, "clip.mp4"));
    const fetchAs = async (who: { rawSessionId: string }) => {
      const res = await w.srv.http(
        `/api/asks/${forPat.id}/files/${ref.filename}`,
        { method: "GET", rawSessionId: who.rawSessionId },
      );
      return {
        status: res.status,
        bytes: res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null,
      };
    };
    expect(await fetchAs(w.pat)).toEqual({ status: 200, bytes: VIDEO });
    expect(await fetchAs(w.owner)).toEqual({ status: 200, bytes: VIDEO });
    expect((await fetchAs(w.sam)).status).toBe(404);
  });
});

describe("live", () => {
  it("pushes another member's ask and its close to an owner's socket, never the owner's own ask, a secret request or a non-owner's socket", async () => {
    const w = await world();
    const nil = await w.srv.connectWs(w.owner.rawSessionId);
    const pat = await w.srv.connectWs(w.pat.rawSessionId);
    const sam = await w.srv.connectWs(w.sam.rawSessionId);

    const own = await open(w, "Nil's?");
    const personal = await secretRequest(w, w.pats.id);
    const forPat = await open(w, "Pat's?", { member: w.pat.username });
    await waitUntil(
      () => frames(nil, "others_ask_upserted").length > 0,
      "Nil hears Pat's ask",
    );
    // Enabling: Nil hears its own ask and Pat hears both of Pat's on the
    // existing events; the sockets saw every create by now.
    await waitUntil(
      () =>
        frames(nil, "ask_upserted").some((f) => f.entry?.id === own.id) &&
        frames(pat, "ask_upserted").some((f) => f.entry?.id === forPat.id) &&
        frames(pat, "ask_upserted").some(
          (f) => f.entry?.secret?.requestId === personal,
        ),
      "the addressees hear their asks",
    );
    const up = frames(nil, "others_ask_upserted");
    expect(up.map((f) => [f.entry?.id, f.entry?.member])).toEqual([
      [forPat.id, w.pat.username],
    ]);

    const replied = await call(
      w.srv,
      "POST",
      `/api/asks/${forPat.id}/reply`,
      session(w.pat),
      { text: "done" },
    );
    expect(replied.status).toBe(204);
    await waitUntil(
      () => frames(nil, "others_ask_removed").some((f) => f.id === forPat.id),
      "Nil hears Pat's ask close",
    );
    // Sam sees the room, so the reply's chat line reaches Sam after every
    // ask frame above would have.
    await waitUntil(
      () =>
        sam.messages.some((m) => {
          const e = (m as { type?: string; entry?: { content?: unknown } })
            .entry;
          return (
            (m as { type?: string }).type === "log_entry" &&
            e?.content === "done"
          );
        }),
      "Sam sees the reply in the chat",
    );
    for (const ws of [pat, sam])
      expect(
        ws.messages.filter((m) =>
          String((m as { type?: string }).type).startsWith("others_ask_"),
        ),
      ).toEqual([]);
  });
});
