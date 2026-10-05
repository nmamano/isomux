// Webhook resource handlers (opIds webhooks.{list,get,create,update,delete,
// deliveries,dryRun,readSecret,rotateSecret}) and the webhookTargetAllowed
// precondition. The public delivery route is server/webhooks/ingress.ts. See
// internal-docs/webhooks-design.md sections 2, 4 and 7.
//
// [ownership] userId/username/createdBy come from the TOKEN identity, never the
// body, as for apps: the hook belongs to the caller's user, so it outlives the
// agent that created it.
//
// [the secret] Only readSecret and rotateSecret put it in a response. toWire is
// the one place a record becomes wire, and the record has no secret field.
//
// LEAF over the executor, the registry and the S1 core. Live office state
// arrives through the injected deps.

import {
  ok,
  created,
  noContent,
  fail,
  type HandlerErrorStatus,
  type HandlerResult,
  type PreconditionFn,
  type RouteHandler,
  type RouteHandlerContext,
} from "../executor.ts";
import {
  WEBHOOK_DELIVERY_LOG_MAX,
  WebhookRegistryError,
  validateWebhookFields,
  type WebhookFields,
  type WebhookRegistry,
} from "../../webhooks/registry.ts";
import { isWebhookPing, planWebhookDelivery } from "../../webhooks/ingress.ts";
import type { Identity } from "../../identity/index.ts";
import type {
  WebhookRecord,
  WebhookTarget,
  WebhookWire,
} from "../../../shared/types.ts";
import type {
  WebhookDryRunRes,
  WebhookErrorCode,
} from "../../../shared/contract-shapes.ts";

export const WEBHOOK_DELIVERIES_DEFAULT_LIMIT = 50;

export interface WebhooksDeps {
  registry: WebhookRegistry;
  attributionFor(identity: Identity): {
    createdBy: string;
    username: string | undefined;
  };
  // An office owner, or an agent or API token whose user is one: sees and
  // manages every hook, as for apps.
  hasOfficeWideReach(identity: Identity): boolean;
  // The public origin; the hook URL is `${origin}/hooks/${id}`.
  publicOrigin(): string;
  // Pre-verify counters (design section 6). In memory, from ingress.
  counters(id: string): Pick<WebhookWire, "counters" | "countersSince">;
  // Drop ingress's in-memory state (counters, limits, the log's index) of a
  // deleted hook. Called after the delete commits.
  forget(id: string): void;
  // Tell the hook owner's and the office owners' sockets. Called only after a
  // committed change, with the same wire object the response carries.
  announce(wire: WebhookWire): void;
  announceRemoved(record: WebhookRecord): void;
}

// Live lookups for webhookTargetAllowed.
export interface WebhookTargetDeps {
  get(id: string): WebhookRecord | null;
  // The hook owner (not the calling agent) reaches the agent's room.
  agentReachableByUser(
    userId: string | null,
    agentId: string,
  ): "ok" | "invalid_id" | "unavailable";
  cronjobExists(cronjobId: string): boolean;
  // The caller passes cronjobOwnerOrOfficeOwner for this cronjob.
  callerManagesCronjob(identity: Identity, cronjobId: string): boolean;
  // The hook owner created the cronjob or is an office owner: the rule each
  // dispatch checks again.
  userMayRunCronjob(userId: string | null, cronjobId: string): boolean;
}

const STATUS_BY_CODE: Record<WebhookErrorCode, HandlerErrorStatus> = {
  invalid_request: 400,
  invalid_name: 400,
  invalid_scheme: 400,
  invalid_headers: 400,
  invalid_rules: 400,
  invalid_target: 400,
  invalid_note: 400,
  rule_field_too_long: 422,
  scheme_immutable: 422,
  name_taken: 409,
  webhook_limit_reached: 409,
  secret_missing: 409,
  registry_corrupt: 500,
  persist_failed: 500,
};

function renderRegistryError(err: unknown): HandlerResult {
  if (err instanceof WebhookRegistryError) {
    return fail(STATUS_BY_CODE[err.code], err.code, err.message);
  }
  throw err;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const MUTABLE_FIELDS = [
  "name",
  "signatureHeader",
  "eventHeader",
  "deliveryHeader",
  "rules",
  "target",
  "enabled",
] as const;

const invalid = (code: WebhookErrorCode, message: string) =>
  new WebhookRegistryError(code, message);

// The whole field set a request asks for. Create: the body over the defaults;
// an agent that names no target gets itself. Update: the body merged into the
// stored record. Throws WebhookRegistryError. The precondition and the handler
// both call this, so they judge the same record.
export function resolveWebhookFields(
  identity: Identity,
  body: unknown,
  before: WebhookRecord | null,
): WebhookFields {
  if (!isPlainObject(body)) {
    throw invalid("invalid_request", "the body must be a JSON object");
  }
  if (before === null) {
    let target = body.target;
    if (target === undefined) {
      if (identity.scope !== "agent" || !identity.agentId) {
        throw invalid("invalid_target", "target is required");
      }
      target = { kind: "agent", agentId: identity.agentId };
    }
    return validateWebhookFields({
      name: body.name,
      scheme: body.scheme,
      signatureHeader: body.signatureHeader ?? null,
      eventHeader: body.eventHeader ?? null,
      deliveryHeader: body.deliveryHeader ?? null,
      rules: body.rules ?? [],
      target,
      enabled: body.enabled ?? true,
    });
  }
  // Any PATCH that names the scheme, even with the stored value (PM ruling).
  if (Object.hasOwn(body, "scheme")) {
    throw invalid(
      "scheme_immutable",
      "a webhook's scheme cannot be changed; leave it out, or create a new webhook",
    );
  }
  if (!MUTABLE_FIELDS.some((field) => Object.hasOwn(body, field))) {
    throw invalid(
      "invalid_request",
      `the request changes nothing; send one or more of ${MUTABLE_FIELDS.join(", ")}`,
    );
  }
  const merged: Record<string, unknown> = {
    name: before.name,
    scheme: before.scheme,
    signatureHeader: before.signatureHeader,
    eventHeader: before.eventHeader,
    deliveryHeader: before.deliveryHeader,
    rules: before.rules,
    target: before.target,
    enabled: before.enabled,
  };
  for (const field of MUTABLE_FIELDS) {
    if (Object.hasOwn(body, field)) merged[field] = body[field];
  }
  return validateWebhookFields(
    merged as Parameters<typeof validateWebhookFields>[0],
  );
}

// webhookTargetAllowed. Runs on the whole resolved record, so a PATCH that
// edits only rules, note or enabled cannot keep a target the caller could not
// set. A hidden agent and a missing one get the same 403.
export function webhookTargetPrecondition(
  deps: WebhookTargetDeps,
): PreconditionFn {
  return (ctx: RouteHandlerContext) => {
    const id = ctx.params.id;
    const before = id === undefined ? null : deps.get(id);
    // An update of an unknown id: the handler answers 404.
    if (id !== undefined && before === null) return null;
    let target: WebhookTarget;
    try {
      target = resolveWebhookFields(ctx.identity, ctx.body, before).target;
    } catch (err) {
      return renderRegistryError(err);
    }
    const ownerUserId = before === null ? ctx.identity.userId : before.userId;
    if (target.kind === "agent") {
      const reach = deps.agentReachableByUser(ownerUserId, target.agentId);
      if (reach === "invalid_id") {
        return fail(400, "invalid_target", "target.agentId is not an agent id");
      }
      return reach === "ok"
        ? null
        : fail(
            403,
            "forbidden",
            "target.agentId must name a live agent in a room the hook owner can access",
          );
    }
    const allowed =
      deps.cronjobExists(target.cronjobId) &&
      deps.callerManagesCronjob(ctx.identity, target.cronjobId) &&
      deps.userMayRunCronjob(ownerUserId, target.cronjobId);
    return allowed
      ? null
      : fail(
          403,
          "forbidden",
          "target.cronjobId must name a cronjob that you manage and that the hook owner created",
        );
  };
}

export function webhooksHandlers(
  deps: WebhooksDeps,
): Record<string, RouteHandler> {
  const { registry } = deps;

  // The ONE place a record becomes wire. The record type has no secret field.
  const toWire = (record: WebhookRecord): WebhookWire => {
    const latest = registry.readDeliveries(record.id, 1)[0];
    return {
      ...record,
      url: `${deps.publicOrigin()}/hooks/${record.id}`,
      secretState: registry.secretState(record.id),
      ...deps.counters(record.id),
      lastDelivery: latest
        ? { outcome: latest.outcome, receivedAt: latest.receivedAt }
        : null,
    };
  };

  // Every handler wraps its registry access, so a corrupt registry answers
  // with its own code on a read as well as a write.
  const guarded =
    (handler: RouteHandler): RouteHandler =>
    async (ctx) => {
      try {
        return await handler(ctx);
      } catch (err) {
        return renderRegistryError(err);
      }
    };

  // A failed announce must not turn a committed change into an error answer.
  const announced = (send: () => void) => {
    try {
      send();
    } catch (err) {
      console.error("[webhooks] could not announce a change:", err);
    }
  };

  // The owner guard has run on :id, so a miss here is a genuine unknown.
  const recordOr404 = (id: string) => registry.get(id);

  return {
    "webhooks.list": guarded((ctx) => {
      const all = deps.hasOfficeWideReach(ctx.identity);
      const userId = ctx.identity.userId;
      return ok(
        registry
          .list()
          .filter((hook) => all || (userId !== null && hook.userId === userId))
          .map(toWire),
      );
    }),

    "webhooks.get": guarded((ctx) => {
      const record = recordOr404(ctx.params.id);
      return record ? ok(toWire(record)) : fail(404, "not_found");
    }),

    "webhooks.create": guarded((ctx) => {
      // hasOwningUser has run; this narrows the type.
      const userId = ctx.identity.userId;
      if (userId === null) return fail(403, "forbidden");
      const fields = resolveWebhookFields(ctx.identity, ctx.body, null);
      const { createdBy, username } = deps.attributionFor(ctx.identity);
      const record = registry.create({
        fields,
        userId,
        username: username ?? null,
        createdBy,
        ...(ctx.identity.scope === "agent" && ctx.identity.agentId
          ? { createdByAgentId: ctx.identity.agentId }
          : {}),
      });
      const wire = toWire(record);
      announced(() => deps.announce(wire));
      return created(wire);
    }),

    "webhooks.update": guarded((ctx) => {
      const before = recordOr404(ctx.params.id);
      if (!before) return fail(404, "not_found");
      const fields = resolveWebhookFields(ctx.identity, ctx.body, before);
      const record = registry.update(before.id, fields);
      if (!record) return fail(404, "not_found");
      const wire = toWire(record);
      announced(() => deps.announce(wire));
      return ok(wire);
    }),

    "webhooks.delete": guarded((ctx) => {
      const record = registry.remove(ctx.params.id);
      if (!record) return fail(404, "not_found");
      announced(() => deps.forget(record.id));
      announced(() => deps.announceRemoved(record));
      return noContent();
    }),

    "webhooks.deliveries": guarded((ctx) => {
      const record = recordOr404(ctx.params.id);
      if (!record) return fail(404, "not_found");
      const raw = ctx.query.get("limit");
      const limit =
        raw === null ? WEBHOOK_DELIVERIES_DEFAULT_LIMIT : Number(raw);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > WEBHOOK_DELIVERY_LOG_MAX
      ) {
        return fail(
          400,
          "invalid_request",
          `limit must be an integer from 1 to ${WEBHOOK_DELIVERY_LOG_MAX}`,
        );
      }
      return ok({ deliveries: registry.readDeliveries(record.id, limit) });
    }),

    // What a delivery would do, by the stages after the signature check
    // (design section 1, stages 8 and 10). No dispatch, no row. The event is
    // the raw header value: rules match it exactly, and the block reduces it
    // for display. Ingress runs the same two functions on the same raw value.
    "webhooks.dryRun": guarded((ctx) => {
      const record = recordOr404(ctx.params.id);
      if (!record) return fail(404, "not_found");
      const body = ctx.body;
      if (
        !isPlainObject(body) ||
        typeof body.event !== "string" ||
        !isPlainObject(body.payload)
      ) {
        return fail(
          400,
          "invalid_request",
          "send {event, payload}: the event name and the JSON object payload",
        );
      }
      const event = body.event;
      let result: WebhookDryRunRes;
      if (isWebhookPing(record, event)) {
        result = { outcome: "ping" };
      } else {
        const plan = planWebhookDelivery(record, event, body.payload, "");
        result =
          plan.kind === "no_match"
            ? { outcome: "no_match" }
            : {
                outcome: "match",
                ruleIndex: plan.ruleIndex,
                args: plan.args,
                block: plan.block,
              };
      }
      return ok(result);
    }),

    "webhooks.readSecret": guarded((ctx) => {
      const record = recordOr404(ctx.params.id);
      if (!record) return fail(404, "not_found");
      const secret = registry.readSecret(record.id);
      return secret === null
        ? fail(
            409,
            "secret_missing",
            "this webhook has no secret (backups do not hold secrets); rotate it to make a new one",
          )
        : ok({ secret });
    }),

    "webhooks.rotateSecret": guarded((ctx) => {
      const record = recordOr404(ctx.params.id);
      if (!record) return fail(404, "not_found");
      const secret = registry.rotateSecret(record.id);
      if (secret === null) return fail(404, "not_found");
      // The secret changed, so the caller must get it even if the announce
      // (which reads the registry again) fails.
      announced(() => deps.announce(toWire(record)));
      return ok({ secret });
    }),
  };
}
