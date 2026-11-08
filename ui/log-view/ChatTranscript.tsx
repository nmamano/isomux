import { ActivityIndicator } from "./ActivityIndicator.tsx";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  DetachedSubagentSteps,
  detachedSubagentSteps,
  findRawToolCallGroups,
  liveTailEntryIds,
  lastVisibleEntryIndex,
} from "./tool-call-groups.ts";
import { SecretRequestOutcomes } from "./SecretRequestCard.tsx";
import { AskOrigins, askOrigins } from "./ask-link.tsx";
import { copySelectionAsPlainText } from "./plain-copy.ts";
import {
  ChatJump,
  ChatLevelContext,
  type ChatJumpFn,
  type ChatRest,
  type JumpTarget,
} from "./load-rest.ts";
import { jumpToLogEntry } from "./jump-to-entry.ts";
import { useI18n } from "../i18n.tsx";

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
  const detachedSteps = useMemo(
    () => detachedSubagentSteps(logs, rawToolGroups),
    [logs, rawToolGroups],
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

  // On only while the HTML export takes its snapshot (chat-export.ts):
  // every message expanded, and a message in edit shown as sent.
  const [exportView, setExportView] = useState(false);

  return {
    expandedMessages,
    toggleMessage,
    exportView,
    setExportView,
    groupedChildIds,
    rawToolGroupByFirstId,
    detachedSteps,
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
  rest,
}: {
  logs: LogEntry[];
  view: ReturnType<typeof useChatTranscript>;
  isMobile: boolean;
  getUserMessageRef?: (id: string) => RefCallback<HTMLDivElement>;
  entryProps?: (entry: LogEntry) => EntryOptions;
  onCopyToTerminal?: (command: string) => void;
  afterEntry?: (entry: LogEntry) => ReactNode;
  interaction?: ReactNode;
  // Recent then complete (task 9ebe887d slice 3): the surface's useLoadRest.
  // A recent chat shows the top row; ChatJump links use it.
  rest?: ChatRest;
  activity?: {
    state: AgentState;
    stateChangedAt?: number;
    onAbort?: () => void;
  };
}) {
  const { t } = useI18n();
  const outcomes = useMemo(() => secretRequestOutcomes(logs), [logs]);
  const origins = useMemo(() => askOrigins(logs), [logs]);
  const level = rest?.level ?? null;
  const partial = level === "recent" || level === "loadingRest";

  // Jumps from links in this transcript (task 9ebe887d slice 3): ring the
  // entry in this surface only. In a chat that is not whole, a target that is
  // not rendered loads the rest and waits here; a whole chat without it, an
  // agent change or a clear drops it.
  const rootRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ target: JumpTarget; agent?: string } | null>(null);
  const resolve = useCallback(
    (target: JumpTarget) =>
      "entryId" in target ? target.entryId : origins.get(target.askId),
    [origins],
  );
  const jump = useCallback<ChatJumpFn>(
    (target) => {
      const id = resolve(target);
      const root = rootRef.current;
      if (id && root && jumpToLogEntry(id, root)) {
        pending.current = null;
        return;
      }
      if (!partial) return;
      pending.current = { target, agent: logs[0]?.agentId };
      if (level === "recent") rest?.loadRest();
    },
    [resolve, partial, level, rest, logs],
  );
  // After each change of entries or level: the jump rings once its target
  // renders, and goes when the chat changed agent, was cleared, or is whole
  // without it.
  useEffect(() => {
    const wait = pending.current;
    if (!wait) return;
    if (logs[0]?.agentId !== wait.agent) {
      pending.current = null;
      return;
    }
    const id = resolve(wait.target);
    const root = rootRef.current;
    if ((id && root && jumpToLogEntry(id, root)) || !partial)
      pending.current = null;
  }, [resolve, partial, logs]);

  return (
    <div ref={rootRef} data-chat-transcript style={{ display: "contents" }}>
      <ChatJump.Provider value={jump}>
        <ChatLevelContext.Provider value={level}>
          <SecretRequestOutcomes.Provider value={outcomes}>
            <AskOrigins.Provider value={origins}>
              <DetachedSubagentSteps.Provider value={view.detachedSteps}>
                {partial && (
                  <div
                    data-chat-rest={level}
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      padding: "6px 0 10px",
                      fontSize: 12,
                      color: "var(--text-faint)",
                    }}
                  >
                    {level === "recent" ? (
                      <button
                        type="button"
                        onClick={() => rest?.loadRest()}
                        style={{
                          background: "none",
                          border: "1px solid var(--border-light)",
                          borderRadius: 12,
                          padding: "3px 12px",
                          font: "inherit",
                          color: "var(--text-secondary)",
                          cursor: "pointer",
                        }}
                      >
                        {t("logView.rest.loadOlder")}
                      </button>
                    ) : (
                      <span>{t("logView.rest.loadingOlder")}</span>
                    )}
                  </div>
                )}
                {logs.map((entry) => {
                  if (entry.metadata?.interactionFallback === true) return null;
                  if (view.groupedChildIds.has(entry.id)) return null;
                  const td = view.turnData.get(entry.id);
                  const rawToolGroup = view.rawToolGroupByFirstId.get(entry.id);
                  const isUserMsg =
                    entry.kind === "user_message" &&
                    senderIsHuman(entry.metadata);
                  // Only a message reads the export view: every other card keeps
                  // its props, so the snapshot does not render it again.
                  const exporting =
                    view.exportView && entry.kind === "user_message";
                  return (
                    <div
                      key={entry.id}
                      data-log-entry-id={entry.id}
                      ref={
                        isUserMsg ? getUserMessageRef?.(entry.id) : undefined
                      }
                      onCopy={copySelectionAsPlainText}
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
                          messageExpanded={
                            exporting || view.expandedMessages.has(entry.id)
                          }
                          exportView={exporting || undefined}
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
              </DetachedSubagentSteps.Provider>
            </AskOrigins.Provider>
          </SecretRequestOutcomes.Provider>
        </ChatLevelContext.Provider>
      </ChatJump.Provider>
    </div>
  );
}
