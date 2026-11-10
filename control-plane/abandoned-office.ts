// End the office of a never-paid reservation whose Checkout is over
// (task 03eef464). Its name is already free (reservation-hold.ts deadSql), but
// until a new signup takes the name over, the instance stayed 'provisioning'
// for ever. The sweep sets it to 'deprovisioned', as a takeover does, and
// writes one audit row. Its asset never reached a provider (provider_id is
// null), so nothing reconciles it. The reservation row stays: it keeps the
// name history until a takeover rewrites it.

import type { Store } from "./store.ts";
import { abandonedSql, UNPAID_OPENING_HOLD_MS } from "./reservation-hold.ts";

const ACTOR = "checkout-expiry";

export interface AbandonedSweepSummary {
  ended: number;
  failed: number;
}

interface Candidate {
  id: string;
  name: string;
}

interface Locked {
  id: string;
  name: string;
  account_id: string;
  checkout_state: string | null;
}

/** `report` gets one line per failed candidate: its office name and the error. */
export async function sweepAbandonedOffices(
  store: Store,
  report: (line: string) => void = () => {},
): Promise<AbandonedSweepSummary> {
  const cutoff = store.now() - UNPAID_OPENING_HOLD_MS;
  const candidates = await store.sqlAll<Candidate>(
    "select i.id, (select n.name from name_reservations n where n.instance_id = i.id) " +
      `as name from instances i where ${abandonedSql("i", "$1")} order by i.created_at`,
    [cutoff],
  );
  const summary: AbandonedSweepSummary = { ended: 0, failed: 0 };
  for (const candidate of candidates) {
    try {
      if (await endOffice(store, candidate.id, cutoff)) summary.ended++;
    } catch (err) {
      summary.failed++;
      report(
        `${candidate.name}: ending the office failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return summary;
}

/**
 * One office in one transaction. The reservation lock comes first, and the
 * re-check is a SEPARATE statement: under READ COMMITTED it takes a new
 * snapshot after the lock is granted, so it sees a re-arm the web committed
 * while this transaction waited (advanceExpiredOrdinaryCheckout takes the same
 * lock).
 */
async function endOffice(
  store: Store,
  instanceId: string,
  cutoff: number,
): Promise<boolean> {
  return store.tx(async () => {
    const reservation = await store.sqlGet<Locked>(
      "select id, name, account_id, checkout_state from name_reservations " +
        "where instance_id = $1 for update",
      [instanceId],
    );
    if (!reservation) return false;
    const still = await store.sqlGet<{ abandoned: boolean }>(
      `select ${abandonedSql("i", "$2")} as abandoned from instances i where i.id = $1`,
      [instanceId, cutoff],
    );
    if (!still?.abandoned) return false;
    const instance = await store.getInstance(instanceId);
    if (!instance) return false;
    // A lost CAS is another writer's change: skip it, the next pass re-reads.
    const ended = await store.casInstance(instance.id, instance.version, {
      service_state: "deprovisioned",
    });
    if (!ended) return false;
    await store.appendAudit({
      actor: ACTOR,
      instance_id: instanceId,
      action: "abandon_office",
      target: reservation.name,
      outcome: "abandoned",
      detail: JSON.stringify({
        reservation: reservation.id,
        account: reservation.account_id,
        checkout_state: reservation.checkout_state,
      }),
      ts: store.now(),
    });
    return true;
  });
}
