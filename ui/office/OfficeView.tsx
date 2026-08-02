import { useState, useEffect, useCallback } from "react";
import { useAppState, useDispatch, useTheme, useFeatures } from "../store.tsx";
import { Floor, Walls } from "./Floor.tsx";
import { RoomProps } from "./RoomProps.tsx";
import { RoomTabBar } from "./RoomTabBar.tsx";
import { DeskUnit } from "./DeskUnit.tsx";
import { EmptySlot } from "./EmptySlot.tsx";
import { GhostBody, GhostTag } from "./Ghost.tsx";
import { useGhostTransitions, type DoorCoord } from "./useGhostTransitions.ts";
import { SCENE_W, SCENE_H } from "./grid.ts";
import { apiFetch } from "../api.ts";
import type {
  MoveAgentReq,
  SwapDesksReq,
} from "../../shared/contract-shapes.ts";
import { SunIcon, MoonIcon } from "../components/ThemeIcons.tsx";
import { ThemePicker } from "../components/ThemePicker.tsx";
import { MobileHeader, getRoomCounts } from "../components/MobileHeader.tsx";
import { NavActions, type NavAction } from "../components/NavActions.tsx";
import {
  WallPanelMenu,
  type WallPanelMenuItem,
} from "../components/WallPanelMenu.tsx";
import {
  TasksIcon,
  BuildingIcon,
  DoorIcon,
  ListIcon,
  DeviceIcon,
  ClockIcon,
  UserIcon,
} from "../components/NavIcons.tsx";
import { useSwipeLeftRight } from "../hooks/useSwipeLeftRight.ts";
import { useViewport } from "./useViewport.ts";
import { ZoomControls } from "./ZoomControls.tsx";
import type { AgentInfo } from "../../shared/types.ts";
import { DESK_COUNT } from "../../shared/desks.ts";
import { buildCommitNotice } from "../../shared/update-notice.ts";

// Pixel size of a single ghost (width). ~50% of the agent character
// (52×68) so it reads as "small floating watcher" against the desks.
// Height scales proportionally inside the SVG viewBox.
const GHOST_SIZE = 40;

// Pixel coords (scene-container space) where ghosts park when sliding
// to/from a door on a room switch. Roughly centered horizontally on the
// DoorDropZone (left zone x ∈ [0,85]; right zone x ∈ [SCENE_W-85, SCENE_W])
// with the ghost-box top placed so the body sits in front of the door
// threshold. Module-level so the hook's effect deps stay stable.
const LEFT_DOOR_COORD: DoorCoord = { left: 25, top: 270 };
const RIGHT_DOOR_COORD: DoorCoord = { left: SCENE_W - 65, top: 270 };

/** HTML drop zone positioned over an SVG door - SVG elements are unreliable drag-and-drop targets */
function DoorDropZone({
  side,
  onDrop,
  onDragOverChange,
  onClick,
}: {
  side: "left" | "right";
  onDrop: (deskIndex: number) => boolean;
  onDragOverChange: (over: boolean) => void;
  onClick: () => void;
}) {
  const [reject, setReject] = useState(false);
  // Pixel positions within the 950×700 scene container, derived from the SVG door transforms
  const style: React.CSSProperties =
    side === "left"
      ? {
          position: "absolute",
          left: 0,
          top: 225,
          width: 85,
          height: 155,
          zIndex: 200,
        }
      : {
          position: "absolute",
          right: 0,
          top: 225,
          width: 85,
          height: 155,
          zIndex: 200,
        };
  return (
    <div
      data-no-pan
      style={{
        ...style,
        cursor: "pointer",
        background: reject ? "rgba(255,60,60,0.08)" : "transparent",
      }}
      onClick={onClick}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragEnter={() => onDragOverChange(true)}
      onDragLeave={() => onDragOverChange(false)}
      onDrop={(e) => {
        e.preventDefault();
        onDragOverChange(false);
        const src = parseInt(e.dataTransfer.getData("text/plain"), 10);
        if (!isNaN(src)) {
          const ok = onDrop(src);
          if (!ok) {
            setReject(true);
            setTimeout(() => setReject(false), 400);
          }
        }
      }}
    />
  );
}

export interface ViewportControls {
  resetView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

interface OfficeViewProps {
  onSpawn: (deskIndex: number) => void;
  onContextMenu: (x: number, y: number, agent: AgentInfo) => void;
  onOpenUserSettings: () => void;
  // Click on a ghost: open user settings preopened to that user. Distinct
  // from `onOpenUserSettings` (which opens to the current user / the
  // generic flow). Optional so other consumers of OfficeView aren't
  // forced to thread a handler they don't need.
  onOpenUserSettingsForUser?: (userId: string) => void;
  onOpenDeviceSettings: () => void;
  onEditOfficePrompt: () => void;
  onEditRoomSettings?: () => void;
  onOpenTasks: () => void;
  onOpenCronjobs: () => void;
  onOpenUpdate: () => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  viewportControlsRef?: React.RefObject<ViewportControls | null>;
}

export function OfficeView({
  onSpawn,
  onContextMenu,
  onOpenUserSettings,
  onOpenUserSettingsForUser,
  onOpenDeviceSettings,
  onEditOfficePrompt,
  onEditRoomSettings,
  onOpenTasks,
  onOpenCronjobs,
  onOpenUpdate,
  onSwipeLeft,
  onSwipeRight,
  viewportControlsRef,
}: OfficeViewProps) {
  const {
    agents,
    needsAttention,
    stateChangedAt,
    office,
    tasks,
    currentRoomId,
    rooms,
    isMobile,
    updateAvailable,
    updateInfo,
    hasReceivedInitialState,
    presences,
    sessionContext,
  } = useAppState();
  const roomCount = rooms.length;
  const roomNames = rooms.map((r) => r.name);
  // Dense index of the selected room within the visible projection. Drives
  // positional door nav (prev/next neighbour); -1 when nothing is selected.
  const currentRoomIndex = rooms.findIndex((r) => r.id === currentRoomId);
  const officePrompt = office.prompt;
  const dispatch = useDispatch();
  const { mode, toggleTheme } = useTheme();
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const { embed } = useFeatures();
  const mobileScale = isMobile ? screen.width / (SCENE_W - 200) : 1;
  // layoutKey changes whenever the centered-scene static transform changes, so
  // useViewport re-measures pan-clamp bounds (ResizeObserver alone won't catch
  // transform-only updates).
  const layoutKey = `${embed ? 1 : 0}|${isMobile ? 1 : 0}|${mobileScale}`;
  const viewport = useViewport(layoutKey, !embed);
  // Cede one-finger swipes to pan once the user zooms in (iOS-gallery pattern).
  const swipeRef = useSwipeLeftRight(
    onSwipeLeft ?? (() => {}),
    onSwipeRight ?? (() => {}),
    isMobile,
    () => !viewport.isZoomedIn(),
  );
  const attachContainer = useCallback(
    (node: HTMLDivElement | null) => {
      swipeRef(node);
      viewport.setContainer(node);
    },
    // viewport.setContainer is stable across renders by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [swipeRef, viewport.setContainer],
  );

  // Expose viewport controls to parent for keyboard shortcuts (0, +, -). Skip
  // in embed mode - the zoom UI is hidden there, and the keyboard parity
  // should match.
  useEffect(() => {
    if (!viewportControlsRef || embed) {
      return;
    }
    viewportControlsRef.current = {
      resetView: viewport.resetView,
      zoomIn: viewport.zoomIn,
      zoomOut: viewport.zoomOut,
    };
    return () => {
      viewportControlsRef.current = null;
    };
  }, [
    viewportControlsRef,
    embed,
    viewport.resetView,
    viewport.zoomIn,
    viewport.zoomOut,
  ]);

  // Filter agents to current room for rendering
  const roomAgents = agents.filter((a) => a.roomId === currentRoomId);
  // Final ghost placement list - natural desk / lobby positions, plus
  // door-slide overrides for ghosts whose presence just crossed into / out
  // of our current room. The hook owns all per-ghost coordinate state;
  // OfficeView just renders the result.
  const ghostPlacements = useGhostTransitions(
    presences,
    roomAgents,
    currentRoomId,
    rooms,
    sessionContext?.connectionId ?? null,
    LEFT_DOOR_COORD,
    RIGHT_DOOR_COORD,
  );
  const [leftDoorDragOver, setLeftDoorDragOver] = useState(false);
  const [rightDoorDragOver, setRightDoorDragOver] = useState(false);
  const [leftDoorReject, setLeftDoorReject] = useState(false);
  const [rightDoorReject, setRightDoorReject] = useState(false);
  const [wallMenu, setWallMenu] = useState<{ x: number; y: number } | null>(
    null,
  );

  const wallMenuItems: WallPanelMenuItem[] = [
    {
      id: "office",
      icon: BuildingIcon,
      label: "Office settings",
      onClick: onEditOfficePrompt,
    },
    ...(onEditRoomSettings
      ? [
          {
            id: "room",
            icon: DoorIcon,
            label: "Room settings",
            onClick: onEditRoomSettings,
          },
        ]
      : []),
    {
      id: "user",
      icon: UserIcon,
      label: "User settings",
      onClick: onOpenUserSettings,
    },
    {
      id: "device",
      icon: DeviceIcon,
      label: "Device settings",
      onClick: onOpenDeviceSettings,
    },
  ];

  const counts = getRoomCounts(roomAgents);

  const officeActions: NavAction[] = [
    { id: "tasks", icon: TasksIcon, label: "Tasks", onClick: onOpenTasks },
    {
      id: "cronjobs",
      icon: ClockIcon,
      label: "Cron jobs",
      onClick: onOpenCronjobs,
    },
    {
      id: "user",
      icon: UserIcon,
      label: "User",
      onClick: onOpenUserSettings,
      title: "User settings",
    },
    {
      id: "device",
      icon: DeviceIcon,
      label: "Device",
      onClick: onOpenDeviceSettings,
      title: "Device settings",
    },
    {
      id: "office",
      icon: BuildingIcon,
      label: "Office",
      onClick: onEditOfficePrompt,
      title: "Office settings",
    },
    ...(onEditRoomSettings
      ? [
          {
            id: "room",
            icon: DoorIcon,
            label: "Room",
            onClick: onEditRoomSettings,
            title: "Room settings",
          },
        ]
      : []),
    {
      id: "theme",
      icon: mode === "dark" ? <MoonIcon size={15} /> : <SunIcon size={15} />,
      label: "Theme",
      onClick: () => setThemePickerOpen(true),
      title: "Change theme",
    },
  ];

  const mobileOfficeActions: NavAction[] = [
    ...officeActions,
    {
      id: "list",
      icon: ListIcon,
      label: "Show agent list",
      onClick: () => dispatch({ type: "toggle_mobile_view" }),
    },
  ];

  return (
    <div
      style={{
        height: isMobile
          ? "calc(100dvh - var(--banner-h, 0px))"
          : "calc(100vh - var(--banner-h, 0px))",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      {/* Top HUD bar */}
      {embed ? null : isMobile ? (
        <MobileHeader
          counts={counts}
          actions={mobileOfficeActions}
          updateAvailable={updateAvailable}
          onOpenUpdate={onOpenUpdate}
        />
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 20px",
            height: 44,
            background: "var(--bg-hud)",
            backdropFilter: "blur(16px)",
            borderBottom: "1px solid var(--border-subtle)",
            flexShrink: 0,
            zIndex: 500,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span
              style={{
                fontSize: 15,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                color: "var(--text-primary)",
              }}
            >
              Isomux
            </span>
            {updateAvailable && (
              <span
                onClick={onOpenUpdate}
                title={
                  updateInfo?.mode === "commit"
                    ? buildCommitNotice(updateInfo)?.notice
                    : undefined
                }
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--blue, #58a6ff)",
                  fontFamily: "'JetBrains Mono',monospace",
                  letterSpacing: "0.02em",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: "var(--blue, #58a6ff)",
                    boxShadow: "0 0 8px var(--blue, #58a6ff)",
                  }}
                />
                {updateInfo?.mode === "commit"
                  ? (buildCommitNotice(updateInfo)?.pill ?? "update available")
                  : "new release"}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            {(
              [
                { n: counts.working, c: "var(--green)", l: "working" },
                { n: counts.waiting, c: "var(--purple)", l: "waiting" },
                { n: counts.error, c: "var(--red)", l: "error" },
                { n: counts.idle, c: "var(--text-muted)", l: "idle" },
              ] as const
            )
              .filter((s) => s.n > 0)
              .map((s) => (
                <div
                  key={s.l}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 10,
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
                  {s.n} {s.l}
                </div>
              ))}
          </div>
          <NavActions actions={officeActions} viewport="desktop" />
        </div>
      )}

      {!embed && <RoomTabBar />}

      {/* Office scene */}
      {/* touch-action: none keeps iOS from turning one-finger drags into page scroll.
          Room-swipe still works because that hook reads touch coordinates directly. */}
      <div
        ref={attachContainer}
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          touchAction: "none",
        }}
      >
        {/* Ambient gradients */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse at 50% 30%, var(--ambient-1) 0%, transparent 50%), radial-gradient(ellipse at 25% 65%, var(--ambient-2) 0%, transparent 35%), radial-gradient(ellipse at 75% 65%, var(--ambient-3) 0%, transparent 35%)",
            pointerEvents: "none",
          }}
        />

        {/* Viewport layer - zoom/pan transform applies here, wrapping the centered scene */}
        <div
          // viewport.setScene is a stable callback from useViewport.
          // eslint-disable-next-line react-hooks/refs
          ref={viewport.setScene}
          style={{
            position: "absolute",
            inset: 0,
            transformOrigin: "0 0",
          }}
        >
          {/* Centered scene container - static centering transform */}
          <div
            // viewport.setContent: same stable-callback pattern as setScene above.
            // eslint-disable-next-line react-hooks/refs
            ref={viewport.setContent}
            style={{
              position: "absolute",
              left: "50%",
              top: embed
                ? isMobile
                  ? "55%"
                  : "64%"
                : isMobile
                  ? "45%"
                  : "50%",
              transform: embed
                ? `translate(-50%, -50%) scale(${isMobile ? mobileScale * 0.85 : 0.9})`
                : isMobile
                  ? `translate(-50%, -50%) scale(${mobileScale})`
                  : "translate(-50%, -50%)",
              transformOrigin: "center center",
              width: SCENE_W,
              height: SCENE_H,
            }}
          >
            <Walls
              onToggleTheme={toggleTheme}
              onWallPanelClick={(x, y) => setWallMenu({ x, y })}
              hasOfficePrompt={!!officePrompt}
              onOpenTasks={onOpenTasks}
              onOpenCronjobs={onOpenCronjobs}
              taskCount={
                tasks.filter(
                  (t) => t.status !== "done" && t.status !== "backlog",
                ).length
              }
              leftDoor={
                currentRoomIndex > 0
                  ? {
                      label:
                        roomNames[currentRoomIndex - 1] ??
                        `Room ${currentRoomIndex}`,
                      onClick: () =>
                        dispatch({
                          type: "set_current_room",
                          roomId: rooms[currentRoomIndex - 1].id,
                        }),
                      dragOver: leftDoorDragOver,
                      reject: leftDoorReject,
                    }
                  : null
              }
              rightDoor={
                currentRoomIndex >= 0 && currentRoomIndex < roomCount - 1
                  ? {
                      label:
                        roomNames[currentRoomIndex + 1] ??
                        `Room ${currentRoomIndex + 2}`,
                      onClick: () =>
                        dispatch({
                          type: "set_current_room",
                          roomId: rooms[currentRoomIndex + 1].id,
                        }),
                      dragOver: rightDoorDragOver,
                      reject: rightDoorReject,
                    }
                  : null
              }
            />
            <Floor />
            <RoomProps />
            {currentRoomIndex > 0 && (
              <DoorDropZone
                side="left"
                // viewport.wrapClick is a stable callback that wraps a click
                // handler to suppress clicks during pan-drag.
                // eslint-disable-next-line react-hooks/refs
                onClick={viewport.wrapClick(() =>
                  dispatch({
                    type: "set_current_room",
                    roomId: rooms[currentRoomIndex - 1].id,
                  }),
                )}
                onDragOverChange={(over) => setLeftDoorDragOver(over)}
                onDrop={(deskIndex) => {
                  const a = roomAgents.find((a) => a.desk === deskIndex);
                  if (!a) {
                    setLeftDoorReject(true);
                    setTimeout(() => setLeftDoorReject(false), 400);
                    return false;
                  }
                  const targetRoomId = rooms[currentRoomIndex - 1]?.id;
                  if (
                    !targetRoomId ||
                    agents.filter((x) => x.roomId === targetRoomId).length >=
                      DESK_COUNT
                  ) {
                    setLeftDoorReject(true);
                    setTimeout(() => setLeftDoorReject(false), 400);
                    return false;
                  }
                  apiFetch("POST", `/api/agents/${a.id}/move`, {
                    targetRoomId,
                  } satisfies MoveAgentReq).catch(() => {});
                  return true;
                }}
              />
            )}
            {currentRoomIndex >= 0 && currentRoomIndex < roomCount - 1 && (
              <DoorDropZone
                side="right"
                // viewport.wrapClick: same stable-callback pattern as left door.
                // eslint-disable-next-line react-hooks/refs
                onClick={viewport.wrapClick(() =>
                  dispatch({
                    type: "set_current_room",
                    roomId: rooms[currentRoomIndex + 1].id,
                  }),
                )}
                onDragOverChange={(over) => setRightDoorDragOver(over)}
                onDrop={(deskIndex) => {
                  const a = roomAgents.find((a) => a.desk === deskIndex);
                  if (!a) {
                    setRightDoorReject(true);
                    setTimeout(() => setRightDoorReject(false), 400);
                    return false;
                  }
                  const targetRoomId = rooms[currentRoomIndex + 1]?.id;
                  if (
                    !targetRoomId ||
                    agents.filter((x) => x.roomId === targetRoomId).length >=
                      DESK_COUNT
                  ) {
                    setRightDoorReject(true);
                    setTimeout(() => setRightDoorReject(false), 400);
                    return false;
                  }
                  apiFetch("POST", `/api/agents/${a.id}/move`, {
                    targetRoomId,
                  } satisfies MoveAgentReq).catch(() => {});
                  return true;
                }}
              />
            )}
            {/* eslint-disable react-hooks/refs -- viewport.wrapClick is a stable callback */}
            {Array.from({ length: DESK_COUNT }, (_, i) => {
              const agent = roomAgents.find((a) => a.desk === i);
              if (agent) {
                return (
                  <DeskUnit
                    key={agent.id}
                    agent={agent}
                    onClick={viewport.wrapClick(() =>
                      dispatch({ type: "focus", agentId: agent.id }),
                    )}
                    onContextMenu={(e) =>
                      onContextMenu(e.clientX, e.clientY, agent)
                    }
                    needsAttention={needsAttention.has(agent.id)}
                    onSwap={(a, b) => {
                      const rid = currentRoomId;
                      if (rid)
                        apiFetch("POST", `/api/rooms/${rid}/swap-desks`, {
                          deskA: a,
                          deskB: b,
                        } satisfies SwapDesksReq).catch(() => {});
                    }}
                    stateChangedAt={stateChangedAt.get(agent.id)}
                  />
                );
              }
              return (
                <EmptySlot
                  key={`empty-${i}`}
                  deskIndex={i}
                  onClick={viewport.wrapClick(() => onSpawn(i))}
                  onSwap={(a, b) => {
                    const rid = currentRoomId;
                    if (rid)
                      apiFetch("POST", `/api/rooms/${rid}/swap-desks`, {
                        deskA: a,
                        deskB: b,
                      } satisfies SwapDesksReq).catch(() => {});
                  }}
                />
              );
            })}
            {/* eslint-enable react-hooks/refs */}
            {/* Live-avatars: floating ghost per active presence whose
                currentRoomId matches the viewer's currentRoomId. Rendered
                last (and with high z-index) so they sit above desks,
                walls, and props per Q20 in the design memo. */}
            {/* Two layers, two stable per-connection keys per layer. The
                body and tag layers are independent React siblings, each
                iterating placements in connectionId order. Body/tag never
                interleave in the DOM, so a new arrival's body insertion
                can't shift an existing ghost's tag (or vice versa). Combined
                with the connectionId-sorted output from useGhostTransitions,
                no existing ghost's DOM node moves when an unrelated anchor
                changes - which keeps CSS transitions intact and prevents
                browsers from re-attach-restarting any inline animations. */}
            {ghostPlacements.map((p) => (
              <GhostBody
                key={p.presence.connectionId}
                left={p.left}
                top={p.top}
                size={GHOST_SIZE}
                variant={p.presence.avatarVariant}
                color={p.presence.avatarColor}
                username={p.presence.username}
                device={p.presence.device}
                userId={p.presence.userId}
                dimmed={p.dimmed}
                onClick={onOpenUserSettingsForUser}
              />
            ))}
            {ghostPlacements.map((p) => (
              <GhostTag
                key={p.presence.connectionId}
                left={p.left}
                top={p.top}
                size={GHOST_SIZE}
                variant={p.presence.avatarVariant}
                color={p.presence.avatarColor}
                username={p.presence.username}
                device={p.presence.device}
                userId={p.presence.userId}
                dimmed={p.dimmed}
                onClick={onOpenUserSettingsForUser}
              />
            ))}
          </div>
        </div>

        {/* Zoom controls */}
        {!embed && (
          /* eslint-disable react-hooks/refs -- stable callbacks from useViewport */
          <ZoomControls
            onZoomIn={viewport.zoomIn}
            onZoomOut={viewport.zoomOut}
            onReset={viewport.resetView}
          />
          /* eslint-enable react-hooks/refs */
        )}

        {/* Vignette */}
        {!embed && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              boxShadow: "inset 0 0 120px var(--vignette)",
            }}
          />
        )}

        {/* Empty-state overlay for members with no visible rooms (the
            default for new members until they create their own room or
            an owner grants them access). The office floor/walls/desks
            underneath still render so the scene still reads as an
            office - the boss specifically wanted the empty-office vibe
            as background. Gated on hasReceivedInitialState so it doesn't
            flash during the pre-hydration window when rooms is still []. */}
        {hasReceivedInitialState && rooms.length === 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              zIndex: 100,
            }}
          >
            <div
              style={{
                padding: "18px 24px",
                borderRadius: 12,
                background: "var(--bg-overlay)",
                backdropFilter: "blur(12px)",
                border: "1px solid var(--border-light)",
                textAlign: "center",
                maxWidth: 340,
                boxShadow: "0 8px 32px var(--shadow-heavy)",
              }}
            >
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: "var(--text-primary)",
                }}
              >
                No rooms assigned
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-ghost)",
                  marginTop: 8,
                  lineHeight: 1.5,
                }}
              >
                <p style={{ margin: "0 0 8px" }}>
                  Use the <strong>+</strong> in the room tab bar to create your
                  own room.
                </p>
                <p style={{ margin: "0 0 8px" }}>
                  New rooms you create are visible only to you and the office
                  owners by default (owners can change that).
                </p>
                <p style={{ margin: 0 }}>
                  You can also ask an owner to add you to existing rooms.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom HUD */}
      {!embed && (
        <div
          style={{
            padding: isMobile ? "8px 12px" : "8px 20px",
            ...(isMobile
              ? {
                  paddingBottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
                }
              : {}),
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
            ? [
                "TAP → open",
                "LONG-PRESS → actions",
                "PINCH → zoom",
                "DRAG (zoomed) → pan",
              ]
            : [
                "CLICK → open agent",
                "DRAG → swap desks or move to door",
                "WHEEL / +- → zoom",
                "DRAG → pan",
                "RIGHT-CLICK → actions",
                "0 → reset view",
              ]
          ).map((h, i) => (
            <span
              key={i}
              style={{
                fontSize: 10,
                color: "var(--text-hint)",
                fontFamily: "'JetBrains Mono',monospace",
                letterSpacing: "0.04em",
              }}
            >
              {h}
            </span>
          ))}
        </div>
      )}
      {wallMenu && (
        <WallPanelMenu
          x={wallMenu.x}
          y={wallMenu.y}
          items={wallMenuItems}
          onClose={() => setWallMenu(null)}
        />
      )}
      <ThemePicker
        open={themePickerOpen}
        onClose={() => setThemePickerOpen(false)}
      />
    </div>
  );
}
