// The model catalog of an OpenCode server: GET /api/model per folder, kept
// per server process.
import type { OpenCodeLease, OpenCodeSupervisor } from "./supervisor.ts";
import { EFFORT_LEVELS, type EffortLevel } from "../../../shared/types.ts";
import { asRecord, listData, positiveNumber, stringField } from "./records.ts";

// OpenCode 2.1.4 sends an SSE comment ": heartbeat" on /api/event every
// 15.000 s (measured 2026-10-25), and no data frame. 45 s is three missed
// heartbeats. The same bound covers the requests a turn makes before its
// stream reads: with 8 sessions on one 1.18.35 server, /event headers took at
// most 0.5 s, POST /session 1.7 s and /provider 12.8 s (2026-10-07). It is
// defined here because the catalog load also stops at it.
export const OPENCODE_EVENT_STREAM_DEADLINE_MS = 45_000;

// A turn stops waiting for the catalog at the deadline above, but the load
// goes on so a late success is kept. This bound only frees the slot of a
// load that never answers, so a later caller can try again.
export const OPENCODE_CATALOG_LOAD_LIMIT_MS = 5 * 60_000;

// How often a turn asks again for a list that 2.1.4 fills a moment after a
// start or a folder open: the plugin rows of a folder, and the providers.
// The catalog load uses it too, after a 503.
export const OPENCODE_LIST_POLL_MS = 250;

export interface OpenCodeDeadlineScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export const realDeadlineScheduler: OpenCodeDeadlineScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

// A route that serves one folder names it in the query.
export function folderPath(path: string, cwd: string): string {
  return `${path}?${new URLSearchParams({ "location[directory]": cwd })}`;
}

export interface DiscoveredOpenCodeModel {
  id: string;
  label: string;
  contextLimit?: number;
  // The catalog's input and output limits, for the compaction point
  // (openCodeAutoCompactTokens). Server-internal, like the rest of this type.
  inputLimit?: number;
  outputLimit?: number;
  isFree?: boolean;
  supportedEfforts: { level: EffortLevel }[];
}

// 2.1.4 lists a model's prices as tiers. A model is free when it has at
// least one tier and every price of every tier is zero.
function openCodeModelIsFree(rawCost: unknown): boolean {
  if (!Array.isArray(rawCost) || rawCost.length === 0) return false;
  return rawCost.every((tier) => {
    const cost = asRecord(tier);
    const cache = asRecord(cost.cache);
    const values: unknown[] = [];
    for (const [record, field] of [
      [cost, "input"],
      [cost, "output"],
      [cache, "read"],
      [cache, "write"],
    ] as const) {
      if (field in record) values.push(record[field]);
    }
    return (
      values.length > 0 &&
      values.every((value) => typeof value === "number" && value === 0)
    );
  });
}

// One catalog per OpenCode server process and directory (/api/model takes
// the folder, and a project config can add models). A running server does
// not reload its model registry, and every change to the model list replaces
// the server (internal-docs/opencode-oc1-scope.md), so the server key is the
// invalidation. Callers share one load; only a success is kept.
const keptCatalogs = new WeakMap<
  OpenCodeSupervisor,
  {
    serverKey: string;
    byCwd: Map<string, Promise<DiscoveredOpenCodeModel[]>>;
  }
>();

export function keptCatalog(
  supervisor: OpenCodeSupervisor,
  lease: OpenCodeLease,
  cwd: string,
  scheduler: OpenCodeDeadlineScheduler = realDeadlineScheduler,
): Promise<DiscoveredOpenCodeModel[]> {
  const serverKey = lease.serverKey;
  let kept = keptCatalogs.get(supervisor);
  if (!kept || kept.serverKey !== serverKey) {
    kept = { serverKey, byCwd: new Map() };
    keptCatalogs.set(supervisor, kept);
  }
  const byCwd = kept.byCwd;
  const existing = byCwd.get(cwd);
  if (existing) return existing;
  const load = loadCatalog(lease, cwd, scheduler);
  byCwd.set(cwd, load);
  load.catch(() => {
    if (byCwd.get(cwd) === load) byCwd.delete(cwd);
  });
  return load;
}

// OpenCode 2.2.5 waits at most 5 s for the folder's plugins to activate
// (the Isomux safety plugin, and the folder's .opencode/plugins) before it
// lists the models, then answers 503 "Location plugins did not finish
// activating". On a busy box that wait runs out, and a later request gets the
// list. Measured 2026-11-11 with a folder plugin whose setup takes 8 s: 503,
// 503, then 200. A setup that throws also settles, and the list answers. Just
// after a start, a 503 "service_starting" comes back at once. So a 503 is
// asked again, until the wait a turn gives the catalog; only a setup that
// never ends runs into that cap.
async function loadCatalog(
  lease: OpenCodeLease,
  cwd: string,
  scheduler: OpenCodeDeadlineScheduler,
): Promise<DiscoveredOpenCodeModel[]> {
  const controller = new AbortController();
  const timer = scheduler.setTimeout(
    () => controller.abort(),
    OPENCODE_CATALOG_LOAD_LIMIT_MS,
  );
  let capped = false;
  const cap = scheduler.setTimeout(() => {
    capped = true;
  }, OPENCODE_EVENT_STREAM_DEADLINE_MS);
  const unavailable = () => new Error("OpenCode HTTP 503 at /api/model.");
  let lastUnavailable = false;
  try {
    for (;;) {
      // A row carries its provider's settings, which can hold an API key.
      // Reduce it to scalars right here and never log, store or forward the
      // raw body.
      let response: Response;
      try {
        response = await fetch(
          new URL(folderPath("/api/model", cwd), lease.baseUrl),
          {
            headers: { authorization: lease.authHeader },
            signal: controller.signal,
          },
        );
      } catch (error) {
        if (lastUnavailable && controller.signal.aborted) throw unavailable();
        throw error;
      }
      if (response.status === 503) {
        await response.body?.cancel().catch(() => undefined);
        lastUnavailable = true;
        if (!capped)
          await pauseFor(scheduler, OPENCODE_LIST_POLL_MS, controller.signal);
        if (capped || controller.signal.aborted) throw unavailable();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`OpenCode HTTP ${response.status} at /api/model.`);
      }
      const models = allowDiscoveredModels(await response.json());
      // 2.1.4 lists no model for a moment after a start (gate E4a): an empty
      // list is a catalog that has not loaded yet, not one to keep.
      if (models.length === 0) throw new Error("OpenCode listed no model yet.");
      return models;
    }
  } finally {
    scheduler.clearTimeout(timer);
    scheduler.clearTimeout(cap);
  }
}

// A pause that an abort ends early.
export function pauseFor(
  scheduler: OpenCodeDeadlineScheduler,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      scheduler.clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = scheduler.setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// stopIfStarted: a server this listing starts stops when it ends, instead of
// after the idle wait (OpenCodeLease.releaseAndStopIfStarted).
export async function discoverOpenCodeModels(
  supervisor: OpenCodeSupervisor,
  cwd: string,
  options: { stopIfStarted?: boolean } = {},
): Promise<DiscoveredOpenCodeModel[]> {
  const lease = await supervisor.acquire();
  try {
    return await keptCatalog(supervisor, lease, cwd);
  } finally {
    if (options.stopIfStarted) lease.releaseAndStopIfStarted();
    else lease.release();
  }
}

// The rows of GET /api/model: 2.1.4 lists the enabled models of the
// providers it can use (gate E4a).
export function allowDiscoveredModels(raw: unknown): DiscoveredOpenCodeModel[] {
  const byId = new Map<string, DiscoveredOpenCodeModel>();
  for (const model of listData(raw).map(asRecord)) {
    if (model.enabled !== true || model.status !== "active") continue;
    const providerId = stringField(model, "providerID");
    if (!providerId || !safeCatalogId(providerId)) continue;
    const rawModelId =
      stringField(model, "modelID") ?? stringField(model, "id");
    if (!rawModelId) continue;
    const modelId = rawModelId.startsWith(`${providerId}/`)
      ? rawModelId.slice(providerId.length + 1)
      : rawModelId;
    if (!modelId || !safeCatalogId(modelId)) continue;
    const id = `${providerId}/${modelId}`;
    const modelLabel = safeCatalogLabel(model.name, modelId);
    const contextLimit = positiveNumber(asRecord(model.limit), "context");
    const inputLimit = positiveNumber(asRecord(model.limit), "input");
    const outputLimit = positiveNumber(asRecord(model.limit), "output");
    const variants = new Set(
      (Array.isArray(model.variants) ? model.variants.map(asRecord) : [])
        .map((variant) => variant.id)
        .filter((value): value is string => typeof value === "string"),
    );
    const supportedEfforts = EFFORT_LEVELS.filter(({ level }) =>
      variants.has(level),
    ).map(({ level }) => ({ level }));
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        // The two house providers prefix every model; "OpenCode Zen - " or
        // "OpenCode Go - " on each row is noise - the picker groups
        // them as pay-as-you-go and subscription instead. Other providers
        // keep the prefix - it disambiguates same-named models across them.
        label:
          providerId === "opencode" || providerId === "opencode-go"
            ? modelLabel
            : `${providerId} - ${modelLabel}`,
        ...(contextLimit !== null ? { contextLimit } : {}),
        ...(inputLimit !== null ? { inputLimit } : {}),
        ...(outputLimit !== null ? { outputLimit } : {}),
        ...(openCodeModelIsFree(model.cost) ? { isFree: true } : {}),
        supportedEfforts,
      });
    }
  }
  const compare = (
    left: DiscoveredOpenCodeModel,
    right: DiscoveredOpenCodeModel,
  ) => {
    if (left.label !== right.label) return left.label < right.label ? -1 : 1;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  };
  return [...byId.values()].sort(compare);
}

function safeCatalogId(value: string): boolean {
  return value.length <= 128 && /^[a-zA-Z0-9._:-]+$/.test(value);
}

function safeCatalogLabel(value: unknown, fallback: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }) ||
    /(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|bearer)/i.test(
      value,
    )
  )
    return fallback;
  return value;
}
