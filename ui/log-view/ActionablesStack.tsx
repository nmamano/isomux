// The agent's open actionables for this member, stacked above the chat input
// (internal-docs/actionables-design.md). Each card is the agent's prompt, a
// reply field prefilled with the catalog's "done", Reply and Dismiss. The
// stack scrolls past a maximum height and collapses to one bar: open by
// default on a desktop, collapsed on a phone. The server closes an answered
// actionable and pushes actionable_removed; the card also goes on a 204, so
// the click shows its result without waiting for the push.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useAppState, useDispatch } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { getDevice } from "../device-settings.ts";
import { timeSince } from "../../shared/i18n/time.ts";
import type { ActionableEntry } from "../../shared/types.ts";
import type {
  ActionableDismissReq,
  ActionableReplyReq,
} from "../../shared/contract-shapes.ts";
import { actionablesFor } from "../actionables-sync.ts";
import { InlineMarkdown } from "../members-chat/InlineMarkdown.tsx";

// The stack's height before it scrolls: about two and a half cards on a
// desktop, so a cut card shows there is more.
const MAX_HEIGHT_DESKTOP = 240;
const MAX_HEIGHT_MOBILE = "45vh";
const PROMPT_LINES = 3;

function Chevron({ open, size }: { open: boolean; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
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

function CountPill({ count, isMobile }: { count: number; isMobile: boolean }) {
  return (
    <span
      style={{
        fontSize: isMobile ? 11 : 10,
        fontWeight: 700,
        color: "var(--bg-base)",
        background: "var(--orange-text)",
        padding: "0 6px",
        borderRadius: 8,
        lineHeight: "16px",
        flexShrink: 0,
      }}
    >
      {count}
    </span>
  );
}

function ActionableCard({
  entry,
  isMobile,
}: {
  entry: ActionableEntry;
  isMobile: boolean;
}) {
  const { t, language } = useI18n();
  const dispatch = useDispatch();
  const [reply, setReply] = useState(() => t("actionables.replyDefault"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const promptRef = useRef<HTMLDivElement>(null);

  // Show more only when the clamp cuts the prompt.
  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el || expanded) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [entry.prompt, expanded]);

  const since = timeSince(language, entry.createdAt);
  const age = since.kind === "now" ? t("common.justNow") : since.text;
  const fontSize = isMobile ? 14 : 13;

  async function answer(dismiss: boolean) {
    if (busy) return;
    if (!dismiss && reply.trim() === "") return;
    setBusy(true);
    setError(null);
    const device = getDevice() || undefined;
    try {
      if (dismiss)
        await apiFetch("POST", `/api/actionables/${entry.id}/dismiss`, {
          ...(device ? { device } : {}),
        } satisfies ActionableDismissReq);
      else
        await apiFetch("POST", `/api/actionables/${entry.id}/reply`, {
          text: reply,
          ...(device ? { device } : {}),
        } satisfies ActionableReplyReq);
      dispatch({ type: "actionable_removed", id: entry.id });
    } catch (err) {
      setBusy(false);
      setError(
        t("actionables.answerFailed", {
          error: err instanceof ApiError ? err.message : String(err),
        }),
      );
    }
  }

  const buttonPad = isMobile ? "8px 14px" : "5px 14px";
  return (
    <div
      data-actionable={entry.id}
      style={{
        padding: isMobile ? "9px 10px 10px 11px" : "8px 10px 9px 11px",
        borderRadius: 8,
        background: "var(--bg-subtle)",
        border: "1px solid var(--border-light)",
        borderLeft: "3px solid var(--orange)",
        marginBottom: 6,
        fontFamily: "var(--font-ui)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            ref={promptRef}
            data-actionable-prompt=""
            style={{
              color: "var(--text-primary)",
              fontSize,
              lineHeight: 1.5,
              overflowWrap: "break-word",
              ...(expanded
                ? {}
                : {
                    display: "-webkit-box",
                    WebkitLineClamp: PROMPT_LINES,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }),
            }}
          >
            <InlineMarkdown content={entry.prompt} />
          </div>
          {(clamped || expanded) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                marginTop: 2,
                color: "var(--accent-text)",
                fontSize: isMobile ? 12 : 11,
                cursor: "pointer",
              }}
            >
              {expanded
                ? t("cards.toolResult.showLess")
                : t("cards.toolResult.showMore")}
            </button>
          )}
        </div>
        <span
          style={{
            color: "var(--text-ghost)",
            fontSize: isMobile ? 12 : 11,
            lineHeight: `${fontSize * 1.5}px`,
            flexShrink: 0,
          }}
        >
          {age}
        </span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void answer(false);
        }}
        style={{ display: "flex", gap: 6, marginTop: 7, alignItems: "center" }}
      >
        <input
          value={reply}
          disabled={busy}
          onChange={(e) => setReply(e.target.value)}
          aria-label={t("actionables.reply")}
          style={{
            flex: 1,
            minWidth: 0,
            maxWidth: isMobile ? undefined : 460,
            padding: isMobile ? "8px 10px" : "5px 10px",
            background: "var(--bg-input)",
            border: "1px solid var(--border-light)",
            borderRadius: 8,
            color: "var(--text-primary)",
            fontFamily: "var(--font-ui)",
            // 16px keeps iOS Safari from zooming into the field.
            fontSize: isMobile ? 16 : 12,
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={busy || reply.trim() === ""}
          style={{
            padding: buttonPad,
            borderRadius: 8,
            border: "none",
            background: "var(--accent-text)",
            color: "var(--bg-base)",
            fontSize: 12,
            fontWeight: 600,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
            flexShrink: 0,
          }}
        >
          {t("actionables.reply")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void answer(true)}
          style={{
            padding: buttonPad,
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text-dim)",
            fontSize: 12,
            cursor: busy ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          {t("actionables.dismiss")}
        </button>
      </form>
      {error && (
        <div
          role="alert"
          style={{
            marginTop: 6,
            color: "var(--red-text)",
            fontSize: isMobile ? 12 : 11,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

export function ActionablesStack({
  agentId,
  isMobile,
}: {
  agentId: string;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const { actionables } = useAppState();
  const entries = actionablesFor(actionables, agentId);
  const [collapsed, setCollapsed] = useState(isMobile);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Fade the bottom edge while more cards wait below it.
  const [moreBelow, setMoreBelow] = useState(false);
  const measure = () => {
    const el = bodyRef.current;
    setMoreBelow(
      !!el && el.scrollTop + el.clientHeight < el.scrollHeight - 2,
    );
  };
  useEffect(measure, [entries.length, collapsed, actionables]);

  if (entries.length === 0) return null;
  const toggleStyle = {
    display: "flex",
    alignItems: "center",
    fontFamily: "var(--font-ui)",
    cursor: "pointer",
  } as const;

  if (collapsed)
    return (
      <div data-actionables-stack="collapsed" style={{ marginBottom: 10 }}>
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setCollapsed(false)}
          style={{
            ...toggleStyle,
            gap: 7,
            width: "100%",
            padding: isMobile ? "9px 10px" : "6px 10px",
            borderRadius: 8,
            background: "var(--bg-subtle)",
            border: "1px solid var(--border-light)",
            borderLeft: "3px solid var(--orange)",
            color: "var(--text-secondary)",
            fontSize: isMobile ? 13 : 12,
            textAlign: "left",
          }}
        >
          <span style={{ color: "var(--text-muted)", display: "flex" }}>
            <Chevron open={false} size={isMobile ? 12 : 10} />
          </span>
          <CountPill count={entries.length} isMobile={isMobile} />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {entries[0].prompt.replace(/\s+/g, " ")}
          </span>
        </button>
      </div>
    );

  const fade = "linear-gradient(to bottom, black calc(100% - 28px), transparent)";
  return (
    <div data-actionables-stack="open" style={{ marginBottom: 10 }}>
      <button
        type="button"
        aria-expanded={true}
        onClick={() => setCollapsed(true)}
        style={{
          ...toggleStyle,
          gap: 6,
          background: "none",
          border: "none",
          padding: "0 0 6px 2px",
          color: "var(--text-muted)",
          fontSize: isMobile ? 12 : 11,
          fontWeight: 600,
        }}
      >
        <Chevron open size={isMobile ? 12 : 10} />
        <span>{t("actionables.title")}</span>
        <CountPill count={entries.length} isMobile={isMobile} />
      </button>
      <div
        ref={bodyRef}
        onScroll={measure}
        data-actionables-body=""
        style={{
          maxHeight: isMobile ? MAX_HEIGHT_MOBILE : MAX_HEIGHT_DESKTOP,
          overflowY: "auto",
          ...(moreBelow ? { maskImage: fade, WebkitMaskImage: fade } : {}),
        }}
      >
        {entries.map((entry) => (
          <ActionableCard key={entry.id} entry={entry} isMobile={isMobile} />
        ))}
      </div>
    </div>
  );
}
