// A schedule's agent target (task a0c26f59): the request shape, and the
// answers of the routes that need a session such a job never runs.

import {
  CRONJOB_COMMAND_MAX,
  type CronjobRun,
  type CronjobTarget,
} from "../shared/types.ts";

// The answer to a send or an edit into a run that messaged an agent.
export const TARGET_RUN_NOT_RESUMABLE =
  "This run sent a message to an agent. It has no session to continue.";

// The answer to a send or an edit into a run of a command job.
export const COMMAND_RUN_NOT_RESUMABLE =
  "Command runs have no session to continue.";

// Why nothing can be sent into `run`, or null when it has a session: a run
// that ran a command or sent a message to an agent has none.
export function runWithoutSession(
  run: Pick<CronjobRun, "commandSnapshot" | "targetAgentSnapshot">,
): string | null {
  if (run.commandSnapshot !== undefined) return COMMAND_RUN_NOT_RESUMABLE;
  return run.targetAgentSnapshot ? TARGET_RUN_NOT_RESUMABLE : null;
}

// The answer to a system prompt read of a job that messages an agent (with or
// without a command).
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

// A request body's command: a command, null (PATCH: remove it), or the reason
// it is neither. A command is a non-empty string after trim, at most
// CRONJOB_COMMAND_MAX characters.
export function parseCronjobCommand(
  value: unknown,
): { ok: true; command: string | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, command: null };
  if (typeof value !== "string" || value.trim().length === 0)
    return { ok: false, error: "command must be a non-empty string or null" };
  if (value.length > CRONJOB_COMMAND_MAX)
    return {
      ok: false,
      error: `command must be at most ${CRONJOB_COMMAND_MAX} characters`,
    };
  return { ok: true, command: value };
}

// The answer to a command set on a job with no agent target.
export const COMMAND_NEEDS_TARGET =
  "A schedule with a command needs an agent target.";

// The answer to a removed command that leaves a job with no prompt.
export const MESSAGE_NEEDS_PROMPT =
  "A schedule that only messages an agent needs a prompt.";
