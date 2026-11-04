import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n.tsx";
import { secondaryBorder, secondaryFill } from "./dialog-styles.ts";

export function useUnsavedChangesPrompt(
  dirty: boolean,
  {
    closeRef,
    onDiscard,
    onLeave,
    resumeWhenClean = true,
  }: {
    // Filled with the guarded close every render, for a parent that routes
    // its navigation through this form.
    closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
    // Resets the fields when the member picks Discard.
    onDiscard?: () => void;
    // Runs before the stashed action on every exit that goes through.
    onLeave?: () => void;
    // When the form turns clean while the prompt is open (a save that was in
    // flight has finished), close the prompt and run the stashed action.
    // False closes the prompt and drops the action. Default true.
    resumeWhenClean?: boolean;
  } = {},
) {
  const [open, setOpen] = useState(false);
  // The exit that waits on the prompt: set while the prompt is open, with the
  // caller's action if it gave one.
  const pendingRef = useRef<{ after?: () => void } | null>(null);
  // The timer below runs after the render that made the form clean, so it
  // reads the options of the latest render.
  const latestRef = useRef({ onLeave, resumeWhenClean });
  useEffect(() => {
    latestRef.current = { onLeave, resumeWhenClean };
  });

  useEffect(() => {
    if (dirty) return;
    // Defer the state update because this effect reacts to a saved/reset form;
    // a synchronous update here trips React's cascading-render safeguard.
    // The pending exit is read when the timer fires: if the form turns dirty
    // again first, the cleanup cancels the timer and the exit still waits.
    const close = window.setTimeout(() => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      setOpen(false);
      // Nothing is unsaved now (a save that raced the exit has finished), so
      // the exit the member asked for goes through.
      if (pending && latestRef.current.resumeWhenClean) leave(pending.after);
    }, 0);
    return () => window.clearTimeout(close);
  }, [dirty]);

  function leave(after?: () => void) {
    latestRef.current.onLeave?.();
    after?.();
  }

  function request(after?: () => void) {
    if (!dirty) {
      leave(after);
      return;
    }
    pendingRef.current = { after };
    setOpen(true);
  }

  useEffect(() => {
    if (closeRef) closeRef.current = request;
    return () => {
      if (closeRef) closeRef.current = null;
    };
  });

  function discard() {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setOpen(false);
    onDiscard?.();
    leave(pending?.after);
  }

  function cancel() {
    pendingRef.current = null;
    setOpen(false);
  }

  return { open, discard, cancel, request };
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
          background: "var(--red-text)",
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
          border: secondaryBorder,
          background: secondaryFill,
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
