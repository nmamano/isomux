// The customer-key retention deadline is independent of whether provisioning
// reached a box. A failed create still leaves signup data in the instance row,
// so every raw key is cleared when its one immutable ceiling passes.

import type { InstanceRow, Store } from "./store.ts";

export const ACCESS_RETENTION_SWEEP_ACTOR = "access-retention-sweep";

type ClearResult = "cleared" | "contended" | "no-longer-due";

function isPastRetention(instance: InstanceRow, now: number): boolean {
  return (
    instance.customer_ssh_key !== null &&
    instance.access_window_expires_at !== null &&
    instance.access_window_expires_at <= now
  );
}

async function clearCustomerKeyIn(
  store: Store,
  candidate: InstanceRow,
  now: number,
): Promise<ClearResult> {
  if (!store.inTransaction()) {
    throw new Error("clearCustomerKeyIn must run inside a transaction");
  }
  let current = await store.getInstance(candidate.id);
  if (!current || !isPastRetention(current, now)) return "no-longer-due";

  let cleared = await store.casInstance(current.id, current.version, {
    customer_ssh_key: null,
  });
  if (!cleared) {
    current = await store.getInstance(candidate.id);
    if (!current || !isPastRetention(current, now)) return "no-longer-due";
    cleared = await store.casInstance(current.id, current.version, {
      customer_ssh_key: null,
    });
  }
  if (!cleared) return "contended";

  await store.appendAudit({
    actor: ACCESS_RETENTION_SWEEP_ACTOR,
    instance_id: candidate.id,
    action: "clear_customer_ssh_key",
    target: candidate.id,
    outcome: "succeeded",
    detail: "access-window retention ceiling passed",
  });
  return "cleared";
}

export async function sweepCustomerKeyRetention(
  store: Store,
  report: (line: string) => void = () => {},
): Promise<number> {
  const now = store.now();
  const candidates = await store.customerKeysPastRetention(now);
  let cleared = 0;
  for (const candidate of candidates) {
    const result = await store.tx(() =>
      clearCustomerKeyIn(store, candidate, now),
    );
    if (result === "cleared") cleared++;
    if (result === "contended") {
      report(
        `${candidate.id}: customer key row moved twice; retention clear will retry`,
      );
    }
  }
  return cleared;
}
