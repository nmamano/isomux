import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type {
  BackupStatusWire,
  StorageUsageWire,
  UsageBucketWire,
  UsageReportWire,
  MemoryReadRes,
} from "../shared/contract-shapes.ts";
import type {
  CronjobRun,
  LogEntry,
  MembersChatMessage,
} from "../shared/types.ts";
import type { AppWire, PresenceInfo, ServerMessage } from "../shared/types.ts";
import { cronjobRunStreamId, ordinaryRooms } from "../shared/types.ts";
import { IN_ROOT_ORDER, OUT_OF_ROOT_ORDER } from "../shared/storage-labels.ts";
import { injectedMemorySize } from "../shared/memory-size.ts";
import { MEMORY_CAPS } from "../shared/memory-caps.ts";
import {
  DEMO_ROOM_NAMES,
  demoApi,
  seedDemoDeviceDefaults,
  sendInitialState,
} from "./demo-server.ts";
import { demoAppMockContent } from "./demo-app.ts";
import { addRawListener, removeRawListener } from "./ws.ts";
import {
  getMembersChatHidden,
  setMembersChatHidden,
} from "./device-settings.ts";

function sumBucket(rows: UsageBucketWire[]): UsageBucketWire {
  return rows.reduce(
    (sum, row) => ({
      totalIn: sum.totalIn + row.totalIn,
      cacheRead: sum.cacheRead + row.cacheRead,
      cacheCreation: sum.cacheCreation + row.cacheCreation,
      totalOut: sum.totalOut + row.totalOut,
      costUSD: Number((sum.costUSD + row.costUSD).toFixed(2)),
    }),
    { totalIn: 0, cacheRead: 0, cacheCreation: 0, totalOut: 0, costUSD: 0 },
  );
}

describe("demo fixture data", () => {
  it("loads canned memory for each editable demo scope", async () => {
    for (const scope of ["agent", "room", "office"] as const) {
      const memory = (await demoApi(
        "GET",
        `/api/memory?scope=${scope}&scopeId=demo`,
      )) as MemoryReadRes;
      expect(memory.text.length).toBeGreaterThan(0);
      expect(memory.version.length).toBeGreaterThan(0);
      expect(memory.size).toBe(injectedMemorySize(memory.text));
      expect(memory.cap).toBe(MEMORY_CAPS[scope]);
    }
  });

  it("persists edited agent memory in the demo fixture", async () => {
    const path = "/api/memory?scope=agent&scopeId=memory-test";
    const before = (await demoApi("GET", path)) as MemoryReadRes;
    const text = `${before.text}\nRemember the edited value.`;
    const saved = (await demoApi("PUT", "/api/memory", {
      scope: "agent",
      scopeId: "memory-test",
      text,
      version: before.version,
    })) as { version: string };
    const after = (await demoApi("GET", path)) as MemoryReadRes;
    expect(after.text).toBe(text);
    expect(after.version).toBe(saved.version);
  });

  it("reports every seeded agent and room with production-equivalent totals and ordering", async () => {
    const first = (await demoApi("GET", "/api/usage")) as UsageReportWire;
    const second = (await demoApi("GET", "/api/usage")) as UsageReportWire;

    expect(first).toEqual(second);
    expect(first.agents.map((agent) => agent.name).sort()).toEqual(
      [
        "Michael",
        "Dwight",
        "Jim",
        "Pam",
        "Stanley",
        "Kevin",
        "Angela",
        "Kelly",
        "Creed",
        "Receptionist",
      ].sort(),
    );
    expect(first.rooms.map((room) => room.name)).toEqual([
      ...DEMO_ROOM_NAMES,
      "Lobby",
    ]);
    expect(first.agents.map((row) => row.lifetime.costUSD)).toEqual(
      [...first.agents]
        .map((row) => row.lifetime.costUSD)
        .sort((a, b) => b - a),
    );
    expect(first.rooms.map((row) => row.lifetime.costUSD)).toEqual(
      [...first.rooms].map((row) => row.lifetime.costUSD).sort((a, b) => b - a),
    );
    expect(first.cronjobs?.map((row) => row.lifetime.costUSD)).toEqual(
      [...(first.cronjobs ?? [])]
        .map((row) => row.lifetime.costUSD)
        .sort((a, b) => b - a),
    );
    expect(first.total.session).toEqual(
      sumBucket(first.agents.map((row) => row.session)),
    );
    expect(first.total.lifetime).toEqual(
      sumBucket([
        ...first.agents.map((row) => row.lifetime),
        ...(first.cronjobs ?? []).map((row) => row.lifetime),
      ]),
    );
  });

  it("reports all storage categories, an exact office-state subtotal, and coherent backup status", async () => {
    const storage = (await demoApi(
      "GET",
      "/api/storage/usage",
    )) as StorageUsageWire;
    const backup = (await demoApi(
      "GET",
      "/api/backup/status",
    )) as BackupStatusWire;
    const expectedIds = [...IN_ROOT_ORDER, ...OUT_OF_ROOT_ORDER];

    expect(storage.categories.map((category) => category.id)).toEqual(
      expectedIds,
    );
    expect(storage.stateRootBytes).toBe(
      storage.categories
        .filter((category) => IN_ROOT_ORDER.includes(category.id))
        .reduce((sum, category) => sum + category.bytes, 0),
    );
    const backupCategory = storage.categories.find(
      (category) => category.id === "backups",
    );
    expect(backupCategory).toMatchObject({
      available: true,
      path: backup.destDir,
    });
    expect(backup).toMatchObject({ ok: true, error: null, retention: 7 });
  });

  it("keeps the completed cron run coherent across list and transcript routes", async () => {
    const all = (await demoApi("GET", "/api/cron-runs")) as {
      jobs: { cronjobId: string; runs: CronjobRun[] }[];
    };
    const run = all.jobs[0].runs[0];
    const perJob = (await demoApi(
      "GET",
      `/api/cronjobs/${run.cronjobId}/runs`,
    )) as {
      runs: CronjobRun[];
    };
    const detail = (await demoApi(
      "GET",
      `/api/cronjobs/${run.cronjobId}/runs/${run.id}`,
    )) as { run: CronjobRun; entries: LogEntry[] };

    expect(run).toMatchObject({
      cronjobName: "Cat archive backup check",
      status: "completed",
      trigger: "scheduled",
      agentTypeSnapshot: "claude",
      modelFamilySnapshot: "haiku",
      permissionModeSnapshot: "bypassPermissions",
      cwdSnapshot: "~/accounting/cats",
    });
    expect(run.startedAt).toBeLessThan(run.endedAt!);
    expect(perJob.runs).toEqual([run]);
    expect(detail.run).toEqual(run);
    expect(detail.entries.length).toBeGreaterThan(0);
    expect(
      detail.entries.every(
        (entry) => entry.agentId === cronjobRunStreamId(run.id),
      ),
    ).toBe(true);
    expect(new Set(detail.entries.map((entry) => entry.id)).size).toBe(
      detail.entries.length,
    );
    expect(detail.entries.map((entry) => entry.timestamp)).toEqual(
      [...detail.entries].map((entry) => entry.timestamp).sort((a, b) => a - b),
    );
  });

  // As on the server, a new Claude agent starts in Bypass (task f49289bd).
  it("spawns a Claude agent with no mode in Bypass", async () => {
    const demoRoom = (await demoApi("POST", "/api/rooms", {
      name: "Claude defaults",
    })) as { room: { id: string } };
    const claude = (await demoApi("POST", "/api/agents", {
      name: "Claude Demo Default",
      cwd: "~/demo-claude",
      desk: 0,
      roomId: demoRoom.room.id,
      modelFamily: "opus",
      effort: "high",
      agentType: "claude",
    })) as { agent: { permissionMode: string; agentType: string } };
    expect(claude.agent.agentType).toBe("claude");
    expect(claude.agent.permissionMode).toBe("bypassPermissions");
  });

  it("keeps usage stable across agent and cron fixture mutations", async () => {
    const initial = (await demoApi("GET", "/api/usage")) as UsageReportWire;
    const michael = initial.agents.find(
      (agent) => agent.id === "demo-michael",
    )!;
    expect(michael.lifetime.costUSD).toBe(27.42);

    await demoApi("PATCH", "/api/agents/demo-michael", { name: "Toby" });
    const renamed = (await demoApi("GET", "/api/usage")) as UsageReportWire;
    expect(
      renamed.agents.find((agent) => agent.id === michael.id),
    ).toMatchObject({
      name: "Toby",
      session: michael.session,
      lifetime: michael.lifetime,
    });
    await demoApi("PATCH", "/api/agents/demo-michael", { name: "Michael" });

    const spawned = (await demoApi("POST", "/api/agents", {
      name: "Toby",
      cwd: "~/human-resources",
      permissionMode: "default",
      desk: 5,
      roomId: initial.rooms.find((room) => room.name === DEMO_ROOM_NAMES[0])!
        .id,
      instructions: "Keep a close eye on workplace conduct.",
      outfit: {
        hat: "none",
        color: "#888888",
        hair: "#553322",
        hairStyle: "short",
        skin: "#FDEBD0",
        beard: "none",
        accessory: null,
      },
      modelFamily: "sonnet",
      effort: "high",
      agentType: "claude",
    })) as { agent: { id: string } };
    const afterSpawn = (await demoApi("GET", "/api/usage")) as UsageReportWire;
    expect(
      afterSpawn.agents.find((agent) => agent.id === spawned.agent.id),
    ).toMatchObject({
      name: "Toby",
      session: {
        totalIn: 0,
        cacheRead: 0,
        cacheCreation: 0,
        totalOut: 0,
        costUSD: 0,
      },
      lifetime: {
        totalIn: 0,
        cacheRead: 0,
        cacheCreation: 0,
        totalOut: 0,
        costUSD: 0,
      },
    });

    const demoRoom = (await demoApi("POST", "/api/rooms", {
      name: "OpenCode defaults",
    })) as { room: { id: string } };
    const openCode = (await demoApi("POST", "/api/agents", {
      name: "OpenCode Demo Default",
      cwd: "~/demo-opencode",
      desk: 0,
      roomId: demoRoom.room.id,
      modelFamily: "opencode/muse-spark-1.2-contributor-free",
      effort: "high",
      agentType: "opencode",
    })) as { agent: { permissionMode: string } };
    expect(openCode.agent.permissionMode).toBe("bypassPermissions");

    const created = (await demoApi("POST", "/api/cronjobs", {
      name: "Party planning reminder",
      schedule: { type: "weekly", weekday: 5, hour: 16, minute: 0 },
      prompt: "Remind the committee to confirm the cake order.",
      cwd: "~/party-planning",
      agentType: "claude",
      modelFamily: "haiku",
      effort: "high",
      permissionMode: "bypassPermissions",
    })) as { id: string };
    const afterCreate = (await demoApi("GET", "/api/usage")) as UsageReportWire;
    expect(
      afterCreate.cronjobs?.find((job) => job.id === created.id)?.lifetime,
    ).toEqual({
      totalIn: 0,
      cacheRead: 0,
      cacheCreation: 0,
      totalOut: 0,
      costUSD: 0,
    });
    await demoApi("DELETE", `/api/cronjobs/${created.id}`);

    const beforeDelete = (await demoApi(
      "GET",
      "/api/usage",
    )) as UsageReportWire;
    const deleted = beforeDelete.cronjobs!.find(
      (job) => job.name === "Morning office digest",
    )!;
    const survivors = new Map(
      beforeDelete
        .cronjobs!.filter((job) => job.id !== deleted.id)
        .map((job) => [job.id, job.lifetime]),
    );
    await demoApi("DELETE", `/api/cronjobs/${deleted.id}`);
    const afterDelete = (await demoApi("GET", "/api/usage")) as UsageReportWire;
    expect(
      new Map(afterDelete.cronjobs!.map((job) => [job.id, job.lifetime])),
    ).toEqual(survivors);
    expect(afterDelete.total.lifetime.costUSD).toBe(
      Number(
        (
          beforeDelete.total.lifetime.costUSD - deleted.lifetime.costUSD
        ).toFixed(2),
      ),
    );
  });

  // One fixture defines a demo app: the Apps tab's list and the page the
  // app opens on. The page content stays off the apps wire.
  it("opens every listed app on its own page and keeps page content off the wire", async () => {
    const apps = (await demoApi("GET", "/api/apps")) as AppWire[];
    expect(apps.length).toBeGreaterThan(0);
    const fallback = demoAppMockContent("");
    for (const app of apps) {
      expect(demoAppMockContent(app.name)).not.toEqual(fallback);
      expect(Object.keys(app)).not.toContain("page");
    }
  });
});

describe("demo members chat", () => {
  it("keeps pin mutations and the served strip consistent", async () => {
    const message = (await demoApi("POST", "/api/members-chat", {
      text: "pin fixture",
    })) as MembersChatMessage;
    const path = `/api/members-chat/${message.id}/pin`;
    const pinned = (await demoApi("PUT", path, {
      active: true,
    })) as MembersChatMessage;
    expect(typeof pinned.pinnedAt).toBe("number");
    const repeated = (await demoApi("PUT", path, {
      active: true,
    })) as MembersChatMessage;
    expect(repeated.pinnedAt).toBe(pinned.pinnedAt);
    const page = (await demoApi("GET", "/api/members-chat")) as {
      pinned: MembersChatMessage[];
    };
    expect(page.pinned.some((pin) => pin.id === message.id)).toBe(true);
    const invalid = await Promise.allSettled([
      demoApi("PUT", path, { active: "yes" }),
      demoApi("PUT", "/api/members-chat/missing/pin", { active: true }),
    ]);
    expect(invalid.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    await demoApi("PUT", path, { active: false });
    const after = (await demoApi("GET", "/api/members-chat")) as {
      pinned: MembersChatMessage[];
    };
    expect(after.pinned.some((pin) => pin.id === message.id)).toBe(false);
  });

  it("serves a canned page and lands a post as the demo viewer", async () => {
    const page = (await demoApi("GET", "/api/members-chat")) as {
      messages: MembersChatMessage[];
      hasMore: boolean;
      unread: number;
    };
    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.hasMore).toBe(false);
    expect(new Set(page.messages.map((m) => m.kind))).toEqual(
      new Set(["user", "api", "agent"]),
    );
    const posted = (await demoApi("POST", "/api/members-chat", {
      text: "hello from the demo",
    })) as MembersChatMessage;
    expect(posted.userName).toBe("Ricky");
    const reactionPath = `/api/members-chat/${posted.id}/thumbs-up`;
    const reacted = (await demoApi("PUT", reactionPath, {
      active: true,
    })) as MembersChatMessage;
    expect(reacted.thumbsUp).toEqual([
      { kind: "user", userId: posted.userId, userName: "Ricky" },
    ]);
    const repeated = (await demoApi("PUT", reactionPath, {
      active: true,
    })) as MembersChatMessage;
    expect(repeated.thumbsUp).toEqual(reacted.thumbsUp);
    const removed = (await demoApi("PUT", reactionPath, {
      active: false,
    })) as MembersChatMessage;
    expect(removed.thumbsUp).toEqual([]);

    const after = (await demoApi("GET", "/api/members-chat")) as {
      messages: MembersChatMessage[];
    };
    expect(after.messages.at(-1)?.id).toBe(posted.id);
    let threw = false;
    try {
      await demoApi("POST", "/api/members-chat", { text: "   " });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// Task 379ae5db: the UI reads and writes every instruction layer through
// GET/PUT .../instructions, so the demo serves them with the same version rule.
it("serves every instruction layer's read and version-guarded write", async () => {
  const { room } = (await demoApi("POST", "/api/rooms", {
    name: "Instructions room",
  })) as { room: { id: string } };
  const roomId = room.id;
  for (const path of [
    "/api/office/instructions",
    `/api/rooms/${roomId}/instructions`,
    "/api/agents/demo-michael/instructions",
    "/api/users/Ricky/instructions",
    "/api/cron-instructions",
  ]) {
    const before = (await demoApi("GET", path)) as {
      instructions: string | null;
      version: string;
    };
    expect([path, typeof before.version]).toEqual([path, "string"]);
    const text = `Demo text for ${path}`;
    await demoApi("PUT", path, { instructions: text, version: before.version });
    const stale = await demoApi("PUT", path, {
      instructions: "stale",
      version: before.version,
    }).catch((error: unknown) => error);
    expect([path, stale]).toMatchObject([
      path,
      { status: 409, code: "version_conflict" },
    ]);
    expect([path, await demoApi("GET", path)]).toMatchObject([
      path,
      { instructions: text },
    ]);
  }
});

it("shows demo task history and restores a deleted task once", async () => {
  const task = (await demoApi("POST", "/api/tasks", {
    title: "Demo audit task",
  })) as import("../shared/types.ts").TaskItem;
  await demoApi("DELETE", `/api/tasks/${task.id}`, undefined);
  const page = (await demoApi(
    "GET",
    `/api/audit-log?targetId=${task.id}`,
    undefined,
  )) as import("../shared/audit.ts").AuditPage;
  expect(page.items[0].deletedTask?.id).toBe(task.id);
  const restored = (await demoApi(
    "POST",
    `/api/tasks/${task.id}/restore`,
    undefined,
  )) as import("../shared/types.ts").TaskItem;
  expect(restored.id).toBe(task.id);
  const history = (await demoApi(
    "GET",
    `/api/tasks/${task.id}/history`,
    undefined,
  )) as import("../shared/audit.ts").TaskHistory;
  expect(history.items[0].operation).toBe("tasks.restore");
  expect(
    demoApi("POST", `/api/tasks/${task.id}/restore`, undefined),
  ).rejects.toMatchObject({ status: 409 });
});

// Task d587f975: Stephen's phone ghost walks the whole office, so a visitor
// sees it reach Angela in the second room. The lobby is not a room he visits.
it("cycles Stephen's ghost through every room agent and never the lobby", () => {
  const seen: ServerMessage[] = [];
  const listen = (data: string) => seen.push(JSON.parse(data));
  addRawListener(listen);
  jest.useFakeTimers();
  let roomAgents: { id: string; roomId: string }[] = [];
  try {
    sendInitialState();
    const full = seen.find((m) => m.type === "full_state");
    if (full?.type !== "full_state") throw new Error("no full_state sent");
    const roomIds = new Set(ordinaryRooms(full.rooms).map((r) => r.id));
    roomAgents = full.agents.filter((a) => roomIds.has(a.roomId));
    // The conditions this test needs: agents in more than one room, and an
    // agent outside every room (the lobby receptionist).
    expect(new Set(roomAgents.map((a) => a.roomId)).size).toBeGreaterThan(1);
    expect(full.agents.length).toBeGreaterThan(roomAgents.length);
    jest.advanceTimersByTime(4000 * roomAgents.length);
  } finally {
    jest.useRealTimers();
    removeRawListener(listen);
  }
  const stops: PresenceInfo[] = seen.flatMap((m) =>
    m.type === "presence_list" ? m.entries : [],
  );
  const roomOf = new Map(roomAgents.map((a) => [a.id, a.roomId]));
  for (const stop of stops)
    expect(stop.currentRoomId).toBe(roomOf.get(stop.focusedAgentId ?? "")!);
  expect([...new Set(stops.map((s) => s.focusedAgentId))].sort()).toEqual(
    roomAgents.map((a) => a.id).sort(),
  );
});

describe("demo device defaults", () => {
  const store = new Map<string, string>();
  const realLocalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });
  afterEach(() => {
    if (realLocalStorage)
      Object.defineProperty(globalThis, "localStorage", realLocalStorage);
    // @ts-expect-error - removing the stub installed above
    else delete globalThis.localStorage;
  });

  // Task d587f975: the demo opens with the lobby members chat minimized.
  it("minimizes the members chat when this browser has no saved choice", () => {
    expect(getMembersChatHidden()).toBe(null);
    seedDemoDeviceDefaults();
    expect(getMembersChatHidden()).toBe(true);
  });

  it("keeps a visitor's saved choice to show the members chat", () => {
    setMembersChatHidden(false);
    seedDemoDeviceDefaults();
    expect(getMembersChatHidden()).toBe(false);
  });
});
