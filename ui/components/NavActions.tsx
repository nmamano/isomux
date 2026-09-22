import { useState, useRef, useEffect, type ReactNode } from "react";
import { Portal } from "./Portal.tsx";
import { useI18n } from "../i18n.tsx";

export type NavAction = {
  id: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  title?: string;
  // Shown but inert, for an action that exists and has nothing to act on
  // (End with no conversation running).
  disabled?: boolean;
};

export function NavActions({
  actions,
  viewport,
}: {
  actions: NavAction[];
  viewport: "mobile" | "desktop";
}) {
  if (viewport === "desktop") return <DesktopActions actions={actions} />;
  return <MobileActions actions={actions} />;
}

function DesktopActions({ actions }: { actions: NavAction[] }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--nav-actions-gap, 6px)",
      }}
    >
      {actions.map((a) => (
        <button
          key={a.id}
          onClick={a.onClick}
          disabled={a.disabled}
          title={a.title ?? a.label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--nav-action-inner-gap, 6px)",
            padding: "5px var(--nav-action-inline-padding, 10px)",
            borderRadius: 6,
            border: `1px solid ${a.active ? "var(--green-border)" : "var(--border-medium)"}`,
            background: a.active ? "var(--green-bg)" : "var(--btn-surface)",
            color: a.active ? "var(--green)" : "var(--text-dim)",
            opacity: a.disabled ? 0.45 : 1,
            fontSize: 11,
            cursor: a.disabled ? "not-allowed" : "pointer",
            transition: "color 0.15s, background 0.15s, border-color 0.15s",
            lineHeight: 1,
          }}
        >
          <span style={{ display: "flex", alignItems: "center" }}>
            {a.icon}
          </span>
          <span className="nav-action-label">{a.label}</span>
        </button>
      ))}
    </div>
  );
}

function MobileActions({ actions }: { actions: NavAction[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect)
      setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t))
        return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        title={t("common.moreActions")}
        style={{
          background: "var(--btn-surface)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "3px 8px",
          color: "var(--text-dim)",
          fontSize: 16,
          cursor: "pointer",
          lineHeight: 1,
        }}
      >
        &#8943;
      </button>
      {open && pos && (
        <Portal>
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              top: pos.top,
              right: pos.right,
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              boxShadow: "0 8px 24px var(--shadow-heavy)",
              minWidth: 200,
              zIndex: 2000,
              overflow: "hidden",
            }}
          >
            {actions.map((a) => (
              <button
                key={a.id}
                title={a.title ?? a.label}
                disabled={a.disabled}
                onClick={() => {
                  setOpen(false);
                  a.onClick();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  width: "100%",
                  padding: "12px 16px",
                  background: a.active ? "var(--green-bg)" : "transparent",
                  border: "none",
                  color: a.active ? "var(--green)" : "var(--text-primary)",
                  opacity: a.disabled ? 0.45 : 1,
                  fontSize: 14,
                  cursor: a.disabled ? "not-allowed" : "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    width: 20,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {a.icon}
                </span>
                <span>{a.label}</span>
              </button>
            ))}
          </div>
        </Portal>
      )}
    </>
  );
}
