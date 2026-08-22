import { afterEach, describe, expect, test } from "bun:test";
import {
  ACCESS_RETENTION_SWEEP_ACTOR,
  sweepCustomerKeyRetention,
} from "./access-retention.ts";
import type { Store } from "./store.ts";
import { openTestStore, releaseTestStores } from "./testing/pg.ts";

afterEach(releaseTestStores);

const RAW_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIcustomer";

async function instance(
  store: Store,
  id: string,
  expiresAt: number | null,
  fingerprint: string | null = "SHA256:installed",
) {
  return store.createInstance({
    id,
    run_id: null,
    name: `${id}.test.isomux.app`,
    plan: "V153",
    region: "EU",
    service_state: "provisioning",
    goal: "live",
    access_window_expires_at: expiresAt,
    customer_ssh_key: RAW_KEY,
    customer_ssh_key_fingerprint: fingerprint,
  });
}

describe("customer SSH key retention sweep", () => {
  test("clears only the raw key after the immutable ceiling and records the deletion", async () => {
    const now = 1_700_000_000_000;
    const store = await openTestStore(() => now);
    await instance(store, "inst-expired", now - 1);

    expect(await sweepCustomerKeyRetention(store)).toBe(1);

    const after = await store.getInstance("inst-expired");
    expect(after?.customer_ssh_key).toBeNull();
    expect(after?.customer_ssh_key_fingerprint).toBe("SHA256:installed");
    expect(await store.auditEvents()).toContainEqual(
      expect.objectContaining({
        actor: ACCESS_RETENTION_SWEEP_ACTOR,
        instance_id: "inst-expired",
        action: "clear_customer_ssh_key",
        target: "inst-expired",
        outcome: "succeeded",
        detail: "access-window retention ceiling passed",
      }),
    );
  });

  test("uses the ceiling alone and never invents a missing fingerprint", async () => {
    const now = 1_700_000_000_000;
    const store = await openTestStore(() => now);
    await instance(store, "inst-no-contact", now, null);
    await instance(store, "inst-not-due", now + 1);
    await instance(store, "inst-no-ceiling", null);

    expect(await sweepCustomerKeyRetention(store)).toBe(1);
    expect(
      (await store.getInstance("inst-no-contact"))?.customer_ssh_key,
    ).toBeNull();
    expect(
      (await store.getInstance("inst-no-contact"))
        ?.customer_ssh_key_fingerprint,
    ).toBeNull();
    expect((await store.getInstance("inst-not-due"))?.customer_ssh_key).toBe(
      RAW_KEY,
    );
    expect((await store.getInstance("inst-no-ceiling"))?.customer_ssh_key).toBe(
      RAW_KEY,
    );
  });

  test("reports contention, continues the pass, and retries on the next cadence", async () => {
    const now = 1_700_000_000_000;
    const store = await openTestStore(() => now);
    await instance(store, "inst-contended", now - 2);
    await instance(store, "inst-other", now - 1);
    const realCas = store.casInstance.bind(store);
    store.casInstance = async (id, ...args) =>
      id === "inst-contended" ? null : realCas(id, ...args);
    const reports: string[] = [];

    expect(
      await sweepCustomerKeyRetention(store, (line) => reports.push(line)),
    ).toBe(1);
    expect((await store.getInstance("inst-contended"))?.customer_ssh_key).toBe(
      RAW_KEY,
    );
    expect(
      (await store.getInstance("inst-other"))?.customer_ssh_key,
    ).toBeNull();
    expect(reports).toEqual([
      "inst-contended: customer key row moved twice; retention clear will retry",
    ]);

    store.casInstance = realCas;
    expect(await sweepCustomerKeyRetention(store)).toBe(1);
    expect(
      (await store.getInstance("inst-contended"))?.customer_ssh_key,
    ).toBeNull();
  });
});
