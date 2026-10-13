// The member a /api/users/:username/{env,secrets,mcp-servers} route acts on.
// The guard (selfOrEnvOwner or selfUserOrApi) has admitted the caller for
// :username, the member themself or an office owner for any member, so the
// subject is always the path's member, never the caller (Nil, 2026-10-13).
// One resolver for every such handler: a copy that read identity.userId
// would make an owner edit their own item.

import type { RouteHandler } from "../executor.ts";
import type { SecretScope } from "../../secret-store.ts";
import { isEnvOwnerIdentity, type GuardDeps } from "../../identity/guards.ts";

type Ctx = Parameters<RouteHandler>[0];

// Null for an unknown username: the handler answers 404.
export function memberSubject(
  userIdForUsername: GuardDeps["userIdForUsername"],
): (ctx: Ctx) => SecretScope | null {
  return (ctx) => {
    const userId = userIdForUsername(ctx.params.username ?? "");
    return userId ? { kind: "user", userId } : null;
  };
}

// The question officeEnvOwner asks, for a handler that serves an owner and a
// member differently on one route.
export function callerIsEnvOwner(
  ctx: Ctx,
  isOfficeOwnerUserId: GuardDeps["isOfficeOwnerUserId"],
): boolean {
  return isEnvOwnerIdentity(ctx.identity, isOfficeOwnerUserId);
}
