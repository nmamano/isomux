import { useState, useRef, useEffect } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { useTheme } from "../store.tsx";
import { StatusLight } from "../office/StatusLight.tsx";
import { TodoButton } from "./TodoPanel.tsx";
import { send } from "../ws.ts";
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
  const { agents, connected, currentRoom, roomCount } = useAppState();
  const dispatch = useDispatch();
  const { theme, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const roomAgents = agents.filter((a) => a.room === currentRoom);
  const room0Full = agents.filter((a) => a.room === 0).length >= 8;
  const showRoomTabs = roomCount > 1 || room0Full;

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
        height: "100dvh",
        background: "var(--bg-base)",
        display: "flex",
        flexDirection: "column",
        fontFamily: "'DM Sans', sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          paddingTop: "calc(12px + env(safe-area-inset-top, 0px))",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-surface)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "var(--text-primary)",
              letterSpacing: "-0.3px",
            }}
          >
            Isomux
          </span>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: connected ? "var(--green)" : "var(--red)",
              flexShrink: 0,
            }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ position: "relative" }} ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              style={{
                background: "var(--btn-surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "6px 10px",
                color: "var(--text-dim)",
                fontSize: 18,
                cursor: "pointer",
                lineHeight: 1,
              }}
            >
              &#8943;
            </button>
            {menuOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  boxShadow: "0 8px 24px var(--shadow-heavy)",
                  minWidth: 180,
                  zIndex: 200,
                  overflow: "hidden",
                }}
              >
                <button
                  onClick={() => { setMenuOpen(false); onOpenTodos(); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "12px 16px",
                    background: "transparent", border: "none",
                    color: "var(--text-primary)", fontSize: 14,
                    cursor: "pointer", textAlign: "left",
                    fontFamily: "'DM Sans',sans-serif",
                  }}
                >
                  <span style={{ width: 20, textAlign: "center", fontSize: 15 }}>&#9745;</span>
                  <span>Todos</span>
                </button>
                <button
                  onClick={() => { setMenuOpen(false); onEditUsername(); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "12px 16px",
                    background: "transparent", border: "none",
                    color: "var(--text-primary)", fontSize: 14,
                    cursor: "pointer", textAlign: "left",
                    fontFamily: "'DM Sans',sans-serif",
                  }}
                >
                  <span style={{ width: 20, textAlign: "center", fontSize: 15 }}>&#9998;</span>
                  <span>{username}</span>
                </button>
                <button
                  onClick={() => { setMenuOpen(false); onEditOfficePrompt(); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "12px 16px",
                    background: "transparent", border: "none",
                    color: "var(--text-primary)", fontSize: 14,
                    cursor: "pointer", textAlign: "left",
                    fontFamily: "'DM Sans',sans-serif",
                  }}
                >
                  <span style={{ width: 20, textAlign: "center", fontSize: 15 }}>&#9881;</span>
                  <span>Office rules</span>
                </button>
                <button
                  onClick={() => { setMenuOpen(false); toggleTheme(); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "12px 16px",
                    background: "transparent", border: "none",
                    color: "var(--text-primary)", fontSize: 14,
                    cursor: "pointer", textAlign: "left",
                    fontFamily: "'DM Sans',sans-serif",
                  }}
                >
                  <span style={{ width: 20, textAlign: "center", fontSize: 15 }}>{theme === "dark" ? "\u2600" : "\u263E"}</span>
                  <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
                </button>
                {onToggleView && (
                  <button
                    onClick={() => { setMenuOpen(false); onToggleView(); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      width: "100%", padding: "12px 16px",
                      background: "transparent", border: "none",
                      color: "var(--text-primary)", fontSize: 14,
                      cursor: "pointer", textAlign: "left",
                      fontFamily: "'DM Sans',sans-serif",
                      borderTop: "1px solid var(--border)",
                    }}
                  >
                    <span style={{ width: 20, textAlign: "center", fontSize: 15 }}>&#9634;</span>
                    <span>Office view</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Room tabs */}
      {showRoomTabs && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "8px 16px",
            borderBottom: "1px solid var(--border)",
            overflowX: "auto",
            flexShrink: 0,
          }}
        >
          {Array.from({ length: roomCount }, (_, i) => {
            const isActive = i === currentRoom;
            const count = agents.filter((a) => a.room === i).length;
            return (
              <button
                key={i}
                onClick={() => dispatch({ type: "set_current_room", room: i })}
                style={{
                  padding: "5px 12px",
                  borderRadius: 8,
                  border: isActive ? "1px solid var(--accent)" : "1px solid var(--border)",
                  background: isActive ? "var(--accent-bg)" : "transparent",
                  color: isActive ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "'JetBrains Mono',monospace",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {i + 1} <span style={{ fontSize: 10, opacity: 0.6 }}>{count}/8</span>
              </button>
            );
          })}
          <button
            onClick={() => send({ type: "create_room" })}
            style={{
              padding: "5px 10px",
              borderRadius: 8,
              border: "1px dashed var(--border)",
              background: "transparent",
              color: "var(--text-hint)",
              fontSize: 14,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            +
          </button>
        </div>
      )}

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
                  onContextMenu(rect.left, rect.bottom + 4, agent);
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
        style={{
          position: "fixed",
          bottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
          right: 24,
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "var(--accent)",
          color: "var(--bg-base)",
          border: "none",
          fontSize: 28,
          fontWeight: 300,
          cursor: "pointer",
          boxShadow: "0 4px 20px var(--shadow-heavy)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1,
          zIndex: 100,
        }}
      >
        +
      </button>
    </div>
  );
}
