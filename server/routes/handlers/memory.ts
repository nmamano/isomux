// Memory resource handlers - isomux-memory on the unified REST surface. Three
// verbs: READ (memory.read), APPEND (memory.append), REPLACE (memory.replace).
// See internal-docs/isomux-memory-design.md.
//
// Scopes: agent, room, office, member. On APPEND the author + date are server-
// stamped from the token identity, NEVER the body; scopeId is a TARGET selector,
// not an authority claim. Access follows the rooms (task bf94d714):
//   room   - read and write: whoever reaches the room.
//   member - read: whoever shares a live ordinary room with the member
//            (sharesRoomWithMember); write: the member, their agents and
//            tokens, and an office owner's reach.
//   agent  - write: the agent, and whoever can edit its instructions
//            (agents.setInstructions); read: those, and whoever reaches the
//            agent's room (its system prompt, which holds this memory, has
//            that audience).
//   office - any authenticated caller.
// A scope the caller cannot read answers as missing (404); one it reads but
// cannot write answers 403. A pack's memory area limits it further.
//
// Auto-load is separate (agent-manager): a member's notes auto-load only into
// that member's own agents' prompts.
//
// LEAF over the executor + injected MemoryDeps. No manager/auth/store imports.

import { ok, created, fail, type RouteHandler } from "../executor.ts";
import {
  injectedSize,
  MEMORY_LINE_MAX,
  MemoryCapError,
  MemoryLineTooLongError,
} from "../../memory-store.ts";
import { MEMORY_CAPS } from "../../../shared/memory-caps.ts";
import type { Identity } from "../../identity/index.ts";
import type { MemoryItem, MemoryScope } from "../../../shared/types.ts";
import type {
  MemoryCreateReq,
  MemoryReplaceReq,
} from "../../../shared/contract-shapes.ts";

export interface MemoryDeps {
  // The live room-access rule (GuardDeps.hasRoomAccess): token rooms and
  // packs apply.
  hasRoomAccess(identity: Identity, roomId: string): boolean;
  // GuardDeps-backed sharesRoomWithMember and hasOfficeOwnerReach.
  sharesRoomWithMember(identity: Identity, userId: string): boolean;
  hasOfficeOwnerReach(identity: Identity): boolean;
  // Whether the identity passes agents.setInstructions for this agent, as the
  // executor checks it (authorizeRoute).
  editsAgentInstructions(identity: Identity, agentId: string): boolean;
  // A live agent's room, or null.
  agentRoomId(agentId: string): string | null;
  // Whole raw file + optimistic-concurrency version.
  read(
    scope: MemoryScope,
    scopeId: string | null,
  ): { text: string; version: string };
  // Append one server-stamped line; returns the new item + post-write version.
  // authorAgentId is the caller's own agentId (agent tokens only) - the store
  // uses it to skip the redundant author stamp on an agent's notes to itself.
  append(input: {
    scope: MemoryScope;
    scopeId: string | null;
    author: string;
    authorAgentId?: string | null;
    text: string;
  }): { item: MemoryItem; version: string; size: number; cap: number };
  // Overwrite the whole file guarded by expectedVersion; conflict writes nothing.
  replace(input: {
    scope: MemoryScope;
    scopeId: string | null;
    text: string;
    author: string;
    expectedVersion: string;
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
  // Target-EXISTENCE checks: the target's display name, or null when it does
  // not exist. Access is checked in resolveTarget.
  roomName(roomId: string): string | null;
  agentName(agentId: string): string | null;
  userName(userId: string): string | null;
}

// `name` is the room or member name the auto-load label shows, or the agent's
// name (null for office), so a reader can join a READ to the block in its prompt.
type Target =
  | { scope: MemoryScope; scopeId: string | null; name: string | null }
  | { error: ReturnType<typeof fail> };

export function memoryHandlers(deps: MemoryDeps): Record<string, RouteHandler> {
  // Who writes agent memory: the agent, and whoever can edit its
  // instructions.
  function writesAgent(identity: Identity, agentId: string): boolean {
    if (identity.scope === "agent" && identity.agentId === agentId) return true;
    return deps.editsAgentInstructions(identity, agentId);
  }

  function readsAgent(identity: Identity, agentId: string): boolean {
    if (writesAgent(identity, agentId)) return true;
    const roomId = deps.agentRoomId(agentId);
    return roomId !== null && deps.hasRoomAccess(identity, roomId);
  }

  function writesMember(identity: Identity, userId: string): boolean {
    return identity.userId === userId || deps.hasOfficeOwnerReach(identity);
  }

  // Resolve the (scope, target file) for this caller, or a deliberate error.
  // Shared by READ (query) and APPEND/REPLACE (body).
  //   agent  - omitted scopeId defaults to the caller's own agent (agent token);
  //            a user cookie must pass an explicit agent id.
  //   room   - scopeId required + must EXIST.
  //   office - never takes a scopeId (always office.md).
  //   member - omitted scopeId defaults to the caller's own/manager userId.
  //   other  - unsupported.
  // A target the caller cannot read answers as missing; one it reads but
  // cannot write (a write verb) answers 403.
  function resolveTarget(
    identity: Identity,
    scope: unknown,
    rawScopeId: unknown,
    verb: "read" | "write",
  ): Target {
    if (scope === "agent") {
      if (rawScopeId === undefined || rawScopeId === null) {
        if (identity.scope === "agent" && identity.agentId) {
          return {
            scope: "agent",
            scopeId: identity.agentId,
            name: deps.agentName(identity.agentId),
          };
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
      const name = deps.agentName(rawScopeId);
      if (name === null || !readsAgent(identity, rawScopeId)) {
        return { error: fail(404, "agent_not_found", "no such agent") };
      }
      if (verb === "write" && !writesAgent(identity, rawScopeId)) {
        return {
          error: fail(
            403,
            "memory_write_forbidden",
            "only the agent and whoever can edit its instructions can change this memory",
          ),
        };
      }
      return { scope: "agent", scopeId: rawScopeId, name };
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
      const name = deps.roomName(rawScopeId);
      if (name === null || !deps.hasRoomAccess(identity, rawScopeId)) {
        return { error: fail(404, "room_not_found", "no such room") };
      }
      return { scope: "room", scopeId: rawScopeId, name };
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
      return { scope: "office", scopeId: null, name: null };
    }
    if (scope === "member") {
      if (rawScopeId === undefined || rawScopeId === null) {
        // Default to the caller's own/manager user. An agent token with no
        // manager userId has no default -> 400 (never members/null.md).
        const own = identity.userId;
        if (!own) {
          return {
            error: fail(
              400,
              "invalid_scope_id",
              "member scope requires a scopeId (caller has no associated user)",
            ),
          };
        }
        const name = deps.userName(own);
        if (name === null) {
          return { error: fail(404, "user_not_found", "no such user") };
        }
        return { scope: "member", scopeId: own, name };
      }
      if (typeof rawScopeId !== "string" || !deps.isSafeScopeId(rawScopeId)) {
        return { error: fail(400, "invalid_scope_id", "scopeId is malformed") };
      }
      const name = deps.userName(rawScopeId);
      if (name === null || !deps.sharesRoomWithMember(identity, rawScopeId)) {
        return { error: fail(404, "user_not_found", "no such user") };
      }
      if (verb === "write" && !writesMember(identity, rawScopeId)) {
        return {
          error: fail(
            403,
            "memory_write_forbidden",
            "only the member, their agents, and office owners and their agents can change this memory",
          ),
        };
      }
      return { scope: "member", scopeId: rawScopeId, name };
    }
    return {
      error: fail(
        400,
        "unsupported_scope",
        "scope must be agent, room, office, or member",
      ),
    };
  }

  return {
    // READ - the whole raw file text + version (uncapped). For the read-modify-
    // replace edit flow and for human curation.
    "memory.read": (ctx) => {
      const scope = ctx.query.get("scope") ?? "agent";
      const scopeId = ctx.query.get("scopeId") ?? undefined;
      const target = resolveTarget(ctx.identity, scope, scopeId, "read");
      if ("error" in target) return target.error;
      const memory = deps.read(target.scope, target.scopeId);
      return ok({
        ...memory,
        size: injectedSize(memory.text),
        cap: MEMORY_CAPS[target.scope],
        scopeId: target.scopeId,
        name: target.name,
      });
    },

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
      const target = resolveTarget(
        ctx.identity,
        body.scope,
        body.scopeId,
        "write",
      );
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
      // Caps are hard: a line that would put the scope over its injected-size
      // cap is refused here, loudly, instead of ever being trimmed later.
      try {
        const res = deps.append({
          scope: target.scope,
          scopeId: target.scopeId,
          author,
          // Only an AGENT token can be writing to its own agent scope; a user
          // cookie always names a human, so it passes null and stays stamped.
          authorAgentId:
            ctx.identity.scope === "agent"
              ? (ctx.identity.agentId ?? null)
              : null,
          text,
        });
        return created(res);
      } catch (e) {
        if (e instanceof MemoryLineTooLongError) {
          return fail(
            422,
            "memory_line_too_long",
            `a memory must fit in ${MEMORY_LINE_MAX} characters of text (this one is ${e.size}). A fact that needs more than that is not a trigger: put the detail in a doc or the task record and save a pointer to it.`,
            { size: e.size, cap: MEMORY_LINE_MAX },
          );
        }
        if (e instanceof MemoryCapError) {
          return fail(
            422,
            "memory_over_cap",
            `adding this would put the scope over its size cap (${e.size} of ${e.cap} chars). Trim this scope and save again, or drop the note - do not save it to a wider scope.`,
            { size: e.size, cap: e.cap },
          );
        }
        throw e;
      }
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
      const target = resolveTarget(
        ctx.identity,
        body.scope,
        body.scopeId,
        "write",
      );
      if ("error" in target) return target.error;
      const author = deps.authorFor(ctx.identity);
      if (!author) {
        return fail(
          404,
          "agent_not_found",
          "caller identity could not be resolved",
        );
      }
      // Caps are hard on growth too; a replace that shrinks a legacy over-cap
      // file is allowed (see memory-store), so incremental trims go through.
      let res;
      try {
        res = deps.replace({
          scope: target.scope,
          scopeId: target.scopeId,
          text: body.text,
          author,
          expectedVersion: body.version,
        });
      } catch (e) {
        if (e instanceof MemoryCapError) {
          return fail(
            422,
            "memory_over_cap",
            `the new contents exceed this scope's size cap (${e.size} of ${e.cap} chars); trim further`,
            { size: e.size, cap: e.cap },
          );
        }
        throw e;
      }
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
