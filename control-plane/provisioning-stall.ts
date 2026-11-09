// A paid office that never opened any operation has no repair path of its own.
// Turn that silent state into durable operator attention after three times the
// measured end-to-end provisioning duration, counted from the payment. An
// unpaid reservation is 'provisioning' too, and never counts.

import { clearAttentionIn, raiseAttentionIn } from "./attention.ts";
import type { Store } from "./store.ts";
import { stalledSql } from "./provisioning-stall-sql.ts";

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
      `${stalledSql("i", "$2")} or r.id is not null order by i.created_at`,
    [PROVISIONING_STALL_REASON, cutoff],
  );
  let changed = 0;
  for (const candidate of candidates) {
    changed += await store.tx(async () => {
      const row = await store.sqlGet<{ stalled: boolean }>(
        `select ${stalledSql("i", "$2")} as stalled from instances i where i.id = $1`,
        [candidate.id, cutoff],
      );
      if (!row) return 0;
      const open = (await store.openReasons(candidate.id)).find(
        (reason) =>
          reason.source_op_id === "" &&
          reason.reason === PROVISIONING_STALL_REASON,
      );
      if (row.stalled) {
        return (await raiseAttentionIn(store, {
          instanceId: candidate.id,
          reasonClass: "operation_condition",
          reason: PROVISIONING_STALL_REASON,
          severity: "critical",
          actor: ACTOR,
        }))
          ? 1
          : 0;
      }
      if (!open) return 0;
      await clearAttentionIn(store, candidate.id, open.id, ACTOR);
      return 1;
    });
  }
  return changed;
}
