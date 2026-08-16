import type { LogEntry, SubagentOrigin } from "../../shared/types.ts";
import { parseIsomuxCurl, type IsomuxCurlRequest } from "./isomux-curl.ts";
import { isomuxUiPorts } from "./IsomuxCurlSummary.tsx";

export function isomuxRequestForToolCall(
  name: string,
  input: unknown,
): IsomuxCurlRequest | null {
  if (name !== "Bash" || !input || typeof input !== "object") return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string"
    ? parseIsomuxCurl(command, isomuxUiPorts)
    : null;
}

export type ToolEntryIndex = {
  toolCallIds: ReadonlySet<unknown>;
  resultByToolUseId: ReadonlyMap<unknown, LogEntry>;
};

export function buildToolEntryIndex(entries: LogEntry[]): ToolEntryIndex {
  const toolCallIds = new Set<unknown>();
  const resultByToolUseId = new Map<unknown, LogEntry>();
  for (const entry of entries) {
    if (entry.kind === "tool_call") {
      const toolId = entry.metadata?.toolId;
      toolCallIds.add(toolId);
    } else if (entry.kind === "tool_result") {
      const toolUseId = entry.metadata?.toolUseId;
      // Preserve Array.find semantics if malformed input repeats an id.
      if (toolUseId && !resultByToolUseId.has(toolUseId))
        resultByToolUseId.set(toolUseId, entry);
    }
  }
  return { toolCallIds, resultByToolUseId };
}

/**
 * True when this tool_result is paired with a tool_call in the same turn and
 * has nothing the user needs to see in its own row (no attachments). Folded
 * results are hidden - the tool_call's expand panel renders their text, and
 * errored results additionally show a compact preview inside their (red)
 * tool_call card. Errors fold too: with parallel tool calls the results
 * arrive after ALL the calls, so a standalone error row would sit under an
 * unrelated call's card instead of the one that failed.
 * Shared between LogEntryCard (skips rendering folded rows), grouping, and
 * LogView (recomputes isLastInTurn against visible entries).
 */
export function isFoldedToolResult(
  entry: LogEntry,
  turnEntries: LogEntry[] | undefined,
  index?: ToolEntryIndex | null,
): boolean {
  if (entry.kind !== "tool_result") return false;
  if ((entry.attachments?.length ?? 0) > 0) return false;
  const toolUseId = entry.metadata?.toolUseId;
  if (!toolUseId || !turnEntries) return false;
  return index
    ? index.toolCallIds.has(toolUseId)
    : turnEntries.some(
        (candidate) =>
          candidate.kind === "tool_call" &&
          candidate.metadata?.toolId === toolUseId,
      );
}

export function lastVisibleEntryIndex(
  entries: LogEntry[],
  groupedChildIds: ReadonlySet<string>,
): number {
  const entryIndex = buildToolEntryIndex(entries);
  for (let cursor = entries.length - 1; cursor >= 0; cursor--) {
    if (
      !isFoldedToolResult(entries[cursor], entries, entryIndex) &&
      !groupedChildIds.has(entries[cursor].id)
    )
      return cursor;
  }
  return -1;
}

function subagentIdentity(entry: LogEntry): string {
  const origin = entry.metadata?.subagent as SubagentOrigin | undefined;
  return origin?.parentToolUseId ?? "";
}

function matchingResult(
  entry: LogEntry,
  entries: LogEntry[],
  index?: ToolEntryIndex | null,
): LogEntry | undefined {
  const toolId = entry.metadata?.toolId;
  if (!toolId) return undefined;
  if (index) return index.resultByToolUseId.get(toolId);
  return entries.find(
    (candidate) =>
      candidate.kind === "tool_result" &&
      candidate.metadata?.toolUseId === toolId,
  );
}

function isRawSuccessfulToolCall(
  entry: LogEntry,
  entries: LogEntry[],
  index?: ToolEntryIndex | null,
): boolean {
  if (entry.kind !== "tool_call") return false;
  if (isomuxRequestForToolCall(entry.content, entry.metadata?.input))
    return false;
  const result = matchingResult(entry, entries, index);
  if (result && !isFoldedToolResult(result, entries, index)) return false;
  return result?.metadata?.isError !== true;
}

export type RawToolCallGroup = {
  firstId: string;
  entries: LogEntry[];
};

// The live tail keeps only the newest tool batch expanded while an agent is
// busy. A cap prevents one uninterrupted, subagent-heavy batch from making a
// large section of settled history change height on each busy/idle transition.
export const MAX_LIVE_TAIL_ENTRIES = 100;

export function liveTailEntryIds(
  entries: LogEntry[],
  isBusy: boolean,
): ReadonlySet<string> {
  if (!isBusy) return new Set();
  const index = buildToolEntryIndex(entries);
  let start = entries.length;
  for (let cursor = entries.length - 1; cursor >= 0; cursor--) {
    const entry = entries[cursor];
    if (
      entry.kind !== "tool_call" &&
      !isFoldedToolResult(entry, entries, index)
    ) {
      break;
    }
    start = cursor;
  }
  start = Math.max(start, entries.length - MAX_LIVE_TAIL_ENTRIES);
  return new Set(entries.slice(start).map((entry) => entry.id));
}

/**
 * Find runs of ordinary tool-call cards. Paired results do not break a run
 * because they already fold into their call. A visible entry, a structured
 * Isomux curl, an errored call, or a different subagent identity does.
 *
 * Collapsed children are absent from the DOM, so browser find, selection, and
 * selection-cite cannot reach them until the group is expanded.
 */
export function findRawToolCallGroups(
  entries: LogEntry[],
  excludedIds: ReadonlySet<string> = new Set(),
  index: ToolEntryIndex | null = buildToolEntryIndex(entries),
): RawToolCallGroup[] {
  const groups: RawToolCallGroup[] = [];
  let run: LogEntry[] = [];
  let identity = "";
  const flush = () => {
    if (run.length >= 2) groups.push({ firstId: run[0].id, entries: run });
    run = [];
    identity = "";
  };

  for (const entry of entries) {
    if (excludedIds.has(entry.id)) {
      flush();
      continue;
    }
    if (isFoldedToolResult(entry, entries, index)) {
      continue;
    }
    if (!isRawSuccessfulToolCall(entry, entries, index)) {
      flush();
      continue;
    }
    const nextIdentity = subagentIdentity(entry);
    if (run.length > 0 && nextIdentity !== identity) flush();
    if (run.length === 0) identity = nextIdentity;
    run.push(entry);
  }
  flush();
  return groups;
}

export function commandForPermissionDenial(
  denial: { toolUseId?: string },
  turnEntries: LogEntry[] | undefined,
): string | null {
  if (!denial.toolUseId || !turnEntries) return null;
  const call = turnEntries.find(
    (entry) =>
      entry.kind === "tool_call" && entry.metadata?.toolId === denial.toolUseId,
  );
  if (!call || call.content !== "Bash") return null;
  const command = (call.metadata?.input as { command?: unknown } | undefined)
    ?.command;
  if (typeof command !== "string" || /[\r\n]/.test(command)) return null;
  return command;
}
