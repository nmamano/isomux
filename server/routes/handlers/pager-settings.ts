// Pager settings handlers (opIds pagerSettings.{get,update,test}): where a
// member's pages go. Design: internal-docs/pager-design.md, "Delivery:
// Discord".
//
// Self-only, the same gate as userEnv.*: the route table passes the caller's
// cookie session or that member's own API token (cap user:env +
// selfUserOrApi), and the handlers act on the caller's userId. No agent scope
// holds user:env, so no agent reads or changes these settings. The webhook URL
// is a credential: no response carries more than its masked form.
//
// LEAF over the executor, the settings store and the delivery service.

import { ok, fail, type RouteHandler } from "../executor.ts";
import type { PagerTestRes } from "../../../shared/contract-shapes.ts";
import {
  parsePagerSettingsPatch,
  PagerSettingsUnavailableError,
  toPagerSettingsRes,
  type PagerSettingsStore,
} from "../../pager-settings.ts";

export interface PagerSettingsDeps {
  settings: PagerSettingsStore;
  // Re-arm the member's open pages after a change.
  rescheduleMember(userId: string): void;
  sendTest(userId: string): Promise<PagerTestRes>;
}

function subjectUserId(ctx: Parameters<RouteHandler>[0]): string | null {
  return (ctx.identity.scope === "user" || ctx.identity.scope === "api") &&
    ctx.identity.userId
    ? ctx.identity.userId
    : null;
}

// Every failure is answered here, never rethrown: the executor logs a thrown
// error in full, and an error on this path (a failed save of the file that
// holds the webhook URL) is not worth that risk. The log line is fixed text.
function guarded(handler: RouteHandler): RouteHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof PagerSettingsUnavailableError) {
        return fail(500, "pager_settings_unavailable", err.message);
      }
      console.error("[pager] a pager settings request failed");
      return fail(500, "pager_settings_failed");
    }
  };
}

export function pagerSettingsHandlers(
  deps: PagerSettingsDeps,
): Record<string, RouteHandler> {
  const handlers: Record<string, RouteHandler> = {
    "pagerSettings.get": (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(403, "forbidden");
      return ok(toPagerSettingsRes(deps.settings.get(userId)));
    },

    "pagerSettings.update": (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(403, "forbidden");
      const parsed = parsePagerSettingsPatch(ctx.body ?? {});
      if (!parsed.ok) return fail(422, "invalid_request", parsed.message);
      const next = deps.settings.update(userId, parsed.patch);
      deps.rescheduleMember(userId);
      return ok(toPagerSettingsRes(next));
    },

    "pagerSettings.test": async (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(403, "forbidden");
      return ok(await deps.sendTest(userId));
    },
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([opId, h]) => [opId, guarded(h)]),
  );
}
