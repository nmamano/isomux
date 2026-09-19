import { resolve } from "node:path";
import { fail, ok, noContent, file, type RouteHandler } from "../executor";
import type { BrowserExtensionService } from "../../browser-extension-service";

export function browserExtensionHandlers(
  service: BrowserExtensionService,
  packagePath = resolve(import.meta.dir, "../../../browser-extension/dist.zip"),
): Record<string, RouteHandler> {
  return {
    "browser.download": async () => {
      const path = packagePath;
      if (!(await Bun.file(path).exists()))
        return fail(
          404,
          "extension_unavailable",
          "The Chrome extension package is unavailable.",
        );
      return file(path, "application/zip", {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="isomux-browser.zip"',
      });
    },
    "browser.get": (ctx) => ok(service.status(ctx.identity.userId!)),
    "browser.pair": (ctx) => {
      const body = ctx.body ?? {};
      if (
        typeof body !== "object" ||
        Array.isArray(body) ||
        ("replace" in body && typeof body.replace !== "boolean")
      )
        return fail(422, "invalid_request", "replace must be a boolean");
      const member = ctx.identity.userId!;
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
