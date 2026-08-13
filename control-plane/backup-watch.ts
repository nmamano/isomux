// Monitor hosted provider snapshot evidence.
//
// The create request asks Contabo for its Automated Backup add-on. That request
// is not evidence. The snapshot endpoint does not distinguish manual snapshots
// from add-on backups, so this watch claims snapshot presence only. It raises
// durable operator attention when snapshot evidence is absent, stale, or
// unreadable. Restore remains a manual operator action.

import { clearAttentionIn, raiseAttentionIn } from "./attention.ts";
import type { ProviderSnapshotEvidence } from "./provider.ts";
import type { Store } from "./store.ts";

export const BACKUP_MAX_AGE_MS = 26 * 60 * 60 * 1000;
export const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const PROVIDER_SNAPSHOT_MISSING_REASON =
  "the hosted office has no recent provider snapshot";
export const PROVIDER_SNAPSHOT_STALE_REASON =
  "the hosted office provider snapshot is more than 26 hours old";
export const PROVIDER_SNAPSHOT_UNREADABLE_REASON =
  "provider snapshot evidence could not be read";

const BACKUP_REASONS = new Set([
  PROVIDER_SNAPSHOT_MISSING_REASON,
  PROVIDER_SNAPSHOT_STALE_REASON,
  PROVIDER_SNAPSHOT_UNREADABLE_REASON,
]);

export interface BackupWatchDeps {
  snapshots(providerId: string): Promise<ProviderSnapshotEvidence>;
  report?: (line: string) => void;
}

export async function watchHostedBackups(
  store: Store,
  deps: BackupWatchDeps,
): Promise<number> {
  let checked = 0;
  for (const instance of await store.listInstances()) {
    if (instance.service_state !== "live") continue;
    checked++;
    const asset = await store.assetForInstance(instance.id);
    if (!asset?.provider_id) {
      await replaceBackupAttention(
        store,
        instance.id,
        PROVIDER_SNAPSHOT_UNREADABLE_REASON,
        "warning",
        deps,
      );
      continue;
    }
    try {
      const evidence = await deps.snapshots(asset.provider_id);
      const now = store.now();
      if (evidence.newestSnapshotAt === null) {
        if (now - instance.created_at <= BACKUP_MAX_AGE_MS) {
          await clearBackupAttention(store, instance.id, deps);
          deps.report?.(
            `provider snapshot pending for ${instance.id}: no snapshot row yet`,
          );
        } else {
          await replaceBackupAttention(
            store,
            instance.id,
            PROVIDER_SNAPSHOT_MISSING_REASON,
            "critical",
            deps,
          );
        }
        continue;
      }
      if (now - evidence.newestSnapshotAt > BACKUP_MAX_AGE_MS) {
        await replaceBackupAttention(
          store,
          instance.id,
          PROVIDER_SNAPSHOT_STALE_REASON,
          "critical",
          deps,
          `newest provider snapshot observed ${new Date(evidence.newestSnapshotAt).toISOString()}`,
        );
        continue;
      }
      await clearBackupAttention(store, instance.id, deps);
      deps.report?.(
        `provider snapshot observed for ${instance.id}: ${new Date(evidence.newestSnapshotAt).toISOString()}; add-on health is not directly observed`,
      );
    } catch (err) {
      await replaceBackupAttention(
        store,
        instance.id,
        PROVIDER_SNAPSHOT_UNREADABLE_REASON,
        "warning",
        deps,
      );
      deps.report?.(
        `provider snapshot check failed for ${instance.id}: ${messageOf(err)}`,
      );
    }
  }
  return checked;
}

async function replaceBackupAttention(
  store: Store,
  instanceId: string,
  reason: string,
  severity: "warning" | "critical",
  deps: BackupWatchDeps,
  detail?: string,
): Promise<void> {
  const open = (await store.openReasons(instanceId)).filter(
    (row) => row.source_op_id === "" && BACKUP_REASONS.has(row.reason),
  );
  if (open.length === 1 && open[0]?.reason === reason) return;
  await store.tx(async () => {
    for (const row of open) {
      await clearAttentionIn(store, instanceId, row.id);
    }
    await raiseAttentionIn(store, {
      instanceId,
      reasonClass: "operation_condition",
      reason,
      severity,
      detail,
    });
  });
  deps.report?.(`backup attention (${severity}) on ${instanceId}: ${reason}`);
}

async function clearBackupAttention(
  store: Store,
  instanceId: string,
  deps: BackupWatchDeps,
): Promise<void> {
  const open = (await store.openReasons(instanceId)).filter(
    (row) => row.source_op_id === "" && BACKUP_REASONS.has(row.reason),
  );
  if (open.length === 0) return;
  await store.tx(async () => {
    for (const row of open) {
      await clearAttentionIn(store, instanceId, row.id);
    }
  });
  deps.report?.(`backup attention cleared for ${instanceId}`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
