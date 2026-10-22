// Every change to a user's room access re-projects their live board and
// cronjob list (task e8a81336). The owner of that rule is the user-record
// write itself (users.ts updateUserById -> the access hook), so the rows
// below drive the production paths that change room access: the access and
// role routes, rooms.close, and (last test) bootstrap promotion, which writes
// the record from auth.ts with no route around it. Each checks a connected
// socket of the subject converges to the new access without a reconnect.
//
// One fixture for every row: owner Morgan, member Mia, room B holding a task
// and a cronjob. A row starts Mia with or without access to B, asserts that
// connect hydration agrees, runs the path, and asserts the board, the
// cronjob list (and, where the path keeps room B open, the room list) Mia's
// socket holds afterwards.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getUserByName, updateUserById } from "../users.ts";
import { withAuditContextSync } from "../audit-context.ts";
import type {
  CronjobListWire,
  RoomWire,
  TaskItem,
} from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string, ms = 1500) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

type Msg = { type?: string } & Record<string, unknown>;
const ofType = (msgs: unknown[], type: string): Msg[] =>
  (msgs as Msg[]).filter((m) => m.type === type);
const boardIds = (m: Msg) => (m.tasks as TaskItem[]).map((t) => t.id);
const jobIds = (m: Msg) => (m.cronjobs as CronjobListWire[]).map((c) => c.id);
const roomIds = (m: Msg) => (m.rooms as RoomWire[]).map((r) => r.id);

async function http(
  srv: TestServer,
  method: string,
  path: string,
  rawSessionId: string,
  body?: unknown,
): Promise<number> {
  const res = await srv.http(path, {
    method,
    rawSessionId,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return res.status;
}

// Fixture writes, outside any route: the store wants an audit actor.
function seedTask(srv: TestServer, title: string, roomId: string): TaskItem {
  return withAuditContextSync(
    { kind: "member", id: "fixture", name: "fixture" },
    "tasks.create",
    () =>
      srv.agentManager.addTask(title, "fixture", {
        username: "fixture",
        roomId,
      }),
  );
}

function seedJob(srv: TestServer, username: string, roomId: string) {
  return srv.cronjobManager.addCronjob({
    name: "Job in B",
    schedule: { type: "interval", minutes: 60 },
    prompt: "p",
    cwd: srv.stateRoot,
    agentType: "claude",
    modelFamily: "opus",
    effort: "medium",
    permissionMode: "bypassPermissions",
    username,
    userId: getUserByName(username)?.id ?? null,
    roomId,
  });
}

interface Ctx {
  srv: TestServer;
  ownerSession: string;
  roomB: string;
}

interface Row {
  path: string;
  // Mia's access to room B before the path runs; the path flips it.
  start: { role: "owner" | "member"; grantB: boolean };
  run: (ctx: Ctx) => Promise<void>;
  // The role session_context must carry afterwards, for a path that changes it.
  role?: "owner" | "member";
  // A path that closes room B leaves no room to look for in full_state.
  closesB?: boolean;
}

const ROWS: Row[] = [
  {
    path: "users.setAccess grant",
    start: { role: "member", grantB: false },
    run: async ({ srv, ownerSession, roomB }) => {
      expect(
        await http(srv, "PUT", "/api/users/Mia/access", ownerSession, {
          allowedRooms: [roomB],
        }),
      ).toBe(200);
    },
  },
  {
    path: "users.setAccess revoke",
    start: { role: "member", grantB: true },
    run: async ({ srv, ownerSession }) => {
      expect(
        await http(srv, "PUT", "/api/users/Mia/access", ownerSession, {
          allowedRooms: [],
        }),
      ).toBe(200);
    },
  },
  {
    path: "users.update demote",
    start: { role: "owner", grantB: false },
    role: "member",
    run: async ({ srv, ownerSession }) => {
      expect(
        await http(srv, "PATCH", "/api/users/Mia", ownerSession, {
          role: "member",
        }),
      ).toBe(200);
    },
  },
  {
    path: "rooms.close",
    start: { role: "member", grantB: true },
    closesB: true,
    run: async ({ srv, ownerSession, roomB }) => {
      expect(
        await http(srv, "DELETE", `/api/rooms/${roomB}`, ownerSession),
      ).toBeLessThan(300);
    },
  },
];

describe("an access change re-projects the subject's live board and cronjobs", () => {
  for (const row of ROWS) {
    const before = row.start.role === "owner" || row.start.grantB;
    it(`${row.path}: room B ${before ? "drops out" : "comes in"} live`, async () => {
      const srv = await startTestServer();
      server = srv;
      const owner = await srv.seedOwner("Morgan");
      const mia = await srv.seedMember("Mia");
      const miaId = getUserByName("Mia")!.id;
      const roomB = srv.agentManager.createRoom("Room B");
      const task = seedTask(srv, "in B", roomB);
      const job = seedJob(srv, "Morgan", roomB);
      if (row.start.grantB) updateUserById(miaId, { allowedRooms: [roomB] });
      if (row.start.role === "owner")
        expect(updateUserById(miaId, { role: "owner" }).ok).toBe(true);

      const sock: TestSocket = await srv.connectWs(mia.rawSessionId);
      await waitUntil(
        () =>
          ofType(sock.messages, "tasks").length > 0 &&
          ofType(sock.messages, "cronjobs_state").length > 0 &&
          ofType(sock.messages, "full_state").length > 0,
        "connect hydration",
      );
      // Connect hydration is the base projection: it already agrees with the
      // starting access, so the flip below is the path's doing.
      expect(
        boardIds(ofType(sock.messages, "tasks")[0]).includes(task.id),
      ).toBe(before);
      expect(
        jobIds(ofType(sock.messages, "cronjobs_state")[0]).includes(job.id),
      ).toBe(before);
      expect(
        roomIds(ofType(sock.messages, "full_state")[0]).includes(roomB),
      ).toBe(before);

      const mark = sock.messages.length;
      const after = () => sock.messages.slice(mark);
      await row.run({ srv, ownerSession: owner.rawSessionId, roomB });

      const after_ = !before;
      await waitUntil(() => {
        const boards = ofType(after(), "tasks");
        const jobs = ofType(after(), "cronjobs_state");
        return (
          boards.length > 0 &&
          jobs.length > 0 &&
          boardIds(boards.at(-1)!).includes(task.id) === after_ &&
          jobIds(jobs.at(-1)!).includes(job.id) === after_
        );
      }, `Mia's board and cronjobs after ${row.path}`);

      if (!row.closesB) {
        const states = ofType(after(), "full_state");
        expect(states.length).toBeGreaterThan(0);
        expect(roomIds(states.at(-1)!).includes(roomB)).toBe(after_);
      }
      if (row.role) {
        const ctxs = ofType(after(), "session_context");
        expect(ctxs.length).toBeGreaterThan(0);
        expect((ctxs.at(-1)!.context as { role: string }).role).toBe(row.role);
      }
    });
  }

  it("a write that changes no room access re-projects nothing", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    const miaId = getUserByName("Mia")!.id;
    const roomA = srv.agentManager.createRoom("Room A");
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(miaId, { allowedRooms: [roomA, roomB] });

    const sock: TestSocket = await srv.connectWs(mia.rawSessionId);
    await waitUntil(
      () =>
        ofType(sock.messages, "tasks").length > 0 &&
        ofType(sock.messages, "full_state").length > 0,
      "connect hydration",
    );
    const mark = sock.messages.length;

    // The same grants in another order, then a record edit through the route.
    // A re-projection fired by either write reaches the socket before the
    // route's user_updated does.
    expect(updateUserById(miaId, { allowedRooms: [roomB, roomA] }).ok).toBe(
      true,
    );
    expect(
      await http(srv, "PATCH", "/api/users/Mia", owner.rawSessionId, {
        name: "Mia Two",
      }),
    ).toBe(200);
    await waitUntil(
      () => ofType(sock.messages.slice(mark), "user_updated").length > 0,
      "the rename reaches Mia",
    );
    const types = (sock.messages.slice(mark) as Msg[]).map((m) => m.type);
    expect(types).not.toContain("tasks");
    expect(types).not.toContain("cronjobs_state");
    expect(types).not.toContain("full_state");
  });

  it("bootstrap promotion of a connected member converges in one step, never through a roomless state", async () => {
    // No owner yet: claiming the office by an existing member's name promotes
    // that member (auth.ts commitBootstrapOwnerUser).
    const srv = await startTestServer();
    server = srv;
    const mia = await srv.seedMember("Mia");
    const miaId = getUserByName("Mia")!.id;
    const roomA = srv.agentManager.createRoom("Room A");
    const roomB = srv.agentManager.createRoom("Room B");
    updateUserById(miaId, { allowedRooms: [roomA] });
    const inA = seedTask(srv, "in A", roomA);
    const inB = seedTask(srv, "in B", roomB);

    const sock: TestSocket = await srv.connectWs(mia.rawSessionId);
    await waitUntil(
      () =>
        ofType(sock.messages, "tasks").length > 0 &&
        ofType(sock.messages, "full_state").length > 0,
      "connect hydration",
    );
    const hydrated = boardIds(ofType(sock.messages, "tasks")[0]);
    expect(hydrated.includes(inA.id)).toBe(true);
    expect(hydrated.includes(inB.id)).toBe(false);
    const mark = sock.messages.length;
    const after = () => sock.messages.slice(mark);

    const res = await srv.http("/auth/claim", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `name=Mia&key=${encodeURIComponent(srv.setupKey())}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(getUserByName("Mia")!.role).toBe("owner");

    await waitUntil(() => {
      const boards = ofType(after(), "tasks");
      return boards.length > 0 && boardIds(boards.at(-1)!).includes(inB.id);
    }, "Mia's board after the promotion");
    const ctxs = ofType(after(), "session_context");
    expect(ctxs.length).toBeGreaterThan(0);
    expect((ctxs.at(-1)!.context as { role: string }).role).toBe("owner");
    // Every frame between the two states keeps room A: the promotion never
    // shows Mia a member with no rooms.
    for (const board of ofType(after(), "tasks")) {
      expect(boardIds(board)).toContain(inA.id);
    }
    const states = ofType(after(), "full_state");
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) expect(roomIds(state)).toContain(roomA);
  });
});
