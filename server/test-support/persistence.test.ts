// Phase 1.3 — Persistence round-trip + pre-flatten (stable-room-IDs) characterization.
//
// Freezes TODAY's on-disk persistence at the persistence-FUNCTION seam:
// loadAgents/saveAgents, loadTasks/saveTasks, the cronjob config + run files,
// agent-history, office/server config, recent-cwds, and users (via the real
// write API — there is no saveUsers). Two jobs:
//   - Round-trip: write then load, asserting field preservation, so the Phase 3
//     refactor cannot silently drop or mangle a persisted field.
//   - Pre-flatten freeze: pin the CURRENT nested agents.json shape — Room[] with
//     PersistedAgents nested under each room, NO explicit roomId on the agent,
//     userId NOT resolved at this layer — as the before-picture that 3c's
//     stable-room-IDs flatten migration will be diffed against.
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
// Expected to change when 3c lands: the pre-flatten assertions flip to the
// flattened (explicit-roomId) shape at that point — that is the point of pinning
// them now.

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
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
      defaultRoomId: "bbbb0002",
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
// Round-trip: recent-cwds (kept minimal per review — dedup/cap/order only)
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
// through different APIs — easy to regress).
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
    });
  });
});

// ---------------------------------------------------------------------------
// Pre-flatten persisted shape: the stable-room-IDs (Phase 3c) before-picture.
// HIGHEST-VALUE net. Freeze the OLD nested shape verbatim; 3c flattens it.
// ---------------------------------------------------------------------------

describe("pre-flatten persisted shape — stable-room-IDs before-picture (Phase 1.3)", () => {
  // A pre-flatten agents.json: Room[] with agents nested under each room, NO
  // explicit roomId on any PersistedAgent. Room membership is POSITIONAL (which
  // room's .agents array the record lives in). Alice carries userId+username
  // (new-style); Bob is a legacy record with username only (no userId).
  //
  // The actual 3c tripwires are the roomId- and userId-absence checks below:
  // loadAgents will STILL return Room[] with nested .agents after 3c (only the
  // on-disk record gains an explicit roomId), so the positional/return-shape
  // test is current-behavior characterization, while Object.hasOwn(roomId)===false
  // is what flips to failing once 3c flattens the persisted record.
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
    // Return-shape characterization (not a flatten tripwire — see describe note):
    // pins that loadAgents groups agents by room, in order, by array position.
    seedNestedAgents();
    const rooms = loadAgents();
    expect(rooms.map((r) => r.id)).toEqual(["aaaa0001", "bbbb0002"]);
    expect(rooms[0].agents.map((a) => a.id)).toEqual(["agent-aaa"]);
    expect(rooms[1].agents.map((a) => a.id)).toEqual(["agent-bbb"]);
  });

  it("does NOT invent an explicit roomId on any PersistedAgent (3c adds that)", () => {
    seedNestedAgents();
    const rooms = loadAgents();
    for (const room of rooms) {
      for (const agent of room.agents) {
        // own-property check: catches an explicitly-present `roomId: undefined`
        // future field, not just a missing key.
        expect(Object.hasOwn(agent, "roomId")).toBe(false);
      }
    }
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

  it("users' room references (allowedRooms/notifRooms/defaultRoomId) stay intact and id-based", () => {
    seed("users.json", {
      "user-1": {
        id: "user-1",
        name: "Boss",
        role: "owner",
        allowedRooms: ["aaaa0001", "bbbb0002"],
        notifRooms: ["aaaa0001"],
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
    expect(boss?.defaultRoomId).toBe("bbbb0002");
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

  it("loadAgents migrates in memory only — it does NOT rewrite agents.json on disk", () => {
    seedNestedAgents();
    const original = readFileSync(stateFile("agents.json"), "utf-8");
    loadAgents();
    // The upgraded shape lands on the next saveAgents (agent-manager's job),
    // never as a side effect of loadAgents.
    expect(readFileSync(stateFile("agents.json"), "utf-8")).toBe(original);
  });
});
