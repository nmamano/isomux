import { resolve } from "node:path";
import { fail, ok, noContent, file, type RouteHandler } from "../executor";
import type { BrowserExtensionService } from "../../browser-extension-service";
import type { BrowserBackend } from "../../browser-extension-store";

export function browserExtensionHandlers(
  service: BrowserExtensionService,
  select: (member: string, backend: BrowserBackend) => Promise<void>,
  packagePath = resolve(import.meta.dir, "../../../browser-extension/dist.zip"),
): Record<string, RouteHandler> {
  return {
    "browser.download": async () => {
      const path = packagePath;
      if (!(await Bun.file(path).exists())) return fail(404, "extension_unavailable", "The Chrome extension package is unavailable.");
      return file(path, "application/zip", { "Cache-Control": "no-store", "Content-Disposition": 'attachment; filename="isomux-browser.zip"' });
    },
    "browser.get": (ctx) => ok(service.status(ctx.identity.userId!)),
    "browser.select": async (ctx) => {
      const body = ctx.body as { backend?: unknown } | null;
      if (
        !body ||
        (body.backend !== "headless" && body.backend !== "extension")
      )
        return fail(
          422,
          "invalid_request",
          "backend must be headless or extension",
        );
      await select(ctx.identity.userId!, body.backend);
      return noContent();
    },
    "browser.pair": (ctx) => {
      const body = ctx.body ?? {};
      if (
        typeof body !== "object" ||
        Array.isArray(body) ||
        ("replace" in body && typeof body.replace !== "boolean")
      )
        return fail(422, "invalid_request", "replace must be a boolean");
      const member = ctx.identity.userId!;
      if (service.store.record(member).backend === null)
        return fail(
          409,
          "browser_selection_required",
          "Browser selection is unavailable; select a browser backend again",
        );
      if (
        service.store.record(member).hash &&
        !("replace" in body && body.replace)
      )
        return fail(
          409,
          "browser_already_paired",
          "A Chrome browser is already paired",
        );
      return ok(
        service.store.pair(member, "replace" in body && body.replace === true),
      );
    },
    "browser.revoke": (ctx) => {
      const member = ctx.identity.userId!;
      service.store.revoke(member);
      service.disconnect(member, true);
      return noContent();
    },
  };
}
