import { createContext } from "react";
import type { LogEntry, SubagentOrigin } from "../../shared/types.ts";
import { parseIsomuxCurl, type IsomuxCurlRequest } from "./isomux-curl.ts";
import { isomuxUiPorts } from "./IsomuxCurlSummary.tsx";
import { isNoUpdateReply } from "../../shared/no-update.ts";

// The shell tool of each engine: Claude and Codex "Bash", OpenCode "shell"
// (and "bash" in its older builds). Each carries input.command.
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Bash",
  "bash",
  "shell",
]);

export function isomuxRequestForToolCall(
  name: string,
  input: unknown,
): IsomuxCurlRequest | null {
  if (!SHELL_TOOL_NAMES.has(name) || !input || typeof input !== "object")
    return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string"
    ? parseIsomuxCurl(command, isomuxUiPorts)
    : null;
}

type ToolEntryIndex = {
  toolCallIds: ReadonlySet<unknown>;
  resultByToolUseId: ReadonlyMap<unknown, LogEntry>;
};

function buildToolEntryIndex(entries: LogEntry[]): ToolEntryIndex {
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
  index: ToolEntryIndex,
): LogEntry | undefined {
  const toolId = entry.metadata?.toolId;
  return toolId ? index.resultByToolUseId.get(toolId) : undefined;
}

function isRawSuccessfulToolCall(
  entry: LogEntry,
  entries: LogEntry[],
  index: ToolEntryIndex,
): boolean {
  if (entry.kind !== "tool_call") return false;
  if (isomuxRequestForToolCall(entry.content, entry.metadata?.input))
    return false;
  const result = matchingResult(entry, index);
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
): RawToolCallGroup[] {
  const index = buildToolEntryIndex(entries);
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

/**
 * The runs a member who does not show tool calls sees as one "N steps" line
 * (task e7579473): every tool call, office calls included (task 17fb1a29),
 * except one that sends a message to another agent, every tool_result
 * without attachments, subagent steps, permission denials, background-task
 * breadcrumbs and Codex stderr. Errors and subagent changes do not split a
 * run; anything else does. A run may hold one entry. A result that folds
 * into its call's card joins a run but never starts one, so a card that
 * stays never gets an empty line under it.
 */
export function findHiddenToolRuns(entries: LogEntry[]): RawToolCallGroup[] {
  return findHiddenRuns(entries, { tools: true, messages: false });
}

function isHiddenToolEntry(entry: LogEntry): boolean {
  switch (entry.kind) {
    case "tool_call":
      // A message to another agent is the agent-message fold's.
      return messageRecipient(entry) === null;
    case "tool_result":
      return (entry.attachments?.length ?? 0) === 0;
    case "system":
      return (
        !!entry.metadata?.permissionDenied ||
        !!entry.metadata?.taskEvent ||
        entry.content.startsWith("[codex stderr]")
      );
    default:
      return false;
  }
}

/**
 * A subagent step that sits after a member message which came later than the
 * card that started its subagent, so by position it reads as a reply to that
 * message. `target` is the entry id a click on its pill jumps to: the
 * starting tool_call, or the firstId of the collapsed raw group that hides
 * it. `background` is true only when that subagent runs in the background
 * (Claude: the starting call's input.run_in_background); a foreground
 * subagent whose turn took a steer is selected too, without the word.
 */
export type DetachedSubagentStep = { target: string; background: boolean };

/**
 * Entry id -> DetachedSubagentStep for every selected entry, group children
 * included: an expanded RawToolCallGroupCard renders each child through
 * LogEntryCard, and each child's pill shows the same state. An entry whose
 * starting card is not in `entries` is not selected.
 */
export function detachedSubagentSteps(
  entries: LogEntry[],
  groups: RawToolCallGroup[],
): ReadonlyMap<string, DetachedSubagentStep> {
  const groupOf = new Map<string, string>();
  for (const group of groups)
    for (const entry of group.entries) groupOf.set(entry.id, group.firstId);
  // toolId -> index of the tool_call that carries it.
  const callAt = new Map<unknown, number>();
  const steps = new Map<string, DetachedSubagentStep>();
  let lastMemberAt = -1;
  entries.forEach((entry, at) => {
    if (entry.kind === "user_message") lastMemberAt = at;
    const parentToolUseId = subagentIdentity(entry);
    if (parentToolUseId) {
      const parentAt = callAt.get(parentToolUseId);
      if (parentAt !== undefined && parentAt < lastMemberAt) {
        const parent = entries[parentAt];
        const input = parent.metadata?.input as
          { run_in_background?: unknown } | undefined;
        steps.set(entry.id, {
          target: groupOf.get(parent.id) ?? parent.id,
          background: input?.run_in_background === true,
        });
      }
    }
    if (entry.kind === "tool_call" && entry.metadata?.toolId)
      callAt.set(entry.metadata.toolId, at);
  });
  return steps;
}

/**
 * Whether the chat folds tool calls (task e7579473): a tool result with
 * images then shows the images alone. False outside ChatTranscript.
 */
export const HideToolCalls = createContext(false);

/** The chat's detached subagent steps; empty outside ChatTranscript. */
export const DetachedSubagentSteps = createContext<
  ReadonlyMap<string, DetachedSubagentStep>
>(new Map());

// The agent id a card sends a message to: POST /api/agents/:id/messages,
// with or without a query (steer, deliverAt). Null for any other card.
function messageRecipient(entry: LogEntry): string | null {
  if (entry.kind !== "tool_call") return null;
  const request = isomuxRequestForToolCall(
    entry.content,
    entry.metadata?.input,
  );
  if (request?.method !== "POST") return null;
  const match = /^\/api\/agents\/([^/?#]+)\/messages(?:[?#]|$)/.exec(
    request.path,
  );
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function isPeerMessage(entry: LogEntry): boolean {
  return (
    entry.kind === "user_message" &&
    (typeof entry.metadata?.sender_agent_name === "string" ||
      typeof entry.metadata?.sender_agent_id === "string")
  );
}

/**
 * A message between agents (task d5c0f33d): a user_message another agent (or
 * the agent itself, scheduled) sent, or a tool call that sends one, schedules
 * one or steers with one (POST /api/agents/:id/messages).
 */
export function isAgentMessageEntry(entry: LogEntry): boolean {
  return isPeerMessage(entry) || messageRecipient(entry) !== null;
}

/**
 * The runs a member sees as one folded line. `tools`: the tool-call fold
 * (findHiddenToolRuns); `messages`: the agent-message fold. With tools false,
 * a run holds only agent messages and the results that fold into them. A run
 * may reach past the turn a message from another agent starts. A reply that
 * is only the no-update keyword (task 51c187f4) folds with either fold or
 * neither: it never shows as a card. A run is cut after its last such reply
 * (task c9479484), so the line that says nothing is new never also holds the
 * traffic that leads into the next reply; back-to-back quiet turns stay one.
 */
export function findHiddenRuns(
  entries: LogEntry[],
  fold: { tools: boolean; messages: boolean },
): RawToolCallGroup[] {
  const index = buildToolEntryIndex(entries);
  const groups: RawToolCallGroup[] = [];
  let run: LogEntry[] = [];
  // Whether `run` holds a no-update reply, and the index of the first entry
  // after its last one that is not a folded result: the run is cut there.
  let quiet = false;
  let cut = -1;
  const push = (entry: LogEntry, folded: boolean) => {
    if (isNoUpdateReply(entry)) {
      quiet = true;
      cut = -1;
    } else if (!folded && quiet && cut < 0) cut = run.length;
    run.push(entry);
  };
  const flush = () => {
    const parts = cut > 0 ? [run.slice(0, cut), run.slice(cut)] : [run];
    for (const part of parts)
      if (part.length > 0) groups.push({ firstId: part[0].id, entries: part });
    run = [];
    quiet = false;
    cut = -1;
  };
  for (const entry of entries) {
    if (isFoldedToolResult(entry, entries, index)) {
      if (run.length > 0) push(entry, true);
    } else if (
      isNoUpdateReply(entry) ||
      (fold.messages && isAgentMessageEntry(entry)) ||
      (fold.tools && isHiddenToolEntry(entry))
    ) {
      push(entry, false);
    } else {
      flush();
    }
  }
  flush();
  return groups;
}

/**
 * What a folded line counts: agent messages (messages in, and top-level
 * cards that send one) and top-level steps. A run with no message counts at
 * least one step, unless it holds a no-update reply.
 */
export function hiddenRunCounts(run: LogEntry[]): {
  messages: number;
  steps: number;
  // Present when the run holds a reply that is only the no-update keyword.
  quiet?: true;
} {
  let messages = 0;
  let calls = 0;
  let quiet = false;
  for (const entry of run) {
    if (isNoUpdateReply(entry)) quiet = true;
    else if (isPeerMessage(entry)) messages++;
    else if (entry.kind === "tool_call" && !entry.metadata?.subagent) {
      if (messageRecipient(entry) !== null) messages++;
      else calls++;
    }
  }
  if (quiet) return { messages, steps: calls, quiet: true };
  return { messages, steps: messages > 0 ? calls : Math.max(1, calls) };
}

/**
 * The agents a run's messages came from or went to, in order of first
 * appearance, deduplicated, at most 3. The line draws their avatars.
 */
export function hiddenRunPeers(run: LogEntry[]): string[] {
  const peers: string[] = [];
  for (const entry of run) {
    const sender = entry.metadata?.sender_agent_id;
    const id =
      entry.kind === "user_message"
        ? typeof sender === "string" && isPeerMessage(entry)
          ? sender
          : null
        : messageRecipient(entry);
    if (id && !peers.includes(id)) peers.push(id);
    if (peers.length === 3) break;
  }
  return peers;
}
