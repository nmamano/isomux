// One folded run, for a member who does not show tool calls (task e7579473,
// Nil 2026-11-15: "for non-technical folks who would get overwhelmed by
// anything that looks like terminal commands") or messages between agents
// (task d5c0f33d). Closed, it is one quiet line in the chat font: "N steps",
// "N agent messages", or both, led by the avatars of the agents the run
// talked with. When the run ends a turn, the turn copy button sits beside it
// and copies the whole turn (Nil, 2026-11-15, task 59aca671). A tap on the
// line opens the cards the run holds. A reply that is only the no-update
// keyword (task 51c187f4) adds "nothing new for you" to the line; a run of only
// such replies is a still line, with nothing to open. A line that ends with
// such a reply has no copy button: the turn has nothing for the member. A
// line can hold the restart line (findHiddenRuns). The open state
// lives in useChatTranscript, keyed by the run's first entry, so it stays
// open while a live run grows and through an HTML export.

import type { ComponentProps } from "react";
import type { LogEntry } from "../../shared/types.ts";
import { isNoUpdateReply } from "../../shared/no-update.ts";
import { StatusShape } from "../components/StatusShape.tsx";
import { useI18n } from "../i18n.tsx";
import { AgentAvatar } from "./chat-avatars.tsx";
import type { HiddenRunTurn } from "./ChatTranscript.tsx";
import { LogEntryCard, TurnCopyButton } from "./LogEntryCard.tsx";
import { hiddenRunCounts, hiddenRunPeers } from "./tool-call-groups.ts";

export function HiddenToolRunCard({
  entries,
  turn,
  isMobile,
  cardProps,
  open,
  onToggle,
}: {
  entries: LogEntry[];
  open: boolean;
  onToggle: () => void;
  turn?: HiddenRunTurn;
  isMobile?: boolean;
  // What the chat passes each card of the open run (message toggle, turn,
  // the surface's entry options).
  cardProps: (
    entry: LogEntry,
  ) => Omit<ComponentProps<typeof LogEntryCard>, "entry" | "isLastInTurn">;
}) {
  const { t, tn } = useI18n();
  const counts = hiddenRunCounts(entries);
  const parts = [
    counts.messages > 0 && tn("cards.toolCall.hiddenMessages", counts.messages),
    counts.steps > 0 && tn("cards.toolCall.hiddenSteps", counts.steps),
  ].filter(Boolean);
  // A run that holds only no-update replies (task 51c187f4) has nothing to
  // open: it is a still line. A tool result in a run is one that folds into
  // its call's card, which draws outside the run, so it adds nothing to open.
  // A run that also holds a restart line opens to show it.
  const quietOnly = entries.every(
    (entry) => isNoUpdateReply(entry) || entry.kind === "tool_result",
  );
  if (counts.quiet && !quietOnly) parts.push(t("cards.toolCall.hiddenQuiet"));
  const label = quietOnly
    ? t("cards.toolCall.hiddenQuietOnly")
    : parts.join(" · ");
  const peers = hiddenRunPeers(entries).map((id) => (
    <AgentAvatar key={id} agentId={id} />
  ));
  const line = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    border: "none",
    borderRadius: 10,
    background: "var(--expand-btn)",
    color: "var(--text-dim)",
    cursor: "pointer",
    fontSize: isMobile ? 14 : 13,
    padding: "2px 10px",
    fontFamily: "inherit",
  } as const;
  const avatars = peers.length > 0 && (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      {peers}
    </span>
  );
  if (quietOnly) {
    return (
      <div style={{ margin: "4px 0", position: "relative" }}>
        <span data-hidden-quiet style={{ ...line, cursor: "default" }}>
          {label}
        </span>
      </div>
    );
  }
  if (open) {
    return (
      <div>
        <button
          data-hidden-steps-open
          aria-expanded
          onClick={onToggle}
          style={line}
        >
          <span style={{ fontSize: 8 }}>
            <StatusShape kind="triangle" rotate={90} />
          </span>
          {avatars}
          {label}
        </button>
        {entries.map((entry) => (
          <LogEntryCard
            key={entry.id}
            entry={entry}
            isMobile={isMobile}
            {...cardProps(entry)}
            isLastInTurn={!!turn?.isLastInTurn && entry.id === turn.lastCardId}
          />
        ))}
      </div>
    );
  }
  return (
    <div style={{ margin: "4px 0", position: "relative" }}>
      <button
        data-hidden-steps
        aria-expanded={false}
        onClick={onToggle}
        style={line}
      >
        {avatars}
        {label}
        <span style={{ fontSize: 8 }}>
          <StatusShape kind="triangle" />
        </span>
      </button>
      {turn?.isLastInTurn && <TurnCopyButton turnEntries={turn.turnEntries} />}
    </div>
  );
}
