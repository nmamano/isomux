// Phase 1.3 — Load-time migration characterization + the pre-userid backup helper.
//
// Freezes the migrations that fire when the persistence loaders read a
// pre-current on-disk shape: the agents.json shape-detection + field backfills,
// the tasks/cronjobs/runs `device`->`username` + permission-mode coercions, the
// users.json legacy name-keyed -> id-keyed rewrite + field normalization, the
// office-prompt.md / cronjobs-prompt fold-ins, and migrations.ts's one-shot
// pre-userid backup (the boot-order safety surface 3c can perturb).
//
// Same seam discipline as persistence.test.ts: drive the loaders directly
// against a pre-seeded temp STATE_ROOT (NOT the WS harness, which wipes it).
//
// Disk-rewrite precision (a load-time migration either rewrites the file or
// not, and that distinction matters for the refactor):
//   - users.json name-keyed -> id-keyed: rewrites IMMEDIATELY -> asserted on disk.
//   - loadAgents(): migrates IN MEMORY only -> NOT a disk rewrite (pinned in
//     persistence.test.ts).
//   - loadOfficeConfig() w/ legacy office-prompt.md: writes office-config.json
//     ONLY when the legacy prompt is non-empty.
//   - migrateCronjobsPromptFromOfficeConfig(): writes cronjobs-prompt.md ONLY
//     when that file is absent.
//
// Console capture: the migration paths log intentionally (and the backup path
// logs when it actually writes a bundle — review asked this be captured, not
// surprise suite noise). beforeEach swaps console.log/error for collectors and
// afterEach restores them; tests that care assert on the captured lines.
//
// The loadLog legacy `images` -> `attachments` read-time migration
// (persistence.ts) was deferred from the initial 1.3 net (by review agreement)
// as a log/attachment-compat concern rather than part of the room-shape /
// pre-flatten migration story. It is a load-time migration, so it landed back
// here when the deferral was reconciled — see the final describe below.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import {
  loadAgents,
  loadTasks,
  loadOfficeConfig,
  loadLog,
} from "../persistence.ts";
import {
  loadCronjobs,
  loadRuns,
  loadCronjobsPrompt,
  migrateCronjobsPromptFromOfficeConfig,
} from "../cronjob-persistence.ts";
import {
  listUsers,
  getUserById,
  getUserByName,
  _testResetUsers,
} from "../users.ts";
import {
  runPreUseridBackupIfNeeded,
  _testResetSentinel,
} from "../migrations.ts";

let logs: string[] = [];
let errs: string[] = [];
let origLog: typeof console.log;
let origErr: typeof console.error;

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
  writeFileSync(
    path,
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
}

beforeEach(() => {
  resetStateRoot();
  logs = [];
  errs = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

const HEX8 = /^[0-9a-f]{8}$/;

// ---------------------------------------------------------------------------
// agents.json shape detection
// ---------------------------------------------------------------------------

describe("agents.json shape detection (Phase 1.3)", () => {
  it("missing file -> one generated default room with no agents", () => {
    const rooms = loadAgents();
    expect(rooms.length).toBe(1);
    expect(rooms[0].name).toBe("Room 1");
    expect(rooms[0].prompt).toBeNull();
    expect(rooms[0].agents).toEqual([]);
    expect(rooms[0].id).toMatch(HEX8);
  });

  it("empty array -> one generated default room", () => {
    seed("agents.json", []);
    const rooms = loadAgents();
    expect(rooms.length).toBe(1);
    expect(rooms[0].name).toBe("Room 1");
    expect(rooms[0].agents).toEqual([]);
  });

  it("non-array JSON -> one generated default room", () => {
    seed("agents.json", { not: "an array" });
    const rooms = loadAgents();
    expect(rooms.length).toBe(1);
    expect(rooms[0].name).toBe("Room 1");
  });

  it("corrupt JSON -> one generated default room", () => {
    seed("agents.json", "{ this is not valid json");
    const rooms = loadAgents();
    expect(rooms.length).toBe(1);
    expect(rooms[0].name).toBe("Room 1");
  });

  it("legacy array-of-arrays (PersistedAgent[][]) -> one room per sub-array, generated ids", () => {
    seed("agents.json", [
      [
        {
          id: "a1",
          name: "A1",
          desk: 0,
          cwd: "/",
          outfit: {},
          permissionMode: "default",
          modelFamily: "opus",
          lastSessionId: null,
          topic: null,
          customInstructions: null,
        },
      ],
      [
        {
          id: "b1",
          name: "B1",
          desk: 0,
          cwd: "/",
          outfit: {},
          permissionMode: "default",
          modelFamily: "opus",
          lastSessionId: null,
          topic: null,
          customInstructions: null,
        },
      ],
    ]);
    const rooms = loadAgents();
    expect(rooms.length).toBe(2);
    expect(rooms.map((r) => r.name)).toEqual(["Room 1", "Room 2"]);
    expect(rooms.every((r) => HEX8.test(r.id))).toBe(true);
    expect(rooms[0].agents.map((a) => a.id)).toEqual(["a1"]);
    expect(rooms[1].agents.map((a) => a.id)).toEqual(["b1"]);
  });

  it("legacy flat PersistedAgent[] -> single 'Room 1' wrapping every agent", () => {
    seed("agents.json", [
      {
        id: "a1",
        name: "A1",
        desk: 0,
        cwd: "/",
        outfit: {},
        permissionMode: "default",
        modelFamily: "opus",
        lastSessionId: null,
        topic: null,
        customInstructions: null,
      },
      {
        id: "a2",
        name: "A2",
        desk: 1,
        cwd: "/",
        outfit: {},
        permissionMode: "default",
        modelFamily: "opus",
        lastSessionId: null,
        topic: null,
        customInstructions: null,
      },
    ]);
    const rooms = loadAgents();
    expect(rooms.length).toBe(1);
    expect(rooms[0].name).toBe("Room 1");
    expect(HEX8.test(rooms[0].id)).toBe(true);
    expect(rooms[0].agents.map((a) => a.id)).toEqual(["a1", "a2"]);
  });
});

// ---------------------------------------------------------------------------
// agents.json field migrations
// ---------------------------------------------------------------------------

describe("agents.json field migrations (Phase 1.3)", () => {
  function seedRoomWithAgent(
    agent: Record<string, unknown>,
    room: Record<string, unknown> = {},
  ): void {
    seed("agents.json", [
      {
        id: "aaaa0001",
        name: "Room 1",
        prompt: null,
        agents: [agent],
        ...room,
      },
    ]);
  }

  it("backfills modelFamily from a legacy exact `model` id and drops `model`", () => {
    seedRoomWithAgent({
      id: "a1",
      name: "Legacy",
      desk: 0,
      cwd: "/",
      outfit: {},
      permissionMode: "default",
      model: "claude-opus-4-6", // legacy exact id, no modelFamily
      lastSessionId: null,
      topic: null,
      customInstructions: null,
      username: "Boss",
    });
    const agent = loadAgents()[0].agents[0];
    expect(agent.modelFamily).toBe("opus");
    expect(Object.hasOwn(agent, "model")).toBe(false);
  });

  it("stamps username:null on a legacy agent missing the field, preserves it when present", () => {
    seed("agents.json", [
      {
        id: "aaaa0001",
        name: "Room 1",
        prompt: null,
        agents: [
          // No `username` key at all -> backfilled to null.
          {
            id: "a1",
            name: "Legacy",
            desk: 0,
            cwd: "/",
            outfit: {},
            permissionMode: "default",
            modelFamily: "opus",
            lastSessionId: null,
            topic: null,
            customInstructions: null,
          },
          // Has `username` -> preserved verbatim.
          {
            id: "a2",
            name: "Owned",
            desk: 1,
            cwd: "/",
            outfit: {},
            permissionMode: "default",
            modelFamily: "opus",
            lastSessionId: null,
            topic: null,
            customInstructions: null,
            username: "Nil",
          },
        ],
      },
    ]);
    const [legacy, owned] = loadAgents()[0].agents;
    expect(legacy.username).toBeNull();
    expect(owned.username).toBe("Nil");
  });

  it("backfills a missing room id (generated hex) and coerces a non-string prompt to null", () => {
    seed("agents.json", [
      // id missing, prompt is a number -> coerced to null.
      { name: "Room 1", prompt: 123, agents: [] },
    ]);
    const room = loadAgents()[0];
    expect(HEX8.test(room.id)).toBe(true);
    expect(room.prompt).toBeNull();
  });

  it("strips a legacy per-room envFile (env is per-user now)", () => {
    seed("agents.json", [
      {
        id: "aaaa0001",
        name: "Room 1",
        prompt: null,
        envFile: "/legacy/room.env",
        agents: [],
      },
    ]);
    const room = loadAgents()[0];
    expect(Object.hasOwn(room, "envFile")).toBe(false);
    // The strip logs a one-line operator notice.
    expect(logs.some((l) => l.includes("stripped envFile"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tasks.json migration
// ---------------------------------------------------------------------------

describe("tasks.json migration (Phase 1.3)", () => {
  it("migrates legacy `device` -> `username` and drops `device`", () => {
    seed("tasks.json", [
      {
        id: "t1",
        title: "Old",
        status: "open",
        createdBy: "Boss",
        createdAt: 1,
        device: "Nil",
      },
      {
        id: "t2",
        title: "New",
        status: "open",
        createdBy: "Boss",
        createdAt: 2,
        username: "Marc",
      },
    ]);
    const [t1, t2] = loadTasks();
    expect(t1.username).toBe("Nil");
    expect(Object.hasOwn(t1, "device")).toBe(false);
    expect(t2.username).toBe("Marc"); // already-migrated rows untouched
  });
});

// ---------------------------------------------------------------------------
// cronjobs.json + runs.json migrations
// ---------------------------------------------------------------------------

describe("cronjobs.json / runs.json migrations (Phase 1.3)", () => {
  it("cronjobs: device->username, agentType default 'claude', permissionMode 'auto'->'bypassPermissions'", () => {
    seed("cronjobs/cronjobs.json", [
      {
        id: "job00001",
        name: "Legacy job",
        schedule: { type: "interval", minutes: 60 },
        prompt: "go",
        cwd: "/",
        modelFamily: "opus",
        effort: "high",
        permissionMode: "auto", // legacy -> bypassPermissions
        enabled: true,
        createdBy: "Boss",
        userId: null,
        device: "Nil", // legacy -> username
        createdAt: 1,
        lastFireAt: null,
        nextFireAt: 2,
        // agentType absent -> defaults to "claude"
      },
    ]);
    const [job] = loadCronjobs();
    expect(job.username).toBe("Nil");
    expect(Object.hasOwn(job, "device")).toBe(false);
    expect(job.agentType).toBe("claude");
    expect(job.permissionMode).toBe("bypassPermissions");
  });

  it("runs: agentTypeSnapshot default 'claude', permissionModeSnapshot 'auto'->'bypassPermissions'", () => {
    seed("cronjobs/job00001/runs.json", [
      {
        id: "run00001",
        cronjobId: "job00001",
        cronjobName: "Legacy job",
        trigger: "scheduled",
        status: "completed",
        startedAt: 1,
        endedAt: 2,
        errorReason: null,
        promptSnapshot: "go",
        modelFamilySnapshot: "opus",
        effortSnapshot: "high",
        cwdSnapshot: "/",
        permissionModeSnapshot: "auto", // legacy -> bypassPermissions
        rootSessionId: "rs1",
        previewText: "",
        // agentTypeSnapshot absent -> defaults to "claude"
      },
    ]);
    const [run] = loadRuns("job00001");
    expect(run.agentTypeSnapshot).toBe("claude");
    expect(run.permissionModeSnapshot).toBe("bypassPermissions");
  });
});

// ---------------------------------------------------------------------------
// users.json migrations
// ---------------------------------------------------------------------------

describe("users.json legacy name-keyed -> id-keyed migration (Phase 1.3)", () => {
  it("mints ids for legacy records AND rewrites users.json id-keyed on disk", () => {
    // Pre-userid shape: keyed by lowercase(name), records have NO id field.
    seed("users.json", {
      alice: { name: "Alice", role: "owner", allowedRooms: [], notifRooms: [] },
      bob: { name: "Bob", role: "member", allowedRooms: [], notifRooms: [] },
    });
    _testResetUsers();

    const users = listUsers();
    expect(users.length).toBe(2);
    for (const u of users) expect(HEX8.test(u.id)).toBe(true);

    // The migration rewrites the file IMMEDIATELY (id-keyed), unlike loadAgents.
    const onDisk = JSON.parse(
      readFileSync(stateFile("users.json"), "utf-8"),
    ) as Record<string, { id?: string; name?: string }>;
    for (const [key, rec] of Object.entries(onDisk)) {
      expect(HEX8.test(key)).toBe(true); // key is now the minted id, not "alice"
      expect(rec.id).toBe(key); // record carries the same id
    }
    // Name lookup still resolves through the freshly-minted id.
    expect(getUserByName("Alice")?.role).toBe("owner");
  });
});

describe("users.json field normalization (Phase 1.3)", () => {
  it("normalizes a legacy 'all' allowedRooms/notifRooms sentinel to [] at the loader", () => {
    // NOTE: this is the LOADER fallback. The boot-time expansion of "all" to a
    // concrete room-id snapshot runs in a separate boot migration BEFORE
    // users.ts loads; it is not exercised here. Record carries an id so no
    // id-minting/disk-rewrite is triggered — this isolates the normalization.
    seed("users.json", {
      u1: {
        id: "u1",
        name: "Al",
        role: "owner",
        allowedRooms: "all",
        notifRooms: "all",
        memberPrompt: "   ",
        avatarColor: "not-a-color",
        avatarVariant: "bogus-variant",
      },
    });
    _testResetUsers();
    const u = getUserById("u1");
    expect(u?.allowedRooms).toEqual([]);
    expect(u?.notifRooms).toEqual([]);
    expect(u?.memberPrompt).toBeNull(); // whitespace -> null
    expect(u?.role).toBe("owner");
    expect(u?.avatarColor).toMatch(/^#[0-9a-f]{6}$/); // invalid -> deterministic default
    expect(u?.avatarVariant).toBe("classic"); // invalid -> classic
  });

  it("preserves valid fields and defaults a missing role to 'member'", () => {
    seed("users.json", {
      u1: {
        id: "u1",
        name: "Val",
        // role missing -> member
        allowedRooms: ["r1"],
        notifRooms: ["r1"],
        memberPrompt: "I am Val.",
        avatarColor: "#AABBCC",
        avatarVariant: "big-eyes",
      },
    });
    _testResetUsers();
    const u = getUserById("u1");
    expect(u?.role).toBe("member");
    expect(u?.memberPrompt).toBe("I am Val.");
    expect(u?.avatarColor).toBe("#aabbcc"); // normalized to lowercase
    expect(u?.avatarVariant).toBe("big-eyes");
  });

  it("backfills missing view-preference fields (hidden/order) to [] and preserves/normalizes present ones (Phase 3b)", () => {
    seed("users.json", {
      // Legacy record predating Phase 3b: no hidden/order keys at all.
      legacy: {
        id: "legacy",
        name: "Legacy",
        role: "member",
        allowedRooms: ["r1", "r2"],
        notifRooms: ["r1"],
      },
      // Valid view prefs -> preserved verbatim.
      withprefs: {
        id: "withprefs",
        name: "Pref",
        role: "member",
        allowedRooms: ["r1", "r2"],
        hidden: ["r2"],
        order: ["r2", "r1"],
      },
      // Malformed (non-array) view prefs -> normalized to [].
      bad: {
        id: "bad",
        name: "Bad",
        role: "member",
        allowedRooms: ["r1"],
        hidden: "r1",
        order: 42,
      },
    });
    _testResetUsers();
    const legacy = getUserById("legacy");
    expect(legacy?.hidden).toEqual([]);
    expect(legacy?.order).toEqual([]);
    const withprefs = getUserById("withprefs");
    expect(withprefs?.hidden).toEqual(["r2"]);
    expect(withprefs?.order).toEqual(["r2", "r1"]);
    const bad = getUserById("bad");
    expect(bad?.hidden).toEqual([]);
    expect(bad?.order).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// office-config / cronjobs-prompt fold-ins
// ---------------------------------------------------------------------------

describe("office-config legacy office-prompt.md fold-in (Phase 1.3)", () => {
  it("folds a non-empty office-prompt.md into office-config.json (writes the config file)", () => {
    seed("office-prompt.md", "Legacy office prompt.\n");
    const cfg = loadOfficeConfig();
    expect(cfg.prompt).toBe("Legacy office prompt.\n");
    expect(cfg.envFile).toBeNull();
    expect(cfg.name).toBeNull();
    // Non-empty legacy prompt -> config file is materialized on disk.
    expect(existsSync(stateFile("office-config.json"))).toBe(true);
  });

  it("an empty office-prompt.md yields a null prompt and does NOT create office-config.json", () => {
    seed("office-prompt.md", "   \n");
    const cfg = loadOfficeConfig();
    expect(cfg.prompt).toBeNull();
    // Nothing worth persisting -> no fresh file touched.
    expect(existsSync(stateFile("office-config.json"))).toBe(false);
  });
});

describe("cronjobs-prompt fold-in from office-config (Phase 1.3)", () => {
  it("migrates a legacy cronjobsPrompt from office-config.json into cronjobs-prompt.md", () => {
    seed("office-config.json", {
      prompt: null,
      cronjobsPrompt: "Legacy cron prompt",
    });
    migrateCronjobsPromptFromOfficeConfig();
    expect(existsSync(stateFile("cronjobs/cronjobs-prompt.md"))).toBe(true);
    expect(loadCronjobsPrompt()).toBe("Legacy cron prompt");
  });

  it("is a no-op when cronjobs-prompt.md already exists (does not overwrite)", () => {
    seed("cronjobs/cronjobs-prompt.md", "Current cron prompt");
    seed("office-config.json", { cronjobsPrompt: "Legacy cron prompt" });
    migrateCronjobsPromptFromOfficeConfig();
    expect(loadCronjobsPrompt()).toBe("Current cron prompt");
  });
});

// ---------------------------------------------------------------------------
// migrations.ts — runPreUseridBackupIfNeeded (boot-order safety surface)
// ---------------------------------------------------------------------------

describe("runPreUseridBackupIfNeeded (Phase 1.3)", () => {
  const SENTINEL = ".pre-userid-migration-applied";
  const backupsDir = () => stateFile("backups");

  it("is a no-op when the sentinel already exists (even with relevant state present)", () => {
    seed("users.json", { u1: { id: "u1", name: "Al", role: "owner" } });
    seed(SENTINEL, "already applied\n"); // sentinel short-circuits before backup
    runPreUseridBackupIfNeeded();
    expect(existsSync(backupsDir())).toBe(false);
  });

  it("fresh install (no relevant state) writes the sentinel and creates no backup bundle", () => {
    runPreUseridBackupIfNeeded();
    expect(existsSync(stateFile(SENTINEL))).toBe(true);
    expect(existsSync(backupsDir())).toBe(false);
  });

  it("seeded relevant state creates exactly one backup bundle, copies the file, and logs", () => {
    seed("users.json", { u1: { id: "u1", name: "Al", role: "owner" } });
    runPreUseridBackupIfNeeded();

    expect(existsSync(stateFile(SENTINEL))).toBe(true);
    const bundles = readdirSync(backupsDir());
    expect(bundles.length).toBe(1);
    expect(bundles[0].startsWith("pre-userid-migration-")).toBe(true);
    // The seeded file was copied into the bundle.
    expect(existsSync(join(backupsDir(), bundles[0], "users.json"))).toBe(true);
    // Review note: assert the backup-written log rather than let it surprise the suite.
    expect(logs.some((l) => l.includes("pre-userid backup written"))).toBe(
      true,
    );
  });

  it("_testResetSentinel permits a rerun: the backup path actually re-runs", () => {
    // Pins that the rerun RE-EXECUTES the backup, not just that the sentinel
    // toggled. We assert the captured backup-write log increments per run, NOT
    // bundle count: isoStamp() has 1s resolution, so a same-second rerun reuses
    // the backup dir (mkdir recursive no-op) and a count would not change.
    seed("users.json", { u1: { id: "u1", name: "Al", role: "owner" } });
    const backupWrites = () =>
      logs.filter((l) => l.includes("pre-userid backup written")).length;

    runPreUseridBackupIfNeeded();
    expect(existsSync(stateFile(SENTINEL))).toBe(true);
    expect(backupWrites()).toBe(1);

    _testResetSentinel();
    expect(existsSync(stateFile(SENTINEL))).toBe(false);

    runPreUseridBackupIfNeeded();
    expect(existsSync(stateFile(SENTINEL))).toBe(true);
    expect(backupWrites()).toBe(2); // the backup path ran a second time
  });
});

// ---------------------------------------------------------------------------
// loadLog legacy `images` -> `attachments` read-time migration
// (deferred from the initial 1.3 net by review agreement; reconciled here)
// ---------------------------------------------------------------------------

describe("loadLog images -> attachments read-time migration (Phase 1.3, deferred)", () => {
  const agentId = "agent-mig";
  const sessionId = "sess-mig";

  function seedLog(entries: unknown[]): void {
    seed(
      `logs/${agentId}/${sessionId}.jsonl`,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }

  it("migrates a legacy images[] entry to attachments and drops the images field", () => {
    seedLog([
      {
        id: "e1",
        agentId,
        timestamp: 1,
        kind: "file-view",
        content: "legacy",
        images: ["pic.png", "report.pdf", "weird.xyz"],
      },
      { id: "e2", agentId, timestamp: 2, kind: "text", content: "plain" },
    ]);
    const entries = loadLog(agentId, sessionId);
    expect(entries.length).toBe(2);
    // images -> attachments: ext-mapped mediaType (unknown ext -> octet-stream),
    // originalName == filename, size 0.
    expect(entries[0].attachments).toEqual([
      {
        filename: "pic.png",
        originalName: "pic.png",
        mediaType: "image/png",
        size: 0,
      },
      {
        filename: "report.pdf",
        originalName: "report.pdf",
        mediaType: "application/pdf",
        size: 0,
      },
      {
        filename: "weird.xyz",
        originalName: "weird.xyz",
        mediaType: "application/octet-stream",
        size: 0,
      },
    ]);
    // The legacy field is removed after migration.
    expect((entries[0] as { images?: unknown }).images).toBeUndefined();
    // An entry without images is untouched (no attachments synthesized).
    expect(entries[1].attachments).toBeUndefined();
  });

  it("leaves an entry that already has attachments untouched (guard is images && !attachments)", () => {
    const existing = [
      {
        filename: "kept.png",
        originalName: "kept.png",
        mediaType: "image/png",
        size: 123,
      },
    ];
    seedLog([
      {
        id: "e1",
        agentId,
        timestamp: 1,
        kind: "file-view",
        content: "both",
        attachments: existing,
        images: ["ignored.png"],
      },
    ]);
    const entries = loadLog(agentId, sessionId);
    // Existing attachments are preserved unchanged...
    expect(entries[0].attachments).toEqual(existing);
    // ...and because the migration block is skipped, the legacy images field is
    // NOT deleted — a no-op pass-through, frozen as the current behavior.
    expect((entries[0] as { images?: unknown }).images).toEqual([
      "ignored.png",
    ]);
  });
});
