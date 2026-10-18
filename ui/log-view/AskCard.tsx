// One open ask: the agent's prompt, its age, a reply field prefilled with the
// catalog's "done", Reply and Dismiss; a secret request has its masked form
// instead (SecretAskCard). The asks stack above the chat input and the Asks
// page both draw it, so a new kind of ask shows on both. The card goes on a
// 204, without waiting for ask_removed. An ask with a link to an office page
// has a button that opens it (ui/office-link.tsx); the ask stays open.

import { useContext, useLayoutEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useDispatch } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { getDevice } from "../device-settings.ts";
import { timeSince } from "../../shared/i18n/time.ts";
import type { AskEntry } from "../../shared/types.ts";
import type {
  AskDismissReq,
  AskReplyReq,
} from "../../shared/contract-shapes.ts";
import { InlineMarkdown } from "../members-chat/InlineMarkdown.tsx";
import { SecretAskCard } from "./SecretAskCard.tsx";
import { officeLinkFor } from "../../shared/office-links.ts";
import { OfficeLinkOpener, officeLinkLabel } from "../office-link.tsx";

const PROMPT_LINES = 3;

// One ask, of either kind.
export function AskCard({
  entry,
  isMobile,
}: {
  entry: AskEntry;
  isMobile: boolean;
}) {
  return entry.secret ? (
    <SecretAskCard entry={entry} secret={entry.secret} isMobile={isMobile} />
  ) : (
    <ReplyAskCard entry={entry} isMobile={isMobile} />
  );
}

function ReplyAskCard({
  entry,
  isMobile,
}: {
  entry: AskEntry;
  isMobile: boolean;
}) {
  const { t, language } = useI18n();
  const dispatch = useDispatch();
  const [reply, setReply] = useState(() => t("asks.replyDefault"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const promptRef = useRef<HTMLDivElement>(null);
  const openLink = useContext(OfficeLinkOpener);
  // A link this UI does not know is not drawn.
  const link = officeLinkFor(entry.link);

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
        await apiFetch("POST", `/api/asks/${entry.id}/dismiss`, {
          ...(device ? { device } : {}),
        } satisfies AskDismissReq);
      else
        await apiFetch("POST", `/api/asks/${entry.id}/reply`, {
          text: reply,
          ...(device ? { device } : {}),
        } satisfies AskReplyReq);
      dispatch({ type: "ask_removed", id: entry.id });
    } catch (err) {
      setBusy(false);
      setError(
        t("asks.answerFailed", {
          error: err instanceof ApiError ? err.message : String(err),
        }),
      );
    }
  }

  const buttonPad = isMobile ? "8px 14px" : "5px 14px";
  return (
    <div
      data-ask={entry.id}
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
            data-ask-prompt=""
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
          {link && openLink && (
            <div style={{ marginTop: 2 }}>
              <button
                type="button"
                data-ask-office-link={entry.link}
                onClick={() => openLink(link)}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "var(--accent-text)",
                  fontSize: isMobile ? 13 : 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {t("asks.openLink", { page: t(officeLinkLabel(link)) })}
              </button>
            </div>
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
          aria-label={t("asks.reply")}
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
          {t("asks.reply")}
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
          {t("asks.dismiss")}
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
