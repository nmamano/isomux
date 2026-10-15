// Push device handlers (opIds pushDevices.{list,add,remove,test}): the
// devices where a member turned on notifications for their pages.
//
// Self-only, the same gate as pagerSettings.*: the caller's cookie session or
// that member's own API token (cap user:env + selfUserOrApi), acting on the
// caller's userId. No response carries an endpoint or a device key.
//
// LEAF over the executor, the web push store and the delivery service.

import { ok, fail, noContent, type RouteHandler } from "../executor.ts";
import type {
  PushDevicesRes,
  PushTestRes,
} from "../../../shared/contract-shapes.ts";
import {
  parsePushDeviceInput,
  toPushDevice,
  WebPushUnavailableError,
  type WebPushStore,
} from "../../web-push-store.ts";
import { isP256PublicKey } from "../../web-push-crypto.ts";

export interface PushDevicesDeps {
  store: WebPushStore;
  sendTest(userId: string, deviceId: string): Promise<PushTestRes | null>;
}

function subjectUserId(ctx: Parameters<RouteHandler>[0]): string | null {
  return (ctx.identity.scope === "user" || ctx.identity.scope === "api") &&
    ctx.identity.userId
    ? ctx.identity.userId
    : null;
}

// Every failure is answered here, never rethrown: the executor logs a thrown
// error in full, and an error here may quote an endpoint.
function guarded(handler: RouteHandler): RouteHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof WebPushUnavailableError) {
        return fail(500, "web_push_unavailable", err.message);
      }
      console.error("[web-push] a push device request failed");
      return fail(500, "web_push_failed");
    }
  };
}

export function pushDevicesHandlers(
  deps: PushDevicesDeps,
): Record<string, RouteHandler> {
  const handlers: Record<string, RouteHandler> = {
    "pushDevices.list": async (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(403, "forbidden");
      const res: PushDevicesRes = {
        publicKey: (await deps.store.vapid()).publicKey,
        devices: deps.store.list(userId).map(toPushDevice),
      };
      return ok(res);
    },

    "pushDevices.add": async (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(403, "forbidden");
      const parsed = parsePushDeviceInput(ctx.body ?? {});
      if (!parsed.ok) return fail(422, "invalid_request", parsed.message);
      if (!(await isP256PublicKey(parsed.input.p256dh))) {
        return fail(422, "invalid_request", "keys.p256dh is not on P-256");
      }
      const record = await deps.store.upsert(userId, parsed.input);
      return ok(toPushDevice(record));
    },

    "pushDevices.remove": (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(403, "forbidden");
      if (!deps.store.remove(userId, ctx.params.id)) {
        return fail(404, "not_found");
      }
      return noContent();
    },

    "pushDevices.test": async (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(403, "forbidden");
      const res = await deps.sendTest(userId, ctx.params.id);
      return res ? ok(res) : fail(404, "not_found");
    },
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([opId, h]) => [opId, guarded(h)]),
  );
}
