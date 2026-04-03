import { useState, useRef, useEffect } from "react";
import { useAppState, useTheme } from "../store.tsx";
import { StatusLight } from "../office/StatusLight.tsx";
import { RoomTabBar } from "../office/RoomTabBar.tsx";
import type { AgentInfo } from "../../shared/types.ts";

export function AgentListView({
  onFocus,
  onSpawn,
  onContextMenu,
  username,
  onEditUsername,
  onEditOfficePrompt,
  onOpenTodos,
  onToggleView,
}: {
  onFocus: (agentId: string) => void;
  onSpawn: () => void;
  onContextMenu: (x: number, y: number, agent: AgentInfo) => void;
  username: string;
  onEditUsername: () => void;
  onEditOfficePrompt: () => void;
  onOpenTodos: () => void;
  onToggleView?: () => void;
}) {
  const { agents, currentRoom, roomCount } = useAppState();
  const { theme, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const roomAgents = agents.filter((a) => a.room === currentRoom);

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
        position: "fixed",
        inset: 0,
        height: "calc(100dvh - var(--banner-h, 0px))",
        background: "var(--bg-base)",
        display: "flex",
        flexDirection: "column",
        fontFamily: "'DM Sans', sans-serif",
      }}
    >
      {/* Header — matches isometric view */}
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
          {onToggleView && (
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
              <svg width="12" height="10" viewBox="0 0 12 10" fill="currentColor" style={{ display: "block" }}>
                <rect y="0" width="12" height="2" rx="0.5" />
                <rect y="4" width="12" height="2" rx="0.5" />
                <rect y="8" width="12" height="2" rx="0.5" />
              </svg>
            </button>
          )}
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text-primary)" }}>Isomux</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {(
            [
              { n: roomAgents.filter((a) => ["thinking", "tool_executing"].includes(a.state)).length, c: "var(--green)", short: "work" },
              { n: roomAgents.filter((a) => a.state === "waiting_for_response").length, c: "var(--purple)", short: "wait" },
              { n: roomAgents.filter((a) => a.state === "error").length, c: "var(--red)", short: "err" },
            ] as const
          )
            .filter((s) => s.n > 0)
            .map((s) => (
              <div
                key={s.short}
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
                {s.n} {s.short}
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
                  { icon: "\u2611", label: "Todos", action: onOpenTodos },
                  { icon: "\u2699", label: "Office settings", action: onEditOfficePrompt },
                  { icon: theme === "dark" ? "\u2600" : "\u263E", label: theme === "dark" ? "Light mode" : "Dark mode", action: toggleTheme },
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
                    <span style={{ width: 20, textAlign: "center", fontSize: 15 }}>{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <RoomTabBar />

      {/* Agent list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        {roomAgents.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              gap: 8,
              padding: 32,
            }}
          >
            <span style={{ fontSize: 15, color: "var(--text-muted)" }}>
              {roomCount > 1 ? `Room ${currentRoom + 1} is empty` : "No agents yet"}
            </span>
            <span style={{ fontSize: 13, color: "var(--text-faint)" }}>
              Tap + to spawn one
            </span>
          </div>
        ) : (
          roomAgents.map((agent) => (
            <div
              key={agent.id}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "12px 16px",
                borderBottom: "1px solid var(--border)",
                cursor: "pointer",
              }}
              onClick={() => onFocus(agent.id)}
            >
              <div
                style={{
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  marginRight: 12,
                }}
              >
                <StatusLight state={agent.state} size={10} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {agent.name}
                </div>
                {agent.topic && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      marginTop: 2,
                    }}
                  >
                    {agent.topic}
                  </div>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = (e.target as HTMLElement).getBoundingClientRect();
                  onContextMenu(Math.max(8, rect.right - 208), rect.bottom + 4, agent);
                }}
                style={{
                  flexShrink: 0,
                  background: "transparent",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 20,
                  cursor: "pointer",
                  padding: "4px 8px",
                  lineHeight: 1,
                  marginLeft: 8,
                }}
              >
                ...
              </button>
            </div>
          ))
        )}
      </div>

      {/* Floating spawn button */}
      <button
        onClick={onSpawn}
        disabled={roomAgents.length >= 8}
        style={{
          position: "fixed",
          bottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
          right: 24,
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: roomAgents.length >= 8 ? "var(--text-muted)" : "var(--accent)",
          color: "var(--bg-base)",
          border: "none",
          fontSize: 28,
          fontWeight: 300,
          cursor: roomAgents.length >= 8 ? "default" : "pointer",
          boxShadow: "0 4px 20px var(--shadow-heavy)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: "56px",
          zIndex: 100,
          opacity: roomAgents.length >= 8 ? 0.5 : 1,
          paddingBottom: 2,
        }}
      >
        +
      </button>
    </div>
  );
}
