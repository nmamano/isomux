import { resolve } from "node:path";
import { fail, ok, noContent, file, type RouteHandler } from "../executor";
import type { BrowserExtensionService } from "../../browser-extension-service";
import { BROWSER_NAME_MAX, browserName } from "../../browser-extension-store";

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
    // Every code adds a browser. `replace` is retired: still accepted as a
    // boolean for old clients, and ignored.
    "browser.pair": (ctx) => {
      const body = ctx.body ?? {};
      if (
        typeof body !== "object" ||
        Array.isArray(body) ||
        ("replace" in body && typeof body.replace !== "boolean") ||
        ("name" in body && typeof body.name !== "string")
      )
        return fail(422, "invalid_request", "name must be a string");
      const name = "name" in body ? (body.name as string) : "";
      if (browserName(name) === undefined)
        return fail(
          422,
          "invalid_request",
          `name must be at most ${BROWSER_NAME_MAX} characters`,
        );
      return ok(service.store.pair(ctx.identity.userId!, name));
    },
    "browser.revoke": (ctx) => {
      const member = ctx.identity.userId!;
      service.store.revoke(member);
      service.disconnect(member, true);
      return noContent();
    },
    // Looks only among the caller's browsers: a missing id and another
    // member's id get the same 404. A pending code stays valid.
    "browser.revokeOne": (ctx) => {
      const member = ctx.identity.userId!;
      const hash = service.store.revokeBrowser(member, ctx.params.id);
      if (hash === undefined)
        return fail(404, "browser_not_found", "No such paired browser");
      service.disconnect(member, true, hash);
      return noContent();
    },
  };
}
