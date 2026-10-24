import { afterEach, describe, expect, test } from "bun:test";
import {
  CERTIFICATE_CONTACT_CLAIM_MS,
  CERTIFICATE_CONTACT_INTERVAL_MS,
  watchCertificateContact,
} from "./certificate-contact-watch.ts";
import type { Store } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";

afterEach(releaseTestStores, PG_TEST_HOOK_TIMEOUT_MS);

async function live(store: Store, id: string): Promise<void> {
  await store.createInstance({
    id,
    run_id: null,
    name: `${id}.test.isomux.app`,
    plan: "V153",
    region: "EU",
    service_state: "live",
    goal: "live",
    access_window_expires_at: null,
  });
}

const capabilities = {
  providerConfigured: false,
  provisioningConfigured: false,
  checkoutConfigured: false,
  staleProvisioningMs: 30 * 60_000,
  staleProvisioningReason: "stalled",
};

describe("the daily certificate-contact pass", () => {
  test("one failure does not skip later offices or keep any office due", async () => {
    const now = { value: 1_000_000 };
    const store = await openTestStore(() => now.value);
    for (const id of ["inst-a", "inst-b", "inst-c"]) await live(store, id);
    const visited: string[] = [];
    const reports: string[] = [];

    expect(
      await watchCertificateContact(store, {
        holder: "watch-a",
        report: (line) => reports.push(line),
        apply: async (_store, id) => {
          visited.push(id);
          // Fail first in whichever order PostgreSQL returns equal timestamps.
          if (visited.length === 1) throw new Error("scripted failure");
        },
      }),
    ).toBe(3);

    expect(visited).toHaveLength(3);
    expect([...visited].sort()).toEqual(["inst-a", "inst-b", "inst-c"]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(visited[0]);
    expect(reports[0]).toContain("scripted failure");
    for (const id of visited) {
      expect(
        (await store.getInstance(id))?.certificate_contact_next_check_at,
      ).toBe(now.value + CERTIFICATE_CONTACT_INTERVAL_MS);
    }
    expect(
      await watchCertificateContact(store, {
        holder: "watch-a",
        apply: async () => {
          throw new Error("not due");
        },
      }),
    ).toBe(0);
  });

  test("a live claim is not due, and parks nextDueAt at its end", async () => {
    const now = { value: 3_000_000 };
    const store = await openTestStore(() => now.value);
    await live(store, "inst-claimed");
    await store.ensureLiveness("inst-claimed", now.value);
    const liveness = await store.claimLiveness(
      "inst-claimed",
      "liveness-a",
      now.value + CERTIFICATE_CONTACT_CLAIM_MS,
      now.value,
    );
    await store.recordLiveness(
      "inst-claimed",
      liveness!.version,
      "liveness-a",
      {
        rung: "ok",
        strikes: 0,
        checkedAt: now.value,
        nextAt: now.value + CERTIFICATE_CONTACT_INTERVAL_MS,
      },
    );
    const claimUntil = now.value + CERTIFICATE_CONTACT_CLAIM_MS;
    expect(
      await store.claimCertificateContactCheck(
        "inst-claimed",
        "certificate-a",
        claimUntil,
        now.value,
      ),
    ).not.toBeNull();

    const schedule = await store.workSchedule(now.value, 1, 1, {
      ...capabilities,
      cadenceConfigured: false,
      livenessConfigured: true,
    });
    expect(schedule.livenessDue).toBe(false);
    expect(schedule.nextDueAt).toBe(claimUntil);
  });
});
