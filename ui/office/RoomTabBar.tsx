import { useAppState, useDispatch } from "../store.tsx";
import { send } from "../ws.ts";
import type { AgentInfo } from "../../shared/types.ts";

export function RoomTabBar() {
  const { agents, currentRoom, roomCount, needsAttention } = useAppState();
  const dispatch = useDispatch();

  // Auto-show: visible when roomCount > 1 OR Room 1 is full (8 agents)
  const room0Full = agents.filter((a) => a.room === 0).length >= 8;
  if (roomCount <= 1 && !room0Full) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "0 12px",
        height: 32,
        background: "var(--bg-hud)",
        borderBottom: "1px solid var(--border-subtle)",
        overflowX: "auto",
        overflowY: "hidden",
        flexShrink: 0,
        zIndex: 500,
      }}
    >
      {Array.from({ length: roomCount }, (_, i) => {
        const isActive = i === currentRoom;
        const roomAgents = agents.filter((a) => a.room === i);
        const hasAttention = roomAgents.some((a) => needsAttention.has(a.id));
        const isEmpty = roomAgents.length === 0;

        return (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              position: "relative",
            }}
          >
            <button
              onClick={(e) => { (e.target as HTMLElement).blur(); dispatch({ type: "set_current_room", room: i }); }}
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                border: isActive ? "1px solid var(--accent)" : "1px solid transparent",
                background: isActive ? "var(--accent-bg)" : "transparent",
                color: isActive ? "var(--accent)" : "var(--text-dim)",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "'JetBrains Mono',monospace",
                letterSpacing: "0.02em",
                outline: "none",
                position: "relative",
              }}
            >
              Room {i + 1}
              <span style={{
                color: "var(--text-hint)",
                fontSize: 9,
                marginLeft: 4
              }}>
                {roomAgents.length}/8
              </span>
              {hasAttention && !isActive && (
                <span
                  style={{
                    position: "absolute",
                    top: 2,
                    right: 2,
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "var(--purple)",
                    boxShadow: "0 0 4px var(--purple)",
                  }}
                />
              )}
            </button>
            {/* Close button: only for empty rooms that aren't Room 1 */}
            {i > 0 && isEmpty && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  send({ type: "close_room", room: i });
                }}
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  border: "none",
                  background: "transparent",
                  color: "var(--text-hint)",
                  fontSize: 10,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  lineHeight: 1,
                }}
                title="Close empty room"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      {/* Add room button */}
      <button
        onClick={() => send({ type: "create_room" })}
        style={{
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px dashed var(--border)",
          background: "transparent",
          color: "var(--text-hint)",
          fontSize: 12,
          cursor: "pointer",
          fontFamily: "'JetBrains Mono',monospace",
          marginLeft: 4,
          flexShrink: 0,
        }}
        title="Create new room"
      >
        +
      </button>
    </div>
  );
}
