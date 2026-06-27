// Memory resource handlers — isomux-memory on the unified REST surface (opIds
// memory.{list,create}). See internal-docs/isomux-memory-design.md and
// plans/isomux-memory-loop.md.
//
// Scopes supported so far: agent (own file), room, office. Author + date + id
// are server-stamped from the token identity, NEVER the body (mirrors tasks'
// attribution rule); scopeId is a TARGET selector, not an authority claim.
// Authority is intentionally permissive (Nil): any authenticated caller may
// read/write room and office — there is deliberately NO room-access gate, only
// target-EXISTENCE validation. Every not-yet-supported path (boss scope,
// cross-agent agent writes) returns a DELIBERATE error so the temporary posture
// can't be mistaken for the final permissive model.
//
// LEAF over the executor + injected MemoryDeps. No manager/auth imports.

import { ok, created, fail, type RouteHandler } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type { MemoryItem, MemoryScope } from "../../../shared/types.ts";
import { isValidFactType } from "../../../shared/types.ts";
import type { MemoryCreateReq } from "../../../shared/contract-shapes.ts";

export interface MemoryDeps {
  read(scope: MemoryScope, scopeId: string | null): MemoryItem[];
  append(input: {
    scope: MemoryScope;
    scopeId: string | null;
    author: string;
    text: string;
  }): MemoryItem;
  // The caller's display author (agent name / user name), or null if the caller's
  // record can't be resolved — so a write is never stamped "unknown".
  authorFor(identity: Identity): string | null;
  // Strict identifier guard (rejects path traversal in a caller-supplied scopeId).
  isSafeScopeId(id: string): boolean;
  // Target-existence check for room scope. EXISTENCE ONLY — there is deliberately
  // NO room-access gate here (the model is permissive per Nil); do not reuse
  // requiresRoomAccess, which would silently undo that.
  roomExists(roomId: string): boolean;
}

type Target =
  | { scope: MemoryScope; scopeId: string | null }
  | { error: ReturnType<typeof fail> };

export function memoryHandlers(deps: MemoryDeps): Record<string, RouteHandler> {
  // Resolve the (scope, target file) for this caller, or a deliberate error for
  // any path not yet supported. Shared by GET (query) and POST (body).
  //   agent  — own file only (cross-agent is the documented TEMPORARY deferral
  //            until the final permissive target semantics land)
  //   room   — any authenticated caller; scopeId required + must EXIST (no access gate)
  //   office — any authenticated caller; never takes a scopeId (always office.md)
  //   boss / other — unsupported until a later slice
  function resolveTarget(
    identity: Identity,
    scope: unknown,
    rawScopeId: unknown,
  ): Target {
    if (scope === "agent") {
      if (identity.scope !== "agent" || !identity.agentId) {
        return {
          error: fail(
            400,
            "unsupported_caller",
            "agent-scope memory is only available to an agent token in this version",
          ),
        };
      }
      const own = identity.agentId;
      if (rawScopeId === undefined || rawScopeId === null) {
        return { scope: "agent", scopeId: own };
      }
      if (typeof rawScopeId !== "string" || !deps.isSafeScopeId(rawScopeId)) {
        return { error: fail(400, "invalid_scope_id", "scopeId is malformed") };
      }
      if (rawScopeId !== own) {
        // TEMPORARY: the final permissive model allows any caller to write any
        // agent's file; cross-agent agent writes are not enabled yet (room/office
        // deliver the cross-agent value). See the standing-orders deferral.
        return {
          error: fail(
            403,
            "forbidden",
            "an agent may only access its own memory (cross-agent writes are not enabled yet)",
          ),
        };
      }
      return { scope: "agent", scopeId: own };
    }
    if (scope === "room") {
      if (typeof rawScopeId !== "string" || !deps.isSafeScopeId(rawScopeId)) {
        return {
          error: fail(
            400,
            "invalid_scope_id",
            "room scope requires a valid scopeId",
          ),
        };
      }
      if (!deps.roomExists(rawScopeId)) {
        return { error: fail(404, "room_not_found", "no such room") };
      }
      return { scope: "room", scopeId: rawScopeId };
    }
    if (scope === "office") {
      if (rawScopeId !== undefined && rawScopeId !== null) {
        return {
          error: fail(
            400,
            "invalid_scope_id",
            "office memory takes no scopeId",
          ),
        };
      }
      return { scope: "office", scopeId: null };
    }
    return {
      error: fail(
        400,
        "unsupported_scope",
        "scope must be agent, room, or office in this version",
      ),
    };
  }

  return {
    "memory.list": (ctx) => {
      const scope = ctx.query.get("scope") ?? "agent";
      const scopeId = ctx.query.get("scopeId") ?? undefined;
      const target = resolveTarget(ctx.identity, scope, scopeId);
      if ("error" in target) return target.error;
      return ok(deps.read(target.scope, target.scopeId));
    },

    "memory.create": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<MemoryCreateReq>;
      if (!isValidFactType(body.factType)) {
        return fail(
          400,
          "invalid_fact_type",
          "factType must be one of preference|convention|rule|environment|role|contact",
        );
      }
      if (typeof body.text !== "string") {
        return fail(400, "invalid_text", "text is required");
      }
      // Reject newlines on the RAW body BEFORE trimming — otherwise a trailing
      // "\n"/"\r" would be silently normalized into a valid single line, letting
      // a client smuggle a multi-line payload past the one-fact-per-line rail.
      if (/[\r\n]/.test(body.text)) {
        return fail(400, "invalid_text", "text must be a single line");
      }
      const text = body.text.trim();
      if (text.length === 0) {
        return fail(400, "invalid_text", "text must not be blank");
      }
      const target = resolveTarget(ctx.identity, body.scope, body.scopeId);
      if ("error" in target) return target.error;
      const author = deps.authorFor(ctx.identity);
      if (!author) {
        return fail(
          404,
          "agent_not_found",
          "caller identity could not be resolved",
        );
      }
      const item = deps.append({
        scope: target.scope,
        scopeId: target.scopeId,
        author,
        text,
      });
      return created(item);
    },
  };
}
