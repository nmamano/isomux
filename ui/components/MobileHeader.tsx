import { useState, useRef, useEffect } from "react";
import { useTheme } from "../store.tsx";
import { SunIcon, MoonIcon } from "./ThemeIcons.tsx";
import type { AgentInfo } from "../../shared/types.ts";

export type RoomCounts = {
  working: number;
  waiting: number;
  error: number;
  idle: number;
};

export function getRoomCounts(roomAgents: AgentInfo[]): RoomCounts {
  return {
    working: roomAgents.filter((a) => ["thinking", "tool_executing"].includes(a.state)).length,
    waiting: roomAgents.filter((a) => a.state === "waiting_for_response").length,
    error: roomAgents.filter((a) => a.state === "error").length,
    idle: roomAgents.filter((a) => a.state === "idle" || a.state === "stopped").length,
  };
}

const LIST_ICON = (
  <svg width="12" height="10" viewBox="0 0 12 10" fill="currentColor" style={{ display: "block" }}>
    <rect y="0" width="12" height="2" rx="0.5" />
    <rect y="4" width="12" height="2" rx="0.5" />
    <rect y="8" width="12" height="2" rx="0.5" />
  </svg>
);

const ISO_ICON = (
  <svg width="14" height="14" viewBox="0 0 32 32" style={{ display: "block" }}>
    <polygon points="16,2 30,10 16,18 2,10" fill="currentColor" opacity="0.9" />
    <polygon points="2,10 16,18 16,30 2,22" fill="currentColor" opacity="0.5" />
    <polygon points="30,10 16,18 16,30 30,22" fill="currentColor" opacity="0.35" />
  </svg>
);

export function MobileHeader({
  viewMode,
  onToggleView,
  counts,
  onOpenTasks,
  onEditOfficePrompt,
  onEditRoomSettings,
  updateAvailable,
  onOpenUpdate,
}: {
  viewMode: "list" | "office";
  onToggleView: () => void;
  counts: RoomCounts;
  onOpenTasks: () => void;
  onEditOfficePrompt: () => void;
  onEditRoomSettings?: () => void;
  updateAvailable?: boolean;
  onOpenUpdate?: () => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 12px",
        paddingTop: "env(safe-area-inset-top, 0px)",
        height: 40,
        background: "var(--bg-hud)",
        backdropFilter: "blur(16px)",
        borderBottom: "1px solid var(--border-subtle)",
        flexShrink: 0,
        zIndex: 500,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <button
          onClick={onToggleView}
          style={{
            background: "var(--btn-surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            width: 28,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-dim)",
            cursor: "pointer",
            marginRight: 4,
            padding: 0,
          }}
        >
          {viewMode === "list" ? LIST_ICON : ISO_ICON}
        </button>
        <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text-primary)" }}>Isomux</span>
        {updateAvailable && (
          <span
            onClick={onOpenUpdate}
            style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", margin: "-12px -12px -12px -4px", flexShrink: 0, cursor: "pointer" }}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--blue, #58a6ff)", boxShadow: "0 0 6px var(--blue, #58a6ff)" }} />
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {(
          [
            { n: counts.working, c: "var(--green)", label: "working" },
            { n: counts.waiting, c: "var(--purple)", label: "waiting" },
            { n: counts.error, c: "var(--red)", label: "err" },
          ] as const
        )
          .filter((s) => s.n > 0)
          .map((s) => (
            <div
              key={s.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 3,
                fontSize: 9,
                fontWeight: 600,
                color: s.c,
                fontFamily: "'JetBrains Mono',monospace",
                letterSpacing: "0.02em",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: s.c,
                  boxShadow: `0 0 6px ${s.c}`,
                }}
              />
              {s.n} {s.label}
            </div>
          ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ position: "relative" }} ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
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
          {menuOpen && (
            <div
              style={{
                position: "fixed",
                top: menuRef.current ? menuRef.current.getBoundingClientRect().bottom + 6 : 0,
                right: 12,
                background: "var(--bg-surface)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                boxShadow: "0 8px 24px var(--shadow-heavy)",
                minWidth: 180,
                zIndex: 1000,
                overflow: "hidden",
              }}
            >
              {[
                { icon: <span style={{ fontSize: 15 }}>&#x2611;</span>, label: "Tasks", action: onOpenTasks },
                { icon: <span style={{ fontSize: 15 }}>&#x2699;</span>, label: "Office settings", action: onEditOfficePrompt },
                ...(onEditRoomSettings ? [{ icon: <span style={{ fontSize: 15 }}>&#x2302;</span>, label: "Room settings", action: onEditRoomSettings }] : []),
                { icon: theme === "dark" ? <SunIcon size={15} /> : <MoonIcon size={15} />, label: theme === "dark" ? "Light mode" : "Dark mode", action: toggleTheme },
              ].map((item, i) => (
                <button
                  key={i}
                  onClick={() => { setMenuOpen(false); item.action(); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "12px 16px",
                    background: "transparent", border: "none",
                    color: "var(--text-primary)", fontSize: 14,
                    cursor: "pointer", textAlign: "left",
                    fontFamily: "'DM Sans',sans-serif",
                  }}
                >
                  <span style={{ width: 20, display: "flex", alignItems: "center", justifyContent: "center" }}>{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
