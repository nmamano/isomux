import { useState } from "react";
import type { MembersChatMessage } from "../../shared/types.ts";
import { membersChatExcerpt, membersChatPreview } from "../../shared/members-chat.ts";
import { formatNumber } from "../../shared/i18n/number.ts";
import { useI18n } from "../i18n.tsx";
import { UserMessage } from "../log-view/LogEntryCard.tsx";
import { InlineMarkdown } from "./InlineMarkdown.tsx";
import { ReplyQuote } from "./ReplyQuote.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { MEMBERS_CHAT_FILES_BASE } from "./api.ts";

export function PinnedMessageStrip({ message, count, author, loaded, onJump, onUnpin }: {
  message: MembersChatMessage;
  count: number;
  author: string;
  loaded: boolean;
  onJump: () => void;
  onUnpin: () => void;
}) {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const countLabel = count > 20 ? `${formatNumber(language, 20)}+` : formatNumber(language, count);
  return (
    <div data-members-chat-pinned style={{ flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
      <button type="button" aria-expanded={expanded} onClick={() => {
        if (loaded) { setExpanded(false); onJump(); }
        else setExpanded((value) => !value);
      }} style={{ display: "block", width: "100%", border: "none", background: "transparent", padding: "7px 12px", textAlign: "left", fontFamily: "inherit", color: "var(--text-secondary)", cursor: "pointer" }}>
        <span style={{ display: "block", color: "var(--accent)", fontSize: 11, fontWeight: 600 }}>{t("membersChat.pinned", { count: countLabel })} · {author}</span>
        <span style={{ display: "block", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{membersChatPreview(membersChatExcerpt(message.content, message.attachments))}</span>
      </button>
      {expanded && <div data-members-chat-expanded-pin style={{ maxHeight: 240, overflowY: "auto", padding: "0 10px 8px" }}>
        <UserMessage variant="members-chat" content={message.content} username={author} fromNonHuman={message.kind !== "user"}
          renderedContent={<InlineMarkdown content={message.content} />}
          beforeContent={message.replyTo && <ReplyQuote reply={message.replyTo} />}
          attachments={message.attachments} fileBase={MEMBERS_CHAT_FILES_BASE}
          extraActions={<MessageActions>{(close) => <button type="button" style={{ border: "none", background: "transparent", color: "var(--text-primary)", textAlign: "left", font: "inherit", fontSize: 12, cursor: "pointer", padding: "4px 0" }} onClick={() => { close(); onUnpin(); }}>{t("membersChat.unpin")}</button>}</MessageActions>}
        />
      </div>}
    </div>
  );
}
