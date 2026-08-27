// A signup that never opened any operation has no repair path of its own. Turn
// that silent state into durable operator attention after three times the
// measured end-to-end provisioning duration.

import { clearAttentionIn, raiseAttentionIn } from "./attention.ts";
import type { Store } from "./store.ts";

export const PROVISIONING_STALL_MS = 30 * 60_000;
export const PROVISIONING_STALL_REASON =
  "Provisioning did not start within 30 minutes, and no operation was enqueued.";
const ACTOR = "provisioning-stall";

interface Candidate {
  id: string;
  reason_id: string | null;
}

/** Raise or clear the one condition, selecting every candidate in one query. */
export async function sweepProvisioningStalls(store: Store): Promise<number> {
  const cutoff = store.now() - PROVISIONING_STALL_MS;
  const candidates = await store.sqlAll<Candidate>(
    "select i.id, r.id as reason_id from instances i " +
      "left join attention_reasons r on r.instance_id = i.id and r.cleared_at is null " +
      "and r.source_op_id = '' and r.reason = $1 where " +
      "(i.service_state = 'provisioning' and i.created_at <= $2 " +
      "and not exists (select 1 from operations o where o.instance_id = i.id)) " +
      "or r.id is not null order by i.created_at",
    [PROVISIONING_STALL_REASON, cutoff],
  );
  let changed = 0;
  for (const candidate of candidates) {
    changed += await store.tx(async () => {
      const instance = await store.getInstance(candidate.id);
      if (!instance) return 0;
      const hasOperation =
        (
          await store.sqlGet<{ present: number }>(
            "select case when exists (select 1 from operations where instance_id = $1) " +
              "then 1 else 0 end as present",
            [instance.id],
          )
        )?.present === 1;
      const active =
        instance.service_state === "provisioning" &&
        instance.created_at <= cutoff &&
        !hasOperation;
      const open = (await store.openReasons(instance.id)).find(
        (reason) =>
          reason.source_op_id === "" &&
          reason.reason === PROVISIONING_STALL_REASON,
      );
      if (active) {
        return (await raiseAttentionIn(store, {
          instanceId: instance.id,
          reasonClass: "operation_condition",
          reason: PROVISIONING_STALL_REASON,
          severity: "critical",
          actor: ACTOR,
        }))
          ? 1
          : 0;
      }
      if (!open) return 0;
      await clearAttentionIn(store, instance.id, open.id, ACTOR);
      return 1;
    });
  }
  return changed;
}
