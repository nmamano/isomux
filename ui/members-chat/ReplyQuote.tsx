import { membersChatPreview } from "../../shared/members-chat.ts";
import type { MembersChatReply } from "../../shared/types.ts";

export function ReplyQuote({ reply, onJump }: { reply: MembersChatReply; onJump?: () => void }) {
  return (
    <button type="button" onClick={onJump} disabled={!onJump} data-members-chat-quote
      style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderLeft: "3px solid var(--accent)", borderRadius: 4, background: "var(--bg-subtle)", color: "var(--text-secondary)", padding: "5px 8px", marginBottom: 5, fontFamily: "inherit", fontSize: 12, cursor: onJump ? "pointer" : "default" }}>
      <strong style={{ display: "block", color: "var(--accent)" }}>{reply.userName}</strong>
      <span style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{membersChatPreview(reply.excerpt)}</span>
    </button>
  );
}
