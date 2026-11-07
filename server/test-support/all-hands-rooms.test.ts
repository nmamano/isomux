// Chat commands that list other rooms show only rooms every reader of the
// chat may open (task a37baee5). /isomux-all-hands and the
// /isomux-cronjob-system-prompt list stay in the target agent's chat, which
// every reader of the target room reads, so the sender's own access is not
// enough. The room rule itself is server/all-hands-rooms.test.ts; this file
// drives the real server, so the office's room rule reaches the handlers.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { LOBBY_ROOM_ID, type LogEntry } from "../../shared/types.ts";
import type { ApiTokenCreateRes } from "../../shared/contract-shapes.ts";

let server: TestServer | null = null;
const folders: string[] = [];
afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

function freshFolder(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `all-hands-${name}-`));
  folders.push(dir);
  return dir;
}

// Morgan owns the office. Casey reads rooms A and C. The target agent is
// Casey's, in room A. Each other room holds one agent with its own folder:
// B and C a front desk, E only a back-room seat; D is empty; the lobby has
// one.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const casey = await srv.seedMember("Casey");
  const caseyId = getUserByName("Casey")!.id;
  const ownerId = getUserByName("Morgan")!.id;
  srv.agentManager.ensureLobby();
  const roomA = srv.agentManager.createRoom("Alpha");
  const roomB = srv.agentManager.createRoom("Beta");
  const roomC = srv.agentManager.createRoom("Gamma");
  const roomD = srv.agentManager.createRoom("Delta");
  const roomE = srv.agentManager.createRoom("Epsilon");
  expect(updateUserById(caseyId, { allowedRooms: [roomA, roomC] }).ok).toBe(
    true,
  );
  const spawn = async (
    name: string,
    roomId: string,
    userId: string,
    desk?: null,
  ) => {
    const cwd = freshFolder(name.toLowerCase());
    const agent = await srv.agentManager.spawn(
      name,
      cwd,
      "default",
      desk,
      undefined,
      roomId,
      undefined,
      undefined,
      undefined,
      undefined,
      "claude",
      undefined,
      userId,
    );
    if (!agent) throw new Error(`spawn failed: ${name}`);
    return { id: agent.id, name, cwd };
  };
  const target = await spawn("Target", roomA, caseyId);
  const others = {
    lobby: await spawn("LobbyBot", LOBBY_ROOM_ID, ownerId),
    b: await spawn("BetaBot", roomB, ownerId),
    c: await spawn("GammaBot", roomC, ownerId),
    e: await spawn("EpsilonBot", roomE, ownerId, null),
  };
  return {
    srv,
    owner: owner.rawSessionId,
    casey: casey.rawSessionId,
    caseyId,
    ownerId,
    rooms: { a: roomA, b: roomB, c: roomC, d: roomD, e: roomE },
    target,
    others,
  };
}
type Office = Awaited<ReturnType<typeof office>>;

async function send(
  o: Office,
  auth: { session: string } | { bearer: string },
  text: string,
): Promise<number> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if ("bearer" in auth) headers["Authorization"] = `Bearer ${auth.bearer}`;
  const res = await o.srv.http(`/api/agents/${o.target.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
    rawSessionId: "session" in auth ? auth.session : undefined,
  });
  await res.body?.cancel();
  return res.status;
}

// The owner's own API token, limited to some rooms at mint.
async function ownerToken(o: Office, rooms: string[]): Promise<string> {
  const res = await o.srv.http("/api/me/api-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Script",
      expiresInDays: 30,
      limits: { rooms },
    }),
    rawSessionId: o.owner,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as ApiTokenCreateRes).token;
}

async function waitUntil(pred: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await Bun.sleep(10);
  }
}

const systemEntries = (o: Office): LogEntry[] =>
  o.srv.agentManager
    .getAgentLogs(o.target.id)
    .filter((e) => e.kind === "system");

// Every message key in a log text, at any depth.
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== "object") return [];
  const own = typeof (value as { key?: unknown }).key === "string";
  return [
    ...(own ? [(value as { key: string }).key] : []),
    ...Object.values(value).flatMap(keysOf),
  ];
}

// Sends /isomux-all-hands and returns the new answer: its English text and
// whether its message parts carry the line that says rooms were left out.
async function allHands(
  o: Office,
  auth: { session: string } | { bearer: string },
) {
  const before = systemEntries(o).length;
  expect(await send(o, auth, "/isomux-all-hands")).toBe(200);
  await waitUntil(() => systemEntries(o).length > before, "all-hands answer");
  const entry = systemEntries(o).at(-1)!;
  // Enabling condition for the left-out check: the parts carry the keys.
  expect(keysOf(entry.message)).toContain("commands.isomuxAllHands.footer");
  return {
    text: entry.content,
    leftOutLine: keysOf(entry.message).includes(
      "commands.isomuxAllHands.hidden",
    ),
  };
}

// Which of the other rooms' agents an answer shows. An agent counts as shown
// when its name or its folder is in the text; the back-room agent is a count
// line, so its folder stands for it only if it leaks.
function shown(o: Office, text: string) {
  const out: Record<string, boolean> = {};
  for (const [room, agent] of Object.entries(o.others))
    out[room] = text.includes(agent.name) || text.includes(agent.cwd);
  return out;
}

describe("/isomux-all-hands lists only rooms every reader may open", () => {
  it("leaves out the rooms a member who reads the chat lacks, for the member and for the owner", async () => {
    const o = await office();
    for (const auth of [{ session: o.casey }, { session: o.owner }]) {
      const answer = await allHands(o, auth);
      // The target room is always listed.
      expect(answer.text).toContain(o.target.name);
      expect(answer.text).toContain(o.target.cwd);
      expect(shown(o, answer.text)).toEqual({
        lobby: true,
        b: false,
        c: true,
        e: false,
      });
      expect(answer.leftOutLine).toBe(true);
    }
  });

  it("lists a room once every reader may open it, and says nothing when only an empty room is left out", async () => {
    const o = await office();
    // Casey now reads every room but D, which has no agent.
    const { a, b, c, e } = o.rooms;
    expect(updateUserById(o.caseyId, { allowedRooms: [a, b, c, e] }).ok).toBe(
      true,
    );
    const answer = await allHands(o, { session: o.owner });
    expect(shown(o, answer.text)).toEqual({
      lobby: true,
      b: true,
      c: true,
      e: false,
    });
    // E shows as its back-room count line, not as the agent.
    expect(answer.text).not.toContain(o.others.e.cwd);
    expect(answer.leftOutLine).toBe(false);

    // A room with only a back-room agent counts as a listed room.
    expect(updateUserById(o.caseyId, { allowedRooms: [a, b, c] }).ok).toBe(
      true,
    );
    expect((await allHands(o, { session: o.owner })).leftOutLine).toBe(true);
  });

  it("keeps a token limited to rooms inside its rooms, without the lobby", async () => {
    const o = await office();
    // Casey reads every room, so every room is open to every reader of A
    // and only the owner's token, limited to A and C, narrows the list.
    expect(
      updateUserById(o.caseyId, { allowedRooms: Object.values(o.rooms) }).ok,
    ).toBe(true);
    const token = await ownerToken(o, [o.rooms.a, o.rooms.c]);

    // Enabling condition: the owner's own session lists every room.
    const full = await allHands(o, { session: o.owner });
    expect(shown(o, full.text)).toEqual({
      lobby: true,
      b: true,
      c: true,
      e: false,
    });
    expect(full.leftOutLine).toBe(false);

    const limited = await allHands(o, { bearer: token });
    expect(shown(o, limited.text)).toEqual({
      lobby: false,
      b: false,
      c: true,
      e: false,
    });
    expect(limited.leftOutLine).toBe(true);
  });
});

describe("/isomux-cronjob-system-prompt lists only jobs every reader may see", () => {
  it("leaves out the owner's jobs a member who reads the chat cannot see, in the list, the picker and a typed id", async () => {
    const o = await office();
    const job = (name: string, roomId: string) =>
      o.srv.cronjobManager.addCronjob({
        name,
        schedule: { type: "interval", minutes: 60 },
        prompt: "p",
        cwd: o.srv.stateRoot,
        agentType: "claude",
        modelFamily: "opus",
        effort: "medium",
        permissionMode: "bypassPermissions",
        username: "Morgan",
        userId: o.ownerId,
        roomId,
      });
    const inA = job("Job in Alpha", o.rooms.a);
    const inB = job("Job in Beta", o.rooms.b);
    // A job in the lobby is its maker's and the owners' only (the lobby is
    // not an ordinary room), so Casey cannot see it either.
    const inLobby = job("Job in Lobby", LOBBY_ROOM_ID);
    expect(inLobby.roomId).toBe(LOBBY_ROOM_ID);

    // A typed id of the hidden job answers as an unknown id does.
    const answerTo = async (
      id: string,
      auth: { session: string } | { bearer: string } = { session: o.owner },
    ) => {
      const before = systemEntries(o).length;
      expect(await send(o, auth, `/isomux-cronjob-system-prompt ${id}`)).toBe(
        200,
      );
      await waitUntil(() => systemEntries(o).length > before, "typed id");
      const entry = systemEntries(o).at(-1)!;
      return { keys: keysOf(entry.message), meta: entry.metadata ?? {} };
    };
    const unknown = await answerTo("no-such-job");
    expect(unknown.keys.length).toBeGreaterThan(0);
    const hidden = await answerTo(inB.id);
    expect(hidden.keys).toEqual(unknown.keys);
    expect(hidden.meta).not.toHaveProperty("cronjobId");
    // Enabling condition: the visible job's id opens its prompt.
    expect((await answerTo(inA.id)).meta).toMatchObject({ cronjobId: inA.id });

    // A token limited to room A: the owner's job in C (which Casey reads)
    // opens from the owner's session but not from the token, while the job
    // in A still opens from the token.
    const inC = job("Job in Gamma", o.rooms.c);
    const token = await ownerToken(o, [o.rooms.a]);
    expect((await answerTo(inC.id)).meta).toMatchObject({ cronjobId: inC.id });
    expect((await answerTo(inA.id, { bearer: token })).meta).toMatchObject({
      cronjobId: inA.id,
    });
    const fromToken = await answerTo(inC.id, { bearer: token });
    expect(fromToken.keys).toEqual(unknown.keys);
    expect(fromToken.meta).not.toHaveProperty("cronjobId");

    const before = systemEntries(o).length;
    expect(
      await send(o, { session: o.owner }, "/isomux-cronjob-system-prompt"),
    ).toBe(200);
    const pending = () =>
      o.srv.agentManager
        .getPendingInteractions()
        .filter((item) => item.agentId === o.target.id);
    await waitUntil(() => pending().length === 1, "cronjob picker");
    expect(
      pending()[0]
        .choices.map((c) => c.value)
        .sort(),
    ).toEqual([inA.id, inC.id].sort());
    const fallback = systemEntries(o)
      .slice(before)
      .find((e) => e.metadata?.interactionFallback);
    expect(fallback!.content).toContain(inA.name);
    expect(fallback!.content).not.toContain(inB.name);
    expect(fallback!.content).not.toContain(inLobby.name);
  });
});
