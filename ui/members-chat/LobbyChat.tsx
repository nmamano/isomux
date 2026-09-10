import { useEffect, useRef, useState, type RefObject } from "react";
import { Portal } from "../components/Portal.tsx";
import { useI18n } from "../i18n.tsx";
import { useAppState } from "../store.tsx";
import { MembersChatPanel } from "./MembersChatPanel.tsx";
import { MembersChatUnread } from "./MembersChatUnread.tsx";

function MobileChatPanel({
  loadFailed,
  onRetry,
  onClose,
  entryRef,
}: {
  loadFailed: boolean;
  onRetry?: () => void;
  onClose: () => void;
  entryRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const entry = entryRef.current;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    panel.querySelector<HTMLButtonElement>("button")?.focus();
    const keepFocus = (event: FocusEvent) => {
      if (!panel.contains(event.target as Node)) panel.focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      entry?.focus();
    };
  }, [entryRef]);
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      aria-label={t("membersChat.title")}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button, input, textarea, a[href], [tabindex]",
          ),
        ).filter(
          (el) =>
            el.tabIndex >= 0 &&
            !el.matches(":disabled") &&
            el.getClientRects().length > 0,
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (!first) {
          event.preventDefault();
          event.currentTarget.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === event.currentTarget)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === event.currentTarget)
        ) {
          event.preventDefault();
          first.focus();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100dvh",
        zIndex: 1000,
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      <MembersChatPanel
        onClose={onClose}
        loadFailed={loadFailed}
        onRetry={onRetry}
      />
    </div>
  );
}

// Mounted only on the mobile lobby. Leaving the lobby also forgets open state.
export function LobbyChat({
  loadFailed,
  onRetry,
}: {
  loadFailed: boolean;
  onRetry?: () => void;
}) {
  const { t, tn } = useI18n();
  const {
    membersChat: { unread },
  } = useAppState();
  const label =
    unread > 0
      ? `${t("membersChat.title")} ${tn("membersChat.unreadCount", unread)}`
      : t("membersChat.title");
  const [open, setOpen] = useState(false);
  const entryRef = useRef<HTMLButtonElement>(null);
  function close() {
    setOpen(false);
  }
  return (
    <>
      <button
        ref={entryRef}
        onClick={() => setOpen(true)}
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
      {open && (
        <Portal>
          <MobileChatPanel
            entryRef={entryRef}
            loadFailed={loadFailed}
            onRetry={onRetry}
            onClose={close}
          />
        </Portal>
      )}
    </>
  );
}
