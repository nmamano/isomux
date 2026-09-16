import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n.tsx";

export function useUnsavedChangesPrompt(
  dirty: boolean,
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>,
  onDiscard?: () => void,
) {
  const [open, setOpen] = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (dirty) return;
    pendingActionRef.current = null;
    // Defer the state update because this effect reacts to a saved/reset form;
    // a synchronous update here trips React's cascading-render safeguard.
    const close = window.setTimeout(() => setOpen(false), 0);
    return () => window.clearTimeout(close);
  }, [dirty]);

  useEffect(() => {
    if (closeRef) {
      closeRef.current = (after?: () => void) => {
        if (!dirty) {
          after?.();
          return;
        }
        pendingActionRef.current = after ?? null;
        setOpen(true);
      };
    }
    return () => {
      if (closeRef) closeRef.current = null;
    };
  });

  function discard() {
    const next = pendingActionRef.current;
    pendingActionRef.current = null;
    setOpen(false);
    onDiscard?.();
    next?.();
  }

  function cancel() {
    pendingActionRef.current = null;
    setOpen(false);
  }

  return { open, discard, cancel };
}

export function UnsavedChangesPrompt({
  onDiscard,
  onCancel,
  message,
  confirmLabel,
}: {
  onDiscard: () => void;
  onCancel: () => void;
  message?: ReactNode;
  confirmLabel?: ReactNode;
}) {
  const { t } = useI18n();
  const promptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    promptRef.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div
      ref={promptRef}
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        marginTop: 12,
        padding: "8px 10px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-input)",
      }}
    >
      <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}>
        {message ?? t("common.discardPrompt")}
      </span>
      <button
        onClick={onDiscard}
        style={{
          padding: "6px 12px",
          borderRadius: 6,
          border: "1px solid var(--red)",
          background: "var(--red)",
          color: "var(--bg-base)",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {confirmLabel ?? t("common.discard")}
      </button>
      <button
        onClick={onCancel}
        style={{
          padding: "6px 12px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "transparent",
          color: "var(--text-primary)",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}
