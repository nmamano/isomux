// The one-line link above a member message that answers an ask
// (internal-docs/asks-design.md). The message's metadata names the
// ask; a click scrolls to the agent's "Create ask" card, found
// by the id in that call's result. With no such card in the loaded chat the
// line is plain text.

import { createContext, useContext } from "react";
import {
  ASK_DISMISSED_TEXT,
  ASK_FILED_TEXT,
  type AskRef,
  type LogEntry,
} from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";
import type { Translator } from "../../shared/i18n/translate.ts";
import { describeIsomuxRoute } from "./isomux-curl.ts";
import { isomuxRequestForToolCall } from "./tool-call-groups.ts";

/** The ask a user_message answers, from its metadata, or null. */
export function askRefOf(entry: LogEntry): AskRef | null {
  const raw = entry.metadata?.ask;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.prompt !== "string") return null;
  return {
    id: r.id,
    prompt: r.prompt,
    dismissed: r.dismissed === true,
    ...(typeof r.taskId === "string" ? { taskId: r.taskId } : {}),
  };
}

/**
 * The text a member message answering an ask shows: the content of a reply,
 * the translated "Dismissed" of a bare dismiss, and "Dismissed: <reason>"
 * when the member typed a reason; for an ask filed as a task, "Filed as task
 * <id>", with the member's note when they typed one.
 */
export function askAnswerText(
  t: Translator["t"],
  ask: AskRef | null | undefined,
  content: string,
): string {
  if (ask?.taskId)
    return content === ASK_FILED_TEXT
      ? t("asks.filedAsTask", { task: ask.taskId })
      : t("asks.filedAsTaskNote", { task: ask.taskId, note: content });
  if (!ask?.dismissed) return content;
  return content === ASK_DISMISSED_TEXT
    ? t("asks.dismissed")
    : t("asks.dismissedReason", { reason: content });
}

const CREATED_ID = /"id"\s*:\s*"([0-9a-f]{8})"/;

/**
 * Ask id → the log entry id of the tool call that created it. A call
 * counts when it is the create route and its result carries the new id.
 */
export function askOrigins(logs: LogEntry[]): Map<string, string> {
  const callByToolId = new Map<unknown, string>();
  for (const entry of logs) {
    if (entry.kind !== "tool_call") continue;
    const req = isomuxRequestForToolCall(entry.content, entry.metadata?.input);
    if (
      req &&
      describeIsomuxRoute(req.method, req.path) === "apiCall.asks.create"
    )
      callByToolId.set(entry.metadata?.toolId, entry.id);
  }
  const origins = new Map<string, string>();
  if (callByToolId.size === 0) return origins;
  for (const entry of logs) {
    if (entry.kind !== "tool_result") continue;
    const callId = callByToolId.get(entry.metadata?.toolUseId);
    if (!callId) continue;
    const id = CREATED_ID.exec(entry.content)?.[1];
    if (id) origins.set(id, callId);
  }
  return origins;
}

export const AskOrigins = createContext<ReadonlyMap<string, string>>(new Map());

function CheckIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M8 12.5l3 3 5-6" />
    </svg>
  );
}

export function AskLink({
  ask,
  isMobile,
}: {
  ask: AskRef;
  isMobile?: boolean;
}) {
  const { t } = useI18n();
  const origin = useContext(AskOrigins).get(ask.id);
  // Scroll to the card and ring it for a moment, so the eye finds it.
  const jump = () => {
    if (!origin) return;
    const card = document.querySelector<HTMLElement>(
      `[data-log-entry-id="${origin}"]`,
    );
    if (!card) return;
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    card.style.outline = "2px solid var(--orange)";
    card.style.outlineOffset = "2px";
    card.style.borderRadius = "8px";
    setTimeout(() => {
      card.style.outline = "";
      card.style.outlineOffset = "";
      card.style.borderRadius = "";
    }, 1600);
  };
  const label = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <CheckIcon />
      {t("asks.link")}
    </span>
  );
  return (
    <div
      data-ask-link={ask.id}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginBottom: 4,
        fontSize: isMobile ? 12 : 11,
        color: "var(--text-faint)",
        minWidth: 0,
      }}
    >
      {origin ? (
        <button
          type="button"
          onClick={jump}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            font: "inherit",
            fontWeight: 600,
            color: "var(--orange-text)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {label}
        </button>
      ) : (
        <span
          style={{
            fontWeight: 600,
            color: "var(--orange-text)",
            flexShrink: 0,
          }}
        >
          {label}
        </span>
      )}
      <span
        style={{
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {ask.prompt.replace(/\s+/g, " ")}
      </span>
    </div>
  );
}
