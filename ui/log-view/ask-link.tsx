// The one-line link above a member message that answers an ask
// (internal-docs/asks-design.md). The message's metadata names the
// ask; a click on "Ask" scrolls to the agent's "Create ask" card, found
// by the id in that call's result. With no such card in the loaded chat the
// label is plain text. When the line cuts the prompt, or the prompt has more
// lines or options, a click on the prompt shows it whole with its options
// under the line, and a second click folds it.

import { createContext, useContext, useLayoutEffect, useState } from "react";
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
import { jumpToLogEntry } from "./jump-to-entry.ts";
import { InlineMarkdown } from "../members-chat/InlineMarkdown.tsx";
import { noTranslate } from "../no-translate.ts";

/** The ask a user_message answers, from its metadata, or null. */
export function askRefOf(entry: LogEntry): AskRef | null {
  const raw = entry.metadata?.ask;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.prompt !== "string") return null;
  const options =
    Array.isArray(r.options) &&
    r.options.length > 0 &&
    r.options.every((o) => typeof o === "string")
      ? r.options
      : undefined;
  return {
    id: r.id,
    prompt: r.prompt,
    dismissed: r.dismissed === true,
    ...(typeof r.taskId === "string" ? { taskId: r.taskId } : {}),
    ...(options ? { options } : {}),
    ...(typeof r.recommended === "string"
      ? { recommended: r.recommended }
      : {}),
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

function ChevronIcon({ open, size }: { open: boolean; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        transform: open ? "rotate(90deg)" : undefined,
        transition: "transform 0.15s",
      }}
    >
      <path d="M9 6l6 6-6 6" />
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
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);
  // State, not a ref: each fold and each switch to a toggle draws a new span,
  // and the observer must follow it.
  const [oneLineEl, setOneLineEl] = useState<HTMLSpanElement | null>(null);
  const oneLine = ask.prompt.replace(/\s+/g, " ");
  const options = ask.options ?? [];
  // More to show than the one line: more lines, options, or a cut line.
  const expandable =
    cut || options.length > 0 || ask.prompt.trim().includes("\n");

  // A layout effect, so a line that becomes a toggle draws once; measured
  // again when the line's width changes (a panel opens, the phone turns).
  // While expanded there is no span, and the last measure holds.
  useLayoutEffect(() => {
    if (!oneLineEl) return;
    const measure = () =>
      setCut(oneLineEl.scrollWidth > oneLineEl.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(oneLineEl);
    return () => observer.disconnect();
  }, [oneLineEl, oneLine]);

  const jump = () => {
    if (origin) jumpToLogEntry(origin);
  };
  const label = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <CheckIcon />
      {t("asks.link")}
    </span>
  );
  const oneLineText = (
    <span
      ref={setOneLineEl}
      {...noTranslate()}
      style={{
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        minWidth: 0,
      }}
    >
      {oneLine}
    </span>
  );
  const fontSize = isMobile ? 12 : 11;
  return (
    <div data-ask-link={ask.id} style={{ marginBottom: 4, fontSize }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
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
        {expandable ? (
          // Collapsed, the prompt names the button; expanded, the prompt
          // draws under the line, outside it, so its links keep their clicks.
          <button
            type="button"
            data-ask-link-toggle=""
            aria-expanded={expanded}
            {...(expanded
              ? { "aria-label": t("cards.toolResult.showLess") }
              : {})}
            onClick={() => setExpanded((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              minWidth: 0,
              background: "none",
              border: "none",
              // A taller target than the line, for a finger on the chevron.
              padding: "6px 8px 6px 0",
              margin: "-6px 0",
              font: "inherit",
              color: "inherit",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <ChevronIcon open={expanded} size={isMobile ? 12 : 10} />
            {!expanded && oneLineText}
          </button>
        ) : (
          oneLineText
        )}
      </div>
      {expanded && (
        <div
          data-ask-link-full=""
          style={{
            marginTop: 4,
            padding: "6px 10px",
            borderLeft: "2px solid var(--orange)",
            color: "var(--text-secondary)",
            fontSize: isMobile ? 13 : 12,
            lineHeight: 1.5,
            overflowWrap: "break-word",
          }}
        >
          <div {...noTranslate()}>
            <InlineMarkdown content={ask.prompt.trim()} />
          </div>
          {options.length > 0 && (
            <ul
              style={{
                margin: "6px 0 0",
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
              }}
            >
              {options.map((option, i) => (
                <li
                  key={i}
                  data-ask-link-option=""
                  {...(option === ask.recommended
                    ? { "data-ask-link-option-recommended": "" }
                    : {})}
                  style={{
                    padding: "2px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    color: "var(--text-dim)",
                    overflowWrap: "anywhere",
                  }}
                >
                  <span {...noTranslate()}>{option}</span>
                  {option === ask.recommended && " "}
                  {option === ask.recommended && (
                    <span style={{ marginLeft: 3, opacity: 0.8 }}>
                      {t("asks.recommended")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
