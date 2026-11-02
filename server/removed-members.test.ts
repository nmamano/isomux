// The removed-member archive (task 321e7b8e): a removal keeps the member's
// record, variables and connection shapes for REMOVED_MEMBER_RETENTION_MS, and
// "the live record wins" at boot. The routes and the removal itself are in
// server/test-support/routes-removed-members.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import { isCredentialStorePath } from "./credential-store-paths.ts";
import { removeStateDir } from "./test-support/temp-state.ts";
import { createMember, deleteUserById } from "./users.ts";
import { managedUserEnvNotesPath, managedUserEnvPath } from "./user-env.ts";
import {
  REMOVED_MEMBER_RETENTION_MS,
  archiveRemovedMember,
  dropRemovedMember,
  getRemovedMember,
  isRemovedMemberName,
  listRemovedMembers,
  purgeExpiredRemovedMembers,
  readArchivedConnections,
  reconcileRemovedMembers,
  removedMemberWire,
  restoreArchivedFiles,
  type ArchivedConnections,
  type RemovedMember,
} from "./removed-members.ts";
import type { UserRecord } from "../shared/types.ts";

// The layout the module header documents.
const INDEX = join(STATE_ROOT, "removed-members.json");
const DIR = join(STATE_ROOT, "removed-members");
const dirOf = (userId: string) => join(DIR, userId);

const DAY = 24 * 60 * 60 * 1000;
const created: string[] = [];

function clean() {
  if (existsSync(INDEX)) removeStateDir(INDEX);
  if (existsSync(DIR)) removeStateDir(DIR);
  for (const id of created.splice(0)) {
    deleteUserById(id);
    for (const path of [managedUserEnvPath(id), managedUserEnvNotesPath(id)])
      rmSync(path, { force: true });
  }
}
beforeEach(clean);
afterEach(clean);

function user(name: string): UserRecord {
  const made = createMember(name, { role: "member" });
  if (!made.ok) throw new Error(made.error);
  created.push(made.user.id);
  return made.user;
}

function removed(
  record: UserRecord,
  over: Partial<RemovedMember> = {},
): RemovedMember {
  return {
    user: record,
    removedAt: Date.now(),
    removedBy: "Morgan",
    heirId: "u-heir",
    heirName: "Morgan",
    passed: {
      agentIds: ["a1", "a2"],
      killedAgentIds: ["k1"],
      cronjobIds: ["c1"],
      webhookIds: [],
    },
    ...over,
  };
}

const CONNECTIONS: ArchivedConnections = {
  secrets: [
    {
      name: "LINEAR_TOKEN",
      hosts: ["mcp.example.com"],
      form: { kind: "authorization" },
      createdAt: 1_000,
      updatedAt: 2_000,
      note: "For the Linear MCP server.",
    },
  ],
  mcpServers: [
    {
      name: "linear",
      url: "https://mcp.example.com/mcp",
      secret: "LINEAR_TOKEN",
      createdAt: 1_000,
      updatedAt: 2_000,
    },
  ],
};

// The member's variables file and notes, as the live store keeps them.
function writeVariables(userId: string) {
  mkdirSync(join(managedUserEnvPath(userId), ".."), { recursive: true });
  writeFileSync(managedUserEnvPath(userId), "ZED_TOKEN=fake-zed-value\n");
  writeFileSync(
    managedUserEnvNotesPath(userId),
    JSON.stringify({ ZED_TOKEN: "For the Zed CLI." }),
  );
  return {
    env: readFileSync(managedUserEnvPath(userId), "utf8"),
    notes: readFileSync(managedUserEnvNotesPath(userId), "utf8"),
  };
}

describe("the archive", () => {
  it("keeps the record, the connection shapes and a copy of the variables, in a directory only the server user reads", () => {
    const mia = user("Mia");
    writeVariables(mia.id);
    const entry = removed(mia);
    archiveRemovedMember(entry, CONNECTIONS);

    expect(getRemovedMember(mia.id)).toEqual(entry);
    expect(readArchivedConnections(mia.id)).toEqual(CONNECTIONS);
    expect(statSync(dirOf(mia.id)).mode & 0o777).toBe(0o700);
    // Agent tools refuse it like the live variables and secrets.
    expect(isCredentialStorePath(join(dirOf(mia.id), "secrets.json"))).toBe(
      true,
    );
    // A copy: the live files are the removal's to delete, not the archive's.
    expect(existsSync(managedUserEnvPath(mia.id))).toBe(true);
  });

  it("lists newest removal first, and finds a name case-insensitively until the member is dropped", () => {
    const mia = user("Mia");
    const bob = user("Bob");
    archiveRemovedMember(removed(mia, { removedAt: 1_000 }), CONNECTIONS);
    archiveRemovedMember(removed(bob, { removedAt: 2_000 }), CONNECTIONS);
    expect(listRemovedMembers().map((m) => m.user.name)).toEqual([
      "Bob",
      "Mia",
    ]);
    expect(isRemovedMemberName("mIA")).toBe(true);
    expect(isRemovedMemberName("Carol")).toBe(false);

    expect(dropRemovedMember(mia.id)).toBe(true);
    expect(isRemovedMemberName("Mia")).toBe(false);
    expect(getRemovedMember(mia.id)).toBeNull();
    expect(existsSync(dirOf(mia.id))).toBe(false);
    expect(dropRemovedMember(mia.id)).toBe(false);
    expect(listRemovedMembers().map((m) => m.user.name)).toEqual(["Bob"]);
  });

  it("a second archive of the same id replaces the first (a retried removal)", () => {
    const mia = user("Mia");
    archiveRemovedMember(removed(mia, { removedBy: "First" }), CONNECTIONS);
    archiveRemovedMember(removed(mia, { removedBy: "Second" }), {
      secrets: [],
      mcpServers: [],
    });
    expect(listRemovedMembers()).toHaveLength(1);
    expect(getRemovedMember(mia.id)?.removedBy).toBe("Second");
    expect(readArchivedConnections(mia.id)).toEqual({
      secrets: [],
      mcpServers: [],
    });
  });

  it("restore copies the variables back whole, and the archive stays until it is dropped", () => {
    const mia = user("Mia");
    const before = writeVariables(mia.id);
    archiveRemovedMember(removed(mia), CONNECTIONS);
    // The removal deletes the live files.
    rmSync(managedUserEnvPath(mia.id));
    rmSync(managedUserEnvNotesPath(mia.id));

    restoreArchivedFiles(mia.id);
    expect({
      env: readFileSync(managedUserEnvPath(mia.id), "utf8"),
      notes: readFileSync(managedUserEnvNotesPath(mia.id), "utf8"),
    }).toEqual(before);
    expect(getRemovedMember(mia.id)).not.toBeNull();
    expect(existsSync(dirOf(mia.id))).toBe(true);
  });

  it("a member with no variables archives and restores with none", () => {
    const mia = user("Mia");
    archiveRemovedMember(removed(mia), CONNECTIONS);
    restoreArchivedFiles(mia.id);
    expect(existsSync(managedUserEnvPath(mia.id))).toBe(false);
    expect(existsSync(managedUserEnvNotesPath(mia.id))).toBe(false);
  });
});

describe("retention", () => {
  it("purges a member removed the retention period ago or longer, and keeps a younger one", () => {
    const now = 100 * DAY;
    const old = user("Old");
    const edge = user("Edge");
    const young = user("Young");
    archiveRemovedMember(
      removed(old, { removedAt: now - REMOVED_MEMBER_RETENTION_MS - DAY }),
      CONNECTIONS,
    );
    archiveRemovedMember(
      removed(edge, { removedAt: now - REMOVED_MEMBER_RETENTION_MS }),
      CONNECTIONS,
    );
    archiveRemovedMember(
      removed(young, { removedAt: now - REMOVED_MEMBER_RETENTION_MS + 1 }),
      CONNECTIONS,
    );
    expect(purgeExpiredRemovedMembers(now).sort()).toEqual(
      [old.id, edge.id].sort(),
    );
    expect(listRemovedMembers().map((m) => m.user.id)).toEqual([young.id]);
    for (const id of [old.id, edge.id])
      expect(existsSync(dirOf(id))).toBe(false);
    expect(existsSync(dirOf(young.id))).toBe(true);
  });

  it("the retention period is 30 days", () => {
    expect(REMOVED_MEMBER_RETENTION_MS).toBe(30 * DAY);
  });

  it("the wire carries the expiry and the counts of what passed, and no connection", () => {
    const mia = user("Mia");
    const entry = removed(mia, { removedAt: 5 * DAY });
    archiveRemovedMember(entry, CONNECTIONS);
    const wire = removedMemberWire(entry);
    expect(wire).toEqual({
      user: mia,
      removedAt: 5 * DAY,
      expiresAt: 5 * DAY + REMOVED_MEMBER_RETENTION_MS,
      removedBy: "Morgan",
      heirName: "Morgan",
      // Live and killed agents both passed to the heir.
      passed: { agents: 3, schedules: 1, webhooks: 0 },
    });
  });
});

describe("the live record wins at boot", () => {
  it("drops an entry whose id is live (an unfinished removal or a finished restore) with its directory, and keeps the others", () => {
    const live = user("Live");
    const gone = user("Gone");
    archiveRemovedMember(removed(live), CONNECTIONS);
    archiveRemovedMember(removed(gone), CONNECTIONS);
    reconcileRemovedMembers([live.id, "u-someone-else"]);
    expect(listRemovedMembers().map((m) => m.user.id)).toEqual([gone.id]);
    expect(existsSync(dirOf(live.id))).toBe(false);
    expect(readArchivedConnections(gone.id)).toEqual(CONNECTIONS);
  });

  it("removes a directory that has no index entry (a crash before the entry was written)", () => {
    const mia = user("Mia");
    const orphan = dirOf("u-orphan");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "secrets.json"), "[]");
    archiveRemovedMember(removed(mia), CONNECTIONS);
    reconcileRemovedMembers([]);
    expect(existsSync(orphan)).toBe(false);
    expect(readdirSync(DIR)).toEqual([mia.id]);
    expect(getRemovedMember(mia.id)).not.toBeNull();
  });

  it("a fresh office with no archive reconciles and purges to nothing", () => {
    reconcileRemovedMembers([]);
    expect(purgeExpiredRemovedMembers(Date.now())).toEqual([]);
    expect(listRemovedMembers()).toEqual([]);
  });
});
