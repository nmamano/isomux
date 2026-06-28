// Memory resource handlers — isomux-memory on the unified REST surface (opIds
// memory.{list,create,update,delete}). See internal-docs/isomux-memory-design.md
// and plans/isomux-memory-loop.md.
//
// Scopes: agent, room, office, boss. Author + date + id are server-stamped from
// the token identity, NEVER the body (mirrors tasks' attribution rule); scopeId
// is a TARGET selector, not an authority claim. Authority is intentionally
// permissive (Nil): any authenticated caller (agent token OR user cookie) may
// read/write ANY scope and ANY existing target — there is deliberately NO
// room/agent/boss access gate, only target-EXISTENCE validation. Restraint lives
// in the system-prompt affordance, not in code.
//
// The one structural privacy property is in AUTO-LOAD (agent-manager), not here:
// a boss's notes auto-load only into that boss's own agents' prompts. REST reads
// of any scope are open to any authenticated caller (design §2/§3) — boss memory
// is context-scoped for auto-load, not REST-private.
//
// LEAF over the executor + injected MemoryDeps. No manager/auth imports.

import {
  ok,
  created,
  noContent,
  fail,
  type RouteHandler,
} from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type { MemoryItem, MemoryScope } from "../../../shared/types.ts";
import { isValidFactType } from "../../../shared/types.ts";
import type {
  MemoryCreateReq,
  MemoryUpdateReq,
} from "../../../shared/contract-shapes.ts";

// The stable line id (mem:ab12cd). A :id path param must match before we hunt for
// it; a malformed id is a 400, not a 404.
const MEM_ID = /^[0-9a-f]{6}$/;

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
  // Target-EXISTENCE checks. Existence only — there is deliberately NO access
  // gate (the model is permissive per Nil); never reuse requiresRoomAccess, which
  // would silently undo that.
  roomExists(roomId: string): boolean;
  agentExists(agentId: string): boolean;
  userExists(userId: string): boolean;
  // Append-only edit/retract. Return null if targetId is not an ACTIVE id in the
  // target file (absent / already superseded / already tombstoned).
  supersede(input: {
    scope: MemoryScope;
    scopeId: string | null;
    targetId: string;
    author: string;
    text: string;
  }): MemoryItem | null;
  tombstone(input: {
    scope: MemoryScope;
    scopeId: string | null;
    targetId: string;
    author: string;
  }): MemoryItem | null;
}

type Target =
  | { scope: MemoryScope; scopeId: string | null }
  | { error: ReturnType<typeof fail> };

export function memoryHandlers(deps: MemoryDeps): Record<string, RouteHandler> {
  // Resolve the (scope, target file) for this caller, or a deliberate error.
  // Shared by GET (query) and POST (body).
  //   agent  — omitted scopeId defaults to the caller's own agent (agent token);
  //            a user cookie must pass an explicit agent id. Any existing agent
  //            may be targeted by any authenticated caller.
  //   room   — scopeId required + must EXIST.
  //   office — never takes a scopeId (always office.md).
  //   boss   — omitted scopeId defaults to the caller's own/manager userId; any
  //            existing boss may be targeted by any authenticated caller.
  //   other  — unsupported.
  // opts.allowDefaults=false (PATCH/DELETE) requires an EXPLICIT target — no
  // own/manager default — so an edit/retract can never hit the wrong file.
  function resolveTarget(
    identity: Identity,
    scope: unknown,
    rawScopeId: unknown,
    opts: { allowDefaults: boolean } = { allowDefaults: true },
  ): Target {
    if (scope === "agent") {
      if (rawScopeId === undefined || rawScopeId === null) {
        if (
          opts.allowDefaults &&
          identity.scope === "agent" &&
          identity.agentId
        ) {
          return { scope: "agent", scopeId: identity.agentId };
        }
        return {
          error: fail(
            400,
            "invalid_scope_id",
            "agent scope requires a scopeId",
          ),
        };
      }
      if (typeof rawScopeId !== "string" || !deps.isSafeScopeId(rawScopeId)) {
        return { error: fail(400, "invalid_scope_id", "scopeId is malformed") };
      }
      if (!deps.agentExists(rawScopeId)) {
        return { error: fail(404, "agent_not_found", "no such agent") };
      }
      return { scope: "agent", scopeId: rawScopeId };
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
    if (scope === "boss") {
      if (rawScopeId === undefined || rawScopeId === null) {
        // Default to the caller's own/manager user (create/read only). An agent
        // token with no manager userId has no default -> 400 (never bosses/null.md).
        if (!opts.allowDefaults) {
          return {
            error: fail(
              400,
              "invalid_scope_id",
              "boss scope requires a scopeId",
            ),
          };
        }
        const own = identity.userId;
        if (!own) {
          return {
            error: fail(
              400,
              "invalid_scope_id",
              "boss scope requires a scopeId (caller has no associated user)",
            ),
          };
        }
        if (!deps.userExists(own)) {
          return { error: fail(404, "user_not_found", "no such user") };
        }
        return { scope: "boss", scopeId: own };
      }
      if (typeof rawScopeId !== "string" || !deps.isSafeScopeId(rawScopeId)) {
        return { error: fail(400, "invalid_scope_id", "scopeId is malformed") };
      }
      if (!deps.userExists(rawScopeId)) {
        return { error: fail(404, "user_not_found", "no such user") };
      }
      return { scope: "boss", scopeId: rawScopeId };
    }
    return {
      error: fail(
        400,
        "unsupported_scope",
        "scope must be agent, room, office, or boss",
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

    // Edit by id: append a supersede line (never an in-place rewrite). The target
    // file is EXPLICIT (scope + scopeId, no defaults) since :id is unique only
    // within a file. Reuses the create text validation.
    "memory.update": (ctx) => {
      const id = ctx.params.id;
      if (!MEM_ID.test(id)) {
        return fail(400, "invalid_id", "malformed memory id");
      }
      const body = (ctx.body ?? {}) as Partial<MemoryUpdateReq>;
      if (typeof body.text !== "string") {
        return fail(400, "invalid_text", "text is required");
      }
      if (/[\r\n]/.test(body.text)) {
        return fail(400, "invalid_text", "text must be a single line");
      }
      const text = body.text.trim();
      if (text.length === 0) {
        return fail(400, "invalid_text", "text must not be blank");
      }
      const target = resolveTarget(ctx.identity, body.scope, body.scopeId, {
        allowDefaults: false,
      });
      if ("error" in target) return target.error;
      const author = deps.authorFor(ctx.identity);
      if (!author) {
        return fail(
          404,
          "agent_not_found",
          "caller identity could not be resolved",
        );
      }
      const item = deps.supersede({
        scope: target.scope,
        scopeId: target.scopeId,
        targetId: id,
        author,
        text,
      });
      if (!item) {
        return fail(
          404,
          "memory_not_found",
          "no active memory with that id in the target",
        );
      }
      return ok(item);
    },

    // Retract by id: append a tombstone line. Explicit target via query params.
    "memory.delete": (ctx) => {
      const id = ctx.params.id;
      if (!MEM_ID.test(id)) {
        return fail(400, "invalid_id", "malformed memory id");
      }
      const scope = ctx.query.get("scope") ?? undefined;
      const scopeId = ctx.query.get("scopeId") ?? undefined;
      const target = resolveTarget(ctx.identity, scope, scopeId, {
        allowDefaults: false,
      });
      if ("error" in target) return target.error;
      const author = deps.authorFor(ctx.identity);
      if (!author) {
        return fail(
          404,
          "agent_not_found",
          "caller identity could not be resolved",
        );
      }
      const item = deps.tombstone({
        scope: target.scope,
        scopeId: target.scopeId,
        targetId: id,
        author,
      });
      if (!item) {
        return fail(
          404,
          "memory_not_found",
          "no active memory with that id in the target",
        );
      }
      return noContent();
    },
  };
}
