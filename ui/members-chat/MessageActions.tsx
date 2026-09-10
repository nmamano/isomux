import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n.tsx";

export function MessageActions({ children }: { children: (close: () => void) => ReactNode }) {
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
    <details open={open} ref={menuRef} style={{ position: "relative" }} onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        menuRef.current?.querySelector("summary")?.focus();
      }
    }}>
      <summary onClick={(event) => { event.preventDefault(); setOpen((value) => !value); }} aria-label={t("membersChat.actions")} title={t("membersChat.actions")} style={{ listStyle: "none", cursor: "pointer", color: "var(--text-ghost)", padding: 2 }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></svg>
      </summary>
      <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 5, minWidth: 120, display: "flex", flexDirection: "column", alignItems: "stretch", gap: 8, padding: 10, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-surface-solid)", boxShadow: "0 4px 16px #0002" }}>
        {children(close)}
      </div>
    </details>
  );
}
