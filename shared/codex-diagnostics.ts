import type { LogEntry } from "./types.ts";

/** Codex repeats an unresolved history warning each time it processes the thread. */
export function filterMissingToolOutputRepeats(
  text: string,
  seen: Set<string>,
): string {
  return text
    .split("\n")
    .filter((line) => {
      const match = line.match(
        /^(?:\[codex stderr\] )?(?:\S+\s+)?ERROR\s+codex_core::util:\s+Custom tool call output is missing for call id:\s*(\S+)\s*$/,
      );
      if (!match) return true;
      if (seen.has(match[1])) return false;
      seen.add(match[1]);
      return true;
    })
    .join("\n");
}

/** Also coalesce diagnostics already saved before the backend fix. */
export function coalesceCodexDiagnostics(entries: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    if (entry.kind !== "system" || !entry.content.startsWith("[codex stderr]"))
      return [entry];
    const content = filterMissingToolOutputRepeats(entry.content, seen);
    return content.trim()
      ? [content === entry.content ? entry : { ...entry, content }]
      : [];
  });
}
