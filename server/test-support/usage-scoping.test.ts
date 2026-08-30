// /isomux-usage room scoping (task 091d0f6e).
//
// The report is a read surface over room-scoped data, so it follows the same
// ACCESS gate as the other read surfaces (roomAllowedForSession / the visible
// room projection): an office OWNER sees the whole office; a MEMBER sees only
// the rooms they can access - agent rows, room rows, and the total - with cron
// jobs (which carry no room) owner-only.
//
// Direct-call seam against the preload's temp STATE_ROOT, per the
// fork-usage.test.ts idiom: seed sessions.json + agent-history.json by hand,
// hand renderUsageReport a minimal agents map, assert on the markdown.
// Zero LLM calls.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  afterEach,
} from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  buildUsageReportData,
  renderUsageReport,
  usageAudienceForUser,
  type UsageAudience,
} from "../usage-report.ts";
import { registerProductionCronjobManagerForModuleReads } from "../cronjob-manager.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import type { CronjobManager } from "../cronjob-manager.ts";
import type { ManagedAgent } from "../internal-types.ts";
import type { RoomWire, UserRecord } from "../../shared/types.ts";

const ROOM_A = "aaaaaaaa";
const ROOM_B = "bbbbbbbb";

const ROOMS: RoomWire[] = [
  { id: ROOM_A, name: "Room A", prompt: null, canCloseWhenEmpty: false },
  { id: ROOM_B, name: "Room B", prompt: null, canCloseWhenEmpty: true },
];

// The report reads cron jobs through the module-read bridge, which throws when
// no production manager is registered. Register a stub with one cron job that
// has real spend, so "owner sees it / member doesn't" is an assertion about
// scoping rather than about an empty office.
const CRONJOB_COST = 7;
function stubCronjobManager(): void {
  registerProductionCronjobManagerForModuleReads({
    listCronjobs: () => [{ id: "cron-1", name: "Nightly" }],
    readCronjobLifetimeUsage: () => ({
      totalIn: 1000,
      cacheRead: 900,
      cacheCreation: 100,
      totalOut: 200,
      costUSD: CRONJOB_COST,
    }),
  } as unknown as CronjobManager);
}

afterAll(() => {
  // Shared Bun process: don't leak the stub into other test files.
  registerProductionCronjobManagerForModuleReads(null);
});

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
  stubCronjobManager();
});

// Seed one agent's on-disk usage: a single session whose cost is `costUSD`.
// Both the session and lifetime buckets read from this entry.
function seedUsage(agentId: string, costUSD: number): void {
  const dir = join(STATE_ROOT, "logs", agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sessions.json"),
    JSON.stringify({
      s1: {
        topic: null,
        lastModified: 0,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 900,
          cacheCreationInputTokens: 100,
          costUSD,
        },
      },
    }),
  );
}

function seedAgentHistory(
  entries: Record<string, { lastRoomId: string; lastRoomName: string }>,
): void {
  writeFileSync(
    join(STATE_ROOT, "agent-history.json"),
    JSON.stringify(entries),
  );
}

// Only the fields renderUsageReport reads. The cast keeps the fixture honest
// about that (a full ManagedAgent would need a live session + backend).
function liveAgent(id: string, name: string, roomId: string): ManagedAgent {
  return {
    info: { id, name, roomId },
    sessionId: "s1",
  } as unknown as ManagedAgent;
}

const OWNER: UsageAudience = { kind: "owner" };
const MEMBER_OF_A: UsageAudience = {
  kind: "member",
  roomIds: new Set([ROOM_A]),
};

// Two live agents, one per room, plus a killed agent that last lived in Room B
// and one with no history entry at all (an "unknown room" bucket).
function seedOffice(): Map<string, ManagedAgent> {
  seedUsage("agent-live-a", 1);
  seedUsage("agent-live-b", 2);
  seedUsage("agent-killed-b", 4);
  seedUsage("agent-killed-unknown", 8);
  seedAgentHistory({
    "agent-killed-b": { lastRoomId: ROOM_B, lastRoomName: "Room B" },
  });
  return new Map([
    ["agent-live-a", liveAgent("agent-live-a", "Alpha", ROOM_A)],
    ["agent-live-b", liveAgent("agent-live-b", "Beta", ROOM_B)],
  ]);
}

// The single "| **Total** |" row's lifetime dollar cell (last column).
function lifetimeTotalUsd(report: string): string {
  const row = report.split("\n").find((l) => l.startsWith("| **Total** |"));
  if (!row) throw new Error("no total row in report");
  const cells = row.split("|").map((c) => c.trim());
  return cells[cells.length - 2];
}

describe("usageAudienceForUser", () => {
  const base: Omit<UserRecord, "role" | "allowedRooms"> = {
    id: "u1",
    name: "U",
    notifRooms: [],
    envFile: null,
    createdAt: 0,
    avatarColor: "#000000",
    avatarVariant: "classic",
    hidden: [],
    order: [],
    memberPrompt: null,
    language: null,
    slideMode: false,
  };

  it("gives an owner the office-wide audience even with no room grants", () => {
    // Owners access every room by RULE; their allowedRooms is [] post-migration
    // and must not be read as a grant list.
    expect(
      usageAudienceForUser({ ...base, role: "owner", allowedRooms: [] }),
    ).toEqual({ kind: "owner" });
  });

  it("scopes a member to their grants", () => {
    const audience = usageAudienceForUser({
      ...base,
      role: "member",
      allowedRooms: [ROOM_A],
    });
    expect(audience.kind).toBe("member");
    expect(audience.kind === "member" && [...audience.roomIds]).toEqual([
      ROOM_A,
    ]);
  });

  it("fails closed on an unresolved user", () => {
    const audience = usageAudienceForUser(undefined);
    expect(audience.kind).toBe("member");
    expect(audience.kind === "member" && audience.roomIds.size).toBe(0);
  });
});

describe("renderUsageReport room scoping", () => {
  it("shows an owner every room, every agent, and cron jobs", () => {
    const report = renderUsageReport(seedOffice(), ROOMS, OWNER);
    expect(report).toContain("| Alpha | Room A |");
    expect(report).toContain("| Beta | Room B |");
    expect(report).toContain("| Room A |");
    expect(report).toContain("| Room B |");
    expect(report).toContain("(unknown room)");
    expect(report).toContain("## Per-cron job usage");
    expect(report).toContain("## Office total");
    // 1 + 2 + 4 + 8 agents + 7 cron = 22.
    expect(lifetimeTotalUsd(report)).toBe("$22.00");
  });

  it("hides agents, rooms, and their spend outside a member's access", () => {
    const report = renderUsageReport(seedOffice(), ROOMS, MEMBER_OF_A);
    expect(report).toContain("| Alpha | Room A |");
    expect(report).not.toContain("Beta");
    expect(report).toContain("| Room A |");
    expect(report).not.toContain("Room B");
    // Killed agents in a room the member can't reach, and the unknown-room
    // bucket, are owner-only - including their spend.
    expect(report).not.toContain("(unknown room)");
    expect(lifetimeTotalUsd(report)).toBe("$1.00");
  });

  it("keeps cron jobs out of a member's report and out of their total", () => {
    const report = renderUsageReport(seedOffice(), ROOMS, MEMBER_OF_A);
    expect(report).not.toContain("Per-cron job usage");
    expect(report).not.toContain("Nightly");
    expect(report).not.toContain("## Office total");
    expect(report).toContain("## Total");
    // $1.00, not $8.00 - the cron job's $7 never lands in a member's bottom line.
    expect(lifetimeTotalUsd(report)).toBe("$1.00");
  });

  it("gives a member with no grants an empty report, not the office's", () => {
    const report = renderUsageReport(seedOffice(), ROOMS, {
      kind: "member",
      roomIds: new Set(),
    });
    expect(report).not.toContain("Alpha");
    expect(report).not.toContain("Beta");
    expect(report).not.toContain("Room A");
    expect(report).not.toContain("Room B");
    expect(lifetimeTotalUsd(report)).toBe("-");
  });
});

describe("buildUsageReportData parity", () => {
  it("includes accessible killed-agent lifetime spend without exposing an agent row", () => {
    const data = buildUsageReportData(seedOffice(), ROOMS, {
      kind: "member",
      roomIds: new Set([ROOM_B]),
    });
    expect(data.agents.map((a) => a.name)).toEqual(["Beta"]);
    expect(data.rooms.map((r) => r.name)).toEqual(["Room B"]);
    expect(data.rooms[0].session.costUSD).toBe(2);
    expect(data.rooms[0].lifetime.costUSD).toBe(6);
    expect(data.total.lifetime.costUSD).toBe(6);
    expect(data.cronjobs).toBeUndefined();
  });
});

// The direct-call tests above pin the report; this one pins the WIRING - that
// the /isomux-usage handler resolves the AUTHENTICATED CALLER to an audience.
// A regression that dropped the caller (e.g. always passing the owner audience)
// would leave every assertion above green.
describe("/isomux-usage end to end (caller -> audience)", () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  // The command's report lands as a `system` entry in the agent's log. Read the
  // live log rather than the JSONL: a freshly spawned agent has no session yet
  // (the command is answered locally, without waking the backend), so nothing is
  // persisted - which is exactly the state a boss typing /isomux-usage first
  // thing is in.
  function lastReport(srv: TestServer, agentId: string): string {
    const entries = srv.agentManager
      .getAgentLogs(agentId)
      .filter(
        (e) => e.kind === "system" && e.content.includes("## Agent usage"),
      );
    const last = entries[entries.length - 1];
    if (!last) throw new Error("no usage report in the agent's log");
    return last.content;
  }

  it("scopes the report to the caller, in the same conversation", async () => {
    const srv = await startTestServer();
    server = srv;
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    await srv.http(`/api/users/${encodeURIComponent(member.username)}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRooms: [roomB] }),
      rawSessionId: owner.rawSessionId,
    });

    const alpha = await srv.agentManager.spawn(
      "Alpha",
      srv.stateRoot,
      "default",
      0,
      undefined,
      roomA,
    );
    const beta = await srv.agentManager.spawn(
      "Beta",
      srv.stateRoot,
      "default",
      1,
      undefined,
      roomB,
    );
    if (!alpha || !beta) throw new Error("spawn failed");

    // Both users run the command in the SAME agent's conversation (Beta, in the
    // member's only room), so the only variable is who is asking.
    await srv.agentManager.sendMessage(
      beta.id,
      "/isomux-usage",
      member.username,
    );
    const memberReport = lastReport(srv, beta.id);
    expect(memberReport).toContain("Beta");
    expect(memberReport).toContain("Room B");
    expect(memberReport).not.toContain("Alpha");
    expect(memberReport).toContain(
      "_Scoped to the rooms you can access; cron job spend isn't included._",
    );

    await srv.agentManager.sendMessage(
      beta.id,
      "/isomux-usage",
      owner.username,
    );
    const ownerReport = lastReport(srv, beta.id);
    expect(ownerReport).toContain("Alpha");
    expect(ownerReport).toContain("Beta");
    expect(ownerReport).toContain("## Office total");
    expect(ownerReport).not.toContain("Scoped to the rooms you can access");
  });
});

describe("GET /api/usage caller scoping", () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it("returns the shared owner and member projections", async () => {
    const srv = await startTestServer();
    server = srv;
    const roomA = srv.agentManager.getRooms()[0].id;
    const roomB = srv.agentManager.createRoom("Room B");
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Mia");
    await srv.http(`/api/users/${encodeURIComponent(member.username)}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRooms: [roomB] }),
      rawSessionId: owner.rawSessionId,
    });
    await srv.agentManager.spawn(
      "Alpha",
      srv.stateRoot,
      "default",
      0,
      undefined,
      roomA,
    );
    await srv.agentManager.spawn(
      "Beta",
      srv.stateRoot,
      "default",
      1,
      undefined,
      roomB,
    );

    const memberRes = await srv.http("/api/usage", {
      rawSessionId: member.rawSessionId,
    });
    expect(memberRes.status).toBe(200);
    const memberBody = (await memberRes.json()) as {
      scoped: boolean;
      agents: { name: string; roomId: string }[];
      rooms: { id: string }[];
      cronjobs?: unknown;
    };
    expect(memberBody.scoped).toBe(true);
    expect(memberBody.agents.map((a) => a.name)).toEqual(["Beta"]);
    expect(memberBody.agents.every((a) => a.roomId === roomB)).toBe(true);
    expect(memberBody.rooms.map((r) => r.id)).toEqual([roomB]);
    expect(memberBody.cronjobs).toBeUndefined();

    const ownerRes = await srv.http("/api/usage", {
      rawSessionId: owner.rawSessionId,
    });
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as {
      scoped: boolean;
      agents: { name: string }[];
      rooms: { id: string }[];
      cronjobs: unknown[];
    };
    expect(ownerBody.scoped).toBe(false);
    expect(ownerBody.agents.map((a) => a.name).sort()).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(ownerBody.rooms.map((r) => r.id).sort()).toEqual(
      [roomA, roomB].sort(),
    );
    expect(Array.isArray(ownerBody.cronjobs)).toBe(true);

    const plain = await srv.agentManager.spawn(
      "Plain",
      srv.stateRoot,
      "default",
      2,
      undefined,
      roomB,
      undefined,
      undefined,
      undefined,
      member.username,
      "claude",
    );
    const privileged = await srv.agentManager.spawn(
      "Privileged",
      srv.stateRoot,
      "default",
      3,
      undefined,
      roomB,
      undefined,
      undefined,
      undefined,
      member.username,
      "claude",
    );
    if (!plain || !privileged) throw new Error("agent spawn failed");

    const plainRes = await srv.http("/api/usage", {
      headers: { Authorization: `Bearer ${getAgentTokenRaw(plain.id)!}` },
    });
    expect(plainRes.status).toBe(403);

    await srv.agentManager.setPrivileged(privileged.id, true);
    const privilegedRes = await srv.http("/api/usage", {
      headers: {
        Authorization: `Bearer ${getAgentTokenRaw(privileged.id)!}`,
      },
    });
    expect(privilegedRes.status).toBe(200);
    const privilegedBody = (await privilegedRes.json()) as {
      scoped: boolean;
      agents: { name: string; roomId: string }[];
      rooms: { id: string }[];
      cronjobs?: unknown;
    };
    expect(privilegedBody.scoped).toBe(true);
    expect(privilegedBody.agents.some((a) => a.name === "Alpha")).toBe(false);
    expect(privilegedBody.agents.every((a) => a.roomId === roomB)).toBe(true);
    expect(privilegedBody.rooms.map((r) => r.id)).toEqual([roomB]);
    expect(privilegedBody.cronjobs).toBeUndefined();

    expect((await srv.http("/api/usage")).status).toBe(401);
  });
});
