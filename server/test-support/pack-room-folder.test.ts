// The room folder of a member with a permission pack (task 329974fe), through
// the real HTTP server. A member whose pack goes below Standard makes no room
// and sets no folder: their agents work in their room's folder itself, and a
// Folder or Web agent of theirs anywhere else moves to Office (at a pack save,
// at boot, at a move, at a room folder change, at a revive). Agents below
// Standard of one room share its folder; a full agent, a schedule or an app
// may not work there, and nothing breaks a share it leaves behind. No agent,
// schedule or app works inside the office state. The pure rules are in
// ../agent-folder-rules.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend, type FakeSession } from "./fake-backend.ts";
import { getUserByName } from "../users.ts";
import { STATE_ROOT } from "../config.ts";
import type { MemberPack } from "../../shared/pack-fit.ts";
import type { AgentInfo, Cronjob } from "../../shared/types.ts";

// Protocol values: the refusal codes.
const FOLDER_NOT_ALLOWED = "folder_not_allowed";
const PACK_CREATES_NO_ROOM = "pack_creates_no_room";
const PACK_SETS_NO_FOLDER = "pack_sets_no_folder";

let server: TestServer | null = null;
const folders: string[] = [];
afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

function freshFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-room-folder-"));
  folders.push(dir);
  return dir;
}

function subdir(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface Res {
  status: number;
  body: unknown;
}

const errorOf = (res: Res) =>
  ((res.body as { error?: Record<string, unknown> } | null)?.error ??
    {}) as Record<string, unknown>;
const outcome = (res: Res) => ({
  status: res.status,
  code: errorOf(res).code as string | undefined,
});
const REFUSED = { status: 422, code: FOLDER_NOT_ALLOWED };
const NO_FOLDER = { status: 403, code: PACK_SETS_NO_FOLDER };

// The member's pack: below Standard, with what the routes here need.
const PACK: MemberPack = {
  areas: { agents: "write", agentManagement: "write", rooms: "write" },
  agentCeiling: "web",
};
// The pack a Folder or Web agent gets at spawn.
const AGENT_PACK = { areas: { agents: "read" } } as const;

// Morgan owns the office and Casey is a member with access to `rooms`. The
// first room's folder is `roomFolder`.
async function office() {
  const fakeBackend = new FakeBackend({
    storedSessionState: "durable",
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
  const srv = await startTestServer({ fakeBackend });
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Casey");
  const room = srv.agentManager.getRooms()[0].id;
  const o = {
    srv,
    owner: owner.rawSessionId,
    ownerName: owner.username,
    ownerId: getUserByName(owner.username)!.id,
    casey: member.rawSessionId,
    caseyName: member.username,
    caseyId: getUserByName(member.username)!.id,
    room,
    rooms: [room],
    roomFolder: freshFolder(),
  };
  // Casey uses the office's rooms, with no pack yet.
  await packCasey(o, null);
  const set = await asOwner(o, "PATCH", `/api/rooms/${room}`, {
    cwd: o.roomFolder,
  });
  expect(set.status).toBeLessThan(300);
  expect(roomCwd(o, room)).toBe(o.roomFolder);
  return o;
}
type Office = Awaited<ReturnType<typeof office>>;

async function asSession(
  o: Office,
  session: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await o.srv.http(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    rawSessionId: session,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const asOwner = (o: Office, method: string, path: string, body?: unknown) =>
  asSession(o, o.owner, method, path, body);
const asCasey = (o: Office, method: string, path: string, body?: unknown) =>
  asSession(o, o.casey, method, path, body);

async function packCasey(o: Office, pack: MemberPack | null): Promise<void> {
  const res = await asOwner(o, "PUT", `/api/users/${o.caseyName}/access`, {
    allowedRooms: o.rooms,
    pack,
  });
  expect({
    status: res.status,
    pack: getUserByName(o.caseyName)?.pack,
  }).toEqual({ status: 200, pack: pack ?? undefined });
}

// A room the owner makes, with `folder` when given; Casey may use it.
async function newRoom(o: Office, folder?: string): Promise<string> {
  const res = await asOwner(o, "POST", "/api/rooms", { name: "Second" });
  expect(res.status).toBe(201);
  const id = (res.body as { room: { id: string } }).room.id;
  if (folder !== undefined)
    expect(
      (await asOwner(o, "PATCH", `/api/rooms/${id}`, { cwd: folder })).status,
    ).toBeLessThan(300);
  o.rooms.push(id);
  return id;
}

const roomCwd = (o: Office, id: string): string | null | undefined =>
  o.srv.agentManager.getRooms().find((r) => r.id === id)?.cwd;

// A spawn through the route. `who` picks the session.
async function spawnVia(
  o: Office,
  who: "owner" | "casey",
  name: string,
  opts: {
    access?: "chat" | "office" | "folder" | "web" | "standard";
    cwd?: string;
    roomId?: string;
  } = {},
): Promise<Res> {
  const access = opts.access ?? "folder";
  const body = {
    name,
    roomId: opts.roomId ?? o.room,
    agentType: "claude",
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(access !== "standard"
      ? {
          access,
          ...(access === "chat" ? {} : { pack: AGENT_PACK }),
        }
      : {}),
  };
  return who === "owner"
    ? asOwner(o, "POST", "/api/agents", body)
    : asCasey(o, "POST", "/api/agents", body);
}

async function spawned(
  o: Office,
  who: "owner" | "casey",
  name: string,
  opts: Parameters<typeof spawnVia>[3] = {},
): Promise<AgentInfo> {
  const res = await spawnVia(o, who, name, opts);
  expect({ name, ...outcome(res) }).toEqual({
    name,
    status: 201,
    code: undefined,
  });
  return (res.body as { agent: AgentInfo }).agent;
}

const agentOf = (o: Office, id: string): AgentInfo => {
  const agent = o.srv.agentManager.getAgent(id);
  if (!agent) throw new Error(`no live agent ${id}`);
  return agent;
};
const accessOf = (o: Office, id: string) => agentOf(o, id).access ?? "standard";

const markSessions = (o: Office) => new Set(o.srv.fakeBackend.sessions);
const sessionsSince = (
  o: Office,
  agentId: string,
  mark: ReadonlySet<FakeSession>,
): FakeSession[] =>
  o.srv.fakeBackend.sessions.filter(
    (s) => s.opts.agentId === agentId && !mark.has(s),
  );
const sentTexts = (o: Office, agentId: string): string[] =>
  o.srv.fakeBackend.sessions
    .filter((s) => s.opts.agentId === agentId)
    .flatMap((s) => s.sent.map((m) => m.text));

async function waitUntil(pred: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await Bun.sleep(10);
  }
}

// The owner talks to an agent, which makes its session.
async function talkTo(o: Office, agentId: string, text: string) {
  const res = await asOwner(o, "POST", `/api/agents/${agentId}/messages`, {
    text,
  });
  expect(res.status).toBe(200);
  await waitUntil(
    () => sentTexts(o, agentId).some((t) => t.includes(text)),
    `${agentId} got "${text}"`,
  );
}

// Rewrites a path in a state file, as a hand edit or an older version would
// have left it.
function rewriteInFile(file: string, from: string, to: string) {
  const text = readFileSync(file, "utf8");
  expect(text.includes(JSON.stringify(from).slice(1, -1))).toBe(true);
  writeFileSync(
    file,
    text.replaceAll(
      JSON.stringify(from).slice(1, -1),
      JSON.stringify(to).slice(1, -1),
    ),
  );
}

describe("a member with a pack sets no folder", () => {
  it("makes no room and sets no room folder; an owner and a member without a pack do", async () => {
    const o = await office();
    await packCasey(o, PACK);
    const rooms = o.srv.agentManager.getRooms().length;
    expect(
      outcome(await asCasey(o, "POST", "/api/rooms", { name: "Mine" })),
    ).toEqual({ status: 403, code: PACK_CREATES_NO_ROOM });
    expect(o.srv.agentManager.getRooms()).toHaveLength(rooms);

    const elsewhere = freshFolder();
    const name = o.srv.agentManager.getRooms()[0].name;
    for (const body of [
      { cwd: elsewhere },
      { name: "Renamed", cwd: elsewhere },
    ])
      expect({
        body,
        ...outcome(await asCasey(o, "PATCH", `/api/rooms/${o.room}`, body)),
      }).toEqual({
        body,
        ...NO_FOLDER,
      });
    // A body with a name and a folder writes nothing.
    expect({
      cwd: roomCwd(o, o.room),
      name: o.srv.agentManager.getRooms()[0].name,
    }).toEqual({ cwd: o.roomFolder, name });
    // The enabling condition: the pack lets the member rename the room.
    expect(
      (await asCasey(o, "PATCH", `/api/rooms/${o.room}`, { name: "Renamed" }))
        .status,
    ).toBeLessThan(300);

    // An owner does both.
    const second = await newRoom(o, elsewhere);
    expect(roomCwd(o, second)).toBe(elsewhere);
    // So does a member without a pack.
    await packCasey(o, null);
    expect(
      (await asCasey(o, "POST", "/api/rooms", { name: "Mine" })).status,
    ).toBe(201);
  });

  it("spawns only in the room folder: no folder or the room folder itself passes, any other is refused at every stop", async () => {
    const o = await office();
    await packCasey(o, PACK);
    const none = await spawned(o, "casey", "No folder");
    const echo = await spawned(o, "casey", "Echo", { cwd: o.roomFolder });
    expect({
      none: [none.cwd, accessOf(o, none.id)],
      echo: [echo.cwd, accessOf(o, echo.id)],
    }).toEqual({
      none: [o.roomFolder, "folder"],
      echo: [o.roomFolder, "folder"],
    });

    const link = join(freshFolder(), "to-room");
    symlinkSync(o.roomFolder, link);
    const before = o.srv.agentManager.getAllAgents().length;
    for (const [label, cwd] of [
      ["a folder elsewhere", freshFolder()],
      ["a subfolder of the room folder", subdir(o.roomFolder, "sub")],
      ["a link to the room folder", link],
    ] as const)
      for (const access of ["folder", "office", "chat"] as const)
        expect({
          label,
          access,
          ...outcome(
            await spawnVia(o, "casey", `${label} ${access}`, { cwd, access }),
          ),
        }).toEqual({ label, access, ...NO_FOLDER });
    expect(o.srv.agentManager.getAllAgents()).toHaveLength(before);

    // The owner sets any folder.
    const own = await spawned(o, "owner", "Owner's", {
      access: "standard",
      cwd: freshFolder(),
    });
    expect(accessOf(o, own.id)).toBe("standard");
  });

  it("changes no agent's folder; an owner moving the member's Folder agent meets the room-folder rule", async () => {
    const o = await office();
    await packCasey(o, PACK);
    const mine = await spawned(o, "casey", "Mine");
    const elsewhere = freshFolder();
    expect(
      outcome(
        await asCasey(o, "PATCH", `/api/agents/${mine.id}`, { cwd: elsewhere }),
      ),
    ).toEqual(NO_FOLDER);
    // The folder it has already is no change.
    expect(
      (
        await asCasey(o, "PATCH", `/api/agents/${mine.id}`, {
          cwd: o.roomFolder,
        })
      ).status,
    ).toBeLessThan(300);
    expect(
      outcome(
        await asOwner(o, "PATCH", `/api/agents/${mine.id}`, { cwd: elsewhere }),
      ),
    ).toEqual(REFUSED);
    expect(agentOf(o, mine.id).cwd).toBe(o.roomFolder);
  });

  it("a Folder spawn in a room with no folder makes the agent at Office", async () => {
    const o = await office();
    const bare = await newRoom(o);
    expect(roomCwd(o, bare) ?? null).toBeNull();
    await packCasey(o, PACK);
    const agent = await spawned(o, "casey", "Bare", { roomId: bare });
    expect(accessOf(o, agent.id)).toBe("office");
    // The enabling condition: in a room with a folder it stays at Folder.
    const kept = await spawned(o, "casey", "Kept");
    expect(accessOf(o, kept.id)).toBe("folder");
  });
});

describe("agents below Standard of one room share its folder", () => {
  it("Folder, Web and Office agents of any manager share it; a full agent and an agent of another room may not", async () => {
    const o = await office();
    await packCasey(o, PACK);
    const a = await spawned(o, "casey", "A");
    const b = await spawned(o, "casey", "B", { access: "web" });
    const c = await spawned(o, "casey", "C", { access: "office" });
    const d = await spawned(o, "owner", "D", { cwd: o.roomFolder });
    expect(
      [a, b, c, d].map((x) => [
        x.name,
        agentOf(o, x.id).cwd,
        accessOf(o, x.id),
      ]),
    ).toEqual([
      ["A", o.roomFolder, "folder"],
      ["B", o.roomFolder, "web"],
      ["C", o.roomFolder, "office"],
      ["D", o.roomFolder, "folder"],
    ]);

    // A full agent at or above the room folder.
    for (const cwd of [o.roomFolder, dirname(o.roomFolder)])
      expect({
        cwd,
        ...outcome(
          await spawnVia(o, "owner", "Full", { access: "standard", cwd }),
        ),
      }).toEqual({ cwd, ...REFUSED });
    // An agent of another room with the same folder.
    const twin = await newRoom(o, o.roomFolder);
    for (const access of ["folder", "office"] as const)
      expect({
        access,
        ...outcome(
          await spawnVia(o, "owner", "Twin", {
            access,
            cwd: o.roomFolder,
            roomId: twin,
          }),
        ),
      }).toEqual({ access, ...REFUSED });

    // A sharer raised to Standard would be a full agent at the others'
    // folder.
    for (const access of ["standard", "privileged"] as const)
      expect({
        access,
        ...outcome(
          await asOwner(o, "PUT", `/api/agents/${d.id}/access`, { access }),
        ),
      }).toEqual({ access, ...REFUSED });
    expect(accessOf(o, d.id)).toBe("folder");
    // The enabling condition: a Folder agent alone in its folder goes up.
    const alone = await spawned(o, "owner", "Alone", { cwd: freshFolder() });
    expect(
      (
        await asOwner(o, "PUT", `/api/agents/${alone.id}/access`, {
          access: "standard",
        })
      ).status,
    ).toBe(200);
  });

  it("an agent that drops to Office keeps the share: the other agents of the room still start", async () => {
    const o = await office();
    await packCasey(o, PACK);
    const mine = await spawned(o, "casey", "Mine");
    const owners = await spawned(o, "owner", "Owner's", { cwd: o.roomFolder });
    // A lower ceiling moves the member's agent to Office, in the same folder.
    await packCasey(o, { ...PACK, agentCeiling: "office" });
    await waitUntil(() => accessOf(o, mine.id) === "office", "the move landed");
    expect(agentOf(o, mine.id).cwd).toBe(o.roomFolder);

    let mark = markSessions(o);
    await talkTo(o, owners.id, "after the drop");
    expect(
      sessionsSince(o, owners.id, mark).map((s) => s.opts.access),
    ).toContain("folder");
    // And after a boot.
    mark = markSessions(o);
    o.srv = await o.srv.restart();
    server = o.srv;
    await talkTo(o, owners.id, "after the boot");
    expect(accessOf(o, owners.id)).toBe("folder");
    expect(
      sessionsSince(o, owners.id, mark).map((s) => s.opts.access),
    ).toContain("folder");
  });
});

describe("the member's Folder agents outside the room folder move to Office", () => {
  async function before(o: Office) {
    // Before the pack: Casey's agents at the room folder and elsewhere, and
    // the owner's elsewhere.
    const atRoom = await spawned(o, "casey", "At the room");
    const elsewhere = await spawned(o, "casey", "Elsewhere", {
      cwd: freshFolder(),
    });
    const owners = await spawned(o, "owner", "Owner's", { cwd: freshFolder() });
    return { atRoom, elsewhere, owners };
  }

  it("at a pack save", async () => {
    const o = await office();
    const { atRoom, elsewhere, owners } = await before(o);
    await packCasey(o, PACK);
    await waitUntil(
      () => accessOf(o, elsewhere.id) === "office",
      "the move landed",
    );
    expect({
      atRoom: accessOf(o, atRoom.id),
      elsewhere: [
        accessOf(o, elsewhere.id),
        agentOf(o, elsewhere.id).pack?.areas,
      ],
      owners: accessOf(o, owners.id),
    }).toEqual({
      atRoom: "folder",
      // It keeps its pack, inside the member's areas.
      elsewhere: ["office", AGENT_PACK.areas],
      owners: "folder",
    });
  });

  it("at boot, before any session (the update to this version)", async () => {
    const o = await office();
    const { atRoom, elsewhere, owners } = await before(o);
    // A pack saved by a version without the room-folder rule.
    const file = join(STATE_ROOT, "users.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    Object.values(raw).find((u) => u.name === o.caseyName)!.pack = PACK;
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const mark = markSessions(o);
    o.srv = await o.srv.restart();
    server = o.srv;
    await waitUntil(
      () => accessOf(o, elsewhere.id) === "office",
      "the boot moved it",
    );
    expect({
      atRoom: accessOf(o, atRoom.id),
      owners: accessOf(o, owners.id),
    }).toEqual({ atRoom: "folder", owners: "folder" });
    await talkTo(o, elsewhere.id, "after the boot");
    const stops = sessionsSince(o, elsewhere.id, mark).map(
      (s) => s.opts.access,
    );
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.every((s) => s === "office")).toBe(true);
  });

  it("at a move to another room; a move that leaves a share behind is refused", async () => {
    const o = await office();
    const other = await newRoom(o, freshFolder());
    await packCasey(o, PACK);
    const a = await spawned(o, "casey", "A");
    const b = await spawned(o, "casey", "B");
    // A shares the room folder with B: the move is refused and changes
    // nothing.
    expect(
      outcome(
        await asCasey(o, "POST", `/api/agents/${a.id}/move`, {
          targetRoomId: other,
        }),
      ),
    ).toEqual(REFUSED);
    expect([agentOf(o, a.id).roomId, accessOf(o, a.id)]).toEqual([
      o.room,
      "folder",
    ]);
    // Alone, it moves, and lands at Office: the other room's folder is not
    // its folder.
    expect(
      (await asOwner(o, "DELETE", `/api/agents/${b.id}`)).status,
    ).toBeLessThan(300);
    expect(
      (
        await asCasey(o, "POST", `/api/agents/${a.id}/move`, {
          targetRoomId: other,
        })
      ).status,
    ).toBe(200);
    await waitUntil(() => accessOf(o, a.id) === "office", "the move landed");
    expect(agentOf(o, a.id).roomId).toBe(other);
  });

  it("at a room folder change; a change that leaves a share behind with an agent outside the pack is refused", async () => {
    const o = await office();
    await packCasey(o, PACK);
    const a = await spawned(o, "casey", "A");
    const b = await spawned(o, "casey", "B");
    const owners = await spawned(o, "owner", "Owner's", { cwd: o.roomFolder });
    const next = freshFolder();
    expect(
      outcome(await asOwner(o, "PATCH", `/api/rooms/${o.room}`, { cwd: next })),
    ).toEqual(REFUSED);
    expect(roomCwd(o, o.room)).toBe(o.roomFolder);
    expect([a, b, owners].map((x) => accessOf(o, x.id))).toEqual([
      "folder",
      "folder",
      "folder",
    ]);
    // Without the owner's agent the change passes, and the member's agents
    // move to Office.
    expect(
      (await asOwner(o, "DELETE", `/api/agents/${owners.id}`)).status,
    ).toBeLessThan(300);
    expect(
      (await asOwner(o, "PATCH", `/api/rooms/${o.room}`, { cwd: next })).status,
    ).toBeLessThan(300);
    await waitUntil(
      () => [a, b].every((x) => accessOf(o, x.id) === "office"),
      "the moves landed",
    );
  });

  it("at a revive into a room whose folder changed", async () => {
    const o = await office();
    await packCasey(o, PACK);
    const a = await spawned(o, "casey", "A");
    expect(
      (await asOwner(o, "DELETE", `/api/agents/${a.id}`)).status,
    ).toBeLessThan(300);
    expect(
      (
        await asOwner(o, "PATCH", `/api/rooms/${o.room}`, {
          cwd: freshFolder(),
        })
      ).status,
    ).toBeLessThan(300);
    const mark = markSessions(o);
    const revived = await asCasey(o, "POST", `/api/agents/${a.id}/revive`, {
      roomId: o.room,
    });
    expect(revived.status).toBe(200);
    expect(accessOf(o, a.id)).toBe("office");
    await talkTo(o, a.id, "after the revive");
    const stops = sessionsSince(o, a.id, mark).map((s) => s.opts.access);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.every((s) => s === "office")).toBe(true);
  });

  it("a resume does not take the agent back to a folder the rules refuse", async () => {
    const o = await office();
    const old = freshFolder();
    const x = await spawned(o, "casey", "X", { access: "standard", cwd: old });
    await talkTo(o, x.id, "in the old folder");
    const oldSession = o.srv.fakeBackend.sessions.find(
      (s) => s.opts.agentId === x.id,
    )!.sessionId;
    await packCasey(o, PACK);
    await waitUntil(() => accessOf(o, x.id) === "office", "the pack moved it");
    // The owner puts it in the room folder at Folder, in a new conversation.
    expect(
      (await asOwner(o, "POST", `/api/agents/${x.id}/new-conversation`, {}))
        .status,
    ).toBeLessThan(300);
    expect(
      (await asOwner(o, "PATCH", `/api/agents/${x.id}`, { cwd: o.roomFolder }))
        .status,
    ).toBe(200);
    expect(
      (
        await asOwner(o, "PUT", `/api/agents/${x.id}/access`, {
          access: "folder",
          pack: AGENT_PACK,
        })
      ).status,
    ).toBe(200);
    await talkTo(o, x.id, "in the room folder");

    const sock = await o.srv.connectWs(o.owner);
    const seen = sock.messages.length;
    const mark = markSessions(o);
    expect(
      (
        await asOwner(o, "POST", `/api/agents/${x.id}/resume`, {
          sessionId: oldSession,
        })
      ).status,
    ).toBe(204);
    // The resume ends with a line in the agent's chat.
    const resumeLogged = () =>
      sock.messages
        .slice(seen)
        .some(
          (m) =>
            (m as { type?: string }).type === "log_entry" &&
            JSON.stringify(m).includes(x.id),
        );
    await waitUntil(resumeLogged, "the resume ended");
    expect({
      cwd: agentOf(o, x.id).cwd,
      access: accessOf(o, x.id),
      resumedInOld: sessionsSince(o, x.id, mark).some(
        (s) => s.opts.cwd === old,
      ),
      // The folder never switched, not even for a moment.
      switchedToOld: sock.messages
        .slice(seen)
        .some(
          (m) =>
            (m as { type?: string }).type === "agent_updated" &&
            JSON.stringify(m).includes(JSON.stringify(old).slice(1, -1)),
        ),
    }).toEqual({
      cwd: o.roomFolder,
      access: "folder",
      resumedInOld: false,
      switchedToOld: false,
    });
    sock.close();
  });

  it("a revive does not put an agent where it breaks a share or meets one", async () => {
    const o = await office();
    const other = await newRoom(o, freshFolder());
    await packCasey(o, PACK);
    // A full agent of the owner at the room folder, killed; then the member's
    // agents share the folder.
    const full = await spawned(o, "owner", "Full", {
      access: "standard",
      cwd: o.roomFolder,
    });
    const atOffice = await spawned(o, "owner", "Office", {
      access: "office",
      cwd: o.roomFolder,
    });
    for (const id of [full.id, atOffice.id])
      expect(
        (await asOwner(o, "DELETE", `/api/agents/${id}`)).status,
      ).toBeLessThan(300);
    const a = await spawned(o, "casey", "A");
    const b = await spawned(o, "casey", "B");

    // Back as a full agent at their folder.
    expect(
      outcome(
        await asOwner(o, "POST", `/api/agents/${full.id}/revive`, {
          roomId: o.room,
        }),
      ),
    ).toEqual(REFUSED);
    // Back in another room at their folder: the share would break.
    expect(
      outcome(
        await asOwner(o, "POST", `/api/agents/${atOffice.id}/revive`, {
          roomId: other,
        }),
      ),
    ).toEqual(REFUSED);
    expect(
      [full.id, atOffice.id].map((id) =>
        o.srv.agentManager.getAllAgents().some((x) => x.id === id),
      ),
    ).toEqual([false, false]);
    // The member's agents still start.
    const mark = markSessions(o);
    await talkTo(o, a.id, "after the revives");
    expect(sessionsSince(o, a.id, mark).map((s) => s.opts.access)).toContain(
      "folder",
    );
    // The enabling condition: the Office agent comes back in its own room.
    expect(
      (
        await asOwner(o, "POST", `/api/agents/${atOffice.id}/revive`, {
          roomId: o.room,
        })
      ).status,
    ).toBe(200);
    expect(accessOf(o, b.id)).toBe("folder");
  });
});

describe("no agent, schedule or app works inside the office state", () => {
  it("refuses a folder inside the state at every stop and route; holding the state passes", async () => {
    const o = await office();
    const inside = subdir(o.srv.stateRoot, "work-inside");
    expect(
      outcome(
        await spawnVia(o, "owner", "Inside", {
          access: "standard",
          cwd: inside,
        }),
      ),
    ).toEqual(REFUSED);
    const agent = await spawned(o, "owner", "Movable", {
      access: "standard",
      cwd: freshFolder(),
    });
    expect(
      outcome(
        await asOwner(o, "PATCH", `/api/agents/${agent.id}`, { cwd: inside }),
      ),
    ).toEqual(REFUSED);
    expect(
      outcome(
        await asOwner(o, "POST", "/api/cronjobs", {
          name: "Nightly",
          schedule: { type: "interval", minutes: 60 },
          prompt: "do the thing",
          cwd: inside,
          agentType: "claude",
          modelFamily: "opus",
          effort: "medium",
          permissionMode: "bypassPermissions",
        }),
      ),
    ).toEqual(REFUSED);
    expect(
      outcome(
        await asOwner(o, "POST", "/api/apps", {
          name: "inside-app",
          command: "bun run serve.ts",
          cwd: inside,
        }),
      ),
    ).toEqual(REFUSED);
    const roomRes = await asOwner(o, "PATCH", `/api/rooms/${o.room}`, {
      cwd: inside,
    });
    expect(roomRes.status).toBeGreaterThanOrEqual(400);
    expect(roomRes.status).toBeLessThan(500);
    expect(roomCwd(o, o.room)).toBe(o.roomFolder);

    // The enabling condition: the folder that holds the state passes.
    const holder = await spawned(o, "owner", "Holder", {
      access: "standard",
      cwd: dirname(o.srv.stateRoot),
    });
    expect(accessOf(o, holder.id)).toBe("standard");
  });

  it("an agent, a schedule and an app already inside the state do not start", async () => {
    const o = await office();
    const inside = subdir(o.srv.stateRoot, "work-inside");
    const before = freshFolder();
    const agent = await spawned(o, "owner", "Moved in", {
      access: "standard",
      cwd: before,
    });
    const control = await spawned(o, "owner", "Control", {
      access: "standard",
      cwd: freshFolder(),
    });
    expect(
      (
        await asOwner(o, "POST", "/api/apps", {
          name: "moved-app",
          command: "bun run serve.ts",
          cwd: before,
        })
      ).status,
    ).toBe(201);

    // An older version, or a hand edit, put both inside the state.
    for (const file of [
      join(STATE_ROOT, "agents.json"),
      join(STATE_ROOT, "apps", "apps.json"),
    ])
      rewriteInFile(file, before, inside);
    o.srv = await o.srv.restart();
    server = o.srv;
    expect(agentOf(o, agent.id).cwd).toBe(inside);

    const mark = markSessions(o);
    // The enabling condition: an agent elsewhere starts.
    await talkTo(o, control.id, "to the control");
    expect(
      (
        await asOwner(o, "POST", `/api/agents/${agent.id}/messages`, {
          text: "to the agent inside",
        })
      ).status,
    ).toBeLessThan(300);
    await Bun.sleep(200);
    expect(sessionsSince(o, agent.id, mark)).toEqual([]);

    // A schedule an older version left inside the state (the harness loads
    // no schedules at a restart, so it is put there past the route).
    const created = await asOwner(o, "POST", "/api/cronjobs", {
      name: "Nightly",
      schedule: { type: "interval", minutes: 60 },
      prompt: "do the thing",
      cwd: before,
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "bypassPermissions",
    });
    expect(created.status).toBe(201);
    const job = created.body as Cronjob;
    o.srv.cronjobManager.updateCronjob(job.id, { cwd: inside });
    expect(
      o.srv.cronjobManager.listCronjobs().find((j) => j.id === job.id)?.cwd,
    ).toBe(inside);
    const seen = new Set(
      o.srv.cronjobManager.getRunsForCronjob(job.id).map((r) => r.id),
    );
    const sessions = o.srv.fakeBackend.createSessionCount;
    expect(
      (await asOwner(o, "POST", `/api/cronjobs/${job.id}/runs`, {})).status,
    ).toBeLessThan(300);
    const fresh = () =>
      o.srv.cronjobManager
        .getRunsForCronjob(job.id)
        .find((r) => !seen.has(r.id));
    await waitUntil(
      () => fresh() !== undefined && fresh()!.status !== "running",
      "the run ended",
    );
    expect(fresh()!.status).toBe("failed");
    expect(o.srv.fakeBackend.createSessionCount).toBe(sessions);

    const calls = o.srv.appSupervisor.calls;
    const callMark = calls.length;
    expect(
      (await asOwner(o, "POST", "/api/apps/moved-app/start", {})).status,
    ).toBeGreaterThanOrEqual(400);
    expect(calls.slice(callMark)).not.toContain("start:moved-app");
  });
});
