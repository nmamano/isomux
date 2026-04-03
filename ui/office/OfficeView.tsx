import { useState, useRef, useEffect } from "react";
import { useAppState, useDispatch, useTheme } from "../store.tsx";
import { Floor, Walls } from "./Floor.tsx";
import { RoomProps } from "./RoomProps.tsx";
import { RoomTabBar } from "./RoomTabBar.tsx";
import { DeskUnit } from "./DeskUnit.tsx";
import { EmptySlot } from "./EmptySlot.tsx";
import { StatusLight } from "./StatusLight.tsx";
import { SCENE_W, SCENE_H } from "./grid.ts";
import { send } from "../ws.ts";
import { TodoButton } from "../components/TodoPanel.tsx";
import type { AgentInfo } from "../../shared/types.ts";

export function OfficeView({ onSpawn, onContextMenu, username, onEditUsername, onEditOfficePrompt, onOpenTodos }: { onSpawn: (deskIndex: number) => void; onContextMenu: (x: number, y: number, agent: AgentInfo) => void; username: string; onEditUsername: () => void; onEditOfficePrompt: () => void; onOpenTodos: () => void }) {
  const { agents, needsAttention, stateChangedAt, officePrompt, todos, currentRoom, roomCount, isMobile } = useAppState();
  const dispatch = useDispatch();
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

  const mobileScale = isMobile ? screen.width / (SCENE_W - 200) : 1;

  // Filter agents to current room for rendering
  const roomAgents = agents.filter((a) => a.room === currentRoom);

  const counts = {
    working: roomAgents.filter((a) => ["thinking", "tool_executing"].includes(a.state)).length,
    waiting: roomAgents.filter((a) => a.state === "waiting_for_response").length,
    error: roomAgents.filter((a) => a.state === "error").length,
    idle: roomAgents.filter((a) => a.state === "idle" || a.state === "stopped").length,
  };

  return (
    <div
      style={{
        height: isMobile ? "calc(100dvh - var(--banner-h, 0px))" : "calc(100vh - var(--banner-h, 0px))",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
        fontFamily: "'DM Sans',sans-serif",
      }}
    >
      {/* Top HUD bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: isMobile ? "0 12px" : "0 20px",
          paddingTop: isMobile ? "env(safe-area-inset-top, 0px)" : undefined,
          height: isMobile ? 40 : 44,
          background: "var(--bg-hud)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          zIndex: 500,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          {isMobile && (
            <button
              onClick={() => dispatch({ type: "toggle_mobile_view" })}
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
              <svg width="14" height="14" viewBox="0 0 32 32" style={{ display: "block" }}>
                <polygon points="16,2 30,10 16,18 2,10" fill="currentColor" opacity="0.9" />
                <polygon points="2,10 16,18 16,30 2,22" fill="currentColor" opacity="0.5" />
                <polygon points="30,10 16,18 16,30 30,22" fill="currentColor" opacity="0.35" />
              </svg>
            </button>
          )}
          <span style={{ fontSize: isMobile ? 14 : 15, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text-primary)" }}>Isomux</span>
        </div>
        <div style={{ display: "flex", gap: isMobile ? 8 : 12 }}>
          {(
            [
              { n: counts.working, c: "var(--green)", l: "working", short: "working" },
              { n: counts.waiting, c: "var(--purple)", l: "waiting", short: "waiting" },
              { n: counts.error, c: "var(--red)", l: "error", short: "err" },
              { n: counts.idle, c: "var(--text-muted)", l: "idle", short: null as string | null },
            ] as const
          )
            .filter((s) => s.n > 0 && (!isMobile || s.short !== null))
            .map((s) => (
              <div
                key={s.l}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: isMobile ? 3 : 5,
                  fontSize: isMobile ? 9 : 10,
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
                {s.n} {isMobile ? s.short : s.l}
              </div>
            ))}
        </div>
        {isMobile ? (
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
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <TodoButton onOpen={onOpenTodos} />
            <button
              onClick={onEditOfficePrompt}
              style={{
                padding: "4px 10px",
                borderRadius: 8,
                border: "1px solid var(--border-medium)",
                background: "var(--btn-surface)",
                color: "var(--text-dim)",
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "'DM Sans',sans-serif",
              }}
            >
              Office settings
            </button>
            <button
              onClick={toggleTheme}
              style={{
                padding: "4px 10px",
                borderRadius: 8,
                border: "1px solid var(--border-medium)",
                background: "var(--btn-surface)",
                color: "var(--text-dim)",
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "'DM Sans',sans-serif",
              }}
            >
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
        )}
      </div>

      <RoomTabBar />

      {/* Office scene */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {/* Ambient gradients */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse at 50% 30%, var(--ambient-1) 0%, transparent 50%), radial-gradient(ellipse at 25% 65%, var(--ambient-2) 0%, transparent 35%), radial-gradient(ellipse at 75% 65%, var(--ambient-3) 0%, transparent 35%)",
          }}
        />

        {/* Single scene container — floor, walls, and desks share the same coordinate space */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: isMobile ? "45%" : "50%",
            transform: isMobile
              ? `translate(-50%, -50%) scale(${mobileScale})`
              : "translate(-50%, -50%)",
            transformOrigin: "center center",
            width: SCENE_W,
            height: SCENE_H,
          }}
        >
          <Walls
            onToggleTheme={toggleTheme}
            onEditOfficePrompt={onEditOfficePrompt}
            hasOfficePrompt={!!officePrompt}
            onOpenTodos={onOpenTodos}
            todoCount={todos.length}
            leftDoor={currentRoom > 0 ? { label: `Room ${currentRoom}`, onClick: () => dispatch({ type: "set_current_room", room: currentRoom - 1 }) } : null}
            rightDoor={currentRoom < roomCount - 1 ? { label: `Room ${currentRoom + 2}`, onClick: () => dispatch({ type: "set_current_room", room: currentRoom + 1 }) } : null}
          />
          <Floor />
          <RoomProps />
          {Array.from({ length: 8 }, (_, i) => {
            const agent = roomAgents.find((a) => a.desk === i);
            if (agent) {
              return (
                <DeskUnit
                  key={agent.id}
                  agent={agent}
                  onClick={() => dispatch({ type: "focus", agentId: agent.id })}
                  onContextMenu={(e) => onContextMenu(e.clientX, e.clientY, agent)}
                  needsAttention={needsAttention.has(agent.id)}
                  onSwap={(a, b) => send({ type: "swap_desks", deskA: a, deskB: b, room: currentRoom })}
                  stateChangedAt={stateChangedAt.get(agent.id)}
                />
              );
            }
            return <EmptySlot key={`empty-${i}`} deskIndex={i} onClick={() => onSpawn(i)} onSwap={(a, b) => send({ type: "swap_desks", deskA: a, deskB: b, room: currentRoom })} />;
          })}
        </div>

        {/* Vignette */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            boxShadow: "inset 0 0 120px var(--vignette)",
          }}
        />
      </div>

      {/* Bottom HUD */}
      <div
        style={{
          padding: isMobile ? "8px 12px" : "8px 20px",
          ...(isMobile ? { paddingBottom: "calc(8px + env(safe-area-inset-bottom, 0px))" } : {}),
          background: "var(--bg-hud-bottom)",
          backdropFilter: "blur(8px)",
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: isMobile ? 12 : 20,
          flexShrink: 0,
          zIndex: 500,
        }}
      >
        {(isMobile
          ? ["TAP → open", "LONG-PRESS → actions"]
          : ["CLICK → open agent", "DRAG → swap desks", "RIGHT-CLICK → actions", "ESC → back"]
        ).map((h, i) => (
          <span
            key={i}
            style={{
              fontSize: 9,
              color: "var(--text-hint)",
              fontFamily: "'JetBrains Mono',monospace",
              letterSpacing: "0.04em",
            }}
          >
            {h}
          </span>
        ))}
      </div>
    </div>
  );
}
