import { useI18n } from "../i18n.tsx";
import { useHumanChatUnread } from "./human-chat-unread.ts";

// The phone lobby's chat button: unread across every human chat.
export function MembersChatUnread() {
  const unread = useHumanChatUnread();
  const { tn } = useI18n();
  if (unread <= 0) return null;
  const label = tn("membersChat.unreadCount", unread);
  return (
    <span
      data-lobby-unread
      role="img"
      title={label}
      aria-label={label}
      style={{
        position: "absolute",
        top: 2,
        right: 2,
        width: 5,
        height: 5,
        borderRadius: "50%",
        background: "var(--purple)",
        boxShadow: "0 0 4px var(--purple)",
      }}
    />
  );
}
