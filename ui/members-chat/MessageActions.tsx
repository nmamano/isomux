import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n.tsx";
import { secondaryFill } from "../components/dialog-styles.ts";

export function MessageActions({
  children,
}: {
  children: (close: () => void) => ReactNode;
}) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("click", outside);
    return () => document.removeEventListener("click", outside);
  }, [open]);
  return (
    <details
      open={open}
      ref={menuRef}
      style={{ position: "relative" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
          menuRef.current?.querySelector("summary")?.focus();
        }
      }}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
        aria-label={t("membersChat.actions")}
        title={t("membersChat.actions")}
        style={{
          listStyle: "none",
          cursor: "pointer",
          color: "var(--text-ghost)",
          // The box and border of the copy button beside it (CopyButton).
          width: 24,
          height: 24,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid var(--border-medium)",
          borderRadius: 6,
          background: secondaryFill,
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="3" cy="8" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="13" cy="8" r="1.5" />
        </svg>
      </summary>
      <div
        style={{
          position: "absolute",
          right: 0,
          top: "100%",
          zIndex: 5,
          // Drawn like the agent and app ⋯ menus, whose rows (MenuItem) it
          // holds.
          minWidth: 140,
          padding: 5,
          border: "1px solid var(--border-light)",
          borderRadius: 12,
          background: "var(--bg-overlay)",
          backdropFilter: "blur(16px)",
          boxShadow: "0 12px 40px var(--shadow-heavy)",
        }}
      >
        {children(close)}
      </div>
    </details>
  );
}
