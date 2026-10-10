import type { AppRecord } from "../../../shared/types.ts";
import type { AppWidgetStatus } from "../../../shared/contract-shapes.ts";
import type { Identity } from "../../identity/index.ts";
import { fail, ok, type RouteHandler } from "../executor.ts";

export interface AppWidgetDeps {
  get(name: string): AppRecord | null;
  registration(app: AppRecord): number;
  canAccess(app: AppRecord, userId: string): boolean;
  appUrl(app: AppRecord): string | null;
  sessionExpiresAt(app: AppRecord, sessionHash: string | null): number | null;
  chat(app: AppRecord, identity: Identity): AppWidgetStatus["chat"];
}

export function appWidgetHandlers(deps: AppWidgetDeps): Record<string, RouteHandler> {
  return {
    "apps.widget": (ctx) => {
      const app = deps.get(ctx.params.name);
      if (!app || !ctx.identity.userId || !deps.canAccess(app, ctx.identity.userId)) return fail(404, "not_found");
      const registration = deps.registration(app);
      const values = ctx.query.getAll("registration");
      if (values.length !== 1 || values[0] !== String(registration)) return fail(404, "not_found");
      const appUrl = deps.appUrl(app);
      if (!appUrl) return fail(404, "not_found");
      const status: AppWidgetStatus = {
        registration,
        appUrl,
        sessionExpiresAt: deps.sessionExpiresAt(app, ctx.callerSessionIdHash ?? null),
        chat: deps.chat(app, ctx.identity),
      };
      return ok(status);
    },
  };
}
