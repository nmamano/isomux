import { useEffect, useRef, useState, type RefObject } from "react";
import { Portal } from "../components/Portal.tsx";
import { useI18n } from "../i18n.tsx";
import { MembersChatPanel } from "./MembersChatPanel.tsx";
import { MembersChatButton } from "./MembersChatButton.tsx";
import { useMembersChatHydration } from "./useMembersChatHydration.ts";

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
// Fetches the chat page only while open.
export function LobbyChat() {
  const [open, setOpen] = useState(false);
  const { loadFailed, retry } = useMembersChatHydration(open);
  const entryRef = useRef<HTMLButtonElement>(null);
  function close() {
    setOpen(false);
  }
  return (
    <>
      <MembersChatButton buttonRef={entryRef} onClick={() => setOpen(true)} />
      {open && (
        <Portal>
          <MobileChatPanel
            entryRef={entryRef}
            loadFailed={loadFailed}
            onRetry={retry}
            onClose={close}
          />
        </Portal>
      )}
    </>
  );
}
