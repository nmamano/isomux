// Pager settings handlers (opIds pagerSettings.{get,update,test}): where a
// member's pages go. Design: internal-docs/pager-design.md, "Delivery:
// Discord".
//
// The secrets gate (task 7a3b4114): the route table passes the member or an
// office owner, by cookie, API token or privileged agent
// (integration:manage + integrationSelfOrOwner), and the handlers act on the
// path's member, never the caller. The webhook URL is a credential: no
// response carries more than its masked form, as no secrets response carries
// a value.
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
import { memberSubject } from "./member-subject.ts";
import type { GuardDeps } from "../../identity/guards.ts";

export interface PagerSettingsDeps {
  settings: PagerSettingsStore;
  userIdForUsername: GuardDeps["userIdForUsername"];
  // Re-arm the member's open pages after a change.
  rescheduleMember(userId: string): void;
  sendTest(userId: string): Promise<PagerTestRes>;
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
  const subject = memberSubject(deps.userIdForUsername);
  const subjectUserId = (ctx: Parameters<RouteHandler>[0]) =>
    subject(ctx)?.userId ?? null;
  const handlers: Record<string, RouteHandler> = {
    "pagerSettings.get": (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(404, "not_found");
      return ok(toPagerSettingsRes(deps.settings.get(userId)));
    },

    "pagerSettings.update": (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(404, "not_found");
      const parsed = parsePagerSettingsPatch(ctx.body ?? {});
      if (!parsed.ok) return fail(422, "invalid_request", parsed.message);
      const next = deps.settings.update(userId, parsed.patch);
      deps.rescheduleMember(userId);
      return ok(toPagerSettingsRes(next));
    },

    "pagerSettings.test": async (ctx) => {
      const userId = subjectUserId(ctx);
      if (!userId) return fail(404, "not_found");
      return ok(await deps.sendTest(userId));
    },
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([opId, h]) => [opId, guarded(h)]),
  );
}
