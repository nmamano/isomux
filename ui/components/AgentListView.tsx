import { useAppState, useTheme } from "../store.tsx";
import { StatusLight } from "../office/StatusLight.tsx";
import { RoomTabBar } from "../office/RoomTabBar.tsx";
import { MobileHeader, getRoomCounts } from "./MobileHeader.tsx";
import { useSwipeLeftRight } from "../hooks/useSwipeLeftRight.ts";
import { type NavAction } from "./NavActions.tsx";
import {
  TasksIcon,
  IsoIcon,
  ClockIcon,
  AppsIcon,
  SettingsIcon,
} from "./NavIcons.tsx";
import { SunIcon, MoonIcon } from "./ThemeIcons.tsx";
import type { AgentInfo } from "../../shared/types.ts";
import { DESK_COUNT } from "../../shared/desks.ts";

export function AgentListView({
  onFocus,
  onSpawn,
  onContextMenu,
  onOpenSettings,
  onEditRoomSettings,
  onOpenThemePicker,
  onOpenTasks,
  onOpenCronjobs,
  onOpenApps,
  onOpenUpdate,
  onToggleView,
  onSwipeLeft,
  onSwipeRight,
}: {
  onFocus: (agentId: string) => void;
  onSpawn: () => void;
  onContextMenu: (x: number, y: number, agent: AgentInfo) => void;
  onOpenSettings: () => void;
  onEditRoomSettings?: (roomId: string) => void;
  onOpenThemePicker: () => void;
  onOpenTasks: () => void;
  onOpenCronjobs: () => void;
  onOpenApps: () => void;
  onOpenUpdate: () => void;
  onToggleView: () => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}) {
  const { agents, currentRoomId, rooms, updateAvailable, needsAttention } =
    useAppState();
  const { mode } = useTheme();
  const roomCount = rooms.length;
  const roomAgents = agents.filter((a) => a.roomId === currentRoomId);
  const currentRoomName = rooms.find((r) => r.id === currentRoomId)?.name;
  const swipeRef = useSwipeLeftRight(
    onSwipeLeft ?? (() => {}),
    onSwipeRight ?? (() => {}),
    true,
  );

  const actions: NavAction[] = [
    { id: "tasks", icon: TasksIcon, label: "Tasks", onClick: onOpenTasks },
    {
      id: "cronjobs",
      icon: ClockIcon,
      label: "Cron jobs",
      onClick: onOpenCronjobs,
    },
    { id: "apps", icon: AppsIcon, label: "Apps", onClick: onOpenApps },
    // One gear for every setting, matching the floor view's bar.
    {
      id: "settings",
      icon: SettingsIcon,
      label: "Settings",
      onClick: onOpenSettings,
    },
    {
      id: "theme",
      icon: mode === "dark" ? <MoonIcon size={15} /> : <SunIcon size={15} />,
      label: "Theme",
      onClick: onOpenThemePicker,
      title: "Change theme",
    },
    {
      id: "list",
      icon: IsoIcon,
      label: "Show floor view",
      onClick: onToggleView,
    },
  ];

  return (
    <>
      <div
        style={{
          height: "calc(100dvh - var(--banner-h, 0px))",
          background: "var(--bg-base)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <MobileHeader
          counts={getRoomCounts(roomAgents)}
          actions={actions}
          updateAvailable={updateAvailable}
          onOpenUpdate={onOpenUpdate}
        />

        <RoomTabBar onOpenRoomSettings={onEditRoomSettings} />

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
                {roomCount > 1
                  ? `${currentRoomName ?? "This room"} is empty`
                  : "No agents yet"}
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
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "var(--text-primary)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        minWidth: 0,
                      }}
                    >
                      {agent.name}
                    </span>
                    {needsAttention.has(agent.id) && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: "white",
                          background: "var(--purple)",
                          padding: "1px 6px",
                          borderRadius: 8,
                          letterSpacing: "0.02em",
                          boxShadow: "0 0 4px var(--purple)",
                          flexShrink: 0,
                        }}
                      >
                        unread
                      </span>
                    )}
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
                    const rect = (
                      e.target as HTMLElement
                    ).getBoundingClientRect();
                    onContextMenu(
                      Math.max(8, rect.right - 208),
                      rect.bottom + 4,
                      agent,
                    );
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
          disabled={roomAgents.length >= DESK_COUNT}
          style={{
            position: "fixed",
            bottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
            right: 24,
            width: 56,
            height: 56,
            borderRadius: "50%",
            background:
              roomAgents.length >= DESK_COUNT
                ? "var(--text-muted)"
                : "var(--accent)",
            color: "var(--bg-base)",
            border: "none",
            fontSize: 28,
            fontWeight: 300,
            cursor: roomAgents.length >= DESK_COUNT ? "default" : "pointer",
            boxShadow: "0 4px 20px var(--shadow-heavy)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: "56px",
            zIndex: 100,
            opacity: roomAgents.length >= DESK_COUNT ? 0.5 : 1,
            paddingBottom: 2,
          }}
        >
          +
        </button>
      </div>
    </>
  );
}
