import type { AuditActor } from "../../shared/audit.ts";
import type { HandlerResult, RouteHandlerContext } from "./executor.ts";
import { recordAudit } from "../audit-store.ts";
import { requireAuditContext } from "../audit-context.ts";

// These paths contain identifiers, never arbitrary body/response text. A create
// may return its new identifier at the top level. Nested responses are declared
// separately at their route rather than recursively scanning for strings.
export function resourceTargets(
  ctx: RouteHandlerContext,
  result: HandlerResult,
): string[] {
  const ids = Object.values(ctx.params);
  if (
    result.kind === "json" &&
    result.body &&
    typeof result.body === "object"
  ) {
    const body = result.body as Record<string, unknown>;
    if (typeof body.id === "string") ids.push(body.id);
  }
  return [...new Set(ids)];
}
export function savedFileAudit(id: string): void {
  const context = requireAuditContext();
  recordAudit({
    actor: context.actor,
    operation: context.operation,
    targets: [id],
    fields: [],
  });
}
export interface ExecutorAudit {
  actor(ctx: RouteHandlerContext): AuditActor;
  write: typeof recordAudit;
}

export function createdResource(key: string, idField = "id") {
  return (ctx: RouteHandlerContext, result: HandlerResult): string[] => {
    const ids = resourceTargets(ctx, result);
    if (
      result.kind === "json" &&
      result.body &&
      typeof result.body === "object"
    ) {
      const value = (result.body as Record<string, unknown>)[key];
      if (
        value &&
        typeof value === "object" &&
        typeof (value as Record<string, unknown>)[idField] === "string"
      )
        ids.push((value as Record<string, string>)[idField]);
    }
    return [...new Set(ids)];
  };
}
export function namedResource(
  ctx: RouteHandlerContext,
  result: HandlerResult,
): string[] {
  const ids = resourceTargets(ctx, result);
  if (
    result.kind === "json" &&
    result.body &&
    typeof result.body === "object" &&
    typeof (result.body as { name?: unknown }).name === "string"
  )
    ids.push((result.body as { name: string }).name);
  return [...new Set(ids)];
}
// A route must name every additional identifier explicitly. This never walks
// a body or a response recursively and never copies content, tokens or URLs.
export function selectedTargets(options: {
  body?: string[];
  result?: string[];
  self?: boolean;
  fixed?: string;
}) {
  return (ctx: RouteHandlerContext, result: HandlerResult): string[] => {
    const ids = resourceTargets(ctx, result);
    const add = (value: unknown, keys: string[]) => {
      if (!value || typeof value !== "object") return;
      for (const key of keys) {
        const id = (value as Record<string, unknown>)[key];
        if (typeof id === "string" && id) ids.push(id);
      }
    };
    add(ctx.body, options.body ?? []);
    if (result.kind === "json") add(result.body, options.result ?? []);
    if (options.self && ctx.identity.userId) ids.push(ctx.identity.userId);
    if (options.fixed) ids.push(options.fixed);
    return [...new Set(ids)];
  };
}
