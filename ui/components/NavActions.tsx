import {
  useState,
  useRef,
  useEffect,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Portal } from "./Portal.tsx";
import { MenuItem } from "./ContextMenu.tsx";
import { useI18n } from "../i18n.tsx";

export type NavMenuItem = { id: string; label: string; onClick: () => void };

type NavActionBase = {
  id: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  title?: string;
  // Shown but inert, for an action that exists and has nothing to act on
  // (End with no conversation running).
  disabled?: boolean;
  // A count that needs the member, such as open pages. Zero or absent shows
  // nothing.
  badge?: number;
};

// An action runs on click, or opens a menu of choices (Copy: what to copy).
export type NavAction = NavActionBase &
  (
    | { onClick: () => void; menu?: never }
    | { menu: NavMenuItem[]; onClick?: never }
  );

function Badge({ count }: { count: number }) {
  return (
    <span
      className="nav-action-badge"
      style={{
        minWidth: 16,
        height: 16,
        padding: "0 4px",
        borderRadius: 8,
        background: "var(--red)",
        color: "#fff",
        fontSize: 10,
        fontWeight: 700,
        lineHeight: "16px",
        textAlign: "center",
        boxSizing: "border-box",
      }}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

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
      {actions.map((a) =>
        a.menu ? (
          <DesktopMenuAction key={a.id} action={a} menu={a.menu} />
        ) : (
          <button
            key={a.id}
            onClick={a.onClick}
            disabled={a.disabled}
            title={a.title ?? a.label}
            style={desktopButtonStyle(a)}
          >
            <DesktopButtonContent action={a} />
          </button>
        ),
      )}
    </div>
  );
}

function desktopButtonStyle(a: NavAction): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "var(--nav-action-inner-gap, 6px)",
    padding: "5px var(--nav-action-inline-padding, 10px)",
    borderRadius: 6,
    border: `1px solid ${a.active ? "var(--green-border)" : "var(--border-medium)"}`,
    background: a.active ? "var(--green-bg)" : "var(--btn-surface)",
    color: a.disabled
      ? "var(--text-hint)"
      : a.active
        ? "var(--green-text)"
        : "var(--text-dim)",
    fontSize: 11,
    cursor: a.disabled ? "not-allowed" : "pointer",
    transition: "color 0.15s, background 0.15s, border-color 0.15s",
    lineHeight: 1,
  };
}

function DesktopButtonContent({ action: a }: { action: NavAction }) {
  return (
    <>
      <span style={{ display: "flex", alignItems: "center" }}>{a.icon}</span>
      <span className="nav-action-label">{a.label}</span>
      {a.badge ? <Badge count={a.badge} /> : null}
    </>
  );
}

// The button opens its choices under it, drawn like the Apps page's actions
// menu.
function DesktopMenuAction({
  action: a,
  menu,
}: {
  action: NavAction;
  menu: NavMenuItem[];
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setAt(null);
    };
    // Only a scroll that moves the button detaches the menu. The chat log
    // scrolls itself to follow new entries, and must not close it.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && t.contains(buttonRef.current)) setAt(null);
    };
    const onResize = () => setAt(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setAt(null);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [at]);

  function toggle() {
    if (at) {
      setAt(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAt({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }

  return (
    <>
      <button
        ref={buttonRef}
        onClick={toggle}
        disabled={a.disabled}
        title={a.title ?? a.label}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        style={desktopButtonStyle(a)}
      >
        <DesktopButtonContent action={a} />
      </button>
      {at && (
        <Portal>
          <div
            ref={menuRef}
            role="menu"
            data-nav-menu={a.id}
            style={{
              position: "fixed",
              top: at.top,
              right: at.right,
              zIndex: 1000,
              background: "var(--bg-overlay)",
              backdropFilter: "blur(16px)",
              border: "1px solid var(--border-light)",
              borderRadius: 12,
              padding: 5,
              minWidth: 170,
              boxShadow: "0 12px 40px var(--shadow-heavy)",
              animation: "hudIn 0.12s ease-out",
            }}
          >
            {menu.map((item) => (
              <MenuItem
                key={item.id}
                role="menuitem"
                dataNavMenuItem={item.id}
                label={item.label}
                onClick={() => {
                  setAt(null);
                  item.onClick();
                }}
              />
            ))}
          </div>
        </Portal>
      )}
    </>
  );
}

function MobileActions({ actions }: { actions: NavAction[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // The action whose choices show under its row. Collapsed on every open.
  const [expanded, setExpanded] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  // The menu hides its rows, so the trigger carries a dot for any badge.
  const badged = actions.some((a) => a.badge);

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
    // Only a scroll that moves the trigger detaches the fixed menu. The chat
    // log scrolls itself to follow new entries, and must not close it.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && t.contains(triggerRef.current)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => {
          setExpanded(null);
          setOpen((v) => !v);
        }}
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
          position: "relative",
        }}
      >
        &#8943;
        {badged && (
          <span
            className="nav-action-badge-dot"
            aria-hidden="true"
            style={{
              position: "absolute",
              top: -3,
              right: -3,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--red)",
            }}
          />
        )}
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
            {actions.map((a) => {
              const menu = a.menu;
              const isExpanded = menu !== undefined && expanded === a.id;
              return (
                <div key={a.id}>
                  <button
                    title={a.title ?? a.label}
                    disabled={a.disabled}
                    aria-expanded={menu ? isExpanded : undefined}
                    onClick={() => {
                      if (menu) {
                        setExpanded(isExpanded ? null : a.id);
                        return;
                      }
                      setOpen(false);
                      a.onClick?.();
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      width: "100%",
                      padding: "12px 16px",
                      background: a.active ? "var(--green-bg)" : "transparent",
                      border: "none",
                      color: a.disabled
                        ? "var(--text-hint)"
                        : a.active
                          ? "var(--green-text)"
                          : "var(--text-primary)",
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
                    <span style={{ flex: 1 }}>{a.label}</span>
                    {a.badge ? <Badge count={a.badge} /> : null}
                  </button>
                  {menu && isExpanded && (
                    <div role="group" data-nav-menu={a.id}>
                      {menu.map((item) => (
                        <button
                          key={item.id}
                          role="menuitem"
                          data-nav-menu-item={item.id}
                          onClick={() => {
                            setOpen(false);
                            item.onClick();
                          }}
                          style={{
                            display: "block",
                            width: "100%",
                            // Under the parent's label, past its icon column.
                            padding: "10px 16px 10px 48px",
                            background: "transparent",
                            border: "none",
                            color: "var(--text-primary)",
                            fontSize: 14,
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Portal>
      )}
    </>
  );
}
