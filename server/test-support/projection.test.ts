// Phase 1.2 — Projection / ACL characterization.
//
// Freezes TODAY's per-recipient projection — which lives IMPLICITLY in the
// per-WebSocket fanout in server/index.ts (sendProjectedFullState +
// routeAgentEventToWs + the per-WS push helpers), there is no projection
// service yet — so the Phase 3 rewrites have a before/after safety net:
//   - 3b extracts the implicit projection into a declared ACL/view service and
//     replaces materialized owner access + the create_room fan-out with
//     rule-based access, and deletes the global owner-only reorder gate.
//   - 3c replaces the DENSE per-recipient numeric agent.room index with an
//     id-keyed wire.
// These tests pin the CURRENT model verbatim, through the wire only (WS
// messages + REST responses), never internals. They are expected to change
// (or be deliberately flipped) when 3b/3c land; that is the point.
//
// Current model frozen here (verified against index.ts / shared/office-state.ts
// / auth.ts):
//   - Access == UserRecord.allowedRooms (literal string[]; no "all" sentinel).
//   - Owner access is MATERIALIZED: seedOwner snapshots every current room id;
//     create_room appends the new roomId to the creator + every owner's
//     allowedRooms + notifRooms (the fan-out). A fresh member defaults to [].
//   - full_state.agents carry a DENSE per-recipient room index (or are dropped
//     if hidden); full_state.rooms is filtered to the recipient's visible set;
//     all_rooms_list is owner-only and UNFILTERED.
//   - reorder_rooms is GLOBAL and owner-only-gated (the gate 3b deletes).
//
// Determinism (no arbitrary sleeps): routeAgentEvent fans out to every socket
// SYNCHRONOUSLY, so "a full-access owner socket received event X" implies every
// restricted socket's decision on X already ran — that is the barrier for
// negative assertions. The connect handshake sends presence_list LAST, so
// awaiting it guarantees the whole handshake (incl. per-agent log_entry +
// slash_commands replay) arrived. Mutation handlers (create_room / update_user
// / close / reorder) run fully synchronously incl. their pushes, so awaiting one
// recipient's resulting full_state settles all of them.
//
// Scope note — terminal: routeAgentEventToWs gates terminal_output/terminal_exit
// in the SAME agentVisibleForSession switch arm as log_entry/slash_commands, and
// terminal_open additionally replays buffered output via a broadcast guarded by
// an agentVisibleForSession check on the requester. FakeBackend has no PTY and
// the testing strategy carves terminal into its own stubbed-PTY/opt-in seam, so
// terminal is NOT characterized here; proving the shared event arm via
// log/slash/sessions does not stand in for the terminal_open replay path. Both
// belong with the future terminal seam.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
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

let reqSeq = 0;
const nextReqId = () => `req-${++reqSeq}`;

// A FakeBackend that completes every turn (so the agent lands back at
// waiting_for_response). Assertions anchor on the RAW human `user_message` log
// entry — logged verbatim before the orchestrator wraps the text with sender
// attribution for the backend — so the assistant text content is unused.
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
// AFTER `sinceIndex` in the socket's append-only buffer — i.e. it was REPLAYED
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

// Owner grants/sets a member's room access via the real WS update_user seam
// (the owner-gated allowedRooms path). Awaits the ack so the grant is applied.
async function setAccess(
  ownerSock: TestSocket,
  username: string,
  roomIds: string[],
): Promise<void> {
  const requestId = nextReqId();
  ownerSock.send({
    type: "update_user",
    requestId,
    username,
    changes: { allowedRooms: roomIds },
  });
  const resp = await waitForMessageWhere(
    ownerSock,
    (m) => m.type === "settings_save_response" && m.requestId === requestId,
  );
  if (resp.ok !== true)
    throw new Error(`setAccess failed: ${String(resp.error)}`);
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
// `user_message` log entry (the unique marker) is observed on that socket — the
// synchronous-fanout barrier, and the specific entry whose replay the
// transcript-preservation cases assert.
async function driveTurn(
  ownerSock: TestSocket,
  agentId: string,
  marker: string,
): Promise<void> {
  ownerSock.send({ type: "send_message", agentId, text: marker });
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

// Create N extra rooms BEFORE seeding the owner, so the owner's seed snapshot
// covers every room (owner = full access, no create_room fan-out noise).
function makeRoomsBeforeOwner(srv: TestServer, names: string[]): string[] {
  return names.map((n) => srv.agentManager.createRoom(n));
}

describe("full_state projection — connect-time ACL (Phase 1.2)", () => {
  it("two users with overlapping non-identical access: rooms filtered + agent.room dense per recipient", async () => {
    // Checklist: "Two users with overlapping but non-identical access connect
    // simultaneously; full_state rooms are filtered and agent.room is dense per
    // recipient." This is the dense-index contract 3c replaces.
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss"); // full access (all 3 rooms)
    const member = await server.seedMember("Mia");

    const a1 = await spawnIn(server, "A1", r1);
    const a2 = await spawnIn(server, "A2", r2);
    const a3 = await spawnIn(server, "A3", r3);

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(ownerSock, member.username, [r1, r3]); // member sees R1 + R3, not R2
    const memberSock = await connectSettled(server, member.rawSessionId);

    const ofs = latestFullState(ownerSock)!;
    const mfs = latestFullState(memberSock)!;

    // Owner: unfiltered rooms, global dense == identity indices.
    expect(fullStateRoomIds(ofs)).toEqual([r1, r2, r3]);
    expect(agentInFullState(ofs, a1.id)!.room).toBe(0);
    expect(agentInFullState(ofs, a2.id)!.room).toBe(1);
    expect(agentInFullState(ofs, a3.id)!.room).toBe(2);

    // Member: R2 filtered out; R3 collapses to dense index 1; the R2 agent is
    // absent entirely.
    expect(fullStateRoomIds(mfs)).toEqual([r1, r3]);
    expect(agentInFullState(mfs, a1.id)!.room).toBe(0);
    expect(agentInFullState(mfs, a3.id)!.room).toBe(1);
    expect(agentInFullState(mfs, a2.id)).toBeUndefined();
  });

  it("owner with a self-hidden room: main view respects access, owner-only all_rooms_list stays unfiltered; members never receive all_rooms_list", async () => {
    // Checklist: "Owner with hidden rooms: main view respects access, owner-only
    // all_rooms_list stays unfiltered." Confirms the materialized-to-computed
    // owner-access migration (3b) must preserve this.
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

    // Owner hides R3 from their OWN view (a self-restrict of allowedRooms).
    await setAccess(ownerSock, owner.username, [r1, r2]);
    const refreshed = await waitForMessageWhere(
      ownerSock,
      (m) => m.type === "full_state" && fullStateRoomIds(m).length === 2,
    );
    // Main view now respects the self-restriction...
    expect(fullStateRoomIds(refreshed)).toEqual([r1, r2]);

    // ...but the owner-only all_rooms_list is still UNFILTERED. Re-exercise the
    // PUSH path under the restriction (not just the full-access connect snapshot):
    // a room mutation re-pushes all_rooms_list, and it must still include R3 even
    // though R3 is hidden from the owner's own main view.
    const arBefore = bag(ownerSock).filter(
      (m) => m.type === "all_rooms_list",
    ).length;
    ownerSock.send({ type: "rename_room", roomId: r1, name: "R1-renamed" });
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

describe("per-recipient event ACL — mid-session (Phase 1.2)", () => {
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
    await setAccess(ownerSock, member.username, [r1]);
    const memberSock = await connectSettled(server, member.rawSessionId);

    // Hidden-room turn. Barrier = the turn's ASSISTANT text (its LAST log_entry)
    // reaching the owner: the human user_message is logged synchronously, but
    // the assistant reply routes async via the orchestrator stream loop, so
    // waiting on the later of the two guarantees the member's suppression
    // decision has run for EVERY log_entry of this turn (synchronous fanout).
    ownerSock.send({
      type: "send_message",
      agentId: hid.id,
      text: "secret-hidden",
    });
    await waitForLog(
      ownerSock,
      hid.id,
      (e) => e.kind === "text" && e.content === "ok",
    );
    expect(logEntriesFor(memberSock, hid.id)).toHaveLength(0);

    // Positive control: a visible-room turn DOES reach the member (so the
    // absence above is ACL, not a dead pipe).
    ownerSock.send({
      type: "send_message",
      agentId: vis.id,
      text: "open-visible",
    });
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
    await setAccess(ownerSock, member.username, [r1]);
    await driveTurn(ownerSock, vis.id, "vis-log");
    await driveTurn(ownerSock, hid.id, "hid-log");

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

  it("list_sessions fans out only to sockets that can see the agent", async () => {
    // Checklist: "list_sessions/... for hidden agents do not leak ids/topics/
    // timestamps." Barrier = owner receives sessions_list for the hidden agent.
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const vis = await spawnIn(server, "Vis", r1);
    const hid = await spawnIn(server, "Hid", r2);

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(ownerSock, member.username, [r1]);
    const memberSock = await connectSettled(server, member.rawSessionId);

    // Hidden agent: only the owner gets the sessions_list.
    ownerSock.send({ type: "list_sessions", agentId: hid.id });
    await waitForMessageWhere(
      ownerSock,
      (m) => m.type === "sessions_list" && m.agentId === hid.id,
    );
    expect(
      bag(memberSock).some(
        (m) => m.type === "sessions_list" && m.agentId === hid.id,
      ),
    ).toBe(false);

    // Visible agent: the member (who can see it) also receives the fan-out.
    ownerSock.send({ type: "list_sessions", agentId: vis.id });
    await waitForMessageWhere(
      memberSock,
      (m) => m.type === "sessions_list" && m.agentId === vis.id,
    );
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
    await setAccess(ownerSock, member.username, [r1]);
    await driveTurn(ownerSock, x.id, "c1-history");

    const memberSock = await connectSettled(server, member.rawSessionId);
    expect(
      agentInFullState(latestFullState(memberSock)!, x.id),
    ).toBeUndefined();
    expect(logEntriesFor(memberSock, x.id)).toHaveLength(0);

    const sinceIdx = bag(memberSock).length;
    ownerSock.send({ type: "move_agent", agentId: x.id, targetRoomId: r1 });
    await waitForMessageWhere(
      memberSock,
      (m) => m.type === "full_state" && !!agentInFullState(m, x.id),
    );

    const mfs = latestFullState(memberSock)!;
    expect(agentInFullState(mfs, x.id)!.room).toBe(0); // R1 = member's only room
    // Transcript-preservation: the SPECIFIC prior entry is REPLAYED by the
    // move's projected full_state (asserted by position — after the shift).
    await waitForLogSince(
      memberSock,
      x.id,
      (e) => e.kind === "user_message" && e.content === "c1-history",
      sinceIdx,
    );
  });

  it("visible→hidden: the agent drops out of the member's projected full_state", async () => {
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const x = await spawnIn(server, "X", r1); // visible to member
    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(ownerSock, member.username, [r1]);
    await driveTurn(ownerSock, x.id, "c2-history");
    const memberSock = await connectSettled(server, member.rawSessionId);
    expect(agentInFullState(latestFullState(memberSock)!, x.id)).toBeDefined();

    ownerSock.send({ type: "move_agent", agentId: x.id, targetRoomId: r2 });
    await waitForMessageWhere(
      memberSock,
      (m) => m.type === "full_state" && !agentInFullState(m, x.id),
    );
    expect(
      agentInFullState(latestFullState(memberSock)!, x.id),
    ).toBeUndefined();
  });

  it("visible→visible: the dense index remaps and the transcript survives", async () => {
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const x = await spawnIn(server, "X", r1);
    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(ownerSock, member.username, [r1, r3]); // member sees R1 + R3
    await driveTurn(ownerSock, x.id, "c3-history");
    const memberSock = await connectSettled(server, member.rawSessionId);
    expect(agentInFullState(latestFullState(memberSock)!, x.id)!.room).toBe(0);

    const sinceIdx = bag(memberSock).length;
    ownerSock.send({ type: "move_agent", agentId: x.id, targetRoomId: r3 });
    await waitForMessageWhere(
      memberSock,
      (m) => m.type === "full_state" && agentInFullState(m, x.id)?.room === 1,
    );
    const mfs = latestFullState(memberSock)!;
    expect(agentInFullState(mfs, x.id)!.room).toBe(1); // R3 = member's dense idx 1
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
});

describe("room close / reorder with restricted members (Phase 1.2)", () => {
  it("closing a visible room remaps the member's dense indices and replays transcripts", async () => {
    server = await boot();
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const y = await spawnIn(server, "Y", r3); // member's dense idx 1 initially
    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(ownerSock, member.username, [r2, r3]); // sees R2 + R3, not R1
    await driveTurn(ownerSock, y.id, "d1-history");
    const memberSock = await connectSettled(server, member.rawSessionId);

    const before = latestFullState(memberSock)!;
    expect(fullStateRoomIds(before)).toEqual([r2, r3]);
    expect(agentInFullState(before, y.id)!.room).toBe(1);

    // Close R2 (empty; not index 0): shifts the member's dense space down.
    const sinceIdx = bag(memberSock).length;
    ownerSock.send({ type: "close_room", roomId: r2 });
    await waitForMessageWhere(
      memberSock,
      (m) => m.type === "full_state" && fullStateRoomIds(m).join() === r3,
    );
    const after = latestFullState(memberSock)!;
    expect(fullStateRoomIds(after)).toEqual([r3]);
    expect(agentInFullState(after, y.id)!.room).toBe(0); // R3 collapses to 0
    // Replay-on-shift (NOT the connect-time copy): Y stays visible across the
    // close, so the transcript must be re-sent AFTER the close's full_state.
    await waitForLogSince(
      memberSock,
      y.id,
      (e) => e.kind === "user_message" && e.content === "d1-history",
      sinceIdx,
    );
  });

  it("reorder_rooms is global and owner-only-gated (OLD behavior frozen for 3b)", async () => {
    // 3b deletes this gate (reorder becomes per-user, always allowed). Freeze
    // the current behavior: a partial-access member's reorder is a no-op; an
    // owner's reorder rewrites the GLOBAL order and reprojects each member.
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2, r3] = makeRoomsBeforeOwner(server, ["R2", "R3"]);
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(ownerSock, member.username, [r1, r2]); // partial (no R3)
    const memberSock = await connectSettled(server, member.rawSessionId);

    // Member (partial access) cannot reorder the global list: no-op. ping/pong
    // proves the denied command was processed (it emits nothing observable).
    memberSock.send({ type: "reorder_rooms", order: [r3, r2, r1] });
    await pingPong(memberSock);
    expect(server.agentManager.getRooms().map((r) => r.id)).toEqual([
      r1,
      r2,
      r3,
    ]);

    // Owner (full access) reorders globally; the member is reprojected into the
    // new global order (their visible slice R1,R2 flips to R2,R1).
    ownerSock.send({ type: "reorder_rooms", order: [r2, r1, r3] });
    await waitForMessageWhere(
      memberSock,
      (m) =>
        m.type === "full_state" &&
        fullStateRoomIds(m).join() === [r2, r1].join(),
    );
    expect(server.agentManager.getRooms().map((r) => r.id)).toEqual([
      r2,
      r1,
      r3,
    ]);
    expect(fullStateRoomIds(latestFullState(memberSock)!)).toEqual([r2, r1]);
  });
});

describe("create_room owner fan-out — current materialized model (Phase 1.2)", () => {
  it("creator gets access, every owner gets access via the materialized fan-out, other members do not", async () => {
    // Checklist #6, frozen as the CURRENT model: create_room appends the new
    // roomId to the creator + every owner's allowedRooms (the fan-out 3b
    // deletes in favor of rule-based owner access). Also pins a KNOWN-CURRENT
    // LEAK (see below) so 3b has a deliberate test to flip.
    server = await boot();
    const owner = await server.seedOwner("Boss"); // owner, full access
    const creator = await server.seedMember("Cara"); // member, starts []
    const other = await server.seedMember("Omar"); // member, starts []

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    const creatorSock = await connectSettled(server, creator.rawSessionId);
    const otherSock = await connectSettled(server, other.rawSessionId);

    creatorSock.send({ type: "create_room", name: "NewRoom" });

    // Creator gets a projected full_state that now includes the new room.
    const creatorFs = await waitForMessageWhere(
      creatorSock,
      (m) => m.type === "full_state" && fullStateRoomIds(m).length >= 1,
    );
    const newId = fullStateRoomIds(creatorFs)[0];

    // Owner gets it via the fan-out (their allowedRooms is mutated + pushed),
    // NOT via a room_created event (which was suppressed pre-grant).
    await waitForMessageWhere(
      ownerSock,
      (m) => m.type === "full_state" && fullStateRoomIds(m).includes(newId),
    );

    expect(fullStateRoomIds(latestFullState(creatorSock)!)).toContain(newId);
    expect(fullStateRoomIds(latestFullState(ownerSock)!)).toContain(newId);
    // The other member is NOT in the fan-out: the room never enters their view.
    expect(fullStateRoomIds(latestFullState(otherSock)!)).not.toContain(newId);

    // KNOWN-CURRENT-LEAK (frozen on purpose): user_updated / users_list are
    // broadcast UNFILTERED, so the fan-out leaks the hidden room's id to the
    // other member through another user's allowedRooms on the wire. 3b's user-
    // wire projection removes this; this assertion is the red test 3b flips.
    const leaked = await waitForMessageWhere(
      otherSock,
      (m) =>
        m.type === "user_updated" &&
        (m.user as UserRecord).allowedRooms?.includes(newId) === true,
    );
    expect((leaked.user as UserRecord).allowedRooms).toContain(newId);
    // ...even though that room id is absent from the other member's own view.
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
    await setAccess(ownerSock, member.username, [r1]);
    await driveTurn(ownerSock, z.id, "z-history");
    const memberSock = await connectSettled(server, member.rawSessionId);
    expect(fullStateRoomIds(latestFullState(memberSock)!)).toEqual([r1]);

    // Grant R2 on the member's EXISTING socket (no reconnect).
    const sinceIdx = bag(memberSock).length;
    await setAccess(ownerSock, member.username, [r1, r2]);
    await waitForMessageWhere(
      memberSock,
      (m) =>
        m.type === "full_state" &&
        fullStateRoomIds(m).includes(r2) &&
        !!agentInFullState(m, z.id),
    );
    const mfs = latestFullState(memberSock)!;
    expect(fullStateRoomIds(mfs)).toEqual([r1, r2]);
    expect(agentInFullState(mfs, z.id)!.room).toBe(1);
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
    await setAccess(ownerSock, member.username, [r1, r2]);
    const memberSock = await connectSettled(server, member.rawSessionId);
    const memberCid = connectionIdOf(memberSock);

    // Member parks their ghost in R2 (their dense index 1).
    memberSock.send({
      type: "presence_update",
      currentRoom: 1,
      focusedAgentId: null,
      viewMode: "office",
    });
    await waitForMessageWhere(
      ownerSock,
      (m) =>
        m.type === "presence_list" &&
        (
          m.entries as { connectionId: string; currentRoom: number | null }[]
        ).some((e) => e.connectionId === memberCid && e.currentRoom === 1),
    );

    // Revoke R2: the member's view drops it AND their ghost is clamped off-scene.
    const presBefore = bag(ownerSock).filter(
      (m) => m.type === "presence_list",
    ).length;
    await setAccess(ownerSock, member.username, [r1]);
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
    await setAccess(ownerSock, member.username, [r1]);
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

    const ownerSock = await connectSettled(server, owner.rawSessionId);
    await setAccess(ownerSock, member.username, [r1]);
    const memberSock = await connectSettled(server, member.rawSessionId);

    // Into a visible room, but lastRoomId is hidden → blocked on the kill ACL.
    const rid1 = nextReqId();
    memberSock.send({
      type: "revive",
      requestId: rid1,
      agentId: k.id,
      desk: 0,
      roomId: r1,
    });
    const resp1 = await waitForMessageWhere(
      memberSock,
      (m) => m.type === "agent_save_response" && m.requestId === rid1,
    );
    expect(resp1.ok).toBe(false);
    expect(String(resp1.error)).toContain("not available to revive");

    // Into the hidden room itself → blocked on the target-room ACL.
    const rid2 = nextReqId();
    memberSock.send({
      type: "revive",
      requestId: rid2,
      agentId: k.id,
      desk: 0,
      roomId: r2,
    });
    const resp2 = await waitForMessageWhere(
      memberSock,
      (m) => m.type === "agent_save_response" && m.requestId === rid2,
    );
    expect(resp2.ok).toBe(false);
    expect(String(resp2.error)).toContain("access to that room");

    expect(
      server.agentManager.getKilledAgentSummaries().some((s) => s.id === k.id),
    ).toBe(true); // still killed after both blocked attempts

    // Owner can see both rooms → revive succeeds.
    const rid3 = nextReqId();
    ownerSock.send({
      type: "revive",
      requestId: rid3,
      agentId: k.id,
      desk: 0,
      roomId: r1,
    });
    const resp3 = await waitForMessageWhere(
      ownerSock,
      (m) => m.type === "agent_save_response" && m.requestId === rid3,
    );
    expect(resp3.ok).toBe(true);
    expect(server.agentManager.getAgent(k.id)).toBeDefined();
  });
});

describe("agent-to-agent message endpoint is outside browser room ACL (Phase 1.2)", () => {
  it("permits cross-room enqueue (existence-only gate), regardless of either agent's room visibility", async () => {
    // The loopback /agents/:id/message endpoint has NO session and no room ACL:
    // it gates on agent EXISTENCE only and the sender's identity (incl. its
    // roomName) is resolved server-side. Cross-room enqueue is intentional.
    // (Phase 2.1/3a token-auth this endpoint; this freezes that the room
    // boundary does not block delivery today.)
    server = await boot();
    const r1 = server.agentManager.getRooms()[0].id;
    const [r2] = makeRoomsBeforeOwner(server, ["R2"]);
    await server.seedOwner("Boss");

    const sender = await spawnIn(server, "Sender", r2); // a "hidden" room
    const receiver = await spawnIn(server, "Receiver", r1);

    const ok = await server.http(`/agents/${receiver.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "ping", senderAgentId: sender.id }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { ok?: boolean }).ok).toBe(true);

    // Existence is the ONLY gate (no exists-but-hidden distinction — there is no
    // ACL here at all): an unknown sender id is a generic 400.
    const bad = await server.http(`/agents/${receiver.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "ping", senderAgentId: "no-such-agent" }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error?: string }).error).toContain(
      "not a known agent",
    );
  });
});
