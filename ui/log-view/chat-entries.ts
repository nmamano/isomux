import type { LogEntry } from "../../shared/types.ts";

// Log kinds the chat never shows. Both are the server's sender-side record of a
// message the agent sent; the curl card of the same tool call is the view
// (Nil, 2026-09-07). They stay in the log for search and summaries.
export const CHAT_HIDDEN_KINDS: readonly LogEntry["kind"][] = [
  "agent_outbound",
  "api_token_outbound",
];

export function isChatHidden(entry: LogEntry): boolean {
  return CHAT_HIDDEN_KINDS.includes(entry.kind);
}

// An agent log as the chat shows it. Filter the list, not the card: turn
// grouping, the turn copy button and the live tail count every entry they get.
export function chatVisibleEntries(logs: LogEntry[]): LogEntry[] {
  return logs.some(isChatHidden)
    ? logs.filter((entry) => !isChatHidden(entry))
    : logs;
}
