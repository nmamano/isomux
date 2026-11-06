// The ask pinned above the Asks list (task 84aadfab): the one an ask chip or
// the /inbox/asks/<askId> address names. An open ask the member answers is its
// AskCard; any other ask (closed, or open for another member) is read from
// GET /api/asks/:askId and drawn read-only, a closed one with how it closed.
// A secret request never shows an answer, whatever the record holds.

import { useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "../api.ts";
import { useI18n, type UiTranslator } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { useAppState } from "../store.tsx";
import { AskCard } from "../log-view/AskCard.tsx";
import { AskPrompt } from "../log-view/AskPrompt.tsx";
import { RecommendedStar } from "../log-view/recommended-star.tsx";
import { TaskChip, TaskOpener } from "../log-view/task-links.tsx";
import type {
  AskAgentWire,
  AskClosedWire,
} from "../../shared/contract-shapes.ts";
import type { AskMemberWire } from "../../shared/types.ts";

type ReadAsk = AskAgentWire | AskClosedWire;

// The read: null while it runs, "missing" for a 404, a 403 or an error.
type ReadState = { id: string; ask: ReadAsk | "missing" } | null;

function outcomeText(
  { t, rich }: Pick<UiTranslator, "t" | "rich">,
  ask: AskClosedWire,
  taskChip: (id: string) => ReactNode,
): ReactNode {
  const { outcome, taskId } = ask.closed;
  // A secret request's record has no value, and the card shows none anyway.
  const answer = ask.secret ? undefined : ask.closed.answer;
  const words = (text: string) => <span {...noTranslate()}>{text}</span>;
  switch (outcome) {
    case "replied":
      return rich("asks.replied", { reply: words(answer ?? "") });
    case "dismissed":
      return answer
        ? rich("asks.dismissedReason", { reason: words(answer) })
        : t("asks.dismissed");
    case "filed":
      return answer
        ? rich("asks.filedAsTaskNote", {
            task: taskChip(taskId ?? ""),
            note: words(answer),
          })
        : rich("asks.filedAsTask", { task: taskChip(taskId ?? "") });
    case "withdrawn":
      return ask.closed.app
        ? rich("asks.closedWithdrawnApp", { app: words(ask.closed.app) })
        : t("asks.closedWithdrawn");
    case "done":
      return t("asks.closedDone");
    case "saved":
      return t("asks.closedSaved");
    case "declined":
      return ask.sudo ? t("asks.closedSudoDeclined") : t("asks.closedDeclined");
    case "ran":
      return t("asks.closedSudoRan");
    case "refused":
      return t("asks.closedSudoRefused");
    case "agent_removed":
      return t("asks.closedAgentRemoved");
  }
}

function ReadOnlyAsk({ ask, isMobile }: { ask: ReadAsk; isMobile: boolean }) {
  const i18n = useI18n();
  const { t, rich } = i18n;
  const { agents, tasks } = useAppState();
  const openTask = useContext(TaskOpener);
  // The task a filed ask became: its chip when the member sees the task.
  const taskChip = (id: string): ReactNode => {
    const task = tasks.find((x) => x.id === id);
    return task && openTask ? (
      <TaskChip task={task} onOpen={openTask} />
    ) : (
      <span {...noTranslate()}>{id}</span>
    );
  };
  // An ask with no agent is named for its office feature or app.
  const agentName =
    agents.find((a) => a.id === ask.agentId)?.name ??
    ask.office?.name ??
    (ask.agentId === "" ? ask.app?.name : undefined);
  const closed = "closed" in ask ? ask : null;
  const small = { color: "var(--text-ghost)", fontSize: isMobile ? 12 : 11 };
  return (
    <div
      data-ask-readonly={ask.id}
      style={{
        padding: isMobile ? "9px 10px 10px 11px" : "8px 10px 9px 11px",
        borderRadius: 8,
        background: "var(--bg-subtle)",
        border: "1px solid var(--border-light)",
        borderLeft: "3px solid var(--border-medium)",
        fontFamily: "var(--font-ui)",
      }}
    >
      {agentName && (
        <div
          {...noTranslate()}
          style={{
            color: "var(--accent-text)",
            fontSize: isMobile ? 14 : 13,
            fontWeight: 600,
          }}
        >
          {agentName}
        </div>
      )}
      {ask.member && (
        <div style={small}>
          {rich("asks.forMember", {
            member: <span {...noTranslate()}>{ask.member}</span>,
          })}
        </div>
      )}
      <div
        {...noTranslate()}
        style={{
          color: "var(--text-primary)",
          fontSize: isMobile ? 14 : 13,
          lineHeight: 1.5,
          overflowWrap: "break-word",
        }}
      >
        <AskPrompt content={ask.prompt} />
      </div>
      {ask.options && ask.options.length > 0 && (
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}
        >
          {ask.options.map((option, i) => (
            <span
              key={i}
              style={{
                padding: "3px 9px",
                borderRadius: 8,
                border: "1px solid var(--border-medium)",
                color: "var(--text-dim)",
                fontSize: isMobile ? 13 : 12,
                overflowWrap: "anywhere",
              }}
            >
              {option === ask.recommended && (
                <RecommendedStar size={isMobile ? 13 : 11} />
              )}
              <span {...noTranslate()}>{option}</span>
            </span>
          ))}
        </div>
      )}
      <div
        data-ask-outcome={closed ? closed.closed.outcome : "open"}
        style={{
          marginTop: 8,
          color: "var(--text-primary)",
          fontSize: isMobile ? 14 : 13,
          fontWeight: 600,
          overflowWrap: "break-word",
          whiteSpace: "pre-wrap",
        }}
      >
        {closed ? outcomeText(i18n, closed, taskChip) : t("asks.stillOpen")}
      </div>
      {closed?.closed.by && (
        <div style={small}>
          {rich("asks.answeredBy", {
            member: <span {...noTranslate()}>{closed.closed.by}</span>,
          })}
        </div>
      )}
    </div>
  );
}

export function PinnedAsk({
  id,
  entry,
  inStore,
  isMobile,
  undoMs,
  promptLines,
  onFocusAgent,
  onChatAgent,
  onClose,
}: {
  id: string;
  // The open ask as the member answers it, or undefined to read it.
  entry: AskMemberWire | undefined;
  // The id is in the store's open asks: a change re-reads it, so an ask
  // answered on another device shows closed.
  inStore: boolean;
  isMobile: boolean;
  undoMs: number;
  promptLines: number;
  onFocusAgent: (agentId: string) => void;
  onChatAgent?: (agentId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [read, setRead] = useState<ReadState>(null);
  const needsRead = entry === undefined && !inStore;
  useEffect(() => {
    if (!needsRead) return;
    let live = true;
    apiFetch<ReadAsk>("GET", `/api/asks/${id}`).then(
      (ask) => live && setRead({ id, ask }),
      () => live && setRead({ id, ask: "missing" }),
    );
    return () => {
      live = false;
    };
  }, [id, needsRead]);
  const shown = read && read.id === id && needsRead ? read.ask : null;
  return (
    <div
      data-asks-pinned={id}
      style={{
        marginBottom: isMobile ? 16 : 20,
        padding: 8,
        borderRadius: 10,
        outline: "2px solid var(--accent)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          data-asks-pinned-close=""
          aria-label={t("common.close")}
          title={t("common.close")}
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            padding: "0 4px",
            color: "var(--text-dim)",
            fontSize: isMobile ? 18 : 16,
            lineHeight: 1,
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </div>
      {entry ? (
        <AskCard
          entry={entry}
          isMobile={isMobile}
          onFocusAgent={onFocusAgent}
          onChatAgent={onChatAgent}
          undoMs={undoMs}
          promptLines={promptLines}
        />
      ) : shown === "missing" ? (
        <div
          data-asks-pinned-missing=""
          style={{
            padding: "8px 4px",
            color: "var(--text-muted)",
            fontSize: 13,
            fontFamily: "var(--font-ui)",
          }}
        >
          {t("asks.pinnedMissing")}
        </div>
      ) : shown ? (
        <ReadOnlyAsk ask={shown} isMobile={isMobile} />
      ) : null}
    </div>
  );
}
