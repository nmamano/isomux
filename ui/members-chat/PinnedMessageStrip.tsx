import { useState } from "react";
import type { MembersChatMessage } from "../../shared/types.ts";
import {
  membersChatExcerpt,
  membersChatPreview,
} from "../../shared/members-chat.ts";
import { formatNumber } from "../../shared/i18n/number.ts";
import { useI18n } from "../i18n.tsx";
import { UserMessage } from "../log-view/LogEntryCard.tsx";
import { InlineMarkdown } from "./InlineMarkdown.tsx";
import { ReplyQuote } from "./ReplyQuote.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { noTranslate } from "../no-translate.ts";

// The newest pin as a two-line bar above the list. Held (no message yet):
// the same box with the count only, busy and disabled, from full_state's pin
// count until the page brings the pin (UI rule: a view keeps its layout while
// it loads).
export function PinnedMessageStrip(
  props: { count: number } & (
    | {
        message: MembersChatMessage;
        author: string;
        // Where the room chat's files are served from.
        fileBase: string;
        loaded: boolean;
        onJump: () => void;
        onUnpin: () => void;
      }
    | { message?: undefined }
  ),
) {
  const { count, message } = props;
  const live = props.message ? props : null;
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const countLabel =
    count > 20
      ? `${formatNumber(language, 20)}+`
      : formatNumber(language, count);
  return (
    <div
      data-members-chat-pinned
      aria-busy={message ? undefined : true}
      style={{
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-subtle)",
      }}
    >
      <button
        type="button"
        disabled={!message}
        aria-expanded={message ? expanded : undefined}
        onClick={() => {
          if (!live) return;
          if (live.loaded) {
            setExpanded(false);
            live.onJump();
          } else setExpanded((value) => !value);
        }}
        style={{
          display: "block",
          width: "100%",
          border: "none",
          background: "transparent",
          padding: "7px 12px",
          textAlign: "left",
          fontFamily: "inherit",
          color: "var(--text-secondary)",
          cursor: message ? "pointer" : "default",
          opacity: message ? undefined : 0.6,
        }}
      >
        <span
          style={{
            display: "block",
            color: "var(--accent-text)",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {t("membersChat.pinned", { count: countLabel })}
          {live && (
            <>
              {" "}
              · <span {...noTranslate()}>{live.author}</span>
            </>
          )}
        </span>
        <span
          {...noTranslate()}
          style={{
            display: "block",
            fontSize: 12,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {message ? (
            membersChatPreview(
              membersChatExcerpt(message.content, message.attachments),
            )
          ) : (
            <span
              style={{
                display: "inline-block",
                width: "40%",
                height: "0.8em",
                borderRadius: 3,
                background: "var(--border)",
                verticalAlign: "middle",
              }}
            />
          )}
        </span>
      </button>
      {expanded && live && (
        <div
          data-members-chat-expanded-pin
          style={{ maxHeight: 240, overflowY: "auto", padding: "0 10px 8px" }}
        >
          <UserMessage
            variant="members-chat"
            content={live.message.content}
            username={live.author}
            fromNonHuman={live.message.kind !== "user"}
            renderedContent={<InlineMarkdown content={live.message.content} />}
            beforeContent={
              live.message.replyTo && (
                <ReplyQuote reply={live.message.replyTo} />
              )
            }
            attachments={live.message.attachments}
            fileBase={live.fileBase}
            extraActions={
              <MessageActions>
                {(close) => (
                  <button
                    type="button"
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "var(--text-primary)",
                      textAlign: "left",
                      font: "inherit",
                      fontSize: 12,
                      cursor: "pointer",
                      padding: "4px 0",
                    }}
                    onClick={() => {
                      close();
                      live.onUnpin();
                    }}
                  >
                    {t("membersChat.unpin")}
                  </button>
                )}
              </MessageActions>
            }
          />
        </div>
      )}
    </div>
  );
}
