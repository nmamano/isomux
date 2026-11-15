// One folded run, for a member who does not show tool calls (task e7579473,
// Nil 2026-11-15: "for non-technical folks who would get overwhelmed by
// anything that looks like terminal commands") or messages between agents
// (task d5c0f33d). Closed, it is one quiet line in the chat font: "N steps",
// "N agent messages", or both, led by the avatars of the agents the run
// talked with. When the run ends a turn, the turn copy button sits beside it
// and copies the whole turn (Nil, 2026-11-15, task 59aca671). A tap on the
// line opens the cards the run holds. The open state lives in
// useChatTranscript, keyed by the run's first entry, so it stays open while a
// live run grows and through an HTML export.

import type { ComponentProps } from "react";
import type { LogEntry } from "../../shared/types.ts";
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
  const { tn } = useI18n();
  const counts = hiddenRunCounts(entries);
  const label = [
    counts.messages > 0 && tn("cards.toolCall.hiddenMessages", counts.messages),
    counts.steps > 0 && tn("cards.toolCall.hiddenSteps", counts.steps),
  ]
    .filter(Boolean)
    .join(" · ");
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
