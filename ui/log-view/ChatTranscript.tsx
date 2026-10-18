import { ActivityIndicator } from "./ActivityIndicator.tsx";
import {
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefCallback,
} from "react";
import type { AgentState, LogEntry } from "../../shared/types.ts";
import {
  LogEntryCard,
  RawToolCallGroupCard,
  senderIsHuman,
} from "./LogEntryCard.tsx";
import {
  findRawToolCallGroups,
  liveTailEntryIds,
  lastVisibleEntryIndex,
} from "./tool-call-groups.ts";
import { SecretRequestOutcomes } from "./SecretRequestCard.tsx";
import { ActionableOrigins, actionableOrigins } from "./actionable-link.tsx";

// The settled secret requests, from the system entries that close them.
function secretRequestOutcomes(
  logs: LogEntry[],
): ReadonlyMap<string, "saved" | "declined"> {
  const outcomes = new Map<string, "saved" | "declined">();
  for (const entry of logs) {
    const id = entry.metadata?.secretRequestSettled;
    const outcome = entry.metadata?.outcome;
    if (
      typeof id === "string" &&
      (outcome === "saved" || outcome === "declined")
    )
      outcomes.set(id, outcome);
  }
  return outcomes;
}

// Both chat surfaces keep the same turn boundaries and expansion state.
export function useChatTranscript(logs: LogEntry[], isBusy: boolean) {
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleMessage = useCallback((entryId: string) => {
    setExpandedMessages((previous) => {
      const next = new Set(previous);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }, []);
  // Do not collapse the trailing live tool batch: active tool work stays
  // visible as it arrives, while settled history remains stable even when one
  // agent turn runs for hours.
  const liveTailIds = useMemo(
    () => liveTailEntryIds(logs, isBusy),
    [isBusy, logs],
  );
  const rawToolGroups = useMemo(
    () => findRawToolCallGroups(logs, liveTailIds),
    [liveTailIds, logs],
  );
  const rawToolGroupByFirstId = useMemo(
    () => new Map(rawToolGroups.map((group) => [group.firstId, group])),
    [rawToolGroups],
  );
  const groupedChildIds = useMemo(
    () =>
      new Set(
        rawToolGroups.flatMap((group) =>
          group.entries.slice(1).map((entry) => entry.id),
        ),
      ),
    [rawToolGroups],
  );

  // Compute agent turns: group entries between user_messages
  // For each entry, determine if it's the last in its agent turn
  const turnData = useMemo(() => {
    // Identify turn boundaries (user_message entries start a new turn)
    // Agent turn = all non-user entries after a user message, until the next user message
    let currentTurn: { startIdx: number; entries: LogEntry[] } = {
      startIdx: 0,
      entries: [],
    };
    const turns: { startIdx: number; entries: LogEntry[] }[] = [];

    for (let i = 0; i < logs.length; i++) {
      const entry = logs[i];
      if (entry.kind === "user_message") {
        if (currentTurn.entries.length > 0) {
          turns.push(currentTurn);
        }
        // User messages are their own "turn" (no grouping needed)
        turns.push({ startIdx: i, entries: [entry] });
        currentTurn = { startIdx: i + 1, entries: [] };
      } else {
        currentTurn.entries.push(entry);
      }
    }
    if (currentTurn.entries.length > 0) {
      turns.push(currentTurn);
    }

    const entryMap = new Map<
      string,
      { isLastInTurn: boolean; turnEntries: LogEntry[] }
    >();
    for (const turn of turns) {
      if (
        turn.entries.length === 1 &&
        turn.entries[0].kind === "user_message"
      ) {
        entryMap.set(turn.entries[0].id, {
          isLastInTurn: false,
          turnEntries: [],
        });
        continue;
      }
      // Find the last entry that will actually render. Folded tool_results
      // are hidden, so the turn-level copy button needs to land on the
      // preceding visible entry (usually the matching tool_call).
      const lastVisibleIdx = lastVisibleEntryIndex(
        turn.entries,
        groupedChildIds,
      );
      for (let i = 0; i < turn.entries.length; i++) {
        entryMap.set(turn.entries[i].id, {
          isLastInTurn: i === lastVisibleIdx,
          turnEntries: turn.entries,
        });
      }
    }

    return entryMap;
  }, [logs, groupedChildIds]);

  return {
    expandedMessages,
    toggleMessage,
    groupedChildIds,
    rawToolGroupByFirstId,
    turnData,
  };
}

type EntryOptions = Omit<
  ComponentProps<typeof LogEntryCard>,
  | "entry"
  | "messageExpanded"
  | "onToggleMessage"
  | "isLastInTurn"
  | "turnEntries"
  | "isMobile"
>;

export function ChatTranscript({
  logs,
  view,
  isMobile,
  getUserMessageRef,
  entryProps,
  onCopyToTerminal,
  afterEntry,
  interaction,
  activity,
}: {
  logs: LogEntry[];
  view: ReturnType<typeof useChatTranscript>;
  isMobile: boolean;
  getUserMessageRef?: (id: string) => RefCallback<HTMLDivElement>;
  entryProps?: (entry: LogEntry) => EntryOptions;
  onCopyToTerminal?: (command: string) => void;
  afterEntry?: (entry: LogEntry) => ReactNode;
  interaction?: ReactNode;
  activity?: {
    state: AgentState;
    stateChangedAt?: number;
    onAbort?: () => void;
  };
}) {
  const outcomes = useMemo(() => secretRequestOutcomes(logs), [logs]);
  const origins = useMemo(() => actionableOrigins(logs), [logs]);
  return (
    <SecretRequestOutcomes.Provider value={outcomes}>
      <ActionableOrigins.Provider value={origins}>
      {logs.map((entry) => {
        if (entry.metadata?.interactionFallback === true) return null;
        if (view.groupedChildIds.has(entry.id)) return null;
        const td = view.turnData.get(entry.id);
        const rawToolGroup = view.rawToolGroupByFirstId.get(entry.id);
        const isUserMsg =
          entry.kind === "user_message" && senderIsHuman(entry.metadata);
        return (
          <div
            key={entry.id}
            data-log-entry-id={entry.id}
            ref={isUserMsg ? getUserMessageRef?.(entry.id) : undefined}
          >
            {rawToolGroup ? (
              <RawToolCallGroupCard
                entries={rawToolGroup.entries}
                isLastInTurn={td?.isLastInTurn}
                turnEntries={td?.turnEntries}
                isMobile={isMobile}
                onCopyToTerminal={onCopyToTerminal}
              />
            ) : (
              <LogEntryCard
                entry={entry}
                messageExpanded={view.expandedMessages.has(entry.id)}
                onToggleMessage={view.toggleMessage}
                isLastInTurn={td?.isLastInTurn}
                turnEntries={td?.turnEntries}
                isMobile={isMobile}
                {...entryProps?.(entry)}
              />
            )}
            {afterEntry?.(entry)}
          </div>
        );
      })}
      {interaction}
      {activity && <ActivityIndicator {...activity} />}
      </ActionableOrigins.Provider>
    </SecretRequestOutcomes.Provider>
  );
}
