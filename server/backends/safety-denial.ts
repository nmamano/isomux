import type { SafetyDenial } from "../safety-hooks.ts";
import type { NormalizedEvent } from "./types.ts";

// The refused card of a safety hook refusal, for every backend (Claude's
// hooks, the Codex hook's report, the OpenCode plugin's denied event; task
// fcfffe51): the reason on one line, and its "Reason:" line as the card's
// text. `agentId`: the subagent the refused call came from.
export function safetyDenialEvent(
  denial: SafetyDenial,
  agentId?: string,
): NormalizedEvent {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const reasonLine = /^Reason: (.+)$/m.exec(denial.reason)?.[1];
  return {
    kind: "permission_denied",
    toolUseId: denial.toolUseId,
    toolName: denial.toolName,
    message: oneLine(denial.reason),
    decisionReason: oneLine(reasonLine ?? denial.reason),
    ...(agentId ? { agentId } : {}),
  };
}
