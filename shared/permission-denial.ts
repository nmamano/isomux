import type { LogEntry } from "./types.ts";

// The shell tools' names: Claude's and Codex's Bash, and OpenCode's shell
// under both of its names (task fcfffe51).
const SHELL_TOOLS = new Set(["Bash", "shell", "bash"]);

// The command a permission denial refused: the shell call with the denial's
// toolUseId, when its command is one line and it ran in the agent's folder
// (Run runs in the terminal panel's folder, so a call with its own workdir
// has none). The refused card shows Run for it, and the server runs only this
// command for that denial (task 0faacc4e).
export function commandForPermissionDenial(
  denial: { toolUseId?: string },
  entries: readonly LogEntry[] | undefined,
): string | null {
  if (!denial.toolUseId || !entries) return null;
  const call = entries.find(
    (entry) =>
      entry.kind === "tool_call" && entry.metadata?.toolId === denial.toolUseId,
  );
  if (!call || !SHELL_TOOLS.has(call.content)) return null;
  const input = call.metadata?.input as
    { command?: unknown; workdir?: unknown } | undefined;
  if (input?.workdir !== undefined) return null;
  const command = input?.command;
  if (typeof command !== "string" || /[\r\n]/.test(command)) return null;
  return command;
}
