import { afterEach, describe, expect, test } from "bun:test";
import {
  CERTIFICATE_CONTACT_CLAIM_MS,
  CERTIFICATE_CONTACT_INTERVAL_MS,
  watchCertificateContact,
} from "./certificate-contact-watch.ts";
import { driveTicks } from "./drive-loop.ts";
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
          if (id === "inst-b") throw new Error("scripted failure");
        },
      }),
    ).toBe(3);

    expect(visited).toEqual(["inst-a", "inst-b", "inst-c"]);
    expect(reports).toEqual([
      "certificate-contact check failed for inst-b: scripted failure",
    ]);
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

  test("a live office added between passes joins the next daily pass", async () => {
    const now = { value: 2_000_000 };
    const store = await openTestStore(() => now.value);
    await live(store, "inst-first");
    await watchCertificateContact(store, {
      holder: "watch-a",
      apply: async () => {},
    });
    await live(store, "inst-later");
    const visited: string[] = [];
    await watchCertificateContact(store, {
      holder: "watch-a",
      apply: async (_store, id) => visited.push(id),
    });
    expect(visited).toEqual(["inst-later"]);
  });

  test("a live claim pushes nextDueAt forward and the idle loop does not spin", async () => {
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

    const sleeps: number[] = [];
    let stop = false;
    await driveTicks(
      store,
      {
        once: async () => ({
          leased: 0,
          acted: 0,
          completed: 0,
          flagged: 0,
          live: 1,
        }),
      },
      {
        forever: true,
        reporter: { line: () => {}, problem: () => {} },
        capabilities,
        watch: async () => {},
        now: () => now.value,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 2) stop = true;
        },
        shouldStop: () => stop,
      },
    );
    expect(sleeps).toEqual([5_000, 60_000]);
  });
});
