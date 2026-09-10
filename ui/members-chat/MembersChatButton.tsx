import type { Ref } from "react";
import { useI18n } from "../i18n.tsx";
import { useAppState } from "../store.tsx";
import { MembersChatUnread } from "./MembersChatUnread.tsx";

export function MembersChatButton({
  onClick,
  buttonRef,
}: {
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const { t, tn } = useI18n();
  const {
    membersChat: { unread },
  } = useAppState();
  const label =
    unread > 0
      ? `${t("membersChat.title")} ${tn("membersChat.unreadCount", unread)}`
      : t("membersChat.title");
  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      type="button"
      data-lobby-chat-fab
      aria-label={label}
      title={t("membersChat.title")}
      style={{
        position: "absolute",
        right: 12,
        // The zoom stack ends 120px above the scene bottom; leave a 12px gap.
        bottom: 132,
        width: 48,
        height: 48,
        padding: 0,
        border: "1px solid var(--border-light)",
        borderRadius: "50%",
        background: "var(--bg-surface)",
        color: "var(--text-primary)",
        boxShadow: "0 4px 16px var(--shadow-heavy)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 400,
      }}
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
        <path d="M7 9h10M7 13h7" />
      </svg>
      <MembersChatUnread />
    </button>
  );
}
