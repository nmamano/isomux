import type { AppRecord } from "../../../shared/types.ts";
import type { AppWidgetStatus } from "../../../shared/contract-shapes.ts";
import type { Identity } from "../../identity/index.ts";
import { appManifest, type WidgetMetadata } from "../../app-widget-metadata.ts";
import { bytes, fail, ok, type RouteHandler } from "../executor.ts";
import { appReloadRequestedAt } from "../../app-revision.ts";

export interface AppWidgetDeps {
  get(name: string): AppRecord | null;
  registration(app: AppRecord): number;
  canAccess(app: AppRecord, userId: string): boolean;
  appUrl(app: AppRecord): string | null;
  sessionExpiresAt(app: AppRecord, sessionHash: string | null): number | null;
  chat(app: AppRecord, identity: Identity): AppWidgetStatus["chat"];
  // The app's title and icons, read as the short-link page reads them.
  metadata(app: AppRecord): Promise<WidgetMetadata>;
  revision(app: AppRecord): Promise<string | null>;
  serving(app: AppRecord): Promise<boolean>;
}

export function appWidgetHandlers(
  deps: AppWidgetDeps,
): Record<string, RouteHandler> {
  return {
    "apps.widget": async (ctx) => {
      const app = deps.get(ctx.params.name);
      if (
        !app ||
        !ctx.identity.userId ||
        !deps.canAccess(app, ctx.identity.userId)
      )
        return fail(404, "not_found");
      const registration = deps.registration(app);
      const values = ctx.query.getAll("registration");
      if (values.length !== 1 || values[0] !== String(registration))
        return fail(404, "not_found");
      const appUrl = deps.appUrl(app);
      if (!appUrl) return fail(404, "not_found");
      const status: AppWidgetStatus = {
        registration,
        appUrl,
        sessionExpiresAt: deps.sessionExpiresAt(
          app,
          ctx.callerSessionIdHash ?? null,
        ),
        chat: deps.chat(app, ctx.identity),
        revision: await deps.revision(app),
        serving: await deps.serving(app),
        reloadRequestedAt: appReloadRequestedAt(app.name),
      };
      return ok(status);
    },
    // The short-link page's manifest: same 404 as apps.widget for an app the
    // caller cannot see.
    "apps.manifest": async (ctx) => {
      const app = deps.get(ctx.params.name);
      if (
        !app ||
        !ctx.identity.userId ||
        !deps.canAccess(app, ctx.identity.userId) ||
        !deps.appUrl(app)
      )
        return fail(404, "not_found");
      const manifest = appManifest(app, await deps.metadata(app), {
        android: /\bAndroid\b/i.test(ctx.req.headers.get("user-agent") ?? ""),
      });
      return bytes(
        new TextEncoder().encode(JSON.stringify(manifest)),
        "application/manifest+json",
        { "Cache-Control": "no-store" },
      );
    },
  };
}
