import { describe, expect, it } from "bun:test";
import type {
  BackupStatusWire,
  StorageUsageWire,
  UsageBucketWire,
  UsageReportWire,
} from "../shared/contract-shapes.ts";
import type { CronjobRun, LogEntry } from "../shared/types.ts";
import { cronjobRunStreamId } from "../shared/types.ts";
import { IN_ROOT_ORDER, OUT_OF_ROOT_ORDER } from "../shared/storage-labels.ts";
import { DEMO_ROOM_NAMES, demoApi } from "./demo-server.ts";

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
      ].sort(),
    );
    expect(first.rooms.map((room) => room.name)).toEqual([...DEMO_ROOM_NAMES]);
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
      customInstructions: "Keep a close eye on workplace conduct.",
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
});
