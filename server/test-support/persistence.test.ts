// Phase 1.3 - Persistence round-trip + pre-flatten (stable-room-IDs) characterization.
//
// Freezes TODAY's on-disk persistence at the persistence-FUNCTION seam:
// loadAgents/saveAgents, loadTasks/saveTasks, the cronjob config + run files,
// agent-history, office/server config, recent-cwds, and users (via the real
// write API - there is no saveUsers). Two jobs:
//   - Round-trip: write then load, asserting field preservation, so the Phase 3
//     refactor cannot silently drop or mangle a persisted field.
//   - Stable-room-IDs (3c) shape: agents.json stays a nested Room[] (NO
//     structural flatten - additive only). Phase 3c slice 1 stamps an explicit
//     roomId on each PersistedAgent, backfilled from its container room. userId
//     is still NOT resolved at this layer (that is agent-manager's job).
//
// Why NOT the WS harness (startTestServer): the harness WIPES + recreates
// STATE_ROOT on boot (clean slate per server), so it cannot host pre-seeded
// files. These tests drive the persistence functions directly against the
// preload's temp STATE_ROOT instead: write a seed JSON, call the loader, assert
// the loaded shape; for round-trips, save -> load -> assert.
//
// Isolation: beforeEach wipes + recreates STATE_ROOT (mirroring the harness) and
// resets the one cached module on this seam (users.ts). Most persistence
// functions are stateless reads/writes of STATE_ROOT, so no other cache to drop.
//
// Updated for 3c slice 1: the roomId assertion flipped from "absent" to
// "backfilled from container" (additive, no structural flatten). The remaining
// nested/positional + userId-not-derived assertions stay current-behavior.

import { describe, it, expect, beforeEach } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import {
  loadAgents,
  saveAgents,
  loadTasks,
  saveTasks,
  loadAgentHistory,
  saveAgentHistory,
  loadRecentCwds,
  saveRecentCwd,
  loadOfficeConfig,
  saveOfficeConfig,
  loadServerConfig,
  saveServerConfig,
  ensureSessionCwd,
  stampSessionEngineConfig,
  getSessionEngineConfig,
  backfillSessionEngineConfigs,
  listAgentSessions,
  appendLog,
  loadSessionsMap,
  type Room,
  type PersistedAgent,
  type AgentHistory,
} from "../persistence.ts";
import {
  loadCronjobs,
  saveCronjobs,
  loadRuns,
  saveRuns,
  appendRun,
  updateRun,
  findRun,
  loadCronjobHistory,
  saveCronjobHistory,
  loadCronjobsPrompt,
  saveCronjobsPrompt,
} from "../cronjob-persistence.ts";
import {
  claimUser,
  updateUserById,
  getUserById,
  _testResetUsers,
} from "../users.ts";
import { _testResetSentinel } from "../migrations.ts";
import type {
  AgentOutfit,
  TaskItem,
  Cronjob,
  CronjobRun,
  UserRecord,
} from "../../shared/types.ts";

function resetStateRoot(): void {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
  _testResetUsers();
  _testResetSentinel();
}

const stateFile = (rel: string): string => join(STATE_ROOT, rel);

function seed(rel: string, value: unknown): void {
  const path = stateFile(rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

beforeEach(() => {
  resetStateRoot();
});

// Shared, fully-populated outfit so fixtures carry every nested field.
const OUTFIT: AgentOutfit = {
  hat: "cap",
  color: "#ff0000",
  hair: "#221100",
  hairStyle: "short",
  skin: "#ffccaa",
  beard: "none",
  accessory: "glasses",
};

// ---------------------------------------------------------------------------
// Round-trip: agents
// ---------------------------------------------------------------------------

describe("agents persistence round-trip (Phase 1.3)", () => {
  it("preserves a multi-room, multi-agent Room[] losslessly through saveAgents -> loadAgents", () => {
    const claude: PersistedAgent = {
      id: "agent-aaa",
      name: "Alice",
      desk: 0,
      cwd: "/home/x/proj",
      outfit: OUTFIT,
      permissionMode: "auto",
      modelFamily: "opus",
      effort: "high",
      agentType: "claude",
      lastSessionId: "sess-a",
      topic: "Working on the thing",
      customInstructions: "be terse",
      userId: "user-1",
      username: "Boss",
      roomId: "aaaa0001",
    };
    const codex: PersistedAgent = {
      id: "agent-bbb",
      name: "Bob",
      desk: 3,
      cwd: "/home/y",
      outfit: OUTFIT,
      permissionMode: "on-request",
      modelFamily: "gpt-5.5",
      effort: "xhigh",
      agentType: "codex",
      codexSandbox: "workspace-write",
      lastSessionId: null,
      topic: null,
      customInstructions: null,
      userId: "user-2",
      username: "Nil",
      roomId: "bbbb0002",
    };
    const rooms: Room[] = [
      {
        id: "aaaa0001",
        name: "Room 1",
        prompt: "room one prompt",
        agents: [claude],
      },
      { id: "bbbb0002", name: "Room 2", prompt: null, agents: [codex] },
    ];

    saveAgents(rooms);
    expect(loadAgents()).toEqual(rooms);
  });

  it("round-trips an empty room (a room with no agents survives)", () => {
    const rooms: Room[] = [
      { id: "aaaa0001", name: "Room 1", prompt: null, agents: [] },
    ];
    saveAgents(rooms);
    expect(loadAgents()).toEqual(rooms);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: users (no saveUsers; write goes through the real mutation API)
// ---------------------------------------------------------------------------

describe("users persistence round-trip (Phase 1.3)", () => {
  it("preserves a fully-populated UserRecord through write -> reload from disk", () => {
    const claimed = claimUser("Alice", {
      role: "owner",
      allowedRooms: ["aaaa0001", "bbbb0002"],
      notifRooms: ["aaaa0001"],
    });
    const upd = updateUserById(claimed.id, {
      envFile: "/home/alice/.env",
      memberPrompt: "I am Alice the owner.",
      avatarColor: "#abcdef",
      avatarVariant: "big-eyes",
    });
    expect(upd.ok).toBe(true);
    const inMemory = (upd as { ok: true; user: UserRecord }).user;

    // Drop the in-memory cache so getUserById re-reads users.json from disk.
    _testResetUsers();
    const reloaded = getUserById(claimed.id);
    expect(reloaded).toEqual(inMemory);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: tasks
// ---------------------------------------------------------------------------

describe("tasks persistence round-trip (Phase 1.3)", () => {
  it("preserves TaskItem[] (all fields) through saveTasks -> loadTasks", () => {
    const tasks: TaskItem[] = [
      {
        id: "task0001",
        title: "Ship 1.3",
        description: "the persistence net",
        priority: "P1",
        status: "in_progress",
        assignee: "Isomuxer1",
        createdBy: "Isomuxer1",
        username: "Nil",
        createdAt: 1700000000000,
      },
      {
        // Minimal task: only the required fields. Optional-absence is pinned
        // explicitly by the key-set assertion below (toEqual alone can't catch
        // an injected `undefined` key, and JSON.stringify drops it on save).
        id: "task0002",
        title: "Backlog item",
        status: "open",
        createdBy: "Nil",
        createdAt: 1700000001000,
      },
    ];
    saveTasks(tasks);
    const loaded = loadTasks();
    expect(loaded).toEqual(tasks);
    // A loader that injected an optional field (even as undefined) would change
    // this key set; toEqual would not catch it.
    expect(Object.keys(loaded[1]).sort()).toEqual([
      "createdAt",
      "createdBy",
      "id",
      "status",
      "title",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: cronjobs + runs + history + prompt
// ---------------------------------------------------------------------------

describe("cronjob persistence round-trip (Phase 1.3)", () => {
  const job: Cronjob = {
    id: "job00001",
    name: "Nightly digest",
    schedule: { type: "daily", hour: 3, minute: 30 },
    prompt: "Summarize the day.",
    cwd: "/home/proj",
    agentType: "claude",
    modelFamily: "opus",
    effort: "high",
    permissionMode: "bypassPermissions",
    enabled: true,
    createdBy: "Boss",
    userId: "user-1",
    username: "Boss",
    createdAt: 1700000000000,
    lastFireAt: null,
    nextFireAt: 1700003600000,
  };

  const run1: CronjobRun = {
    id: "run00001",
    cronjobId: "job00001",
    cronjobName: "Nightly digest",
    trigger: "scheduled",
    status: "completed",
    startedAt: 1700000000000,
    endedAt: 1700000060000,
    errorReason: null,
    promptSnapshot: "Summarize the day.",
    agentTypeSnapshot: "claude",
    modelFamilySnapshot: "opus",
    effortSnapshot: "high",
    cwdSnapshot: "/home/proj",
    permissionModeSnapshot: "bypassPermissions",
    rootSessionId: "rsess-1",
    currentSessionId: "rsess-1",
    previewText: "All done.",
  };
  const run2: CronjobRun = {
    ...run1,
    id: "run00002",
    trigger: "manual",
    status: "running",
    endedAt: null,
    previewText: "",
    triggeredBy: "Nil",
  };

  it("preserves Cronjob[] through saveCronjobs -> loadCronjobs", () => {
    saveCronjobs([job]);
    expect(loadCronjobs()).toEqual([job]);
  });

  it("preserves an OpenCode composite model in cron definition and run snapshots", () => {
    const openCodeJob: Cronjob = {
      ...job,
      id: "joboc001",
      agentType: "opencode",
      modelFamily: "gate/gate-model",
    };
    const openCodeRun: CronjobRun = {
      ...run1,
      id: "runoc001",
      cronjobId: openCodeJob.id,
      agentTypeSnapshot: "opencode",
      modelFamilySnapshot: "gate/gate-model",
    };
    saveCronjobs([openCodeJob]);
    saveRuns(openCodeJob.id, [openCodeRun]);
    expect(loadCronjobs()).toEqual([openCodeJob]);
    expect(loadRuns(openCodeJob.id)).toEqual([openCodeRun]);
  });

  it("preserves CronjobRun[] through saveRuns -> loadRuns and supports append/update/find", () => {
    saveRuns(job.id, [run1, run2]);
    expect(loadRuns(job.id)).toEqual([run1, run2]);

    const run3: CronjobRun = { ...run1, id: "run00003" };
    appendRun(job.id, run3);
    expect(loadRuns(job.id).map((r) => r.id)).toEqual([
      "run00001",
      "run00002",
      "run00003",
    ]);

    const patched = updateRun(job.id, run1.id, {
      status: "failed",
      errorReason: "boom",
    });
    expect(patched).toEqual({ ...run1, status: "failed", errorReason: "boom" });
    expect(findRun(job.id, run1.id)?.status).toBe("failed");

    expect(findRun(job.id, run2.id)).toEqual(run2);
    expect(findRun(job.id, "missing0")).toBeNull();
  });

  it("round-trips cronjob history and the cronjobs prompt (null prompt clears to null)", () => {
    saveCronjobHistory({ job00001: { lastName: "Nightly digest" } });
    expect(loadCronjobHistory()).toEqual({
      job00001: { lastName: "Nightly digest" },
    });

    saveCronjobsPrompt("Cron system prompt");
    expect(loadCronjobsPrompt()).toBe("Cron system prompt");
    // null is persisted as "" on disk, which loads back as null (empty -> null).
    saveCronjobsPrompt(null);
    expect(loadCronjobsPrompt()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: agent-history
// ---------------------------------------------------------------------------

describe("agent-history persistence round-trip (Phase 1.3)", () => {
  it("preserves AgentHistory (incl. lastRoomId) through saveAgentHistory -> loadAgentHistory", () => {
    const history: AgentHistory = {
      "agent-aaa": {
        name: "Alice",
        lastRoomId: "aaaa0001",
        lastRoomName: "Room 1",
        killedAt: 1700000000000,
        cwd: "/home/x",
        outfit: OUTFIT,
        permissionMode: "auto",
        modelFamily: "opus",
        effort: "high",
        agentType: "claude",
        lastSessionId: "sess-a",
        topic: "topic a",
        customInstructions: "ci",
        userId: "user-1",
        username: "Boss",
      },
    };
    saveAgentHistory(history);
    expect(loadAgentHistory()).toEqual(history);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: recent-cwds (kept minimal per review - dedup/cap/order only)
// ---------------------------------------------------------------------------

describe("recent-cwds persistence round-trip (Phase 1.3)", () => {
  it("dedups, orders most-recent-first, and caps at 20", () => {
    saveRecentCwd("/a");
    saveRecentCwd("/b");
    saveRecentCwd("/a"); // re-saving moves /a back to the front, no duplicate
    expect(loadRecentCwds()).toEqual(["/a", "/b"]);

    for (let i = 0; i < 25; i++) saveRecentCwd(`/dir-${i}`);
    const recent = loadRecentCwds();
    expect(recent.length).toBe(20);
    expect(recent[0]).toBe("/dir-24"); // newest first
  });
});

// ---------------------------------------------------------------------------
// Round-trip: office-config / server-config + the shared-file sibling-key
// preservation invariant (the two surfaces share office-config.json but flow
// through different APIs - easy to regress).
// ---------------------------------------------------------------------------

describe("office-config / server-config persistence (Phase 1.3)", () => {
  it("round-trips OfficeSettings through saveOfficeConfig -> loadOfficeConfig", () => {
    saveOfficeConfig({
      prompt: "Office prompt",
      envFile: "/home/office/.env",
      name: "HQ",
    });
    expect(loadOfficeConfig()).toEqual({
      prompt: "Office prompt",
      envFile: "/home/office/.env",
      name: "HQ",
    });

    saveOfficeConfig({ prompt: null, envFile: null, name: null });
    expect(loadOfficeConfig()).toEqual({
      prompt: null,
      envFile: null,
      name: null,
    });
  });

  it("saveOfficeConfig preserves the server/deployment sibling keys (publicOrigin/externalAccess)", () => {
    saveServerConfig({
      publicOrigin: "https://office.example.com",
      externalAccess: true,
    });
    // A UI office-settings save must not clobber the deployment keys.
    saveOfficeConfig({ prompt: "P", envFile: "/e", name: "N" });

    expect(loadServerConfig()).toEqual({
      publicOrigin: "https://office.example.com",
      externalAccess: true,
      networkBind: "auto",
    });
    expect(loadOfficeConfig()).toEqual({
      prompt: "P",
      envFile: "/e",
      name: "N",
    });
  });

  it("saveServerConfig preserves the OfficeSettings sibling keys (prompt/env/name)", () => {
    saveOfficeConfig({ prompt: "P", envFile: "/e", name: "N" });
    saveServerConfig({
      publicOrigin: "https://office.example.com",
      externalAccess: false,
    });

    expect(loadOfficeConfig()).toEqual({
      prompt: "P",
      envFile: "/e",
      name: "N",
    });
    expect(loadServerConfig()).toEqual({
      publicOrigin: "https://office.example.com",
      externalAccess: false,
      networkBind: "auto",
    });
  });

  it("server-config validates/normalizes publicOrigin and handles externalAccess null", () => {
    // Trailing slash is normalized away on write.
    saveServerConfig({
      publicOrigin: "https://host.example.com/",
      externalAccess: true,
    });
    expect(loadServerConfig().publicOrigin).toBe("https://host.example.com");

    // Invalid origin is rejected loudly at the write boundary, not silently dropped.
    expect(() =>
      saveServerConfig({ publicOrigin: "ftp://nope", externalAccess: null }),
    ).toThrow();

    // externalAccess:null removes the field -> loadServerConfig returns null.
    saveServerConfig({ publicOrigin: null, externalAccess: null });
    expect(loadServerConfig()).toEqual({
      publicOrigin: null,
      externalAccess: null,
      networkBind: "auto",
    });
  });

  it("reads networkBind without letting server config saves overwrite it", () => {
    for (const networkBind of ["auto", "loopback", "all"] as const) {
      seed("office-config.json", {
        publicOrigin: "https://office.example.com",
        externalAccess: true,
        networkBind,
      });
      expect(loadServerConfig().networkBind).toBe(networkBind);

      saveServerConfig({
        publicOrigin: "https://changed.example.com",
        externalAccess: false,
      });
      expect(
        JSON.parse(readFileSync(stateFile("office-config.json"), "utf-8"))
          .networkBind,
      ).toBe(networkBind);
    }
  });

  it("logs and ignores invalid networkBind values", () => {
    const original = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      for (const networkBind of ["loopbak", true, 7, ""]) {
        seed("office-config.json", { networkBind });
        expect(loadServerConfig().networkBind).toBe("auto");
      }
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(4);
    expect(errors.every((line) => line.includes("networkBind"))).toBe(true);
  });

  it("treats a null networkBind as a silent unset", () => {
    seed("office-config.json", { networkBind: null });
    const original = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      expect(loadServerConfig().networkBind).toBe("auto");
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Nested persisted shape + stable-room-IDs (Phase 3c) migration.
// HIGHEST-VALUE net. agents.json stays a nested Room[] (no structural flatten);
// 3c slice 1 backfills an explicit roomId on each agent from its container room.
// ---------------------------------------------------------------------------

describe("nested persisted shape + stable-room-IDs migration (Phase 1.3 / 3c.1)", () => {
  // A pre-3c agents.json: Room[] with agents nested under each room, NO explicit
  // roomId on any PersistedAgent. Room membership is POSITIONAL (which room's
  // .agents array the record lives in). Alice carries userId+username
  // (new-style); Bob is a legacy record with username only (no userId).
  //
  // loadAgents STILL returns Room[] with nested .agents (3c is additive, not a
  // structural flatten); slice 1 stamps each agent's roomId from its container
  // room. The positional/return-shape and userId-not-derived tests stay
  // current-behavior characterization; the roomId test pins the slice-1 backfill.
  function seedNestedAgents(): void {
    seed("agents.json", [
      {
        id: "aaaa0001",
        name: "Room 1",
        prompt: "room one",
        agents: [
          {
            id: "agent-aaa",
            name: "Alice",
            desk: 0,
            cwd: "/x",
            outfit: OUTFIT,
            permissionMode: "auto",
            modelFamily: "opus",
            agentType: "claude",
            lastSessionId: "sess-a",
            topic: null,
            customInstructions: null,
            userId: "user-1",
            username: "Boss",
          },
        ],
      },
      {
        id: "bbbb0002",
        name: "Room 2",
        prompt: null,
        agents: [
          {
            id: "agent-bbb",
            name: "Bob",
            desk: 1,
            cwd: "/y",
            outfit: OUTFIT,
            permissionMode: "on-request",
            modelFamily: "gpt-5.5",
            agentType: "codex",
            lastSessionId: null,
            topic: null,
            customInstructions: null,
            username: "Nil",
          },
        ],
      },
    ]);
  }

  it("loadAgents returns the nested Room[] with positional membership preserved", () => {
    // Return-shape characterization (not a flatten tripwire - see describe note):
    // pins that loadAgents groups agents by room, in order, by array position.
    seedNestedAgents();
    const rooms = loadAgents();
    expect(rooms.map((r) => r.id)).toEqual(["aaaa0001", "bbbb0002"]);
    expect(rooms[0].agents.map((a) => a.id)).toEqual(["agent-aaa"]);
    expect(rooms[1].agents.map((a) => a.id)).toEqual(["agent-bbb"]);
  });

  it("backfills an explicit roomId on each PersistedAgent from its container room (3c slice 1)", () => {
    // Phase 3c slice 1: a pre-3c file (no roomId on agents) is migrated on load
    // by stamping each agent's roomId from its container room - the physical
    // nesting position. No structural flatten: the agents stay nested under
    // Room[]. Idempotent (a file already carrying roomId is unchanged - covered
    // by the round-trip test above).
    seedNestedAgents();
    const rooms = loadAgents();
    for (const room of rooms) {
      for (const agent of room.agents) {
        expect(agent.roomId).toBe(room.id);
      }
    }
    // Spot-check the specific containers (positional membership preserved).
    expect(rooms[0].agents[0].roomId).toBe("aaaa0001");
    expect(rooms[1].agents[0].roomId).toBe("bbbb0002");
  });

  it("prefers the container room id over a MISMATCHED persisted roomId (defensive contract, 3c slice 1)", () => {
    // Design contract (Q1): physical nesting is the source of truth. If a
    // persisted agent carries a roomId that disagrees with its container room
    // (corrupt or hand-edited file), loadAgents corrects it to the container id
    // rather than trusting the stale stamped value.
    seed("agents.json", [
      {
        id: "aaaa0001",
        name: "Room 1",
        prompt: null,
        agents: [
          {
            id: "agent-mismatch",
            name: "Mallory",
            desk: 0,
            cwd: "/x",
            outfit: OUTFIT,
            permissionMode: "auto",
            modelFamily: "opus",
            agentType: "claude",
            lastSessionId: null,
            topic: null,
            customInstructions: null,
            userId: "user-1",
            username: "Boss",
            roomId: "deadbeef", // WRONG - does not match container aaaa0001
          },
        ],
      },
    ]);
    const rooms = loadAgents();
    expect(rooms[0].agents[0].roomId).toBe("aaaa0001"); // container wins
  });

  it("preserves userId when present but does NOT derive it at this layer when absent", () => {
    seedNestedAgents();
    const rooms = loadAgents();
    const alice = rooms[0].agents[0];
    const bob = rooms[1].agents[0];

    expect(alice.userId).toBe("user-1");
    // Legacy username->userId resolution is agent-manager (restoreAgents)'s job,
    // not persistence's. loadAgents must leave userId absent for Bob.
    expect(Object.hasOwn(bob, "userId")).toBe(false);
    expect(bob.username).toBe("Nil");
  });

  it("users' room references (allowedRooms/notifRooms) stay intact and id-based; a legacy defaultRoomId field is tolerated and dropped", () => {
    seed("users.json", {
      "user-1": {
        id: "user-1",
        name: "Boss",
        role: "owner",
        allowedRooms: ["aaaa0001", "bbbb0002"],
        notifRooms: ["aaaa0001"],
        // Simulates an existing users.json written before the Default Room
        // setting was removed. The read must tolerate it (not crash) and simply
        // ignore it - the field is dropped from the in-memory record.
        defaultRoomId: "bbbb0002",
        envFile: null,
        createdAt: 1700000000000,
        memberPrompt: null,
        avatarColor: "#abcdef",
        avatarVariant: "classic",
      },
    });
    _testResetUsers();
    const boss = getUserById("user-1");
    expect(boss?.allowedRooms).toEqual(["aaaa0001", "bbbb0002"]);
    expect(boss?.notifRooms).toEqual(["aaaa0001"]);
    expect(
      (boss as unknown as Record<string, unknown>).defaultRoomId,
    ).toBeUndefined();
  });

  it("killed-agent summaries keep their lastRoomId reference", () => {
    seed("agent-history.json", {
      "agent-ccc": {
        name: "Carol",
        lastRoomId: "aaaa0001",
        lastRoomName: "Room 1",
        killedAt: 1700000005000,
        userId: "user-1",
        username: "Boss",
      },
    });
    const hist = loadAgentHistory();
    expect(hist["agent-ccc"].lastRoomId).toBe("aaaa0001");
    expect(hist["agent-ccc"].lastRoomName).toBe("Room 1");
  });

  it("loadAgents migrates in memory only - it does NOT rewrite agents.json on disk", () => {
    seedNestedAgents();
    const original = readFileSync(stateFile("agents.json"), "utf-8");
    loadAgents();
    // The upgraded shape lands on the next saveAgents (agent-manager's job),
    // never as a side effect of loadAgents.
    expect(readFileSync(stateFile("agents.json"), "utf-8")).toBe(original);
  });
});

describe("per-session engine config (Claude <-> Codex switching)", () => {
  const AGENT = "agent-engine-test";

  it("stamps and reads back a session's engine config", () => {
    stampSessionEngineConfig(AGENT, "S1", {
      agentType: "codex",
      modelFamily: "gpt-5.5",
      effort: "high",
      permissionMode: "on-request",
      codexSandbox: "workspace-write",
    });
    const cfg = getSessionEngineConfig(AGENT, "S1");
    expect(cfg?.agentType).toBe("codex");
    expect(cfg?.modelFamily).toBe("gpt-5.5");
    expect(cfg?.effort).toBe("high");
    expect(cfg?.permissionMode).toBe("on-request");
    expect(cfg?.codexSandbox).toBe("workspace-write");
  });

  it("getSessionEngineConfig returns null for an unknown session", () => {
    expect(getSessionEngineConfig(AGENT, "missing")).toBeNull();
  });

  it("backfill tags legacy (engine-less) sessions but leaves stamped ones untouched", () => {
    // A legacy session: created with cwd only, no engine (pre-feature shape).
    ensureSessionCwd(AGENT, "legacy", "/home/u/proj");
    expect(getSessionEngineConfig(AGENT, "legacy")?.agentType).toBeUndefined();
    // An already-stamped session must not be rewritten by the backfill.
    stampSessionEngineConfig(AGENT, "stamped", {
      agentType: "codex",
      modelFamily: "gpt-5.5",
      effort: "high",
      permissionMode: "on-request",
      codexSandbox: "workspace-write",
    });

    backfillSessionEngineConfigs(AGENT, {
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "auto",
      codexSandbox: undefined,
    });

    // Legacy session adopts the agent's current engine...
    const legacy = getSessionEngineConfig(AGENT, "legacy");
    expect(legacy?.agentType).toBe("claude");
    expect(legacy?.modelFamily).toBe("opus");
    // ...while the already-tagged Codex session is preserved verbatim.
    const stamped = getSessionEngineConfig(AGENT, "stamped");
    expect(stamped?.agentType).toBe("codex");
    expect(stamped?.modelFamily).toBe("gpt-5.5");
  });

  it("backfill preserves the legacy session's cwd and does not reorder it", () => {
    ensureSessionCwd(AGENT, "legacy", "/home/u/proj");
    // listAgentSessions enumerates by on-disk .jsonl transcript, so create one
    // for the session to appear (its metadata still comes from sessions.json).
    writeFileSync(stateFile(`logs/${AGENT}/legacy.jsonl`), "");
    const before = listAgentSessions(AGENT).find(
      (s) => s.sessionId === "legacy",
    );
    backfillSessionEngineConfigs(AGENT, {
      agentType: "claude",
      modelFamily: "opus",
      effort: "medium",
      permissionMode: "auto",
      codexSandbox: undefined,
    });
    const after = listAgentSessions(AGENT).find(
      (s) => s.sessionId === "legacy",
    );
    expect(after?.cwd).toBe("/home/u/proj");
    expect(after?.lastModified).toBe(before?.lastModified);
    expect(after?.agentType).toBe("claude");
  });

  it("stores the first user message preview beside session metadata", () => {
    appendLog(AGENT, "preview", {
      id: "message-1",
      agentId: AGENT,
      timestamp: Date.now(),
      kind: "user_message",
      content: "  First\nmessage  preview ",
    });
    appendLog(AGENT, "preview", {
      id: "message-2",
      agentId: AGENT,
      timestamp: Date.now(),
      kind: "user_message",
      content: "Second message",
    });
    expect(loadSessionsMap(AGENT).preview?.firstUserMessage).toBe(
      "First message preview",
    );
  });

  it("backfills a legacy preview once from a bounded log head", () => {
    const path = stateFile(`logs/${AGENT}/legacy-preview.jsonl`);
    mkdirSync(join(STATE_ROOT, "logs", AGENT), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ kind: "system", content: "init" })}\n${JSON.stringify({ kind: "user_message", content: "Legacy first request" })}\n`,
    );
    const session = listAgentSessions(AGENT).find(
      (s) => s.sessionId === "legacy-preview",
    );
    expect(session?.firstUserMessage).toBe("Legacy first request");
    expect(session?.lastModified).toBeGreaterThan(0);
    expect(loadSessionsMap(AGENT)["legacy-preview"]).toBeUndefined();
    writeFileSync(
      path,
      `${JSON.stringify({ kind: "user_message", content: "Changed on disk" })}\n`,
    );
    expect(
      listAgentSessions(AGENT).find((s) => s.sessionId === "legacy-preview")
        ?.firstUserMessage,
    ).toBe("Changed on disk");
  });

  it("keeps other sessions visible when one legacy log is unreadable", () => {
    appendLog(AGENT, "readable", {
      id: "message-readable",
      agentId: AGENT,
      timestamp: Date.now(),
      kind: "user_message",
      content: "Readable session",
    });
    const unreadable = stateFile(`logs/${AGENT}/unreadable.jsonl`);
    writeFileSync(unreadable, "not readable");
    chmodSync(unreadable, 0);
    try {
      expect(
        listAgentSessions(AGENT).some(
          (session) => session.sessionId === "readable",
        ),
      ).toBe(true);
    } finally {
      chmodSync(unreadable, 0o600);
    }
  });
});
