import type { CSSProperties } from "react";
import { membersChatPreview } from "../../shared/members-chat.ts";
import type { MembersChatReply } from "../../shared/types.ts";
import { noTranslate } from "../no-translate.ts";

// A quote with somewhere to jump is a button; one without (the composer's
// "replying to", a pinned or unloaded message) is plain content, not a
// disabled control.
export function ReplyQuote({
  reply,
  onJump,
}: {
  reply: MembersChatReply;
  onJump?: () => void;
}) {
  const style: CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "left",
    border: "none",
    borderLeft: "3px solid var(--accent)",
    borderRadius: 4,
    background: "var(--bg-subtle)",
    color: "var(--text-secondary)",
    padding: "5px 8px",
    marginBottom: 5,
    fontFamily: "inherit",
    fontSize: 12,
  };
  const body = (
    <>
      <strong style={{ display: "block", color: "var(--accent-text)" }}>
        {reply.userName}
      </strong>
      <span
        style={{
          display: "block",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {membersChatPreview(reply.excerpt)}
      </span>
    </>
  );
  // A name and a member's words: neither is page copy.
  if (!onJump)
    return (
      <div data-members-chat-quote {...noTranslate()} style={style}>
        {body}
      </div>
    );
  return (
    <button
      type="button"
      onClick={onJump}
      data-members-chat-quote
      {...noTranslate()}
      style={{ ...style, cursor: "pointer" }}
    >
      {body}
    </button>
  );
}
