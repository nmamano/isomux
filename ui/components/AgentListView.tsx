import { useAppState } from "../store.tsx";
import { useTheme } from "../store.tsx";
import { StatusLight } from "../office/StatusLight.tsx";
import type { AgentInfo } from "../../shared/types.ts";

export function AgentListView({
  onFocus,
  onSpawn,
  onContextMenu,
  username,
  onEditUsername,
}: {
  onFocus: (agentId: string) => void;
  onSpawn: () => void;
  onContextMenu: (x: number, y: number, agent: AgentInfo) => void;
  username: string;
  onEditUsername: () => void;
}) {
  const { agents, connected } = useAppState();
  const { theme, toggleTheme } = useTheme();

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
          <span
            onClick={onEditUsername}
            style={{
              color: "var(--text-dim)",
              fontSize: 12,
              fontFamily: "'JetBrains Mono',monospace",
              cursor: "pointer",
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--btn-surface)",
            }}
            title="Change name"
          >
            {username.toUpperCase()}
          </span>
          <button
            onClick={toggleTheme}
            style={{
              background: "var(--btn-surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "6px 10px",
              color: "var(--text-dim)",
              fontSize: 14,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            {theme === "dark" ? "\u2600" : "\u263E"}
          </button>
        </div>
      </div>

      {/* Agent list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        {agents.length === 0 ? (
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
              No agents yet
            </span>
            <span style={{ fontSize: 13, color: "var(--text-faint)" }}>
              Tap + to spawn one
            </span>
          </div>
        ) : (
          agents.map((agent) => (
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
