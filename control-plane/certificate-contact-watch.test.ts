import { afterEach, describe, expect, test } from "bun:test";
import {
  CERTIFICATE_CONTACT_CLAIM_MS,
  CERTIFICATE_CONTACT_INTERVAL_MS,
  watchCertificateContact,
} from "./certificate-contact-watch.ts";
import { raiseAttention } from "./attention.ts";
import {
  CERTIFICATE_CONTACT_REASON,
  CERTIFICATE_CREDENTIAL_MISSING_REASON,
} from "./certificate-credentials.ts";
import type { Store } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";

afterEach(releaseTestStores, PG_TEST_HOOK_TIMEOUT_MS);

async function live(
  store: Store,
  id: string,
  serviceState: "live" | "suspended" | "deprovisioned" = "live",
): Promise<void> {
  await store.createInstance({
    id,
    run_id: null,
    name: `${id}.test.isomux.app`,
    plan: "V153",
    region: "EU",
    service_state: serviceState,
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

  test("clears the missing-credential row of an office that is no longer live, and nothing else", async () => {
    const now = { value: 5_000_000 };
    const store = await openTestStore(() => now.value);
    await live(store, "inst-suspended", "suspended");
    await live(store, "inst-deprovisioned", "deprovisioned");
    await live(store, "inst-live");
    for (const instanceId of [
      "inst-suspended",
      "inst-deprovisioned",
      "inst-live",
    ]) {
      for (const reason of [
        CERTIFICATE_CREDENTIAL_MISSING_REASON,
        CERTIFICATE_CONTACT_REASON,
      ]) {
        await raiseAttention(store, {
          instanceId,
          sourceOpId: "",
          reasonClass: "operation_condition",
          reason,
          severity: "critical",
          actor: "certificate-renewal-watch",
        });
      }
    }
    const open = async (id: string) =>
      (await store.openReasons(id)).map((row) => row.reason).sort();
    const both = [
      CERTIFICATE_CREDENTIAL_MISSING_REASON,
      CERTIFICATE_CONTACT_REASON,
    ].sort();
    for (const id of ["inst-suspended", "inst-deprovisioned", "inst-live"]) {
      expect({ id, open: await open(id) }).toEqual({ id, open: both });
    }
    const applied: string[] = [];
    const reports: string[] = [];

    await watchCertificateContact(store, {
      holder: "watch-a",
      report: (line) => reports.push(line),
      // The live office's own check is apply's job, tested on its own.
      apply: async (_store, id) => {
        applied.push(id);
      },
    });

    expect(applied).toEqual(["inst-live"]);
    expect(reports).toEqual([]);
    for (const id of ["inst-suspended", "inst-deprovisioned"]) {
      expect({ id, open: await open(id) }).toEqual({
        id,
        open: [CERTIFICATE_CONTACT_REASON],
      });
    }
    expect(await open("inst-live")).toEqual(both);
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
