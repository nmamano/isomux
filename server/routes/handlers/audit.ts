import type { AuditActorKind, AuditFilter } from "../../../shared/audit.ts";
import type { AuditStore } from "../../audit-store.ts";
import { fail, ok, type RouteHandler } from "../executor.ts";
export function parseAuditFilter(query: URLSearchParams): AuditFilter | null {
  const filter: AuditFilter = {};
  const known = new Set([
    "actorKind",
    "actorId",
    "ownerId",
    "targetId",
    "operation",
    "from",
    "to",
    "before",
    "limit",
  ]);
  for (const key of query.keys()) if (!known.has(key)) return null;
  for (const key of ["actorId", "ownerId", "targetId", "operation"] as const) {
    const value = query.get(key);
    if (value !== null) filter[key] = value;
  }
  const kind = query.get("actorKind");
  if (kind !== null) {
    if (
      ![
        "member",
        "agent",
        "api_token",
        "cronjob",
        "webhook",
        "admin_cli",
        "setup",
        "app",
      ].includes(kind)
    )
      return null;
    filter.actorKind = kind as AuditActorKind;
  }
  for (const key of ["from", "to", "before", "limit"] as const) {
    const value = query.get(key);
    if (value === null) continue;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      return null;
    filter[key] = Number(value);
  }
  if (filter.limit !== undefined && (filter.limit < 1 || filter.limit > 1000))
    return null;
  if (
    filter.from !== undefined &&
    filter.to !== undefined &&
    filter.from > filter.to
  )
    return null;
  return filter;
}
export function auditHandlers(
  store: () => AuditStore,
): Record<string, RouteHandler> {
  return {
    "audit.list": (ctx) => {
      const filter = parseAuditFilter(ctx.query);
      return filter
        ? ok(store().list(filter))
        : fail(400, "invalid_audit_filter");
    },
  };
}
