import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";

export function MembersChatUnread() {
  const {
    membersChat: { unread },
  } = useAppState();
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
