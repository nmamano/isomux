// A room's GitHub issue link (task 7fc83592): GET, PUT and DELETE
// /api/rooms/:roomId/github-link, for an office owner's reach. The poller is
// server/github-sync.ts.
import { ok, noContent, fail, type RouteHandler } from "../executor.ts";
import { toLinkWire, type GithubLinkStore } from "../../github-sync.ts";
import type { Identity } from "../../identity/index.ts";

export interface GithubSyncRouteDeps {
  links(): GithubLinkStore;
  roomExists(roomId: string): boolean;
  // The caller's user id: the link records who saved it.
  userIdOf(identity: Identity): string | null;
}

export function githubSyncHandlers(
  deps: GithubSyncRouteDeps,
): Record<string, RouteHandler> {
  return {
    "githubSync.get": (ctx) => {
      if (!deps.roomExists(ctx.params.roomId)) return fail(404, "not_found");
      const link = deps.links().get(ctx.params.roomId);
      return ok({ link: link ? toLinkWire(link) : null });
    },
    "githubSync.set": (ctx) => {
      if (!deps.roomExists(ctx.params.roomId)) return fail(404, "not_found");
      const userId = deps.userIdOf(ctx.identity);
      if (!userId) return fail(403, "forbidden");
      const result = deps.links().set(ctx.params.roomId, ctx.body, userId);
      if (!result.ok) return fail(result.status, result.code, result.message);
      return ok({ link: toLinkWire(result.link) });
    },
    "githubSync.delete": (ctx) => {
      if (!deps.roomExists(ctx.params.roomId)) return fail(404, "not_found");
      deps.links().remove(ctx.params.roomId);
      return noContent();
    },
  };
}
