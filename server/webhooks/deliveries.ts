// The delivery log and the dedup index of each webhook. See
// internal-docs/webhooks-design.md sections 5 and 6.
//
// File: STATE_ROOT/webhooks/<id>/deliveries.json, WebhookDelivery[], newest
// last, at most WEBHOOK_DELIVERY_LOG_MAX rows. registry.readDeliveries reads
// the same file for the API; every write here is synchronous, so the two agree.
//
// A ROW EXISTS ONLY FOR A VERIFIED DELIVERY. Ingress calls claim() after the
// signature check, never before, so an anonymous caller cannot write here.
//
// THE CLAIM IS ONE SYNCHRONOUS STEP. claim() looks up the body hash and, when
// the window holds no row for it, appends a `pending` row, with no await in
// between. The server runs requests on one thread, so of two requests with the
// same body only one can create the row; the other finds it.
//
// THE WINDOW is the shorter of 24 hours and the retained rows. The index maps a
// body hash to the newest row with that hash; a hit older than 24 hours counts
// as absent, and the trim to 500 rows drops trimmed rows from the index. The
// index is rebuilt from the file on load, so a restart keeps the window.
//
// A `pending` ROW ON DISK when a hook's log loads is from an earlier process
// (this process has not touched the hook yet), so load() turns it into
// target_unavailable "server restarted", and a redelivery can retry it.
//
// WRITE FAILURES. A failed claim write changes nothing in memory and throws:
// ingress answers 500 and the sender can redeliver. A failed settle write keeps
// the outcome in memory (PM ruling, 2026-10-05) and reports false: ingress
// answers 500, and an immediate redelivery finds the final outcome and does
// not dispatch again.

import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { STATE_ROOT } from "../config.ts";
import { atomicWriteFileSync } from "../persistence.ts";
import { WEBHOOK_DELIVERY_LOG_MAX } from "./registry.ts";
import type {
  WebhookDelivery,
  WebhookDeliveryOutcome,
} from "../../shared/types.ts";

export const WEBHOOK_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const WEBHOOK_RESTART_DETAIL = "server restarted";

// Outcomes a later copy of the same body may retry.
const RETRYABLE: ReadonlySet<WebhookDeliveryOutcome> = new Set([
  "dispatch_limited",
  "target_unavailable",
]);

// One hook's rows and index. Opaque to callers: claim() hands it out and
// settle() takes it back.
export interface WebhookDeliveryLog {
  readonly hookId: string;
  rows: WebhookDelivery[];
  index: Map<string, WebhookDelivery>;
}

export interface ClaimInput {
  bodyHash: string;
  bodySize: number;
  event: string;
  deliveryId: string;
}

export type ClaimResult =
  // No row in the window: a new `pending` row.
  | { kind: "new"; log: WebhookDeliveryLog; row: WebhookDelivery }
  // A retryable row, now `pending` again with one more attempt. `previous` is
  // the row before the claim, for a retry that must put it back.
  | {
      kind: "retry";
      log: WebhookDeliveryLog;
      row: WebhookDelivery;
      previous: WebhookDelivery;
    }
  // A row in flight or with a final outcome: one more duplicate, no work.
  | { kind: "duplicate"; row: WebhookDelivery };

export type SettlePatch = Pick<
  WebhookDelivery,
  "outcome" | "status" | "ruleIndex" | "args" | "target" | "detail"
>;

export class WebhookDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookDeliveryError";
  }
}

export interface WebhookDeliveryStore {
  // Synchronous. Throws WebhookDeliveryError when the log cannot be read or
  // the write fails; memory is then unchanged.
  claim(hookId: string, input: ClaimInput): ClaimResult;
  // Write the outcome of a claimed row. False when the write failed (the
  // outcome stays in memory). A log that was forgotten meanwhile (the hook was
  // deleted) is not written, so a settle cannot recreate the hook's directory.
  settle(log: WebhookDeliveryLog, rowId: string, patch: SettlePatch): boolean;
  // Load each hook's log now, so the restart conversion is on disk before the
  // first request. A log that cannot be read is logged and skipped.
  recover(hookIds: readonly string[]): void;
  // The hook is deleted: drop its log, and refuse every later claim on it.
  forget(hookId: string): void;
}

export interface WebhookDeliveryStoreOptions {
  dir?: string;
  now?: () => number;
  // Tests inject a failing writer.
  writeFile?: (path: string, data: string) => void;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const OUTCOMES: ReadonlySet<string> = new Set<WebhookDeliveryOutcome>([
  "pending",
  "ping",
  "bad_payload",
  "no_match",
  "dispatch_limited",
  "target_unavailable",
  "dispatched",
]);

const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const isTime = (v: unknown) => typeof v === "number" && Number.isFinite(v);

function isRowTarget(v: unknown): boolean {
  if (v === null) return true;
  if (!isPlainObject(v)) return false;
  if (v.kind === "agent") return typeof v.agentId === "string";
  return (
    v.kind === "cronjob" &&
    typeof v.cronjobId === "string" &&
    (v.runId === undefined || typeof v.runId === "string")
  );
}

// Every field of a persisted row. One bad row makes the whole file corrupt:
// a row with a missing hash or time would break the window.
function isRow(v: unknown): v is WebhookDelivery {
  return (
    isPlainObject(v) &&
    typeof v.id === "string" &&
    isTime(v.receivedAt) &&
    typeof v.event === "string" &&
    typeof v.deliveryId === "string" &&
    typeof v.bodyHash === "string" &&
    isCount(v.bodySize) &&
    typeof v.outcome === "string" &&
    OUTCOMES.has(v.outcome) &&
    isCount(v.attempts) &&
    isCount(v.duplicates) &&
    isTime(v.lastSeenAt) &&
    isCount(v.status) &&
    (v.ruleIndex === null || isCount(v.ruleIndex)) &&
    (v.args === null ||
      (isPlainObject(v.args) &&
        Object.values(v.args).every((arg) => typeof arg === "string"))) &&
    isRowTarget(v.target) &&
    (v.detail === null || typeof v.detail === "string")
  );
}

export function createWebhookDeliveryStore(
  options: WebhookDeliveryStoreOptions = {},
): WebhookDeliveryStore {
  const dir = resolve(options.dir ?? join(STATE_ROOT, "webhooks"));
  const now = options.now ?? (() => Date.now());
  const writeFile = options.writeFile ?? atomicWriteFileSync;
  const logs = new Map<string, WebhookDeliveryLog>();
  // Deleted hooks. Ids are random and never reused, so a claim on one is a
  // late request that must not recreate the hook's directory.
  const forgotten = new Set<string>();

  const fileFor = (hookId: string) => join(dir, hookId, "deliveries.json");

  const write = (hookId: string, rows: WebhookDelivery[]): void => {
    mkdirSync(join(dir, hookId), { recursive: true, mode: 0o700 });
    writeFile(fileFor(hookId), JSON.stringify(rows));
  };

  const indexOf = (rows: WebhookDelivery[]) => {
    const index = new Map<string, WebhookDelivery>();
    // Oldest first, so the newest row of a hash wins.
    for (const row of rows) index.set(row.bodyHash, row);
    return index;
  };

  const load = (hookId: string): WebhookDeliveryLog => {
    const file = fileFor(hookId);
    let rows: WebhookDelivery[] = [];
    if (existsSync(file)) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf-8"));
      } catch (err) {
        throw new WebhookDeliveryError(
          `${file} is unreadable (${(err as Error).message})`,
        );
      }
      if (!Array.isArray(raw) || !raw.every(isRow)) {
        throw new WebhookDeliveryError(`${file} is not a delivery list`);
      }
      rows = raw;
    }
    let restarted = false;
    rows = rows.map((row) => {
      if (row.outcome !== "pending") return row;
      restarted = true;
      return {
        ...row,
        outcome: "target_unavailable",
        status: 503,
        detail: WEBHOOK_RESTART_DETAIL,
      };
    });
    if (restarted) {
      try {
        write(hookId, rows);
      } catch (err) {
        // Memory holds the conversion; the next write carries it to disk.
        console.error(`[webhooks] could not write ${file}:`, err);
      }
    }
    const log: WebhookDeliveryLog = { hookId, rows, index: indexOf(rows) };
    logs.set(hookId, log);
    return log;
  };

  const logFor = (hookId: string) => logs.get(hookId) ?? load(hookId);

  const newRowId = (rows: WebhookDelivery[]) => {
    let id: string;
    do {
      id = `d_${randomBytes(4).toString("hex")}`;
    } while (rows.some((row) => row.id === id));
    return id;
  };

  // Write `rows`, then make them the log's rows. Throws, with memory
  // unchanged, when the write fails.
  const commit = (log: WebhookDeliveryLog, rows: WebhookDelivery[]) => {
    try {
      write(log.hookId, rows);
    } catch (err) {
      console.error(`[webhooks] could not write ${fileFor(log.hookId)}:`, err);
      throw new WebhookDeliveryError("the delivery log could not be written");
    }
    log.rows = rows;
  };

  const replaced = (
    log: WebhookDeliveryLog,
    before: WebhookDelivery,
    after: WebhookDelivery,
  ) => log.rows.map((row) => (row === before ? after : row));

  return {
    claim(hookId, input) {
      if (forgotten.has(hookId)) {
        throw new WebhookDeliveryError(`webhook ${hookId} was deleted`);
      }
      const log = logFor(hookId);
      const t = now();
      const hit = log.index.get(input.bodyHash);
      if (hit && t - hit.receivedAt < WEBHOOK_DEDUP_WINDOW_MS) {
        if (RETRYABLE.has(hit.outcome)) {
          const row: WebhookDelivery = {
            ...hit,
            outcome: "pending",
            attempts: hit.attempts + 1,
            lastSeenAt: t,
          };
          commit(log, replaced(log, hit, row));
          log.index.set(row.bodyHash, row);
          return { kind: "retry", log, row, previous: hit };
        }
        const row: WebhookDelivery = {
          ...hit,
          duplicates: hit.duplicates + 1,
          lastSeenAt: t,
        };
        commit(log, replaced(log, hit, row));
        log.index.set(row.bodyHash, row);
        return { kind: "duplicate", row };
      }
      const row: WebhookDelivery = {
        id: newRowId(log.rows),
        receivedAt: t,
        event: input.event,
        deliveryId: input.deliveryId,
        bodyHash: input.bodyHash,
        bodySize: input.bodySize,
        outcome: "pending",
        attempts: 1,
        duplicates: 0,
        lastSeenAt: t,
        status: 0,
        ruleIndex: null,
        args: null,
        target: null,
        detail: null,
      };
      const rows = [...log.rows, row];
      const trimmed = rows.splice(
        0,
        Math.max(0, rows.length - WEBHOOK_DELIVERY_LOG_MAX),
      );
      commit(log, rows);
      for (const old of trimmed) {
        if (log.index.get(old.bodyHash) === old) log.index.delete(old.bodyHash);
      }
      log.index.set(row.bodyHash, row);
      return { kind: "new", log, row };
    },

    settle(log, rowId, patch) {
      if (logs.get(log.hookId) !== log) return true;
      const before = log.rows.find((row) => row.id === rowId);
      // Trimmed while in flight: nothing left to write.
      if (!before) return true;
      const after: WebhookDelivery = { ...before, ...patch };
      log.rows = replaced(log, before, after);
      if (log.index.get(after.bodyHash) === before) {
        log.index.set(after.bodyHash, after);
      }
      try {
        write(log.hookId, log.rows);
        return true;
      } catch (err) {
        console.error(
          `[webhooks] could not write ${fileFor(log.hookId)}:`,
          err,
        );
        return false;
      }
    },

    recover(hookIds) {
      for (const hookId of hookIds) {
        try {
          load(hookId);
        } catch (err) {
          console.error(`[webhooks] delivery log of ${hookId}:`, err);
        }
      }
    },

    forget(hookId) {
      logs.delete(hookId);
      forgotten.add(hookId);
    },
  };
}
