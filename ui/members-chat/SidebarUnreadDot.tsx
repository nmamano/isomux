// A dot on the collapsed sidebar's open button while a human chat has unread
// (the sidebar's rows, which carry the counts, are hidden). The button is
// position: relative.
import { useHumanChatUnread } from "./human-chat-unread.ts";

export function SidebarUnreadDot() {
  if (useHumanChatUnread() <= 0) return null;
  return (
    <span
      data-sidebar-unread-dot=""
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 2,
        right: 2,
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: "var(--purple)",
        boxShadow: "0 0 4px var(--purple)",
      }}
    />
  );
}
