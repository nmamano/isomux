// A schedule's agent target (task a0c26f59): the request shape, and the
// answers of the routes that need a session such a job never runs.

import type { CronjobTarget } from "../shared/types.ts";

// The answer to a send or an edit into a run that messaged an agent.
export const TARGET_RUN_NOT_RESUMABLE =
  "This run sent a message to an agent. It has no session to continue.";

// The answer to a system prompt read of a job that messages an agent.
export const TARGET_HAS_NO_SESSION =
  "This schedule sends a message to an agent. No session runs, so it has no system prompt.";

// A request body's target: a target, null (PATCH: back to a session), or the
// reason it is neither. Extra keys are dropped.
export function parseCronjobTarget(
  value: unknown,
): { ok: true; target: CronjobTarget | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, target: null };
  if (typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "target must be an object or null" };
  const t = value as Record<string, unknown>;
  if (t.kind !== "agent")
    return { ok: false, error: 'target.kind must be "agent"' };
  if (typeof t.agentId !== "string" || t.agentId.length === 0)
    return { ok: false, error: "target.agentId must be a non-empty string" };
  return { ok: true, target: { kind: "agent", agentId: t.agentId } };
}
