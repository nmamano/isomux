// The agent's failure record (AgentInfo.failure, task ddf02829): when it is
// set, kept or cleared as the agent changes state. The Inbox shows it to the
// agent's manager and to the members who started the failed turn.

import type { AgentFailure, AgentState } from "../shared/types.ts";
import {
  logTextFields,
  msg,
  type LogPart,
} from "../shared/i18n/log-message.ts";

export interface NextFailureInput {
  current: AgentFailure | null;
  prevState: AgentState;
  nextState: AgentState;
  // The text of the last error entry of this turn (the stash is cleared at
  // every turn start), or null when the turn wrote none.
  lastError: { content: string; message?: LogPart[]; at: number } | null;
  turnMemberIds: readonly string[];
  now: number;
}

/**
 * The failure after a state change. A new failure on a transition into
 * error, or on a new error entry after current.since; null at a real turn
 * start (thinking/tool_executing); otherwise `current`, the same object, so
 * the caller can skip the broadcast and the persist write.
 */
export function nextFailure(input: NextFailureInput): AgentFailure | null {
  const { current, prevState, nextState, lastError, now } = input;
  if (nextState === "thinking" || nextState === "tool_executing") return null;
  if (nextState !== "error") return current;
  const newEntry =
    lastError !== null && (current === null || lastError.at > current.since);
  if (prevState === "error" && current !== null && !newEntry) return current;
  // A transition that wrote no error text (a restore failure, a failed
  // hand-off) still gets a line of its own, never an older failure's.
  const text = lastError ?? logTextFields(msg("systemEntries.turnFailed"));
  return {
    since: now,
    content: text.content,
    ...(text.message !== undefined ? { message: text.message } : {}),
    memberIds: [...input.turnMemberIds],
  };
}

/**
 * A failure read back from agents.json, or undefined when the value is not
 * one (absent, or a hand edit the record cannot use).
 */
export function persistedFailure(value: unknown): AgentFailure | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.since !== "number" ||
    typeof v.content !== "string" ||
    !Array.isArray(v.memberIds) ||
    !v.memberIds.every((id) => typeof id === "string")
  )
    return undefined;
  return {
    since: v.since,
    content: v.content,
    ...(Array.isArray(v.message) ? { message: v.message as LogPart[] } : {}),
    memberIds: [...v.memberIds],
  };
}
