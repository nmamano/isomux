import { apiFetch } from "../api.ts";

// "Send now" for a busy agent, shared by the full chat and the agent widget:
// the server interrupts the current turn and delivers the queue.
export function sendQueueNow(agentId: string): void {
  apiFetch("POST", `/api/agents/${agentId}/send-now`).catch(() => {});
}

// Ctrl/Cmd+Enter in a composer means "deliver now". Check it before a plain
// Enter branch, whose condition also matches modifier+Enter.
export function isSendNowKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey);
}
