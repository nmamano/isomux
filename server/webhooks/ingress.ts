import { recordAudit } from "../audit-store.ts";
// The public delivery route, POST /hooks/:id. See
// internal-docs/webhooks-design.md sections 1, 5 and 6.
//
// THE SIGNATURE IS THE ONLY GATE. No session, no bearer token, no Origin, and
// nothing reads a forwarding header: the route works the same behind any
// proxy or none. buildServer calls handle() on the office host only, after the
// app-host divert, so an app hostname never reaches it.
//
// STAGES 1 TO 6 (lookup, method, secret, ingress limit, body, signature) run
// before the signature is verified. They write no row; they only raise a
// counter on the hook, so an anonymous caller cannot push real rows out of the
// log. From stage 7 (the claim, deliveries.ts) on, the delivery is verified.
//
// IN MEMORY: the counters, the ingress bucket and the dispatch limiter reset
// when the server restarts. They are sanity bounds, not quotas.

import { createHash } from "crypto";
import { createAppMessageLimiter } from "../app-message-limits.ts";
import { formatWebhookSenderPrefix } from "../../shared/identity.ts";
import { buildWebhookBlock, reduceHeaderValue } from "./block.ts";
import { findMatchingRule, renderArgs } from "./match.ts";
import { verifyWebhookSignature } from "./verify.ts";
import {
  createWebhookDeliveryStore,
  type SettlePatch,
  type WebhookDeliveryLog,
} from "./deliveries.ts";
import { WEBHOOK_ID_PATTERN, type WebhookRegistry } from "./registry.ts";
import type {
  QueuedMessage,
  WebhookCounterReason,
  WebhookRecord,
  WebhookWire,
} from "../../shared/types.ts";

// Ruling 8: constants, not env vars.
export const WEBHOOK_BODY_MAX_BYTES = 5 * 1024 * 1024;
export const WEBHOOK_INGRESS_PER_MINUTE = 300;
export const WEBHOOK_INGRESS_BURST = 60;

const INGRESS_PATH = /^\/hooks\/([^/]+)$/;

// The hook id of a delivery path, or null for any other path.
export function matchWebhookIngressPath(pathname: string): string | null {
  return INGRESS_PATH.exec(pathname)?.[1] ?? null;
}

// --- the evaluation the dry run shares ---------------------------------------

// A GitHub ping never reaches a rule, also not a "*" rule. Only the GitHub
// scheme has one; the raw header is compared.
export function isWebhookPing(record: WebhookRecord, event: string): boolean {
  return record.scheme === "github-hmac-sha256" && event === "ping";
}

export type WebhookPlan =
  | { kind: "no_match" }
  | {
      kind: "match";
      ruleIndex: number;
      args: Record<string, string>;
      block: string;
    };

// What a verified, parsed, non-ping delivery asks for: the first matching rule,
// its rendered args, and the block the target receives. `event` is the raw
// header value, matched exactly; the block reduces it for display.
export function planWebhookDelivery(
  record: WebhookRecord,
  event: string,
  payload: unknown,
  deliveryId: string,
): WebhookPlan {
  const matched = findMatchingRule(record.rules, event, payload);
  if (!matched) return { kind: "no_match" };
  const args = renderArgs(matched.rule.args, {
    payload,
    event,
    delivery: deliveryId,
  });
  const { target } = record;
  const block = buildWebhookBlock({
    name: record.name,
    scheme: record.scheme,
    event,
    deliveryId,
    ruleIndex: matched.index,
    args,
    note: target.kind === "agent" ? (target.note ?? null) : null,
    // The agent message starts with the sender prefix and a space.
    reservedChars:
      target.kind === "agent"
        ? formatWebhookSenderPrefix(record.name).length + 1
        : 0,
  });
  return { kind: "match", ruleIndex: matched.index, args, block };
}

// --- the handler -------------------------------------------------------------

export type WebhookSender = Extract<
  QueuedMessage["sender"],
  { kind: "webhook" }
>;

export interface WebhookIngressDeps {
  registry: WebhookRegistry;
  now?: () => number;
  // The delivery log directory; tests point it elsewhere.
  dir?: string;
  writeFile?: (path: string, data: string) => void;
  // The hook owner (not a caller) reaches the agent's room: the rule the
  // webhookTargetAllowed precondition applies, checked again per dispatch.
  agentReachableByUser(
    userId: string | null,
    agentId: string,
  ): "ok" | "invalid_id" | "unavailable";
  // prepareEnqueue: the usage-cap reading the enqueue answers from. It can
  // await, so ingress checks the hook and its target again after it.
  prepareAgent(agentId: string): Promise<void>;
  // enqueueMessage, never steer. Synchronous, so the check before it and the
  // enqueue are one step. `code` names a refusal.
  enqueueToAgent(
    agentId: string,
    sender: WebhookSender,
    text: string,
  ): { ok: true } | { ok: false; code: string };
  // The cronjob exists and the hook owner still owns it or is an office
  // owner: the precondition's rule, checked again per dispatch.
  cronjobRunnableByUser(
    userId: string,
    cronjobId: string,
  ): "ok" | "missing" | "forbidden";
  // runCronjobFromWebhook. Synchronous: it returns the run row and the run
  // continues on its own. null when the cronjob is gone.
  startCronjobRun(
    cronjobId: string,
    webhook: { webhookId: string; webhookName: string; deliveryRowId: string },
    block: string,
  ): { runId: string } | null;
}

export interface WebhookIngress {
  handle(req: Request, hookId: string): Promise<Response>;
  counters(hookId: string): Pick<WebhookWire, "counters" | "countersSince">;
  // Drop the hook's in-memory state after a delete.
  forget(hookId: string): void;
  // Load every hook's delivery log (boot).
  recover(): void;
}

// Short JSON, never naming a cronjob, an agent or a rule.
function reply(
  status: number,
  error: string | null,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify(error === null ? { ok: true } : { error }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...headers,
      },
    },
  );
}

// The body, or null once it passes `cap`. Counted while it streams, so a
// sender without Content-Length is held to the same cap.
async function readCapped(
  req: Request,
  cap: number,
): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > cap) {
    return null;
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// application/json, or the form type with the JSON in `payload` (GitHub
// offers both). Anything else, or a body that is not a JSON object, is null.
function parsePayload(
  contentType: string | null,
  body: Uint8Array,
): Record<string, unknown> | null {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  let json: string | null;
  if (type === "application/json") json = text;
  else if (type === "application/x-www-form-urlencoded") {
    json = new URLSearchParams(text).get("payload");
  } else return null;
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

// Why a dispatch found its target unavailable. Owner-only text in the row.
const REFUSAL_DETAIL: Record<string, string> = {
  "agent not found": "agent deleted",
  agent_stopped: "agent stopped",
  agent_error: "agent in error",
  queue_full: "agent queue full",
  usage_cap: "usage cap reached",
};

const CRONJOB_DETAIL = {
  missing: "cronjob deleted",
  forbidden: "the hook owner no longer owns the cronjob",
} as const;

export function createWebhookIngress(deps: WebhookIngressDeps): WebhookIngress {
  const { registry } = deps;
  const now = deps.now ?? (() => Date.now());
  const store = createWebhookDeliveryStore({
    dir: deps.dir,
    now,
    writeFile: deps.writeFile,
  });
  // 10 attempted dispatches per minute, 500 accepted per rolling day, keyed
  // by hook id (PM ruling, 2026-10-05).
  const limiter = createAppMessageLimiter({ now });
  const countersSince = now();
  const counters = new Map<
    string,
    Partial<Record<WebhookCounterReason, { count: number; lastAt: number }>>
  >();
  const buckets = new Map<string, { tokens: number; at: number }>();
  const refillPerMs = WEBHOOK_INGRESS_PER_MINUTE / 60_000;

  const bump = (hookId: string, reason: WebhookCounterReason) => {
    const forHook = counters.get(hookId) ?? {};
    const t = now();
    forHook[reason] = { count: (forHook[reason]?.count ?? 0) + 1, lastAt: t };
    counters.set(hookId, forHook);
  };

  // Token bucket: WEBHOOK_INGRESS_BURST deep, refilled at
  // WEBHOOK_INGRESS_PER_MINUTE. The wait, when empty, in whole seconds.
  const admit = (hookId: string): number | null => {
    const t = now();
    const bucket = buckets.get(hookId) ?? {
      tokens: WEBHOOK_INGRESS_BURST,
      at: t,
    };
    bucket.tokens = Math.min(
      WEBHOOK_INGRESS_BURST,
      bucket.tokens + (t - bucket.at) * refillPerMs,
    );
    bucket.at = t;
    buckets.set(hookId, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return null;
    }
    return Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000));
  };

  // Stages 8 to 13 for a claimed row. Returns the answer and the row outcome.
  // `retrying` holds the row before a retry claim, so a retry whose body no
  // longer parses can put it back (PM ruling, 2026-10-05).
  const dispatch = async (
    req: Request,
    record: WebhookRecord,
    body: Uint8Array,
    log: WebhookDeliveryLog,
    rowId: string,
    event: string,
    deliveryId: string,
    retrying: SettlePatch | null,
  ): Promise<Response> => {
    const settled = (
      patch: SettlePatch,
      error: string | null,
      headers?: Record<string, string>,
    ): Response =>
      store.settle(log, rowId, patch)
        ? reply(patch.status, error, headers)
        : reply(500, "internal");
    const blank = { ruleIndex: null, args: null, target: null, detail: null };

    // 8: ping.
    if (isWebhookPing(record, event)) {
      return settled({ ...blank, outcome: "ping", status: 200 }, null);
    }

    // 9: parse.
    const payload = parsePayload(req.headers.get("content-type"), body);
    if (payload === null) {
      // A retry keeps its retryable outcome; the attempt still counts.
      if (retrying) {
        return store.settle(log, rowId, retrying)
          ? reply(400, "bad_payload")
          : reply(500, "internal");
      }
      return settled(
        { ...blank, outcome: "bad_payload", status: 400 },
        "bad_payload",
      );
    }

    // 10: match.
    const plan = planWebhookDelivery(record, event, payload, deliveryId);
    if (plan.kind === "no_match") {
      return settled({ ...blank, outcome: "no_match", status: 200 }, null);
    }
    const matched = { ruleIndex: plan.ruleIndex, args: plan.args };
    const { target } = record;
    const rowTarget =
      target.kind === "agent"
        ? { kind: "agent" as const, agentId: target.agentId }
        : { kind: "cronjob" as const, cronjobId: target.cronjobId };

    // 11: dispatch limit.
    const limit = limiter.takeBurst(record.id);
    if (!limit.ok) {
      return settled(
        {
          ...matched,
          outcome: "dispatch_limited",
          status: 429,
          target: rowTarget,
          detail: null,
        },
        "dispatch_limited",
        { "Retry-After": String(limit.retryAfterSec) },
      );
    }

    // 12: target.
    const unavailable = (detail: string) =>
      settled(
        {
          ...matched,
          outcome: "target_unavailable",
          status: 503,
          target: rowTarget,
          detail,
        },
        "target_unavailable",
      );
    if (target.kind === "cronjob") {
      // No await from the check to the start, so they are one step.
      const runnable = deps.cronjobRunnableByUser(
        record.userId,
        target.cronjobId,
      );
      if (runnable !== "ok") return unavailable(CRONJOB_DETAIL[runnable]);
      // A hold of its own, even with no await: commitDaily settles a hold
      // when there is one, so without it this commit would spend the hold of
      // an agent delivery still in flight on the same hook.
      limiter.holdDaily(record.id);
      let started: { runId: string } | null;
      try {
        started = deps.startCronjobRun(
          target.cronjobId,
          {
            webhookId: record.id,
            webhookName: record.name,
            deliveryRowId: rowId,
          },
          plan.block,
        );
      } catch (err) {
        console.error(
          `[webhooks] run of cronjob ${target.cronjobId} failed:`,
          err,
        );
        limiter.releaseDaily(record.id);
        return unavailable("cronjob run failed to start");
      }
      if (!started) {
        limiter.releaseDaily(record.id);
        return unavailable(CRONJOB_DETAIL.missing);
      }
      // 13: dispatched.
      limiter.commitDaily(record.id);
      return settled(
        {
          ...matched,
          outcome: "dispatched",
          status: 202,
          target: {
            kind: "cronjob",
            cronjobId: target.cronjobId,
            runId: started.runId,
          },
          detail: null,
        },
        null,
      );
    }
    const unreachable = "agent deleted or outside the hook owner's rooms";
    if (deps.agentReachableByUser(record.userId, target.agentId) !== "ok") {
      return unavailable(unreachable);
    }
    limiter.holdDaily(record.id);
    let committed = false;
    try {
      let sent: { ok: true } | { ok: false; code: string };
      try {
        await deps.prepareAgent(target.agentId);
        // The await above can outlast a change to the hook or to the owner's
        // rooms. Everything from here to the enqueue is synchronous, so the
        // send goes only where the CURRENT hook and owner allow.
        const current = registry.get(record.id);
        if (
          !current ||
          !current.enabled ||
          current.target.kind !== "agent" ||
          current.target.agentId !== target.agentId
        ) {
          return unavailable("webhook deleted or changed during delivery");
        }
        if (
          deps.agentReachableByUser(current.userId, target.agentId) !== "ok"
        ) {
          return unavailable(unreachable);
        }
        sent = deps.enqueueToAgent(
          target.agentId,
          { kind: "webhook", webhookId: record.id, webhookName: record.name },
          plan.block,
        );
      } catch (err) {
        console.error(`[webhooks] delivery to ${target.agentId} failed:`, err);
        sent = { ok: false, code: "delivery_failed" };
      }
      if (!sent.ok) {
        return unavailable(
          REFUSAL_DETAIL[sent.code] ?? `agent refused (${sent.code})`,
        );
      }
      // 13: dispatched.
      limiter.commitDaily(record.id);
      committed = true;
      return settled(
        {
          ...matched,
          outcome: "dispatched",
          status: 202,
          target: rowTarget,
          detail: null,
        },
        null,
      );
    } finally {
      if (!committed) limiter.releaseDaily(record.id);
    }
  };

  return {
    async handle(req, hookId) {
      // 1: the hook. An id that cannot exist is not looked up.
      if (!WEBHOOK_ID_PATTERN.test(hookId)) return reply(404, "not_found");
      let record: WebhookRecord | null;
      let secret: string | null;
      try {
        record = registry.get(hookId);
        if (!record) return reply(404, "not_found");
        if (!record.enabled) {
          bump(hookId, "disabled");
          return reply(404, "not_found");
        }
        // 2: method.
        if (req.method !== "POST") {
          bump(hookId, "method");
          return reply(405, "method_not_allowed", { Allow: "POST" });
        }
        // 3: secret. Ingress is the one reader besides the two human routes.
        secret = registry.readSecret(hookId);
      } catch (err) {
        console.error("[webhooks] registry unreadable:", err);
        return reply(500, "internal");
      }
      if (secret === null) {
        bump(hookId, "secret_missing");
        return reply(503, "secret_missing");
      }

      // 4: ingress limit, before the body read and the HMAC.
      const wait = admit(hookId);
      if (wait !== null) {
        bump(hookId, "rate_limited");
        return reply(429, "rate_limited", { "Retry-After": String(wait) });
      }

      // 5: body.
      let body: Uint8Array | null;
      try {
        body = await readCapped(req, WEBHOOK_BODY_MAX_BYTES);
      } catch {
        return reply(400, "bad_request");
      }
      if (body === null) {
        bump(hookId, "body_too_large");
        return reply(413, "body_too_large");
      }

      // The body read awaited, so the hook may have been deleted, disabled
      // or given a new secret meanwhile. Stages 1 and 3 again, on the current
      // state; from here to the claim nothing awaits.
      try {
        record = registry.get(hookId);
        if (!record) return reply(404, "not_found");
        if (!record.enabled) {
          bump(hookId, "disabled");
          return reply(404, "not_found");
        }
        secret = registry.readSecret(hookId);
      } catch (err) {
        console.error("[webhooks] registry unreadable:", err);
        return reply(500, "internal");
      }
      if (secret === null) {
        bump(hookId, "secret_missing");
        return reply(503, "secret_missing");
      }

      // 6: signature, over the raw bytes.
      const github = record.scheme === "github-hmac-sha256";
      const header = (name: string | null) =>
        name === null ? null : req.headers.get(name);
      const signature = header(
        github ? "x-hub-signature-256" : record.signatureHeader,
      );
      if (!verifyWebhookSignature(record.scheme, secret, body, signature)) {
        bump(hookId, "bad_signature");
        return reply(401, "bad_signature");
      }

      // 7: claim. The event is stored raw, because a retry matches the stored
      // event; the delivery id is display only, stored reduced.
      let claim;
      try {
        claim = store.claim(hookId, {
          bodyHash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
          bodySize: body.byteLength,
          event: header(github ? "x-github-event" : record.eventHeader) ?? "",
          deliveryId: reduceHeaderValue(
            header(github ? "x-github-delivery" : record.deliveryHeader),
          ),
        });
      } catch (err) {
        console.error(`[webhooks] claim on ${hookId} failed:`, err);
        return reply(500, "internal");
      }
      if (claim.kind === "duplicate") return reply(200, null);

      // A retry reads the event and the delivery id from the stored row, not
      // from this request.
      const { log, row } = claim;
      recordAudit({
        actor: {
          kind: "webhook",
          id: record.id,
          name: record.name,
          ownerId: record.userId,
        },
        operation: "hooks.deliver",
        targets: [record.id, row.id],
        fields: [],
      });
      const retrying =
        claim.kind === "retry"
          ? {
              outcome: claim.previous.outcome,
              status: claim.previous.status,
              ruleIndex: claim.previous.ruleIndex,
              args: claim.previous.args,
              target: claim.previous.target,
              detail: claim.previous.detail,
            }
          : null;
      try {
        return await dispatch(
          req,
          record,
          body,
          log,
          row.id,
          row.event,
          row.deliveryId,
          retrying,
        );
      } catch (err) {
        // A bug, not a bad delivery. The row must not stay `pending`.
        console.error(`[webhooks] dispatch on ${hookId} failed:`, err);
        store.settle(log, row.id, {
          outcome: "target_unavailable",
          status: 500,
          ruleIndex: null,
          args: null,
          target: null,
          detail: "internal error",
        });
        return reply(500, "internal");
      }
    },

    counters(hookId) {
      return { counters: { ...counters.get(hookId) }, countersSince };
    },

    forget(hookId) {
      counters.delete(hookId);
      buckets.delete(hookId);
      limiter.forget(hookId);
      store.forget(hookId);
    },

    recover() {
      let ids: string[];
      try {
        ids = registry.list().map((record) => record.id);
      } catch (err) {
        console.error("[webhooks] registry unreadable at boot:", err);
        return;
      }
      store.recover(ids);
    },
  };
}
