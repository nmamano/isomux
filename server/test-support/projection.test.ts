// Phase 1.2 - Projection / ACL characterization.
//
// Per-recipient projection / ACL net. Began as a Phase 1.2 characterization of
// the implicit per-WebSocket fanout in server/isomux-office.ts (sendProjectedFullState +
// routeAgentEventToWs + the per-WS push helpers); the Phase 3 rewrites then
// FLIPPED these tests in place as they landed, so the file now pins the CURRENT
// (post-3b/3c/3d) model, through the wire only (WS messages + REST responses),
// never internals:
//   - 3b extracted the implicit projection into a declared ACL/view service:
//     materialized owner access + the create_room fan-out became RULE-BASED
//     access, and the global owner-only reorder gate was deleted.
//   - 3c replaced the DENSE per-recipient numeric agent.room index with an
//     id-keyed wire.
//   - 3d cut the room mutations (create/close/rename/settings) and reorder off
//     the WS command bus onto REST; these tests drive them over authenticated
//     HTTP now (the cores + broadcasts are unchanged, so the ACL assertions hold).
//
// Current model frozen here (verified against isomux-office.ts / shared/office-state.ts
// / auth.ts):
//   - Access == UserRecord.allowedRooms for MEMBERS (literal string[]; no "all"
//     sentinel); OWNERS access every room by RULE (canAccess), carrying no
//     materialized grants. A fresh member defaults to [].
//   - create grants ONLY a non-owner creator (+ a projected full_state catch-up);
//     owners reach the new room by rule, with NO fan-out and NO grant broadcast.
//   - full_state.agents carry a stable global roomId (or are dropped if their
//     room is hidden from the recipient); full_state.rooms is filtered to the
//     recipient's visible set; all_rooms_list is owner-only and UNFILTERED.
//     (Phase 3c slice 4 removed the dense per-recipient agent.room index.)
//   - reorder is a PER-USER view preference (view.setOrder), always allowed; the
//     global owner-only gate is gone.
//
// Determinism (no arbitrary sleeps): routeAgentEvent fans out to every socket
// SYNCHRONOUSLY, so "a full-access owner socket received event X" implies every
// restricted socket's decision on X already ran - that is the barrier for
// negative assertions. The connect handshake sends presence_list LAST, so
// awaiting it guarantees the whole handshake (incl. per-agent log_entry +
// slash_commands replay) arrived. The mutation cores (room create/close/rename,
// update_user, reorder) fan out fully synchronously incl. their pushes - for the
// REST mutations the broadcast fires inside the handler before the HTTP response
// resolves - so awaiting one recipient's resulting full_state settles all of them.
//
// Scope note - terminal: routeAgentEventToWs gates terminal_output/terminal_exit
// in the SAME agentVisibleForSession switch arm as log_entry/slash_commands. The
// terminal_open buffered REPLAY is now characterized below (task 39ce6225): it
// seeds the agent's buffered output to ONLY the requesting socket, so a member
// without room access never receives a hidden agent's backlog. That case seeds
// the buffer through the manager's test-only stubbed-terminal seam
// (_testSeedTerminalBuffer), since FakeBackend has no PTY. The broader
// interactive PTY path (live input/resize/close routing) stays carved into a
// future stubbed-PTY/opt-in seam and is NOT characterized here.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import type {
  AgentInfo,
  LogEntry,
  RoomWire,
  KilledAgentSummary,
  UserRecord,
} from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = Record<string, unknown>;
const bag = (sock: TestSocket): Msg[] => sock.messages as Msg[];

// A FakeBackend that completes every turn (so the agent lands back at
// waiting_for_response). Assertions anchor on the RAW human `user_message` log
// entry - logged verbatim before the orchestrator wraps the text with sender
// attribution for the backend - so the assistant text content is unused.
function completingBackend(): FakeBackend {
  return new FakeBackend({
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
}

async function boot(): Promise<TestServer> {
  return startTestServer({ fakeBackend: completingBackend() });
}

// --- buffer-scanning helpers (waitFor matches on TYPE only; 1.2 compares
// per-recipient CONTENT, so we scan socket.messages like onboarding does) ---

async function waitForMessageWhere(
  sock: TestSocket,
  pred: (m: Msg) => boolean,
  timeoutMs = 2000,
): Promise<Msg> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = bag(sock).find(pred);
    if (found) return found;
    if (Date.now() > deadline) {
      const kinds = bag(sock)
        .map((m) => m.type)
        .join(", ");
      throw new Error(`waitForMessageWhere timed out; saw types: [${kinds}]`);
    }
    await sleep(5);
  }
}

function latestFullState(sock: TestSocket): Msg | undefined {
  let last: Msg | undefined;
  for (const m of bag(sock)) if (m.type === "full_state") last = m;
  return last;
}

const fullStateRoomIds = (m: Msg): string[] =>
  (m.rooms as RoomWire[]).map((r) => r.id);

const agentInFullState = (m: Msg, agentId: string): AgentInfo | undefined =>
  (m.agents as AgentInfo[]).find((a) => a.id === agentId);

function logEntriesFor(sock: TestSocket, agentId: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const m of bag(sock)) {
    if (m.type === "log_entry") {
      const entry = m.entry as LogEntry | undefined;
      if (entry?.agentId === agentId) out.push(entry);
    }
  }
  return out;
}

async function waitForLog(
  sock: TestSocket,
  agentId: string,
  pred: (e: LogEntry) => boolean,
  timeoutMs = 2000,
): Promise<LogEntry> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = logEntriesFor(sock, agentId).find(pred);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`waitForLog timed out for ${agentId}`);
    }
    await sleep(5);
  }
}

function slashCommandsFor(sock: TestSocket, agentId: string): Msg[] {
  return bag(sock).filter(
    (m) => m.type === "slash_commands" && m.agentId === agentId,
  );
}

async function waitForTypeCount(
  sock: TestSocket,
  type: string,
  atLeast: number,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (bag(sock).filter((m) => m.type === type).length < atLeast) {
    if (Date.now() > deadline) {
      throw new Error(`waitForTypeCount("${type}", ${atLeast}) timed out`);
    }
    await sleep(5);
  }
}

// Assert (by position) that a log_entry for `agentId` matching `pred` arrives
// AFTER `sinceIndex` in the socket's append-only buffer - i.e. it was REPLAYED
// by a shift's projected full_state, not merely left over from the connect-time
// replay. The real client clears logs on each full_state and depends on this
// replay; our test buffer never clears, so position is how we actually
// constrain the replay-on-shift contract (a plain "entry exists" check would
// pass on the connect-time copy even if the shift replay were deleted).
async function waitForLogSince(
  sock: TestSocket,
  agentId: string,
  pred: (e: LogEntry) => boolean,
  sinceIndex: number,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const msgs = bag(sock);
    for (let i = sinceIndex; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.type === "log_entry") {
        const e = m.entry as LogEntry | undefined;
        if (e?.agentId === agentId && pred(e)) return;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `waitForLogSince timed out for ${agentId} (since index ${sinceIndex})`,
      );
    }
    await sleep(5);
  }
}

function connectionIdOf(sock: TestSocket): string {
  const ctx = bag(sock).find((m) => m.type === "session_context");
  if (!ctx) throw new Error("no session_context on socket");
  return (ctx.context as { connectionId: string }).connectionId;
}

// Connect a WS and block until the connect handshake is fully delivered
// (presence_list is the last handshake message).
async function connectSettled(
  srv: TestServer,
  rawSessionId: string,
): Promise<TestSocket> {
  const sock = await srv.connectWs(rawSessionId);
  await sock.waitFor("presence_list");
  return sock;
}

// Owner grants/sets a member's room access via the real REST users.setAccess
// route (PUT /api/users/:username/access, owner-gated). 3d.9b: this is the
// allowedRooms path; the seam prune-clamps notif/default in the same write,
// pushes a projected full_state to the target, and fans out the scoped lists.
async function setAccess(
  srv: TestServer,
  ownerRawSessionId: string,
  username: string,
  roomIds: string[],
): Promise<void> {
  await httpMut(
    srv,
    ownerRawSessionId,
    "PUT",
    `/api/users/${encodeURIComponent(username)}/access`,
    { allowedRooms: roomIds },
  );
}

async function spawnIn(
  srv: TestServer,
  name: string,
  roomId: string,
): Promise<AgentInfo> {
  const a = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
  );
  if (!a) throw new Error(`spawn failed: ${name}`);
  return a;
}

// Drive one turn from a full-access owner socket and block until the raw human
// `user_message` log entry (the unique marker) is observed on that socket - the
// synchronous-fanout barrier, and the specific entry whose replay the
// transcript-preservation cases assert.
async function driveTurn(
  srv: TestServer,
  rawSessionId: string,
  ownerSock: TestSocket,
  agentId: string,
  marker: string,
): Promise<void> {
  // send_message migrated to REST (3d.6a): POST the human message over HTTP, then
  // block on the streamed user_message marker landing on the socket (the
  // synchronous-fanout barrier the transcript-preservation cases rely on).
  await httpMut(srv, rawSessionId, "POST", `/api/agents/${agentId}/messages`, {
    text: marker,
  });
  await waitForLog(
    ownerSock,
    agentId,
    (e) => e.kind === "user_message" && e.content === marker,
  );
}

async function pingPong(sock: TestSocket): Promise<void> {
  const before = bag(sock).filter((m) => m.type === "pong").length;
  sock.send({ type: "ping" });
  const deadline = Date.now() + 2000;
  while (bag(sock).filter((m) => m.type === "pong").length <= before) {
    if (Date.now() > deadline) throw new Error("pingPong timed out");
    await sleep(5);
  }
}

// REST mutation helper. The room-structure mutations (create/close/rename) and
// reorder cut over from WS to /api in slice 6, so the projection net drives them
// over authenticated HTTP now. The downstream broadcasts (room_*/full_state/
// all_rooms_list) are emitted by the SAME cores, so the per-recipient ACL
// assertions are unchanged - only the command entry transport moved. Awaiting
// the response also closes the old event-before-ack race (the broadcast fired
// synchronously inside the handler, before this resolves).
async function httpMut(
  srv: TestServer,
  rawSessionId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  const res = await srv.http(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    rawSessionId,
  });
  if (res.status >= 400) {
    throw new Error(`httpMut ${method} ${path} -> ${res.status}`);
  }
}

// Create N extra rooms BEFORE seeding the owner, so the owner's seed snapshot
// covers every room (owner = full access, no create_room fan-out noise).
function makeRoomsBeforeOwner(srv: TestServer, names: string[]): string[] {
  return names.map((n) => srv.agentManager.createRoom(n));
}

describe("full_state projection - connect-time ACL (Phase 1.2)", () => {
  it("two users with overlapping non-identical access: rooms filtered per recipient, agents carry stable roomIds", async () => {
    // Post-cut: full_state.rooms is filtered to each recipient's visible set, and
    // agents carry a stable global roomId (no per-recipient dense index). An
    // agent whose room is hidden from the recipient is dropped entirely.
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss"); // full access (all 3 rooms)
    const member = await server.seedMember("Mia");

    const a1 = await spawnIn(server, "A1", r1);
    const a2 = await spawnIn(server, "A2", r2);
    const a3 = await spawnIn(server, "A3", r3);

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1, r3]); // member sees R1 + R3, not R2
    const memberSock = await connectSettled(server, member.rawSessionId);

    const ofs = latestFullState(ownerSock)!;
    const mfs = latestFullState(memberSock)!;

    // Owner: unfiltered rooms; every agent present with its stable roomId.
    expect(fullStateRoomIds(ofs)).toEqual([r1, r2, r3]);
    expect(agentInFullState(ofs, a1.id)!.roomId).toBe(r1);
    expect(agentInFullState(ofs, a2.id)!.roomId).toBe(r2);
    expect(agentInFullState(ofs, a3.id)!.roomId).toBe(r3);

    // Member: R2 filtered out; the R2 agent absent; surviving agents keep the
    // SAME global roomIds (no remap).
    expect(fullStateRoomIds(mfs)).toEqual([r1, r3]);
    expect(agentInFullState(mfs, a1.id)!.roomId).toBe(r1);
    expect(agentInFullState(mfs, a3.id)!.roomId).toBe(r3);
    expect(agentInFullState(mfs, a2.id)).toBeUndefined();
  });

  it("agent.roomId is the stable global id - identical across recipients and present in each recipient's filtered rooms", async () => {
    // Post-cut invariant: every agent's roomId names a room that IS in that
    // recipient's own filtered rooms list (we never ship an agent whose room the
    // recipient can't see), and the id is recipient-independent.
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const a1 = await spawnIn(server, "A1", r1);
    await spawnIn(server, "A2", r2);
    const a3 = await spawnIn(server, "A3", r3);

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1, r3]); // member sees R1 + R3
    const memberSock = await connectSettled(server, member.rawSessionId);

    // Invariant for BOTH recipients: every agent's roomId names a room that IS in
    // that recipient's own filtered rooms list.
    for (const sock of [ownerSock, memberSock]) {
      const fs = latestFullState(sock)!;
      const roomIds = new Set((fs.rooms as RoomWire[]).map((r) => r.id));
      for (const agent of fs.agents as AgentInfo[]) {
        expect(roomIds.has(agent.roomId)).toBe(true);
      }
    }

    // roomId is the STABLE GLOBAL id - identical across recipients (A3 is r3 for
    // both the owner and Mia, who can't even see R2).
    const ownerA3 = agentInFullState(latestFullState(ownerSock)!, a3.id)!;
    const memberA3 = agentInFullState(latestFullState(memberSock)!, a3.id)!;
    expect(ownerA3.roomId).toBe(r3);
    expect(memberA3.roomId).toBe(r3);
    expect(agentInFullState(latestFullState(ownerSock)!, a1.id)!.roomId).toBe(
      r1,
    );
  });

  it("owner access is RULE-BASED: writing an owner's grants does NOT restrict their view; owner-only all_rooms_list stays unfiltered; members never receive all_rooms_list (3b flip)", async () => {
    // 3b FLIP of the old "owner self-hides via allowedRooms" characterization.
    // Under rule-based access an owner reaches every room by RULE, so writing
    // their allowedRooms (now a member-only GRANT store) no longer restricts
    // their own view - they keep seeing all rooms. Owner self-hide moves to the
    // `hidden` VIEW preference (seeded by the owner-access migration; the
    // view.setShown route was removed as callerless in Phase 4). The two
    // invariants that survive UNCHANGED: the owner-only all_rooms_list stays
    // unfiltered, and members never receive all_rooms_list at all.
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    // The unfiltered owner-only admin list, captured at connect.
    const allRooms = await waitForMessageWhere(
      ownerSock,
      (m) => m.type === "all_rooms_list",
    );
    expect((allRooms.rooms as RoomWire[]).map((r) => r.id)).toEqual([
      r1,
      r2,
      r3,
    ]);
    // Owner sees all three rooms by rule at connect.
    expect(fullStateRoomIds(latestFullState(ownerSock)!)).toEqual([r1, r2, r3]);

    // Writing the owner's allowedRooms (grants) is a NO-OP on their view: rule
    // access still covers every room. setAccess pushes a projected full_state to
    // the target; for an owner it MUST still contain all three rooms.
    await setAccess(server, owner.rawSessionId, owner.username, [r1, r2]);
    await waitForMessageWhere(ownerSock, (m) => m.type === "full_state");
    expect(fullStateRoomIds(latestFullState(ownerSock)!)).toEqual([r1, r2, r3]);

    // The owner-only all_rooms_list is unfiltered on the PUSH path too: a room
    // mutation re-pushes it, still carrying every room.
    const arBefore = bag(ownerSock).filter(
      (m) => m.type === "all_rooms_list",
    ).length;
    await httpMut(server, owner.rawSessionId, "PATCH", `/api/rooms/${r1}`, {
      name: "R1-renamed",
    });
    await waitForTypeCount(ownerSock, "all_rooms_list", arBefore + 1);
    const arList = bag(ownerSock).filter((m) => m.type === "all_rooms_list");
    expect(
      (arList[arList.length - 1].rooms as RoomWire[]).map((r) => r.id),
    ).toContain(r3);

    // A member never receives all_rooms_list at all (full-room-list leak guard).
    const memberSock = await connectSettled(server, member.rawSessionId);
    expect(bag(memberSock).some((m) => m.type === "all_rooms_list")).toBe(
      false,
    );
  });
});

describe("per-recipient event ACL - mid-session (Phase 1.2)", () => {
  it("a hidden-room agent's log_entry is suppressed for the restricted member and delivered to the owner", async () => {
    // Checklist: "A hidden-room agent emits log_entry/... ; the restricted user
    // never receives it." Barrier = owner receives the same log_entry (same
    // synchronous fanout path).
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const vis = await spawnIn(server, "Vis", r1);
    const hid = await spawnIn(server, "Hid", r2);

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1]);
    const memberSock = await connectSettled(server, member.rawSessionId);

    // Hidden-room turn. Barrier = the turn's ASSISTANT text (its LAST log_entry)
    // reaching the owner: the human user_message is logged synchronously, but
    // the assistant reply routes async via the orchestrator stream loop, so
    // waiting on the later of the two guarantees the member's suppression
    // decision has run for EVERY log_entry of this turn (synchronous fanout).
    await httpMut(
      server,
      owner.rawSessionId,
      "POST",
      `/api/agents/${hid.id}/messages`,
      { text: "secret-hidden" },
    );
    await waitForLog(
      ownerSock,
      hid.id,
      (e) => e.kind === "text" && e.content === "ok",
    );
    expect(logEntriesFor(memberSock, hid.id)).toHaveLength(0);

    // Positive control: a visible-room turn DOES reach the member (so the
    // absence above is ACL, not a dead pipe).
    await httpMut(
      server,
      owner.rawSessionId,
      "POST",
      `/api/agents/${vis.id}/messages`,
      { text: "open-visible" },
    );
    await waitForLog(
      memberSock,
      vis.id,
      (e) => e.kind === "user_message" && e.content === "open-visible",
    );
  });

  it("connect handshake replays log_entry + slash_commands only for visible agents", async () => {
    // Checklist: hidden-room agent's slash_commands + load-logs are not replayed
    // to a restricted member on connect; a full-access connect replays both.
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const vis = await spawnIn(server, "Vis", r1);
    const hid = await spawnIn(server, "Hid", r2);

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1]);
    await driveTurn(server, owner.rawSessionId, ownerSock, vis.id, "vis-log");
    await driveTurn(server, owner.rawSessionId, ownerSock, hid.id, "hid-log");

    // Restricted member connects fresh: replay must be ACL-filtered.
    const memberSock = await connectSettled(server, member.rawSessionId);
    await waitForLog(
      memberSock,
      vis.id,
      (e) => e.kind === "user_message" && e.content === "vis-log",
    );
    expect(slashCommandsFor(memberSock, vis.id).length).toBeGreaterThan(0);
    expect(logEntriesFor(memberSock, hid.id)).toHaveLength(0);
    expect(slashCommandsFor(memberSock, hid.id)).toHaveLength(0);

    // Full-access connect (a second owner tab) replays BOTH agents.
    const ownerTab2 = await connectSettled(server, owner.rawSessionId);
    await waitForLog(
      ownerTab2,
      hid.id,
      (e) => e.kind === "user_message" && e.content === "hid-log",
    );
    expect(slashCommandsFor(ownerTab2, vis.id).length).toBeGreaterThan(0);
    expect(slashCommandsFor(ownerTab2, hid.id).length).toBeGreaterThan(0);
  });

  it("fences the connect-time replay with log_replay_complete, after the last replayed frame", async () => {
    // The client swaps the whole transcript in at once on this frame; without
    // it the replay is an unterminated burst and the client has to guess when
    // it ended (task 4a38a3f9). Position matters: a fence that arrived BEFORE
    // the last log_entry would commit a partial transcript.
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const owner = await server.seedOwner("Boss");
    const a = await spawnIn(server, "Vis", r1);

    const first = await connectSettled(server, owner.rawSessionId);
    await driveTurn(server, owner.rawSessionId, first, a.id, "replay-me");

    const fresh = await connectSettled(server, owner.rawSessionId);
    const msgs = bag(fresh);
    const fenceAt = msgs.findIndex((m) => m.type === "log_replay_complete");
    expect(fenceAt).toBeGreaterThan(-1);
    const lastLogAt = msgs.reduce(
      (acc, m, i) => (m.type === "log_entry" ? i : acc),
      -1,
    );
    expect(lastLogAt).toBeGreaterThan(-1);
    expect(fenceAt).toBeGreaterThan(lastLogAt);
  });

  it("fences an empty replay too - the case a client cannot infer", async () => {
    // An office with nothing cached sends zero log_entry frames, so "the
    // replay is over" is unobservable without the fence.
    server = await boot();
    const owner = await server.seedOwner("Boss");
    const sock = await connectSettled(server, owner.rawSessionId);
    const msgs = bag(sock);
    expect(msgs.filter((m) => m.type === "log_entry")).toHaveLength(0);
    expect(msgs.filter((m) => m.type === "log_replay_complete")).toHaveLength(
      1,
    );
  });

  it("listSessions (GET) is allowed only for a requester with room access", async () => {
    // The per-WS sessions_list fan-out is retired (3d.6a). agents.listSessions is
    // now a guarded GET (office:read ∧ requiresRoomAccess(:id)) that returns ONLY
    // to the caller, so the ACL is enforced at the request, not the fan-out: a
    // restricted member may read a VISIBLE agent's sessions but is denied a HIDDEN
    // one - no ids/topics/timestamps cross to them.
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const vis = await spawnIn(server, "Vis", r1);
    const hid = await spawnIn(server, "Hid", r2);

    await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1]);

    // Hidden agent: the owner can read its sessions; the restricted member is
    // denied (uniform 403, no existence oracle).
    const ownerHidden = await server.http(`/api/agents/${hid.id}/sessions`, {
      rawSessionId: owner.rawSessionId,
    });
    expect(ownerHidden.status).toBe(200);
    const memberHidden = await server.http(`/api/agents/${hid.id}/sessions`, {
      rawSessionId: member.rawSessionId,
    });
    expect(memberHidden.status).toBe(403);

    // Visible agent: the member (who can see it) is allowed.
    const memberVisible = await server.http(`/api/agents/${vis.id}/sessions`, {
      rawSessionId: member.rawSessionId,
    });
    expect(memberVisible.status).toBe(200);
  });
});

describe("terminal_open buffered-replay ACL (task 39ce6225)", () => {
  it("seeds the buffered output to ONLY the requesting socket - restricted and other-visible sockets receive none", async () => {
    // The terminal_open handler ACL-gates the requester, then replays the
    // agent's buffered PTY output. The bug: it replayed via broadcast() to EVERY
    // socket, leaking a hidden-room agent's terminal backlog to members without
    // room access (and duplicating it into other already-open panels). The fix
    // seeds only the requesting ws; the live terminal_output stream
    // (routeAgentEventToWs, the same agentVisibleForSession arm as log/slash)
    // keeps other visible sockets current. FakeBackend has no node-pty, so the
    // buffer is seeded through the manager's test-only stubbed-terminal seam.
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss"); // full access = the requester
    const restricted = await server.seedMember("Mia"); // r1 only - can't see Hid
    const visible = await server.seedMember("Val"); // r1 + r2 - CAN see Hid

    const hid = await spawnIn(server, "Hid", r2); // hidden from Mia, visible to Val

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, restricted.username, [r1]);
    await setAccess(server, owner.rawSessionId, visible.username, [r1, r2]);
    const restrictedSock = await connectSettled(
      server,
      restricted.rawSessionId,
    );
    const visibleSock = await connectSettled(server, visible.rawSessionId);

    // Seed a NON-EMPTY terminal buffer for the hidden agent without a real PTY:
    // the seam sets the "already running" state openTerminal early-returns on,
    // so the real handler path runs (openTerminal returns true with no spawn,
    // getTerminalBuffer returns the buffer).
    const BACKLOG = "SECRET-PTY-BACKLOG\r\n$ ";
    expect(server.agentManager._testSeedTerminalBuffer(hid.id, BACKLOG)).toBe(
      true,
    );

    const terminalOutFor = (sock: TestSocket): Msg[] =>
      bag(sock).filter(
        (m) => m.type === "terminal_output" && m.agentId === hid.id,
      );

    // No replay anywhere before the open.
    expect(terminalOutFor(ownerSock)).toHaveLength(0);
    expect(terminalOutFor(restrictedSock)).toHaveLength(0);
    expect(terminalOutFor(visibleSock)).toHaveLength(0);

    // The owner (requester) opens the terminal.
    ownerSock.send({ type: "terminal_open", agentId: hid.id });

    // Barrier: the requester receives the buffered replay. handleInboundMessage
    // runs synchronously to the ws.send, so once the owner has it the server's
    // per-socket decision for Mia and Val has already run.
    const replay = await waitForMessageWhere(
      ownerSock,
      (m) => m.type === "terminal_output" && m.agentId === hid.id,
    );
    expect(replay.data).toBe(BACKLOG);
    // Requester-only positive: exactly one replay, no duplicate to the owner.
    expect(terminalOutFor(ownerSock)).toHaveLength(1);

    // Per-socket FIFO flush: a ping->pong round-trip on each other socket
    // guarantees anything the OLD broadcast() would have dispatched to them
    // (dispatched server-side BEFORE these pings) is already in their buffer. So
    // a count of zero FAILS against the old broadcast and PASSES on
    // requester-only.
    await pingPong(restrictedSock);
    await pingPong(visibleSock);

    // Security: the restricted member never receives the hidden agent's buffer.
    expect(terminalOutFor(restrictedSock)).toHaveLength(0);
    // Scope: a DIFFERENT visible user is not re-seeded - the replay is for the
    // requester only, not an ACL-scoped broadcast to everyone who can see Hid.
    expect(terminalOutFor(visibleSock)).toHaveLength(0);
  });
});

describe("agent moves across visibility boundaries (Phase 1.2)", () => {
  it("hidden→visible: member gets a projected full_state with the agent and its REPLAYED transcript", async () => {
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const x = await spawnIn(server, "X", r2); // hidden from member
    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1]);
    await driveTurn(server, owner.rawSessionId, ownerSock, x.id, "c1-history");

    const memberSock = await connectSettled(server, member.rawSessionId);
    expect(
      agentInFullState(latestFullState(memberSock)!, x.id),
    ).toBeUndefined();
    expect(logEntriesFor(memberSock, x.id)).toHaveLength(0);

    const sinceIdx = bag(memberSock).length;
    await httpMut(
      server,
      owner.rawSessionId,
      "POST",
      `/api/agents/${x.id}/move`,
      {
        targetRoomId: r1,
      },
    );
    await waitForMessageWhere(
      memberSock,
      (m) => m.type === "full_state" && !!agentInFullState(m, x.id),
    );

    const mfs = latestFullState(memberSock)!;
    expect(agentInFullState(mfs, x.id)!.roomId).toBe(r1); // now in member's only room
    // Transcript-preservation: the SPECIFIC prior entry is REPLAYED by the
    // move's projected full_state (asserted by position - after the move).
    await waitForLogSince(
      memberSock,
      x.id,
      (e) => e.kind === "user_message" && e.content === "c1-history",
      sinceIdx,
    );
    // The mid-session replay is fenced like the connect-time one, and the
    // fence follows the frames it terminates. This is the second of the two
    // replay sites; a fence on only one leaves the client guessing on the
    // other (task 4a38a3f9).
    const after = bag(memberSock).slice(sinceIdx);
    const fenceAt = after.findIndex((m) => m.type === "log_replay_complete");
    const lastLogAt = after.reduce(
      (acc, m, i) => (m.type === "log_entry" ? i : acc),
      -1,
    );
    expect(fenceAt).toBeGreaterThan(-1);
    expect(lastLogAt).toBeGreaterThan(-1);
    expect(fenceAt).toBeGreaterThan(lastLogAt);
  });

  it("visible→hidden: the agent drops out of the member's projected full_state", async () => {
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const x = await spawnIn(server, "X", r1); // visible to member
    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1]);
    await driveTurn(server, owner.rawSessionId, ownerSock, x.id, "c2-history");
    const memberSock = await connectSettled(server, member.rawSessionId);
    expect(agentInFullState(latestFullState(memberSock)!, x.id)).toBeDefined();

    await httpMut(
      server,
      owner.rawSessionId,
      "POST",
      `/api/agents/${x.id}/move`,
      {
        targetRoomId: r2,
      },
    );
    await waitForMessageWhere(
      memberSock,
      (m) => m.type === "full_state" && !agentInFullState(m, x.id),
    );
    expect(
      agentInFullState(latestFullState(memberSock)!, x.id),
    ).toBeUndefined();
  });

  it("visible→visible: the agent's roomId updates and the transcript survives", async () => {
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const x = await spawnIn(server, "X", r1);
    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1, r3]); // member sees R1 + R3
    await driveTurn(server, owner.rawSessionId, ownerSock, x.id, "c3-history");
    const memberSock = await connectSettled(server, member.rawSessionId);
    expect(agentInFullState(latestFullState(memberSock)!, x.id)!.roomId).toBe(
      r1,
    );

    const sinceIdx = bag(memberSock).length;
    await httpMut(
      server,
      owner.rawSessionId,
      "POST",
      `/api/agents/${x.id}/move`,
      {
        targetRoomId: r3,
      },
    );
    await waitForMessageWhere(
      memberSock,
      (m) =>
        m.type === "full_state" && agentInFullState(m, x.id)?.roomId === r3,
    );
    const mfs = latestFullState(memberSock)!;
    expect(agentInFullState(mfs, x.id)!.roomId).toBe(r3); // now in R3, stable id
    // Replay-on-shift (NOT the connect-time copy): the entry must reappear AFTER
    // the move's full_state. X is visible at connect, so a plain existence check
    // would pass even if the move replay were removed.
    await waitForLogSince(
      memberSock,
      x.id,
      (e) => e.kind === "user_message" && e.content === "c3-history",
      sinceIdx,
    );
  });

  it("move ACL (3d.7a): needs BOTH source-agent and target-room access -> uniform 403", async () => {
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1]); // member sees r1 only

    const inR1 = await spawnIn(server, "InR1", r1); // source visible to member
    const inR2 = await spawnIn(server, "InR2", r2); // source hidden from member

    // Target-room guard: member owns the source agent but NOT the target room.
    const toHidden = await server.http(`/api/agents/${inR1.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRoomId: r2 }),
      rawSessionId: member.rawSessionId,
    });
    expect(toHidden.status).toBe(403);
    expect(server.agentManager.getAgent(inR1.id)!.roomId).toBe(r1); // untouched

    // Source-agent guard: member can reach the target room but not the agent.
    const fromHidden = await server.http(`/api/agents/${inR2.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRoomId: r1 }),
      rawSessionId: member.rawSessionId,
    });
    expect(fromHidden.status).toBe(403);
    expect(server.agentManager.getAgent(inR2.id)!.roomId).toBe(r2); // untouched
  });
});

describe("room close / reorder with restricted members (Phase 1.2)", () => {
  it("closing a visible room sends a bare room_closed delta (no full_state refresh, no dense remap)", async () => {
    server = await boot();
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const y = await spawnIn(server, "Y", r3);
    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r2, r3]); // sees R2 + R3, not R1
    await driveTurn(server, owner.rawSessionId, ownerSock, y.id, "d1-history");
    const memberSock = await connectSettled(server, member.rawSessionId);

    const before = latestFullState(memberSock)!;
    expect(fullStateRoomIds(before)).toEqual([r2, r3]);
    expect(agentInFullState(before, y.id)!.roomId).toBe(r3);

    // Close R2 (empty; not index 0). Post-cut there are no dense indices to
    // shift, so the close is a BARE room_closed delta - no projected full_state
    // and no log replay. The member still holds R2 access at emit time, so the
    // delta reaches them; the handler strips R2 from allowedRooms afterward.
    const fullStatesBefore = bag(memberSock).filter(
      (m) => m.type === "full_state",
    ).length;
    await httpMut(server, owner.rawSessionId, "DELETE", `/api/rooms/${r2}`);
    await waitForMessageWhere(
      memberSock,
      (m) => m.type === "room_closed" && m.roomId === r2,
    );
    // Close-cleanup: the dead R2 id is stripped from the member's allowedRooms,
    // reaching their OWN socket via user_self_updated (the full self record). No
    // all-audience broadcast carries another user's grants (no leak).
    const selfUpd = await waitForMessageWhere(
      memberSock,
      (m) =>
        m.type === "user_self_updated" &&
        !((m.user as UserRecord).allowedRooms ?? []).includes(r2),
    );
    expect((selfUpd.user as UserRecord).allowedRooms).not.toContain(r2);
    // No new full_state was sent on the close - the only refresh would have been
    // the now-deleted dense-shift path.
    expect(bag(memberSock).filter((m) => m.type === "full_state").length).toBe(
      fullStatesBefore,
    );
    // Y (in R3) is untouched: it keeps its stable roomId from the connect
    // full_state; the close did not move it.
    expect(agentInFullState(latestFullState(memberSock)!, y.id)!.roomId).toBe(
      r3,
    );
  });

  it("reorder_rooms is PER-USER (3b.4 flip): a member reorders their own visible rooms; the global order is unchanged; an owner's reorder does not affect the member", async () => {
    // 3b.4 FLIP of the old global/owner-only reorder. Reorder is now a per-user
    // VIEW preference (applyViewChange): always allowed, NO global _rooms
    // mutation, NO rooms_reordered event. Each user's full_state reflects only
    // THEIR own order; one user's reorder never reprojects another.
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1, r2]); // member sees R1, R2
    const memberSock = await connectSettled(server, member.rawSessionId);
    expect(fullStateRoomIds(latestFullState(memberSock)!)).toEqual([r1, r2]);

    // Member reorders their OWN visible slice (R2 before R1) - always allowed,
    // no owner gate. They get a projected full_state in their new order; an
    // inaccessible id in the request (none here) would be silently filtered.
    await httpMut(server, member.rawSessionId, "PUT", "/api/me/view/order", {
      order: [r2, r1],
    });
    await waitForMessageWhere(
      memberSock,
      (m) =>
        m.type === "full_state" &&
        fullStateRoomIds(m).join() === [r2, r1].join(),
    );
    expect(fullStateRoomIds(latestFullState(memberSock)!)).toEqual([r2, r1]);
    // The GLOBAL room order is UNCHANGED - reorder no longer mutates _rooms.
    expect(server.agentManager.getRooms().map((r) => r.id)).toEqual([
      r1,
      r2,
      r3,
    ]);
    // No rooms_reordered wire message is ever emitted (retired in 3b.4).
    expect(bag(memberSock).some((m) => m.type === "rooms_reordered")).toBe(
      false,
    );

    // The owner reorders THEIR own (full) view; this is independent of the
    // member's order and of the global list.
    await httpMut(server, owner.rawSessionId, "PUT", "/api/me/view/order", {
      order: [r3, r2, r1],
    });
    await waitForMessageWhere(
      ownerSock,
      (m) =>
        m.type === "full_state" &&
        fullStateRoomIds(m).join() === [r3, r2, r1].join(),
    );
    expect(fullStateRoomIds(latestFullState(ownerSock)!)).toEqual([r3, r2, r1]);
    // Member's order is untouched by the owner's reorder; global still stable.
    expect(fullStateRoomIds(latestFullState(memberSock)!)).toEqual([r2, r1]);
    expect(server.agentManager.getRooms().map((r) => r.id)).toEqual([
      r1,
      r2,
      r3,
    ]);
  });
});

describe("create_room under rule-based access (Phase 3b flip of the owner fan-out)", () => {
  it("member creator gets access by GRANT (full_state); owners get the room by RULE via room_created (no fan-out); other members do not; no grant leak", async () => {
    // 3b FLIP of the materialized create_room fan-out. Under rule-based access:
    //   - a MEMBER creator is granted access and catches up via a projected
    //     full_state (room_created fired pre-grant, suppressed for them);
    //   - OWNERS reach the new room by RULE, so they receive room_created LIVE
    //     (no allowedRooms fan-out, no full_state push);
    //   - other members get nothing until granted;
    //   - the old KNOWN LEAK is GONE: no user_updated carries the new room id -
    //     a grant change reaches only its own subject (full_state), never the
    //     all-audience broadcast.
    server = await boot();
    const owner = await server.seedOwner("Boss"); // owner, rule access
    const creator = await server.seedMember("Cara"); // member, starts []
    const other = await server.seedMember("Omar"); // member, starts []

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    const creatorSock = await connectSettled(server, creator.rawSessionId);
    const otherSock = await connectSettled(server, other.rawSessionId);

    await httpMut(server, creator.rawSessionId, "POST", "/api/rooms", {
      name: "NewRoom",
    });

    // Member creator catches up via a projected full_state that includes the new
    // room (the grant path - NOT a fan-out).
    const creatorFs = await waitForMessageWhere(
      creatorSock,
      (m) => m.type === "full_state" && fullStateRoomIds(m).length >= 1,
    );
    const newId = fullStateRoomIds(creatorFs)[0];

    // Owner receives the new room by RULE via room_created (NOT a fan-out
    // full_state): rule access puts every owner in the room_created audience.
    const ownerRc = await waitForMessageWhere(
      ownerSock,
      (m) => m.type === "room_created" && (m.room as RoomWire).id === newId,
    );
    expect((ownerRc.room as RoomWire).id).toBe(newId);

    expect(fullStateRoomIds(latestFullState(creatorSock)!)).toContain(newId);
    // The other member never sees the room.
    expect(fullStateRoomIds(latestFullState(otherSock)!)).not.toContain(newId);

    // NO LEAK (the red assertion 3b flips green): ping/pong is the synchronous
    // barrier (the create_room fanout already ran), and NO user_updated carrying
    // the new room id ever reached the other member.
    await pingPong(otherSock);
    expect(
      bag(otherSock).some(
        (m) =>
          m.type === "user_updated" &&
          (m.user as UserRecord).allowedRooms?.includes(newId) === true,
      ),
    ).toBe(false);
    expect(fullStateRoomIds(latestFullState(otherSock)!)).not.toContain(newId);
  });
});

describe("update_user room-access grant / revoke (Phase 1.2)", () => {
  it("granting a member access pushes a projected full_state (with replay) to their existing sockets", async () => {
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const z = await spawnIn(server, "Z", r2);
    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1]);
    await driveTurn(server, owner.rawSessionId, ownerSock, z.id, "z-history");
    const memberSock = await connectSettled(server, member.rawSessionId);
    expect(fullStateRoomIds(latestFullState(memberSock)!)).toEqual([r1]);

    // Grant R2 on the member's EXISTING socket (no reconnect).
    const sinceIdx = bag(memberSock).length;
    await setAccess(server, owner.rawSessionId, member.username, [r1, r2]);
    await waitForMessageWhere(
      memberSock,
      (m) =>
        m.type === "full_state" &&
        fullStateRoomIds(m).includes(r2) &&
        !!agentInFullState(m, z.id),
    );
    const mfs = latestFullState(memberSock)!;
    expect(fullStateRoomIds(mfs)).toEqual([r1, r2]);
    expect(agentInFullState(mfs, z.id)!.roomId).toBe(r2);
    // Newly-visible agent's transcript is REPLAYED (after the grant's full_state).
    await waitForLogSince(
      memberSock,
      z.id,
      (e) => e.kind === "user_message" && e.content === "z-history",
      sinceIdx,
    );
  });

  it("revoking access reprojects the member's view and clamps their presence", async () => {
    // Checklist #7: "update_user allowedRooms ... clamps presence if access was
    // revoked."
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1, r2]);
    const memberSock = await connectSettled(server, member.rawSessionId);
    const memberCid = connectionIdOf(memberSock);

    // Member parks their ghost in R2 (by stable id).
    memberSock.send({
      type: "presence_update",
      currentRoomId: r2,
      focusedAgentId: null,
      viewMode: "office",
    });
    await waitForMessageWhere(
      ownerSock,
      (m) =>
        m.type === "presence_list" &&
        (
          m.entries as { connectionId: string; currentRoomId: string | null }[]
        ).some((e) => e.connectionId === memberCid && e.currentRoomId === r2),
    );

    // Revoke R2: the member's view drops it AND their ghost is clamped off-scene.
    const presBefore = bag(ownerSock).filter(
      (m) => m.type === "presence_list",
    ).length;
    await setAccess(server, owner.rawSessionId, member.username, [r1]);
    await waitForMessageWhere(
      memberSock,
      (m) => m.type === "full_state" && fullStateRoomIds(m).join() === r1,
    );
    expect(fullStateRoomIds(latestFullState(memberSock)!)).toEqual([r1]);

    // Presence clamp: wait for the revoke's presence rebroadcast on the OWNER
    // socket directly (not a cross-socket read keyed off the member's full_state,
    // which races), then assert the member's ghost (was in R2) is now omitted
    // from the wire (currentRoomId clamped to null on revoke).
    await waitForTypeCount(ownerSock, "presence_list", presBefore + 1);
    const ownerPresence = bag(ownerSock).filter(
      (m) => m.type === "presence_list",
    );
    const last = ownerPresence[ownerPresence.length - 1];
    expect(
      (last.entries as { connectionId: string }[]).some(
        (e) => e.connectionId === memberCid,
      ),
    ).toBe(false);
  });
});

describe("agent_removed room-ACL (task 03382535 - 3b.3 flip of the broadcast-all bridge)", () => {
  it("agent_removed reaches only sessions that can see the removed agent's room", async () => {
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const hidden = await spawnIn(server, "Hid", r2);
    const visible = await spawnIn(server, "Vis", r1);

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1]);
    const memberSock = await connectSettled(server, member.rawSessionId);

    // Hidden-room kill first, visible-room kill second; waiting for the
    // SECOND agent_removed on the member socket is the barrier proving the
    // first one had every chance to arrive.
    await server.agentManager.kill(hidden.id);
    await server.agentManager.kill(visible.id);

    await waitForMessageWhere(
      ownerSock,
      (m) => m.type === "agent_removed" && m.agentId === hidden.id,
    );
    await waitForMessageWhere(
      memberSock,
      (m) => m.type === "agent_removed" && m.agentId === visible.id,
    );
    // Pre-3b.3 characterization (now FLIPPED): the member used to receive the
    // hidden-room agent_removed too (broadcast-all id leak). Scoped to the
    // carried pre-removal roomId, it must not arrive.
    expect(
      bag(memberSock).some(
        (m) => m.type === "agent_removed" && m.agentId === hidden.id,
      ),
    ).toBe(false);
    // The wire event carries the pre-removal roomId (audience input).
    const ownerRemoved = bag(ownerSock).find(
      (m) => m.type === "agent_removed" && m.agentId === hidden.id,
    );
    expect(ownerRemoved?.roomId).toBe(r2);
  });
});

describe("killed-agent summary ACL (Phase 1.2)", () => {
  it("killed summaries are filtered by lastRoomId per recipient; killed_agent_added is suppressed for the restricted member", async () => {
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const hk = await spawnIn(server, "Hk", r2); // hidden-room kill
    await server.agentManager.kill(hk.id);
    const vk = await spawnIn(server, "Vk", r1); // visible-room kill
    await server.agentManager.kill(vk.id);

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1]);
    const memberSock = await connectSettled(server, member.rawSessionId);

    const ownerKilled = (
      latestFullState(ownerSock)!.killedAgents as KilledAgentSummary[]
    ).map((k) => k.id);
    const memberKilled = (
      latestFullState(memberSock)!.killedAgents as KilledAgentSummary[]
    ).map((k) => k.id);
    expect(ownerKilled).toContain(hk.id);
    expect(ownerKilled).toContain(vk.id);
    expect(memberKilled).toContain(vk.id);
    expect(memberKilled).not.toContain(hk.id); // hidden lastRoomId filtered

    // Live killed_agent_added for a hidden-room agent: owner gets it (barrier),
    // member does not.
    const lk = await spawnIn(server, "Lk", r2);
    await server.agentManager.kill(lk.id);
    await waitForMessageWhere(
      ownerSock,
      (m) =>
        m.type === "killed_agent_added" &&
        (m.agent as KilledAgentSummary).id === lk.id,
    );
    expect(
      bag(memberSock).some(
        (m) =>
          m.type === "killed_agent_added" &&
          (m.agent as KilledAgentSummary).id === lk.id,
      ),
    ).toBe(false);
  });

  it("revive requires access to BOTH the target room and the killed agent's lastRoomId", async () => {
    // autoSystemInit:false → the spawned agent never receives a backend session
    // id, so when it is killed its lastSessionId is null and the owner's
    // successful revive takes the FRESH-session path (createSession, no resume).
    // That avoids the real resume preflight (claudeSessionFileExists), which
    // would fail for a FakeBackend session and print a production
    // "[revive] Resume ... falling back to fresh session" console.warn on every
    // run. The ACL gates this test characterizes run in the dispatch handler
    // BEFORE any session install, so they are completely unaffected.
    server = await startTestServer({
      fakeBackend: new FakeBackend({ session: { autoSystemInit: false } }),
    });
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const k = await spawnIn(server, "K", r2); // lastRoomId = R2 (hidden)
    await server.agentManager.kill(k.id);

    await connectSettled(server, owner.rawSessionId);
    await setAccess(server, owner.rawSessionId, member.username, [r1]);
    // member.rawSessionId drives REST directly; no member socket needed.

    // POST revive over REST as the given session.
    const reviveHttp = async (rawSessionId: string, roomId: string) => {
      const res = await server!.http(`/api/agents/${k.id}/revive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desk: 0, roomId }),
        rawSessionId,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    // Into a visible room, but lastRoomId is hidden → blocked by the
    // reviveLastRoomAccess precondition (the lastRoomId ACL).
    const blocked1 = await reviveHttp(member.rawSessionId, r1);
    expect(blocked1.status).toBe(403);
    expect(
      String(
        (blocked1.body as { error?: { message?: string } }).error?.message,
      ),
    ).toContain("not available to revive");

    // Into the hidden room itself → blocked by the bodyRoom(roomId) guard
    // (the target-room ACL) before the precondition runs.
    const blocked2 = await reviveHttp(member.rawSessionId, r2);
    expect(blocked2.status).toBe(403);

    expect(
      server.agentManager.getKilledAgentSummaries().some((s) => s.id === k.id),
    ).toBe(true); // still killed after both blocked attempts

    // Owner can see both rooms → revive succeeds (200 { agent }).
    const okRevive = await reviveHttp(owner.rawSessionId, r1);
    expect(okRevive.status).toBe(200);
    expect(server.agentManager.getAgent(k.id)).toBeDefined();
  });
});

describe("agent-to-agent message endpoint is outside browser room ACL (Phase 1.2)", () => {
  it("permits cross-room enqueue (existence-only gate), regardless of either agent's room visibility", async () => {
    // The AGENT branch of /api/agents/:id/messages takes the senderMustEqualToken
    // guard (NO room ACL - cross-room delivery is allowed) plus the
    // messageRecipientExists precondition (existence-only). The sender's identity
    // (incl. its roomName) is derived from the AGENT bearer server-side, so a
    // hidden-room sender still reaches a receiver in another room.
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    await server.seedOwner("Boss");

    const sender = await spawnIn(server, "Sender", r2); // a "hidden" room
    const receiver = await spawnIn(server, "Receiver", r1);

    // Sender authenticates with its own AGENT bearer (the sender is token-
    // derived, not body-sourced). Delivery crosses the room boundary.
    const ok = await server.http(`/api/agents/${receiver.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAgentTokenRaw(sender.id)!}`,
      },
      body: JSON.stringify({ text: "ping" }),
    });
    expect(ok.status).toBe(200);
    expect(typeof ((await ok.json()) as { messageId?: string }).messageId).toBe(
      "string",
    );

    // Existence is the ONLY gate (no exists-but-hidden distinction - no room ACL
    // on the AGENT branch): an unknown RECEIVER is a generic 404 from the
    // messageRecipientExists precondition, never a leak of whether a hidden agent
    // exists.
    const bad = await server.http(`/api/agents/no-such-agent/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAgentTokenRaw(sender.id)!}`,
      },
      body: JSON.stringify({ text: "ping" }),
    });
    expect(bad.status).toBe(404);
  });
});
