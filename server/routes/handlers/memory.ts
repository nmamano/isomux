// Memory resource handlers — slice 3a (the tracer). isomux-memory on the unified
// REST surface (opIds memory.{list,create}). See
// internal-docs/isomux-memory-design.md and plans/isomux-memory-loop.md.
//
// 3a is the THIN vertical: AGENT scope only — an agent reads/writes its OWN
// memory file. Author + date are server-stamped from the token identity, NEVER
// the body (mirrors tasks' attribution rule); scopeId is a TARGET selector, not
// an authority claim. In 3a an agent may only target its own file; cross-agent
// and room/office/boss land in later slices. Every non-agent / non-own / non-
// agent-caller path returns a DELIBERATE error so the temporary 3a posture can't
// be mistaken for the final permissive model.
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
}

type AgentTarget = { agentId: string } | { error: ReturnType<typeof fail> };

export function memoryHandlers(deps: MemoryDeps): Record<string, RouteHandler> {
  // Resolve the target agentId for an AGENT-scope caller in 3a, or an explicit
  // error for any path 3a does not yet support.
  function resolveAgentTarget(
    identity: Identity,
    scope: unknown,
    rawScopeId: unknown,
  ): AgentTarget {
    if (scope !== "agent") {
      return {
        error: fail(
          400,
          "unsupported_scope",
          'only scope:"agent" is supported in this version',
        ),
      };
    }
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
    if (rawScopeId === undefined || rawScopeId === null)
      return { agentId: own };
    if (typeof rawScopeId !== "string" || !deps.isSafeScopeId(rawScopeId)) {
      return { error: fail(400, "invalid_scope_id", "scopeId is malformed") };
    }
    if (rawScopeId !== own) {
      return {
        error: fail(
          403,
          "forbidden",
          "an agent may only access its own memory",
        ),
      };
    }
    return { agentId: own };
  }

  return {
    "memory.list": (ctx) => {
      const scope = ctx.query.get("scope") ?? "agent";
      const scopeId = ctx.query.get("scopeId") ?? undefined;
      const target = resolveAgentTarget(ctx.identity, scope, scopeId);
      if ("error" in target) return target.error;
      return ok(deps.read("agent", target.agentId));
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
      const target = resolveAgentTarget(ctx.identity, body.scope, body.scopeId);
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
        scope: "agent",
        scopeId: target.agentId,
        author,
        text,
      });
      return created(item);
    },
  };
}
