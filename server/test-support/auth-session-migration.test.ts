// Auth core - the sessions.json username -> userId migration
// (tasks 5676b6cb / 530680ae).
//
// Sessions used to be keyed to a display NAME; they are now keyed to the stable
// user id, so a rename flows through to in-flight sessions instead of orphaning
// them. The loader migrates the old shape on read. migrations.test.ts covers the
// users.json half (legacy records getting fresh ids); this file covers the
// sessions half, which had no automated coverage.
//
// The seam is a REAL cold reload: the harness's restart() re-runs the boot path
// against the on-disk state without wiping it, and auth's module caches drop
// back to their not-yet-loaded sentinel so invites.json / sessions.json are
// genuinely re-read. So these tests exercise the same code an operator's
// `systemctl restart` would.
//
// What this freezes:
//   - A legacy `username` row resolves to the live user's id (case-insensitively,
//     since getUserByName is) and keeps working with the SAME cookie.
//   - An ORPHANED legacy row - a username with no matching record - is evicted,
//     not migrated to a dangling id.
//   - The migration is written back, so the second boot has nothing to do and
//     the file is byte-identical afterwards (the whole point of the
//     sessionsNeedsPersist flag).
//   - A legacy row with no expiry stamps fails CLOSED rather than being treated
//     as an eternal session.
//   - Modern rows are passed through untouched, and a stale `username` left
//     alongside a `userId` is stripped rather than trusted.

import { describe, it, expect, afterEach } from "bun:test";
import { createHash, randomBytes } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { validateSession, listActiveSessions } from "../auth.ts";
import { getUserByName } from "../users.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const hashOf = (raw: string) => createHash("sha256").update(raw).digest("hex");

interface LegacyRow {
  sessionIdHash: string;
  sessionPrefix: string;
  username?: string;
  userId?: string;
  createdAt?: number;
  lastSeenAt?: number;
  expiresAt?: number;
  absoluteExpiresAt?: number;
  userAgent?: string | null;
}

// Mint a raw session id + the legacy on-disk row that would have represented it
// before the userId migration.
function legacySession(
  username: string,
  overrides: Partial<LegacyRow> = {},
): { rawSessionId: string; row: LegacyRow } {
  const rawSessionId = randomBytes(32).toString("base64url");
  const now = Date.now();
  return {
    rawSessionId,
    row: {
      sessionIdHash: hashOf(rawSessionId),
      sessionPrefix: rawSessionId.slice(0, 8),
      username,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
      absoluteExpiresAt: now + 365 * 24 * 60 * 60 * 1000,
      userAgent: "legacy-ua",
      ...overrides,
    },
  };
}

function sessionsPath(srv: TestServer): string {
  return join(srv.stateRoot, "sessions.json");
}
function readSessions(srv: TestServer): Record<string, LegacyRow> {
  return JSON.parse(readFileSync(sessionsPath(srv), "utf-8"));
}

describe("auth/migration: sessions.json username -> userId", () => {
  it("migrates a legacy row, evicts an orphan, and leaves a modern row alone", async () => {
    let srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    await srv.seedMember("Alice");
    const aliceId = getUserByName("Alice")!.id;

    // Plant three legacy-shaped rows next to the two modern ones the seeds made.
    const alice = legacySession("Alice");
    // Case differs from the record's display name: getUserByName is
    // case-insensitive, so this must resolve rather than be evicted.
    const aliceCased = legacySession("aLiCe");
    const orphan = legacySession("Ghost");

    const onDisk = readSessions(srv);
    const modernOwnerRow = onDisk[hashOf(owner.rawSessionId)];
    expect(modernOwnerRow).toBeTruthy();
    expect(modernOwnerRow.userId).toBeTruthy();

    for (const s of [alice, aliceCased, orphan]) {
      onDisk[s.row.sessionIdHash] = s.row;
    }
    writeFileSync(sessionsPath(srv), JSON.stringify(onDisk, null, 2));

    srv = await srv.restart();
    server = srv;

    // The legacy rows now validate, bound to Alice's stable id.
    const l1 = validateSession(alice.rawSessionId);
    expect(l1).not.toBeNull();
    expect(l1?.userId).toBe(aliceId);
    expect(l1?.username).toBe("Alice"); // display name from the record, not the row

    const l2 = validateSession(aliceCased.rawSessionId);
    expect(l2).not.toBeNull();
    expect(l2?.userId).toBe(aliceId);

    // The orphan is gone - not migrated onto some dangling id.
    expect(validateSession(orphan.rawSessionId)).toBeNull();
    expect(
      listActiveSessions().some(
        (s) => s.sessionPrefix === orphan.row.sessionPrefix,
      ),
    ).toBe(false);

    // The modern row survived the reload untouched.
    expect(validateSession(owner.rawSessionId)?.username).toBe("Boss");

    // The upgraded shape was written back: userId present, username stripped.
    const after = readSessions(srv);
    expect(after[alice.row.sessionIdHash].userId).toBe(aliceId);
    expect(after[alice.row.sessionIdHash]).not.toHaveProperty("username");
    expect(after[orphan.row.sessionIdHash]).toBeUndefined();
  });

  it("is idempotent: the second boot has nothing left to migrate", async () => {
    let srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    await srv.seedMember("Alice");

    const alice = legacySession("Alice");
    const onDisk = readSessions(srv);
    onDisk[alice.row.sessionIdHash] = alice.row;
    writeFileSync(sessionsPath(srv), JSON.stringify(onDisk, null, 2));

    // Boot 1. The load (and so the migration) is LAZY - it fires on the first
    // auth call, not during startup - so touch a session, then snapshot.
    srv = await srv.restart();
    server = srv;
    expect(validateSession(alice.rawSessionId)).not.toBeNull();
    const afterFirstBytes = readFileSync(sessionsPath(srv), "utf-8");
    expect(afterFirstBytes).not.toContain('"username"');

    // Boot 2. Read BEFORE touching auth: the file must already be in the
    // migrated shape, i.e. boot 1's write-back stuck. That is what makes the
    // migration a one-time event rather than something every boot re-derives.
    srv = await srv.restart();
    server = srv;
    expect(readFileSync(sessionsPath(srv), "utf-8")).toBe(afterFirstBytes);
    expect(validateSession(alice.rawSessionId)).not.toBeNull();
  });

  it("a legacy row with no expiry stamps fails closed", async () => {
    let srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    await srv.seedMember("Alice");

    // Pre-migration rows that predate the expiry fields entirely. The loader
    // defaults them to 0, which must read as "long expired", never as
    // "no expiry recorded, therefore eternal".
    const undated = legacySession("Alice", {
      expiresAt: undefined,
      absoluteExpiresAt: undefined,
    });
    delete undated.row.expiresAt;
    delete undated.row.absoluteExpiresAt;

    const onDisk = readSessions(srv);
    onDisk[undated.row.sessionIdHash] = undated.row;
    writeFileSync(sessionsPath(srv), JSON.stringify(onDisk, null, 2));

    srv = await srv.restart();
    server = srv;

    expect(validateSession(undated.rawSessionId)).toBeNull();
    expect(
      listActiveSessions().some(
        (s) => s.sessionPrefix === undated.row.sessionPrefix,
      ),
    ).toBe(false);
  });

  it("a stale username alongside a userId is stripped, not trusted", async () => {
    let srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const aliceId = getUserByName("Alice")!.id;

    // A half-migrated row: correct userId, plus a leftover username naming
    // somebody else. The userId branch must win and the name must be dropped.
    const onDisk = readSessions(srv);
    const key = hashOf(alice.rawSessionId);
    onDisk[key] = { ...onDisk[key], username: "Boss" };
    writeFileSync(sessionsPath(srv), JSON.stringify(onDisk, null, 2));

    srv = await srv.restart();
    server = srv;

    const lookup = validateSession(alice.rawSessionId);
    expect(lookup?.userId).toBe(aliceId);
    expect(lookup?.username).toBe("Alice");
    expect(readSessions(srv)[key]).not.toHaveProperty("username");
  });
});
