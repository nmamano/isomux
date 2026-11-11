// The Inbox items that come from live agent state, not from asks (task
// ddf02829): an agent waiting on a permission request, and an agent that
// failed. Who sees which item is decided here, in one place.

import type {
  AgentChoiceInteraction,
  AgentFailure,
  AgentInfo,
} from "../shared/types.ts";

export type AgentInboxItem =
  | {
      kind: "permission";
      key: string;
      agentId: string;
      roomId: string;
      // Null when the engine shows no choices (it reads the answer in chat).
      interaction: AgentChoiceInteraction | null;
    }
  | {
      kind: "failed";
      key: string;
      agentId: string;
      roomId: string;
      failure: AgentFailure;
    };

/** The dismiss key of a failure (UserRecord.inboxDismissed). */
export function failureKey(agentId: string, since: number): string {
  return `${agentId}:${since}`;
}

/**
 * The items `me` sees, permission items first (agent list order), then the
 * failed items, newest first. A permission item shows for every agent the
 * member can see; a failed item only to the agent's manager and the members
 * who started the failed turn, until they dismiss it.
 */
export function agentInboxItems(
  agents: readonly AgentInfo[],
  interactions: readonly AgentChoiceInteraction[],
  me: string | null,
  dismissed: readonly string[],
): AgentInboxItem[] {
  const permissions: AgentInboxItem[] = [];
  const failures: (AgentInboxItem & { kind: "failed" })[] = [];
  const gone = new Set(dismissed);
  for (const agent of agents) {
    if (agent.pendingPrompt === "permission") {
      const interaction =
        interactions.find(
          (i) => i.agentId === agent.id && i.kind === "permission",
        ) ?? null;
      permissions.push({
        kind: "permission",
        // Without an interaction the key is the agent's, so once seen it
        // stays seen for that agent's later prompts too. Acceptable: only an
        // engine that reads the answer in chat has none.
        key: `permission:${interaction?.id ?? agent.id}`,
        agentId: agent.id,
        roomId: agent.roomId,
        interaction,
      });
    }
    const failure = agent.failure;
    if (
      failure &&
      me !== null &&
      (agent.userId === me || failure.memberIds.includes(me))
    ) {
      const key = failureKey(agent.id, failure.since);
      if (!gone.has(key))
        failures.push({
          kind: "failed",
          key: `failed:${key}`,
          agentId: agent.id,
          roomId: agent.roomId,
          failure,
        });
    }
  }
  failures.sort((a, b) => b.failure.since - a.failure.since);
  return [...permissions, ...failures];
}

/**
 * The line a failed card shows (Nil, 2026-11-11 sign-off): the first line of
 * the error that is not blank, trimmed; "" when every line is blank. The
 * chat has the full text.
 */
export function failureFirstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}
