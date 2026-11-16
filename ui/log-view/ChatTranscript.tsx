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
import { isNoUpdateReply } from "../../shared/no-update.ts";
import {
  LogEntryCard,
  type RunDeniedCommand,
  RawToolCallGroupCard,
  senderIsHuman,
} from "./LogEntryCard.tsx";
import {
  DetachedSubagentSteps,
  detachedSubagentSteps,
  findHiddenRuns,
  findRawToolCallGroups,
  HideToolCalls,
  isFoldedToolResult,
  liveTailEntryIds,
  lastVisibleEntryIndex,
} from "./tool-call-groups.ts";
import { SecretRequestOutcomes } from "./SecretRequestCard.tsx";
import { HiddenToolRunCard } from "./HiddenToolRunCard.tsx";
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

// Where a folded line takes its turn copy button from: the turn of the run's
// last entry that is not a message to the agent (such a message starts a turn
// of its own), and only when nothing shown follows the run in that turn and
// the run does not end with a no-update reply.
// `lastCardId` is the card that carries the button when the line is open.
export type HiddenRunTurn = {
  isLastInTurn: boolean;
  turnEntries?: LogEntry[];
  lastCardId?: string;
};

// Both chat surfaces keep the same turn boundaries and expansion state.
// hideToolCalls (useHideToolCalls; both surfaces pass it) folds each run of
// tool steps into one "N steps" line; hideAgentMessages (useHideAgentMessages,
// task d5c0f33d) folds each run of messages between agents the same way, into
// the same line when both are on. The HTML export shows them all.
export function useChatTranscript(
  logs: LogEntry[],
  isBusy: boolean,
  hideToolCalls = false,
  hideAgentMessages = false,
) {
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
  // The hidden runs the member opened, by first entry id: held here, not in
  // the card, so an export (which shows the chat unfolded) keeps them open.
  const [openRuns, setOpenRuns] = useState<Set<string>>(() => new Set());
  const toggleRun = useCallback((firstId: string) => {
    setOpenRuns((previous) => {
      const next = new Set(previous);
      if (next.has(firstId)) next.delete(firstId);
      else next.add(firstId);
      return next;
    });
  }, []);
  const openRun = useCallback((firstId: string) => {
    setOpenRuns((previous) =>
      previous.has(firstId) ? previous : new Set(previous).add(firstId),
    );
  }, []);
  // On only while the HTML export takes its snapshot (chat-export.ts):
  // every message expanded, a message in edit shown as sent, and every tool
  // call shown.
  const [exportView, setExportView] = useState(false);
  const hidden = hideToolCalls && !exportView;
  const hideMessages = hideAgentMessages && !exportView;
  // Do not collapse the trailing live tool batch: active tool work stays
  // visible as it arrives, while settled history remains stable even when one
  // agent turn runs for hours.
  // A hidden run stays one line for its whole length, live or not.
  const liveTailIds = useMemo(
    () => liveTailEntryIds(logs, isBusy && !hidden),
    [isBusy, hidden, logs],
  );
  // With tool calls shown, the raw groups are as they were and the message
  // runs come on top: a raw group never holds an office card or a message,
  // so the two lists never share an entry.
  const rawToolGroups = useMemo(
    () => (hidden ? [] : findRawToolCallGroups(logs, liveTailIds)),
    [hidden, liveTailIds, logs],
  );
  const hiddenRuns = useMemo(
    () => findHiddenRuns(logs, { tools: hidden, messages: hideMessages }),
    [hidden, hideMessages, logs],
  );
  const rawToolGroupByFirstId = useMemo(
    () => new Map(rawToolGroups.map((group) => [group.firstId, group])),
    [rawToolGroups],
  );
  const hiddenRunByFirstId = useMemo(
    () => new Map(hiddenRuns.map((run) => [run.firstId, run])),
    [hiddenRuns],
  );
  // Entry id -> the first id of the hidden run that holds it.
  const hiddenRunOf = useMemo(
    () =>
      new Map(
        hiddenRuns.flatMap((run) =>
          run.entries.map((entry) => [entry.id, run.firstId]),
        ),
      ),
    [hiddenRuns],
  );
  const detachedSteps = useMemo(
    () => detachedSubagentSteps(logs, [...rawToolGroups, ...hiddenRuns]),
    [logs, rawToolGroups, hiddenRuns],
  );
  const groupedChildIds = useMemo(
    () =>
      new Set(
        [...rawToolGroups, ...hiddenRuns].flatMap((group) =>
          group.entries.slice(1).map((entry) => entry.id),
        ),
      ),
    [rawToolGroups, hiddenRuns],
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

  const hiddenRunTurns = useMemo(() => {
    const anchors = new Map<string, HiddenRunTurn>();
    for (const run of hiddenRuns) {
      const agentEntries = run.entries.filter(
        (entry) => entry.kind !== "user_message",
      );
      const last = agentEntries.at(-1);
      const turnEntries = last && turnData.get(last.id)?.turnEntries;
      if (!last || !turnEntries) {
        anchors.set(run.firstId, { isLastInTurn: false });
        continue;
      }
      const shown = agentEntries.filter(
        (entry) => !isFoldedToolResult(entry, turnEntries),
      );
      // A no-update reply draws nothing, so it cannot carry the button. A run
      // that ends with one ends a turn with nothing for the member, so the
      // turn has no copy button (sign-off of task 51c187f4).
      const lastCard = shown.findLast((entry) => !isNoUpdateReply(entry));
      const endsQuiet = shown.length > 0 && isNoUpdateReply(shown.at(-1)!);
      anchors.set(run.firstId, {
        isLastInTurn:
          !endsQuiet &&
          lastVisibleEntryIndex(turnEntries, groupedChildIds) <=
            turnEntries.indexOf(last),
        turnEntries,
        lastCardId: lastCard?.id,
      });
    }
    return anchors;
  }, [hiddenRuns, turnData, groupedChildIds]);

  return {
    expandedMessages,
    toggleMessage,
    exportView,
    setExportView,
    groupedChildIds,
    rawToolGroupByFirstId,
    hiddenRunByFirstId,
    hiddenRunOf,
    hiddenRunTurns,
    detachedSteps,
    turnData,
    hidden,
    openRuns,
    toggleRun,
    openRun,
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
  onRunDeniedCommand,
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
  onRunDeniedCommand?: RunDeniedCommand;
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
  // agent change or a clear drops it. A target folded into a closed hidden
  // run opens that run and waits for its card (task 17fb1a29).
  const rootRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ target: JumpTarget; agent?: string } | null>(null);
  const resolve = useCallback(
    (target: JumpTarget) =>
      "entryId" in target ? target.entryId : origins.get(target.askId),
    [origins],
  );
  const { hiddenRunOf, openRuns, openRun } = view;
  // Opens the closed run that holds `id`. False when no closed run does.
  const reveal = useCallback(
    (id: string) => {
      const runId = hiddenRunOf.get(id);
      if (!runId || openRuns.has(runId)) return false;
      openRun(runId);
      return true;
    },
    [hiddenRunOf, openRuns, openRun],
  );
  const jump = useCallback<ChatJumpFn>(
    (target) => {
      const id = resolve(target);
      const root = rootRef.current;
      // First, as a closed line carries its first entry's id.
      if (id && reveal(id)) {
        pending.current = { target, agent: logs[0]?.agentId };
        return;
      }
      if (id && root && jumpToLogEntry(id, root)) {
        pending.current = null;
        return;
      }
      if (!partial) return;
      pending.current = { target, agent: logs[0]?.agentId };
      if (level === "recent") rest?.loadRest();
    },
    [resolve, reveal, partial, level, rest, logs],
  );
  // After each change of entries, level or open runs: the jump opens the
  // closed run that holds its target, rings the target once it renders, and
  // goes when the chat changed agent, was cleared, or is whole without it.
  useEffect(() => {
    const wait = pending.current;
    if (!wait) return;
    if (logs[0]?.agentId !== wait.agent) {
      pending.current = null;
      return;
    }
    const id = resolve(wait.target);
    const root = rootRef.current;
    if (id && reveal(id)) return;
    if ((id && root && jumpToLogEntry(id, root)) || !partial)
      pending.current = null;
  }, [resolve, reveal, partial, logs, openRuns]);

  return (
    <div ref={rootRef} data-chat-transcript style={{ display: "contents" }}>
      <ChatJump.Provider value={jump}>
        <ChatLevelContext.Provider value={level}>
          <SecretRequestOutcomes.Provider value={outcomes}>
            <AskOrigins.Provider value={origins}>
              <DetachedSubagentSteps.Provider value={view.detachedSteps}>
                <HideToolCalls.Provider value={view.hidden}>
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
                    if (entry.metadata?.interactionFallback === true)
                      return null;
                    if (view.groupedChildIds.has(entry.id)) return null;
                    const td = view.turnData.get(entry.id);
                    const rawToolGroup = view.rawToolGroupByFirstId.get(
                      entry.id,
                    );
                    const hiddenRun = view.hiddenRunByFirstId.get(entry.id);
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
                        {hiddenRun ? (
                          <HiddenToolRunCard
                            entries={hiddenRun.entries}
                            open={view.openRuns.has(entry.id)}
                            onToggle={() => view.toggleRun(entry.id)}
                            turn={view.hiddenRunTurns.get(entry.id)}
                            isMobile={isMobile}
                            cardProps={(child) => ({
                              messageExpanded: view.expandedMessages.has(
                                child.id,
                              ),
                              onToggleMessage: view.toggleMessage,
                              turnEntries: view.turnData.get(child.id)
                                ?.turnEntries,
                              onCopyToTerminal,
                              onRunDeniedCommand,
                              ...entryProps?.(child),
                            })}
                          />
                        ) : rawToolGroup ? (
                          <RawToolCallGroupCard
                            entries={rawToolGroup.entries}
                            isLastInTurn={td?.isLastInTurn}
                            turnEntries={td?.turnEntries}
                            isMobile={isMobile}
                            onCopyToTerminal={onCopyToTerminal}
                            onRunDeniedCommand={onRunDeniedCommand}
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
                  {activity && (
                    <ActivityIndicator {...activity} working={view.hidden} />
                  )}
                </HideToolCalls.Provider>
              </DetachedSubagentSteps.Provider>
            </AskOrigins.Provider>
          </SecretRequestOutcomes.Provider>
        </ChatLevelContext.Provider>
      </ChatJump.Provider>
    </div>
  );
}
