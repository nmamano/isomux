// One run of tool steps, for a member who does not show tool calls (task
// e7579473, Nil 2026-11-15: "for non-technical folks who would get overwhelmed
// by anything that looks like terminal commands"). Closed, it is one quiet line
// in the chat font, "N steps"; when the run ends the turn, the turn copy button
// sits beside it and copies the whole turn (Nil, 2026-11-15, task 59aca671). A
// tap on the line opens the cards the run holds. The open
// state lives in useChatTranscript, keyed by the run's first entry, so it
// stays open while a live run grows and through an HTML export.

import type { LogEntry } from "../../shared/types.ts";
import { StatusShape } from "../components/StatusShape.tsx";
import { useI18n } from "../i18n.tsx";
import {
  LogEntryCard,
  type RunDeniedCommand,
  TurnCopyButton,
} from "./LogEntryCard.tsx";
import { hiddenRunSteps, lastVisibleEntryIndex } from "./tool-call-groups.ts";

const NONE: ReadonlySet<string> = new Set();

export function HiddenToolRunCard({
  entries,
  isLastInTurn,
  turnEntries,
  isMobile,
  onCopyToTerminal,
  onRunDeniedCommand,
  open,
  onToggle,
}: {
  entries: LogEntry[];
  open: boolean;
  onToggle: () => void;
  isLastInTurn?: boolean;
  turnEntries?: LogEntry[];
  isMobile?: boolean;
  onCopyToTerminal?: (command: string) => void;
  onRunDeniedCommand?: RunDeniedCommand;
}) {
  const { tn } = useI18n();
  const label = tn("cards.toolCall.hiddenSteps", hiddenRunSteps(entries));
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
  if (open) {
    // A result that folds into its call's card draws nothing, so the turn's
    // copy button goes on the last card that shows.
    const last = lastVisibleEntryIndex(entries, NONE);
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
          {label}
        </button>
        {entries.map((entry, index) => (
          <LogEntryCard
            key={entry.id}
            entry={entry}
            isLastInTurn={isLastInTurn && index === last}
            turnEntries={turnEntries}
            isMobile={isMobile}
            onCopyToTerminal={onCopyToTerminal}
            onRunDeniedCommand={onRunDeniedCommand}
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
        {label}
        <span style={{ fontSize: 8 }}>
          <StatusShape kind="triangle" />
        </span>
      </button>
      {isLastInTurn && <TurnCopyButton turnEntries={turnEntries} />}
    </div>
  );
}
