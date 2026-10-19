// One open ask: the agent's prompt, its age, a reply field prefilled with the
// catalog's "done", Reply and Dismiss; a secret request has its masked form
// instead (SecretAskCard). The asks stack above the chat input and the Asks
// page both draw it, so a new kind of ask shows on both. The card goes on a
// 204, without waiting for ask_removed. An ask with a link to an office page
// or an agent's chat has a button that opens it (ui/office-link.tsx); the ask
// stays open. An ask with options has a button for each, and a tap sends it
// as the reply. An ask's files, editor files and commands are the chat's own
// cards, in that order; their buttons open this agent's panel through the
// store, as in chat (on the Inbox they also open the agent's chat), and
// answer nothing.
//
// The reply draft lives in the store per ask (askDrafts), so it outlives the
// card. While the field holds the untouched default, focus and click select
// it, and Dismiss sends nothing more; a typed reason goes with the dismiss.
// Tab and Shift+Tab move between the reply fields inside the list that draws
// the cards ([data-asks-list]); at either end the browser's order goes on.

import {
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useAppState, useDispatch, useFeatures } from "../store.tsx";
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
import { askLinkFor } from "../../shared/office-links.ts";
import { OfficeLinkOpener, officeLinkLabel } from "../office-link.tsx";
import { FileViewCard } from "./FileViewCard.tsx";
import { EditRequestCard } from "./EditRequestCard.tsx";
import { TerminalCommandCard } from "./TerminalCommandCard.tsx";

const PROMPT_LINES = 3;

// Tab and Shift+Tab to the next or previous reply field of the list. No move
// past either end, so focus is never trapped.
function tabToReplyField(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.nativeEvent.isComposing) return;
  const list = e.currentTarget.closest("[data-asks-list]");
  if (!list) return;
  const fields = [
    ...list.querySelectorAll<HTMLInputElement>("input[data-ask-reply-input]"),
  ].filter((f) => !f.disabled);
  const at = fields.indexOf(e.currentTarget);
  if (at === -1) return;
  const next = fields[at + (e.shiftKey ? -1 : 1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

// One ask, of either kind. `onFocusAgent` is set where the ask's chat is not
// on screen (the Inbox): a click on a terminal or editor card opens it.
export function AskCard({
  entry,
  isMobile,
  onFocusAgent,
}: {
  entry: AskEntry;
  isMobile: boolean;
  onFocusAgent?: (agentId: string) => void;
}) {
  return entry.secret ? (
    <SecretAskCard entry={entry} secret={entry.secret} isMobile={isMobile} />
  ) : (
    <ReplyAskCard
      entry={entry}
      isMobile={isMobile}
      onFocusAgent={onFocusAgent}
    />
  );
}

// A path or command with no panel to send it to: the text only.
function PlainAffordance({ text }: { text: string }) {
  return (
    <div
      style={{
        margin: "8px 0",
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 13,
        color: "var(--text-secondary)",
        wordBreak: "break-all",
      }}
    >
      {text}
    </div>
  );
}

function AskAffordances({
  entry,
  isMobile,
  onFocusAgent,
}: {
  entry: AskEntry;
  isMobile: boolean;
  onFocusAgent?: (agentId: string) => void;
}) {
  const dispatch = useDispatch();
  const features = useFeatures();
  const { agentId, readFiles, editFiles, commands } = entry;
  if (!readFiles && !editFiles && !commands) return null;
  const openInEditor = (path: string) => {
    dispatch({ type: "open_in_editor", agentId, path });
    onFocusAgent?.(agentId);
  };
  const copyToTerminal = (command: string) => {
    dispatch({ type: "copy_to_terminal", agentId, command });
    onFocusAgent?.(agentId);
  };
  return (
    <div style={{ marginTop: 4 }}>
      {readFiles && (
        <FileViewCard
          attachments={readFiles}
          agentId={agentId}
          isMobile={isMobile}
        />
      )}
      {editFiles?.map((file, i) => (
        <div key={i} data-ask-edit-file={file.path}>
          {features.editor ? (
            <EditRequestCard payload={file} onOpen={openInEditor} />
          ) : (
            <PlainAffordance text={file.path} />
          )}
        </div>
      ))}
      {commands?.map((command, i) => (
        <div key={i} data-ask-command={command}>
          {features.terminal ? (
            <TerminalCommandCard
              payload={{ command }}
              onCopy={copyToTerminal}
            />
          ) : (
            <PlainAffordance text={command} />
          )}
        </div>
      ))}
    </div>
  );
}

function ReplyAskCard({
  entry,
  isMobile,
  onFocusAgent,
}: {
  entry: AskEntry;
  isMobile: boolean;
  onFocusAgent?: (agentId: string) => void;
}) {
  const { t, language } = useI18n();
  const dispatch = useDispatch();
  const { askDrafts, agents } = useAppState();
  const draft = askDrafts.get(entry.id);
  const untouched = draft === undefined;
  const reply = draft ?? t("asks.replyDefault");
  const [busy, setBusy] = useState(false);
  // One answer at a time: a second tap in the same frame still sees busy false.
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const promptRef = useRef<HTMLDivElement>(null);
  const openLink = useContext(OfficeLinkOpener);
  // A link this UI does not know is not drawn, nor one to an agent the store
  // does not have.
  const link = askLinkFor(entry.link);
  const linkLabel = !link
    ? null
    : "agentId" in link
      ? (agents.find((a) => a.id === link.agentId)?.name ?? null)
      : t(officeLinkLabel(link));

  // Show more only when the clamp cuts the prompt.
  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el || expanded) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [entry.prompt, expanded]);

  const since = timeSince(language, entry.createdAt);
  const age = since.kind === "now" ? t("common.justNow") : since.text;
  const fontSize = isMobile ? 14 : 13;

  // What the member typed, unless it is blank or the default again.
  function dismissReason(): string | null {
    if (draft === undefined) return null;
    const typed = draft.trim();
    return typed === "" || typed === t("asks.replyDefault").trim()
      ? null
      : draft;
  }

  // While the field holds the untouched default, typing replaces it.
  function selectDefault(el: HTMLInputElement) {
    if (untouched) el.setSelectionRange(0, el.value.length);
  }

  async function answer(dismiss: boolean, text = reply) {
    if (sending.current) return;
    if (!dismiss && text.trim() === "") return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const device = getDevice() || undefined;
    try {
      if (dismiss) {
        const reason = dismissReason();
        await apiFetch("POST", `/api/asks/${entry.id}/dismiss`, {
          ...(reason !== null ? { text: reason } : {}),
          ...(device ? { device } : {}),
        } satisfies AskDismissReq);
      } else
        await apiFetch("POST", `/api/asks/${entry.id}/reply`, {
          text,
          ...(device ? { device } : {}),
        } satisfies AskReplyReq);
      dispatch({ type: "ask_removed", id: entry.id });
    } catch (err) {
      sending.current = false;
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
          {link && linkLabel !== null && openLink && (
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
                {t("asks.openLink", { page: linkLabel })}
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
      <AskAffordances
        entry={entry}
        isMobile={isMobile}
        onFocusAgent={onFocusAgent}
      />
      {entry.options && entry.options.length > 0 && (
        <div
          data-ask-options=""
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}
        >
          {entry.options.map((option, i) => (
            <button
              key={i}
              type="button"
              data-ask-option=""
              disabled={busy}
              onClick={() => void answer(false, option)}
              style={{
                maxWidth: "100%",
                padding: buttonPad,
                borderRadius: 8,
                border: "1px solid var(--accent-text)",
                background: "transparent",
                color: "var(--accent-text)",
                fontFamily: "var(--font-ui)",
                fontSize: isMobile ? 14 : 12,
                fontWeight: 600,
                lineHeight: 1.35,
                textAlign: "left",
                overflowWrap: "anywhere",
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
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
          data-ask-reply-input=""
          onChange={(e) =>
            dispatch({
              type: "set_ask_draft",
              askId: entry.id,
              text: e.target.value,
            })
          }
          onFocus={(e) => selectDefault(e.currentTarget)}
          onClick={(e) => selectDefault(e.currentTarget)}
          onKeyDown={tabToReplyField}
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
