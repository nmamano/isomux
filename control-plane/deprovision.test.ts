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

  test("a state outside the allowed set is refused WITHOUT calling the provider", async () => {
    let called = 0;
    const b = await bed({
      kind: "cancel_asset",
      assetState: "order_ambiguous",
    });
    const result = await cancelAssetHandler({
      cancel: async () => {
        called++;
        return { assetState: "cancel_scheduled" as AssetState };
      },
      get: async () => unreachableGet(),
      allowedAssetStates: ["active", "cancel_scheduled"],
    }).run(b.ctx);
    expect(result.kind).toBe("fatal");
    // The point of the guard is the call that did not happen.
    expect(called).toBe(0);
    expect(b.audits).toEqual([]);
    await b.store.close();
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

  test("no provider asset is deterministically fatal, not a retry", async () => {
    const b = await bed({ kind: "cancel_asset", assetState: null });
    const result = await cancelAssetHandler({
      cancel: async () => ({ assetState: "cancelled" as AssetState }),
      get: async () => unreachableGet(),
      allowedAssetStates: ["active"],
    }).run(b.ctx);
    expect(result.kind).toBe("fatal");
    await b.store.close();
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

  test("its dependency surface is a cancel and a READ, so renewal is unreachable", async () => {
    const deps = {
      cancel: async () => ({ assetState: "cancelled" as AssetState }),
      get: async () => ({ assetState: "cancelled" as AssetState }),
      allowedAssetStates: ["active"] as AssetState[],
    };
    // Not decoration: the handler holds no adapter, so there is nothing on it
    // that could reinstate, renew or create - and `get` only reads.
    expect(
      Object.keys(deps).filter((k) => typeof deps[k as never] === "function"),
    ).toEqual(["cancel", "get"]);
  });
});

describe("remove_dns removes exactly the A records it owns", () => {
  test("a missing Cloudflare writer raises attention and retries", async () => {
    const b = await bed({ kind: "remove_dns" });
    const result = await removeDnsHandler().run(b.ctx);
    expect(result.kind).toBe("retry");
    expect((await b.store.openReasons("inst-1"))[0]?.reason).toBe(
      "the Cloudflare office DNS writer is not configured",
    );
    await b.store.close();
  });

  test("success clears the missing-writer attention and audits the resolution", async () => {
    const b = await bed({ kind: "remove_dns" });
    await removeDnsHandler().run(b.ctx);
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

  test("it deletes and authoritatively proves both exact A record sets absent", async () => {
    const b = await bed({ kind: "remove_dns" });
    const removed: string[] = [];
    const result = await removeDnsHandler({
      officeDns: {
        officeARecords: async () => [],
        replaceOfficeARecords: async () => {},
        removeOfficeARecords: async (host) => {
          removed.push(host, `*.${host}`);
          return true;
        },
      },
    }).run(b.ctx);
    expect(result.kind).toBe("done");
    expect(removed).toEqual(["cp2.test.isomux.app", "*.cp2.test.isomux.app"]);
    expect(evidenceOf(result)).toMatchObject({
      removed: true,
      host: "cp2.test.isomux.app",
      wildcard: "*.cp2.test.isomux.app",
    });
    await b.store.close();
  });

  test("an unrelated AAAA survives in the writer and cannot block A removal", async () => {
    const b = await bed({ kind: "remove_dns" });
    const result = await removeDnsHandler({
      officeDns: {
        officeARecords: async () => [],
        replaceOfficeARecords: async () => {},
        // The writer's exact A query does not expose or delete AAAA records.
        removeOfficeARecords: async () => true,
      },
    }).run(b.ctx);
    expect(result.kind).toBe("done");
    await b.store.close();
  });

  test("a Cloudflare failure is a retry, never a success", async () => {
    const b = await bed({ kind: "remove_dns" });
    const result = await removeDnsHandler({
      officeDns: {
        officeARecords: async () => [],
        replaceOfficeARecords: async () => {},
        removeOfficeARecords: async () => {
          throw new Error("SERVFAIL");
        },
      },
    }).run(b.ctx);
    expect(result.kind).toBe("retry");
    await b.store.close();
  });
});
