// Memory resource handlers - isomux-memory on the unified REST surface. Three
// verbs: READ (memory.read), APPEND (memory.append), REPLACE (memory.replace).
// See internal-docs/isomux-memory-design.md.
//
// Scopes: agent, room, office, boss. On APPEND the author + date are server-
// stamped from the token identity, NEVER the body; scopeId is a TARGET selector,
// not an authority claim. Authority is intentionally permissive (Nil's product
// decision): any authenticated caller (agent token OR user cookie) may read,
// append, or REPLACE ANY scope and ANY existing target - there is deliberately NO
// per-scope access gate on any verb, only target-EXISTENCE validation. Restraint
// (especially "don't make big changes to office-wide memory") lives in the
// system-prompt affordance, and the op-log is the recovery net - not an
// authorization boundary.
//
// The one structural privacy property is in AUTO-LOAD (agent-manager), not here:
// a boss's notes auto-load only into that boss's own agents' prompts. REST reads
// of any scope are open to any authenticated caller - boss memory is
// context-scoped for auto-load, not REST-private.
//
// LEAF over the executor + injected MemoryDeps. No manager/auth/store imports.

import { ok, created, fail, type RouteHandler } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import type { MemoryItem, MemoryScope } from "../../../shared/types.ts";
import type {
  MemoryCreateReq,
  MemoryReplaceReq,
} from "../../../shared/contract-shapes.ts";

export interface MemoryDeps {
  // Whole raw file + optimistic-concurrency version.
  read(
    scope: MemoryScope,
    scopeId: string | null,
  ): { text: string; version: string };
  // Append one server-stamped line; returns the new item + post-write version.
  append(input: {
    scope: MemoryScope;
    scopeId: string | null;
    author: string;
    text: string;
  }): { item: MemoryItem; version: string };
  // Overwrite the whole file guarded by expectedVersion; conflict writes nothing.
  replace(input: {
    scope: MemoryScope;
    scopeId: string | null;
    text: string;
    author: string;
    expectedVersion?: string | null;
  }):
    | { ok: true; version: string }
    | { ok: false; conflict: true; version: string };
  // The first line `text` exactly restates (append-time dedup guard), or null.
  findDuplicate(
    scope: MemoryScope,
    scopeId: string | null,
    text: string,
  ): MemoryItem | null;
  // The caller's display author (agent name / user name), or null if the caller's
  // record can't be resolved - so a write is never stamped "unknown".
  authorFor(identity: Identity): string | null;
  // Strict identifier guard (rejects path traversal in a caller-supplied scopeId).
  isSafeScopeId(id: string): boolean;
  // Target-EXISTENCE checks. Existence only - there is deliberately NO access
  // gate (the model is permissive per Nil); never reuse requiresRoomAccess.
  roomExists(roomId: string): boolean;
  agentExists(agentId: string): boolean;
  userExists(userId: string): boolean;
}

type Target =
  | { scope: MemoryScope; scopeId: string | null }
  | { error: ReturnType<typeof fail> };

export function memoryHandlers(deps: MemoryDeps): Record<string, RouteHandler> {
  // Resolve the (scope, target file) for this caller, or a deliberate error.
  // Shared by READ (query) and APPEND/REPLACE (body).
  //   agent  - omitted scopeId defaults to the caller's own agent (agent token);
  //            a user cookie must pass an explicit agent id. Any existing agent
  //            may be targeted by any authenticated caller.
  //   room   - scopeId required + must EXIST.
  //   office - never takes a scopeId (always office.md).
  //   boss   - omitted scopeId defaults to the caller's own/manager userId; any
  //            existing boss may be targeted by any authenticated caller.
  //   other  - unsupported.
  function resolveTarget(
    identity: Identity,
    scope: unknown,
    rawScopeId: unknown,
  ): Target {
    if (scope === "agent") {
      if (rawScopeId === undefined || rawScopeId === null) {
        if (identity.scope === "agent" && identity.agentId) {
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
        // Default to the caller's own/manager user. An agent token with no
        // manager userId has no default -> 400 (never bosses/null.md).
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
    // READ - the whole raw file text + version (uncapped). For the read-modify-
    // replace edit flow and for human curation.
    "memory.read": (ctx) => {
      const scope = ctx.query.get("scope") ?? "agent";
      const scopeId = ctx.query.get("scopeId") ?? undefined;
      const target = resolveTarget(ctx.identity, scope, scopeId);
      if ("error" in target) return target.error;
      return ok(deps.read(target.scope, target.scopeId));
    },

    // APPEND - one server-stamped line (the safe default). One fact per line.
    "memory.append": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<MemoryCreateReq>;
      if (typeof body.text !== "string") {
        return fail(400, "invalid_text", "text is required");
      }
      // Reject newlines on the RAW body BEFORE trimming - otherwise a trailing
      // "\n"/"\r" would normalize into a valid single line, smuggling a multi-line
      // payload past the one-fact-per-line rail.
      if (/[\r\n]/.test(body.text)) {
        return fail(400, "invalid_text", "text must be a single line");
      }
      const text = body.text.trim();
      if (text.length === 0) {
        return fail(400, "invalid_text", "text must not be blank");
      }
      const target = resolveTarget(ctx.identity, body.scope, body.scopeId);
      if ("error" in target) return target.error;
      // Write-time dedup guard: reject an exact restatement already in this scope,
      // naming the existing line's text.
      const dup = deps.findDuplicate(target.scope, target.scopeId, text);
      if (dup) {
        return fail(
          409,
          "duplicate_memory",
          "a matching memory already exists in this scope",
          { matched: { text: dup.text } },
        );
      }
      const author = deps.authorFor(ctx.identity);
      if (!author) {
        return fail(
          404,
          "agent_not_found",
          "caller identity could not be resolved",
        );
      }
      const res = deps.append({
        scope: target.scope,
        scopeId: target.scopeId,
        author,
        text,
      });
      return created(res);
    },

    // REPLACE - overwrite the whole file, guarded by the version from READ. This
    // is how edits and retractions happen; raw text is written verbatim (no
    // grammar). A version mismatch is a 409 with the current version.
    "memory.replace": (ctx) => {
      const body = (ctx.body ?? {}) as Partial<MemoryReplaceReq>;
      if (typeof body.text !== "string") {
        return fail(400, "invalid_text", "text is required");
      }
      if (typeof body.version !== "string" || body.version.length === 0) {
        return fail(
          400,
          "invalid_version",
          "version is required (from a preceding READ)",
        );
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
      const res = deps.replace({
        scope: target.scope,
        scopeId: target.scopeId,
        text: body.text,
        author,
        expectedVersion: body.version,
      });
      if (!res.ok) {
        return fail(
          409,
          "memory_conflict",
          "the memory file changed since your READ; re-read and retry",
          { version: res.version },
        );
      }
      return ok({ version: res.version });
    },
  };
}
