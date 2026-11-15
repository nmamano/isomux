import type { LogEntry } from "./types.ts";

// The command a permission denial refused: the Bash call with the denial's
// toolUseId, when its command is one line. The refused card shows Run for it,
// and the server runs only this command for that denial (task 0faacc4e).
export function commandForPermissionDenial(
  denial: { toolUseId?: string },
  entries: readonly LogEntry[] | undefined,
): string | null {
  if (!denial.toolUseId || !entries) return null;
  const call = entries.find(
    (entry) =>
      entry.kind === "tool_call" && entry.metadata?.toolId === denial.toolUseId,
  );
  if (!call || call.content !== "Bash") return null;
  const command = (call.metadata?.input as { command?: unknown } | undefined)
    ?.command;
  if (typeof command !== "string" || /[\r\n]/.test(command)) return null;
  return command;
}
