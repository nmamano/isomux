// The member a /api/users/:username/{env,secrets,mcp-servers,voice,
// pager-settings} route acts on.
// The guard (integrationSelfOrOwner or selfUserOrApi) has admitted the caller
// for :username: the member themself or an office owner for any member (or
// their API token or privileged agent), so the
// subject is always the path's member, never the caller (Nil, 2026-10-13).
// One resolver for every such handler: a copy that read identity.userId
// would make an owner edit their own item.

import type { RouteHandler } from "../executor.ts";
import type { SecretScope } from "../../secret-store.ts";
import { hasOfficeOwnerReach, type GuardDeps } from "../../identity/guards.ts";
import { noteAuditMember } from "../../audit-context.ts";

type Ctx = Parameters<RouteHandler>[0];

// Null for an unknown username: the handler answers 404. A write's audit row
// names the member and the item (the :name param, or the name a create sends),
// for the member's "changed for you" list (task 7a3b4114).
export function memberSubject(
  userIdForUsername: GuardDeps["userIdForUsername"],
): (ctx: Ctx) => Extract<SecretScope, { kind: "user" }> | null {
  return (ctx) => {
    const userId = userIdForUsername(ctx.params.username ?? "");
    if (!userId) return null;
    noteAuditMember(userId, itemName(ctx));
    return { kind: "user", userId };
  };
}

function itemName(ctx: Ctx): string | undefined {
  if (ctx.params.name) return ctx.params.name;
  const body = ctx.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const name = (body as Record<string, unknown>).name;
    if (typeof name === "string" && name) return name;
  }
  return undefined;
}

// The question integrationOfficeOwner asks, for the office list handlers
// (secrets, MCP servers), which serve an owner and a member differently. It
// admits an owner's agent: use it on integration:manage routes only, never
// on a route that returns a value.
export function callerIsIntegrationOwner(
  ctx: Ctx,
  isOfficeOwnerUserId: GuardDeps["isOfficeOwnerUserId"],
): boolean {
  return hasOfficeOwnerReach(ctx.identity, { isOfficeOwnerUserId });
}
