// T1 - the /isomux-storage command's ACCESS BOUNDARY (task 1387a9c7).
//
// server/storage-report.test.ts proves the renderer is safe once it is handed
// the right projection. What it cannot prove is that the handler CHOOSES the
// right projection, and that choice is the whole access-control story:
//   - office owner   -> the full measurement (paths + per-agent rows),
//   - signed-in member -> aggregateOnly() (sizes only),
//   - no user record -> refusal, and NO measurement at all.
// That last one matters twice over: it is the command's stand-in for the 403
// the route gives a plain agent token, and a refusal that still walked the disk
// would be a free ~10k-inode spin for anyone who can post a message.
//
// The measurement arrives through deps.getStorageUsage, so these drive the real
// handler over a hand-built StorageUsage and never touch a state root. Users are
// seeded through the real users API against the temp STATE_ROOT the bun-test
// preload installs.

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync } from "fs";
import { STATE_ROOT } from "../config.ts";
import { removeStateDir } from "./temp-state.ts";
import { claimUser, _testResetUsers } from "../users.ts";
import { _testResetSentinel } from "../migrations.ts";
import { createCommandHandling } from "../command-handlers.ts";
import type { StorageUsage } from "../storage-usage.ts";
import type { StorageCategoryId } from "../../shared/contract-shapes.ts";
import { renderLogText, type LogText } from "../../shared/i18n/log-message.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { formatBytes } from "../../shared/i18n/number.ts";
import { CATEGORY_KEYS } from "../../shared/storage-labels.ts";

const MB = 1024 * 1024;

function usageFixture(): StorageUsage {
  const ids: StorageCategoryId[] = [
    "transcripts",
    "attachments",
    "session-metadata",
    "codex-home",
    "cronjobs",
    "memory",
    "other-state",
    "backups",
    "update-snapshots",
  ];
  return {
    stateRoot: "/srv/office-state",
    measuredAt: Date.now(),
    stateRootBytes: 10 * MB,
    categories: ids.map((id) => ({
      id,
      path: id === "backups" ? "/srv/office-backups" : "/srv/office-state",
      available: true,
      bytes: id === "transcripts" ? 10 * MB : 0,
      files: id === "transcripts" ? 4 : 0,
    })),
    agents: [
      {
        agentId: "agentalpha",
        transcriptBytes: 10 * MB,
        attachmentBytes: 0,
        sessions: 2,
        lastActivityAt: Date.now(),
      },
    ],
  };
}

interface Logged {
  kind: string;
  content: LogText;
}

// Minimal deps: the handler under test reads only these. Cast through the
// constructor's parameter type rather than exporting HandlerDeps just for a
// test - the compiler still checks the fields that ARE supplied.
function harness(opts: { usage?: StorageUsage } = {}) {
  const logged: Logged[] = [];
  let measurements = 0;
  const deps = {
    agents: new Map(),
    getRooms: () => [],
    addLogEntry: (_agentId: string, kind: string, content: LogText) => {
      logged.push({ kind, content });
    },
    updateState: () => {},
    getStorageUsage: () => {
      measurements++;
      return opts.usage ?? usageFixture();
    },
  } as unknown as Parameters<typeof createCommandHandling>[0];
  const { commandHandlers } = createCommandHandling(deps);
  return {
    logged,
    measurements: () => measurements,
    run: (username?: string) =>
      commandHandlers.isomuxStorage(
        "a1",
        {} as never,
        [],
        "/isomux-storage",
        username,
        undefined,
      ),
    // The English a reader on English sees; the report is message parts each
    // reader words (task c37a7365).
    report: () =>
      renderLogText(
        translatorFor("en"),
        logged.find((l) => l.kind === "system")?.content ?? "",
      ),
    // Every message key in the reply, nested ones included.
    keys: () =>
      messageKeys(logged.find((l) => l.kind === "system")?.content ?? ""),
  };
}

function messageKeys(value: unknown): string[] {
  if (typeof value === "string") return [];
  if (Array.isArray(value)) return value.flatMap(messageKeys);
  if (typeof value !== "object" || value === null) return [];
  const record = value as { key?: unknown; params?: unknown };
  return [
    ...(typeof record.key === "string" ? [record.key] : []),
    ...Object.values(record.params ?? {}).flatMap(messageKeys),
    ...messageKeys((value as { parts?: unknown }).parts),
    ...messageKeys((value as { lower?: unknown }).lower),
  ];
}

function resetStateRoot(): void {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
  _testResetUsers();
  _testResetSentinel();
}

beforeEach(() => {
  resetStateRoot();
});

describe("/isomux-storage access boundary", () => {
  it("gives the owner paths and agent rows, and a member sizes only", async () => {
    claimUser("Owner", { role: "owner", allowedRooms: [], notifRooms: [] });
    claimUser("Member", { role: "member", allowedRooms: [], notifRooms: [] });
    const owner = harness();
    await owner.run("Owner");
    expect(owner.logged[0]).toEqual({
      kind: "user_message",
      content: "/isomux-storage",
    });
    expect(owner.report()).toContain("/srv/office-state");
    expect(owner.report()).toContain("/srv/office-backups");
    expect(owner.report()).toContain("agentalpha");
    expect(owner.keys()).not.toContain("storageReport.ownerOnly");
    expect(owner.measurements()).toBe(1);

    const member = harness();
    await member.run("Member");
    const report = member.report();
    // The numbers still come through; that is the point of the projection.
    const { t } = translatorFor("en");
    expect(report).toContain(
      `| ${t(CATEGORY_KEYS.transcripts)} | ${formatBytes("en", 10 * MB)} | 4 |`,
    );
    // The filesystem layout and the per-agent enumeration do not.
    expect(report).not.toContain("/srv/office-state");
    expect(report).not.toContain("/srv/office-backups");
    expect(report).not.toContain("agentalpha");
    expect(member.keys()).not.toContain("storageReport.biggestAgents");
    expect(member.keys()).toContain("storageReport.ownerOnly");
  });

  // The refusal must be free: no ~10k-inode walk for a caller with no user
  // record, and nothing rendered that could carry office totals.
  for (const [label, username] of [
    ["an unknown username", "GhostUser"],
    ["no username at all", undefined],
  ] as const) {
    it(`refuses ${label} without measuring`, async () => {
      claimUser("Owner", { role: "owner", allowedRooms: [], notifRooms: [] });
      const h = harness();
      await h.run(username);
      expect(h.keys()).toEqual(["commands.isomuxStorage.forbidden"]);
      expect(h.measurements()).toBe(0);
    });
  }
});
