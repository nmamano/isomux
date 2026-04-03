import { useAppState } from "../store.tsx";
import { StatusLight } from "../office/StatusLight.tsx";
import { RoomTabBar } from "../office/RoomTabBar.tsx";
import { MobileHeader, getRoomCounts } from "./MobileHeader.tsx";
import { useSwipeLeftRight } from "../hooks/useSwipeLeftRight.ts";
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
  onSwipeLeft,
  onSwipeRight,
}: {
  onFocus: (agentId: string) => void;
  onSpawn: () => void;
  onContextMenu: (x: number, y: number, agent: AgentInfo) => void;
  username: string;
  onEditUsername: () => void;
  onEditOfficePrompt: () => void;
  onOpenTodos: () => void;
  onToggleView: () => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}) {
  const { agents, currentRoom, roomCount } = useAppState();
  const roomAgents = agents.filter((a) => a.room === currentRoom);
  const swipeRef = useSwipeLeftRight(onSwipeLeft ?? (() => {}), onSwipeRight ?? (() => {}), true);

  return (
    <div
      style={{
        height: "calc(100dvh - var(--banner-h, 0px))",
        background: "var(--bg-base)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: "'DM Sans', sans-serif",
      }}
    >
      <MobileHeader
        viewMode="list"
        onToggleView={onToggleView}
        counts={getRoomCounts(roomAgents)}
        onOpenTodos={onOpenTodos}
        onEditOfficePrompt={onEditOfficePrompt}
      />

      <RoomTabBar />

      {/* Agent list */}
      <div
        ref={swipeRef}
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
