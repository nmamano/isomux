import { afterEach, describe, expect, test } from "bun:test";
import {
  BACKUP_MAX_AGE_MS,
  watchHostedBackups,
  PROVIDER_SNAPSHOT_MISSING_REASON,
  PROVIDER_SNAPSHOT_STALE_REASON,
  PROVIDER_SNAPSHOT_UNREADABLE_REASON,
} from "./backup-watch.ts";
import { openTestStore, releaseTestStores } from "./testing/pg.ts";

afterEach(async () => {
  await releaseTestStores();
});

async function bed(age = 0) {
  const now = { value: Date.UTC(2026, 7, 13, 12) };
  const store = await openTestStore(() => now.value);
  await store.createInstance({
    id: "inst-1",
    run_id: null,
    name: "cp1.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "live",
    access_window_expires_at: now.value + 1_000_000,
  });
  if (age > 0) {
    await store.sqlRun("update instances set created_at = $1 where id = $2", [
      now.value - age,
      "inst-1",
    ]);
  }
  await store.createAsset({
    id: "asset-1",
    instance_id: "inst-1",
    provider: "contabo",
    provider_id: "203474835",
    intent_id: null,
    asset_state: "active",
    ipv4: "169.58.97.2",
    service_ends_at: null,
    host_key_fingerprint: null,
    next_reconcile_at: now.value,
  });
  return { store, now };
}

async function backupReasons(store: Awaited<ReturnType<typeof openTestStore>>) {
  return (await store.openReasons("inst-1")).map((row) => ({
    reason: row.reason,
    severity: row.severity,
  }));
}

describe("hosted backup evidence", () => {
  test("a request with no first snapshot stays pending during the grace", async () => {
    const b = await bed();
    await watchHostedBackups(b.store, {
      snapshots: async () => ({ newestSnapshotAt: null, snapshotCount: 0 }),
    });
    expect(await backupReasons(b.store)).toEqual([]);
  });

  test("no snapshot after the first-backup window raises critical attention", async () => {
    const b = await bed(BACKUP_MAX_AGE_MS + 1);
    await watchHostedBackups(b.store, {
      snapshots: async () => ({ newestSnapshotAt: null, snapshotCount: 0 }),
    });
    expect(await backupReasons(b.store)).toEqual([
      { reason: PROVIDER_SNAPSHOT_MISSING_REASON, severity: "critical" },
    ]);
  });

  test("a stale snapshot raises critical attention", async () => {
    const b = await bed();
    await watchHostedBackups(b.store, {
      snapshots: async () => ({
        newestSnapshotAt: b.now.value - BACKUP_MAX_AGE_MS - 1,
        snapshotCount: 7,
      }),
    });
    expect(await backupReasons(b.store)).toEqual([
      { reason: PROVIDER_SNAPSHOT_STALE_REASON, severity: "critical" },
    ]);
  });

  test("unreadable provider evidence raises warning attention", async () => {
    const b = await bed();
    await watchHostedBackups(b.store, {
      snapshots: async () => {
        throw new Error("provider unavailable");
      },
    });
    expect(await backupReasons(b.store)).toEqual([
      { reason: PROVIDER_SNAPSHOT_UNREADABLE_REASON, severity: "warning" },
    ]);
  });

  test("fresh verified evidence clears an earlier backup reason", async () => {
    const b = await bed(BACKUP_MAX_AGE_MS + 1);
    await watchHostedBackups(b.store, {
      snapshots: async () => ({ newestSnapshotAt: null, snapshotCount: 0 }),
    });
    await watchHostedBackups(b.store, {
      snapshots: async () => ({
        newestSnapshotAt: b.now.value - 60_000,
        snapshotCount: 1,
      }),
    });
    expect(await backupReasons(b.store)).toEqual([]);
  });

  test("add-on request and snapshot evidence stay separate", async () => {
    const b = await bed(BACKUP_MAX_AGE_MS + 1);
    let reads = 0;
    await watchHostedBackups(b.store, {
      snapshots: async () => {
        reads++;
        return { newestSnapshotAt: null, snapshotCount: 0 };
      },
    });
    expect(reads).toBe(1);
    expect((await backupReasons(b.store))[0]?.reason).toBe(
      PROVIDER_SNAPSHOT_MISSING_REASON,
    );
  });
});
