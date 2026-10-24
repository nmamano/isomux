// The end of life: the money call, and the record that has to actually be gone.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cancelAssetHandler, removeDnsHandler } from "./deprovision.ts";
import { LIFECYCLE_REASON } from "./lifecycle.ts";
import type { AssetState } from "./provider.ts";
import { Store, type AssetRow } from "./store.ts";
import {
  openTestStore,
  PG_TEST_HOOK_TIMEOUT_MS,
  releaseTestStores,
} from "./testing/pg.ts";
import { RemoteBudget, type HandlerContext } from "./tick.ts";

const temps: string[] = [];
afterEach(async () => {
  await releaseTestStores();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, PG_TEST_HOOK_TIMEOUT_MS);

interface Bed {
  ctx: HandlerContext;
  store: Store;
  audits: string[];
  lines: string[];
}

async function bed(opts: {
  kind: "cancel_asset" | "remove_dns";
  assetState?: AssetState | null;
  ipv4?: string | null;
}): Promise<Bed> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-deprov-"));
  temps.push(dir);
  const store = await openTestStore();
  const instance = await store.createInstance({
    id: "inst-1",
    run_id: null,
    name: "cp2.test.isomux.app",
    plan: "V153",
    region: "EU",
    service_state: "suspended",
    goal: "live",
    access_window_expires_at: null,
  });
  let asset: AssetRow | null = null;
  if (opts.assetState !== null) {
    asset = await store.createAsset({
      id: "asset-1",
      instance_id: "inst-1",
      provider: "contabo",
      provider_id: "203474835",
      intent_id: null,
      asset_state: opts.assetState ?? "active",
      ipv4: opts.ipv4 === undefined ? "169.58.97.2" : opts.ipv4,
      service_ends_at: null,
      host_key_fingerprint: null,
      next_reconcile_at: 0,
    });
  }
  const op = await store.enqueue({
    id: `op-${opts.kind}-cancel-sub_1-1`,
    instance_id: "inst-1",
    kind: opts.kind,
    inactivity_deadline_at: 0,
    absolute_deadline_at: 0,
    evidence: { reason: LIFECYCLE_REASON, subscription: "sub_1" },
  });
  const audits: string[] = [];
  const lines: string[] = [];
  return {
    store,
    audits,
    lines,
    ctx: {
      store,
      op,
      instance,
      asset,
      fence: { id: op.id, version: op.version, holder: "h" },
      budget: new RemoteBudget(Date.now() + 60_000, Date.now() + 300_000, () =>
        Date.now(),
      ),
      now: Date.now(),
      report: (l) => lines.push(l),
      audit: (action, outcome, detail) => {
        audits.push(`${action}:${outcome}${detail ? `:${detail}` : ""}`);
        return Promise.resolve();
      },
    },
  };
}

function evidenceOf(result: { evidence?: unknown }): Record<string, unknown> {
  return (result.evidence ?? {}) as Record<string, unknown>;
}

/** The reconcile read must not happen on a path where the cancel succeeded. */
function unreachableGet(): never {
  throw new Error("provider get was called on a path that did not need it");
}

describe("cancel_asset", () => {
  test("it cancels from the states the product actually reaches", async () => {
    for (const state of ["active", "cancel_scheduled"] as AssetState[]) {
      const asked: string[] = [];
      const b = await bed({ kind: "cancel_asset", assetState: state });
      const result = await cancelAssetHandler({
        cancel: async (id) => {
          asked.push(id);
          return {
            assetState: "cancel_scheduled",
            serviceEndsAt: "2026-08-29",
          };
        },
        get: async () => unreachableGet(),
        allowedAssetStates: ["active", "cancel_scheduled"],
      }).run(b.ctx);
      expect(result.kind).toBe("done");
      expect(asked).toEqual(["203474835"]);
      expect(evidenceOf(result).serviceEndsAt).toBe("2026-08-29");
      // The stamp the opener wrote survives the completion, so the row can still
      // be told apart from a dunning one.
      expect(evidenceOf(result).reason).toBe(LIFECYCLE_REASON);
      // And the proven end date is adopted immediately - it is the only
      // deletion date that exists.
      expect((await b.store.getAsset("asset-1"))!.service_ends_at).toBe(
        "2026-08-29",
      );
      await b.store.close();
    }
  });

  // A state outside the allowed set, or no provider asset at all, is fatal
  // (never a retry), and the point of the guard is the call that did not
  // happen.
  test("a state outside the allowed set, or no asset, is refused WITHOUT calling the provider", async () => {
    for (const assetState of ["order_ambiguous", null] as const) {
      let called = 0;
      const b = await bed({ kind: "cancel_asset", assetState });
      const result = await cancelAssetHandler({
        cancel: async () => {
          called++;
          return { assetState: "cancel_scheduled" as AssetState };
        },
        get: async () => unreachableGet(),
        allowedAssetStates: ["active", "cancel_scheduled"],
      }).run(b.ctx);
      expect(result.kind).toBe("fatal");
      expect(called).toBe(0);
      expect(b.audits).toEqual([]);
      await b.store.close();
    }
  });

  test("an asset the provider already ended is DONE, and is not called again", async () => {
    for (const state of ["cancelled", "absent"] as AssetState[]) {
      let called = 0;
      const b = await bed({ kind: "cancel_asset", assetState: state });
      const result = await cancelAssetHandler({
        cancel: async () => {
          called++;
          return { assetState: "cancelled" as AssetState };
        },
        get: async () => unreachableGet(),
        allowedAssetStates: ["active", "cancel_scheduled"],
      }).run(b.ctx);
      expect(result.kind).toBe("done");
      expect(evidenceOf(result).alreadyGone).toBe(true);
      expect(called).toBe(0);
      await b.store.close();
    }
  });

  test("a throw is audited ambiguous and rethrown for the ticker to classify", async () => {
    const b = await bed({ kind: "cancel_asset", assetState: "active" });
    const handler = cancelAssetHandler({
      cancel: async () => {
        throw new Error("connection reset");
      },
      // Provider truth says the box is still live, so the refusal is a real
      // failure and must not be reconciled away.
      get: async () => ({ assetState: "active" as AssetState }),
      allowedAssetStates: ["active"],
    });
    expect(handler.run(b.ctx)).rejects.toThrow("connection reset");
    expect(b.audits.some((a) => a.startsWith("cancel_asset:ambiguous"))).toBe(
      true,
    );
    // A killed cancellation proves nothing about whether it landed.
    expect(handler.timeoutIsRetryable).toBe(false);
    await b.store.close();
  });

  test("a REFUSED cancel reconciles against provider truth instead of retrying forever", async () => {
    // MEASURED 2026-08-10 against 203474835: Contabo answers a second cancel
    // with HTTP 422 and changes nothing. Without this arm, a crash between an
    // accepted cancel and our write would leave the operation retrying into a
    // permanent 422. The live probe is what found it.
    const b = await bed({ kind: "cancel_asset", assetState: "active" });
    const result = await cancelAssetHandler({
      cancel: async () => {
        throw new Error(
          "POST /v1/compute/instances/203474835/cancel: provider returned HTTP 422",
        );
      },
      get: async () => ({
        assetState: "cancel_scheduled" as AssetState,
        serviceEndsAt: "2026-08-29",
      }),
      allowedAssetStates: ["active", "cancel_scheduled"],
    }).run(b.ctx);
    expect(result.kind).toBe("done");
    expect(evidenceOf(result).adoptedAfterRefusal).toBe(true);
    expect((await b.store.getAsset("asset-1"))!.service_ends_at).toBe(
      "2026-08-29",
    );
    // Both are recorded: the call was refused AND the end state is right.
    expect(b.audits.some((a) => a.startsWith("cancel_asset:ambiguous"))).toBe(
      true,
    );
    expect(b.audits.some((a) => a.includes("was already"))).toBe(true);
    await b.store.close();
  });
});

describe("remove_dns removes exactly the A records it owns", () => {
  test("a hung Cloudflare call ends at the remote budget and retries", async () => {
    const b = await bed({ kind: "remove_dns" });
    const begin = Date.now();
    const marker = "no signal ended this call";
    const result = await removeDnsHandler({
      officeDns: {
        officeARecords: async () => [],
        replaceOfficeARecords: async () => {},
        removeOfficeARecords: (_host, signal) =>
          new Promise<boolean>((_resolve, reject) => {
            const late = setTimeout(() => reject(new Error(marker)), 1500);
            signal?.addEventListener("abort", () => {
              clearTimeout(late);
              reject(new Error("socket reset"));
            });
          }),
      },
    }).run({
      ...b.ctx,
      budget: new RemoteBudget(begin + 150, begin + 300_000, () => Date.now()),
    });
    expect(result.kind).toBe("retry");
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(Date.now() - begin).toBeLessThan(1000);
    await b.store.close();
  });

  test("success clears the missing-writer attention and audits the resolution", async () => {
    const b = await bed({ kind: "remove_dns" });
    // A missing writer raises attention and retries instead of doing nothing.
    expect((await removeDnsHandler().run(b.ctx)).kind).toBe("retry");
    expect(await b.store.openReasons("inst-1")).toHaveLength(1);
    const result = await removeDnsHandler({
      officeDns: {
        officeARecords: async () => [],
        replaceOfficeARecords: async () => {},
        removeOfficeARecords: async () => true,
      },
    }).run(b.ctx);
    expect(result.kind).toBe("done");
    expect(await b.store.openReasons("inst-1")).toHaveLength(0);
    expect(
      (await b.store.auditEvents()).some(
        (event) => event.action === "clear_attention",
      ),
    ).toBe(true);
    await b.store.close();
  });

  // Which records the writer deletes, and its authoritative re-list, are
  // cloudflare-dns.test.ts's. Here: the handler asks for THIS office, and only
  // a proven removal is done.
  test.each([
    ["proven absent", async (): Promise<boolean> => true, "done"],
    ["still listed", async (): Promise<boolean> => false, "retry"],
    [
      "a Cloudflare failure",
      async (): Promise<boolean> => {
        throw new Error("SERVFAIL");
      },
      "retry",
    ],
  ] as const)("%s", async (_name, remove, kind) => {
    const b = await bed({ kind: "remove_dns" });
    const hosts: string[] = [];
    const result = await removeDnsHandler({
      officeDns: {
        officeARecords: async () => [],
        replaceOfficeARecords: async () => {},
        removeOfficeARecords: async (host) => {
          hosts.push(host);
          return await remove();
        },
      },
    }).run(b.ctx);
    expect(hosts).toEqual(["cp2.test.isomux.app"]);
    expect(result.kind).toBe(kind);
    if (kind === "done")
      expect(evidenceOf(result)).toMatchObject({
        removed: true,
        host: "cp2.test.isomux.app",
      });
    await b.store.close();
  });
});
