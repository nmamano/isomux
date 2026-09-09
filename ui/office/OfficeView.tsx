import {
  getMembersChatHidden,
  getMembersChatWidth,
  setMembersChatWidth,
  clampMembersChatWidth,
  DEFAULT_MEMBERS_CHAT_WIDTH,
  setMembersChatHidden,
} from "../device-settings.ts";
import { ChatWidthHandle } from "../members-chat/ChatWidthHandle.tsx";
import { useMembersChatHydration } from "../members-chat/useMembersChatHydration.ts";
import { send } from "../ws.ts";
import { LOBBY_ROOM_ID, ordinaryRooms } from "../../shared/types.ts";
import { useMemo, useState, useEffect, useCallback } from "react";
import { useAppState, useDispatch, useTheme, useFeatures } from "../store.tsx";
import { Floor, WallDoors, Walls } from "./Floor.tsx";
import { NewRoomDialog } from "./NewRoomDialog.tsx";
import { RoomProps } from "./RoomProps.tsx";
import { GroundShadows } from "./GroundShadows.tsx";
import { Seasonal } from "./Seasonal.tsx";
import { RoomTabBar } from "./RoomTabBar.tsx";
import { DeskUnit } from "./DeskUnit.tsx";
import { EmptySlot } from "./EmptySlot.tsx";
import { GhostBody, GhostTag } from "./Ghost.tsx";
import {
  useGhostTransitions,
  LEFT_DOOR_COORD,
  RIGHT_DOOR_COORD,
} from "./useGhostTransitions.ts";
import { SCENE_W, SCENE_H } from "./grid.ts";
import { LobbyScene } from "./lobby/index.ts";
import { ReceptionistFigure } from "./ReceptionistFigure.tsx";
import { crownHolder, employeeOfTheMinute } from "./lobby/employee.ts";
import { MembersChatPanel } from "../members-chat/MembersChatPanel.tsx";
import { apiFetch } from "../api.ts";
import type {
  MoveAgentReq,
  SwapDesksReq,
} from "../../shared/contract-shapes.ts";
import { SunIcon, MoonIcon } from "../components/ThemeIcons.tsx";
import { MobileHeader, getRoomCounts } from "../components/MobileHeader.tsx";
import { NavActions, type NavAction } from "../components/NavActions.tsx";
import {
  TasksIcon,
  ClockIcon,
  AppsIcon,
  SettingsIcon,
} from "../components/NavIcons.tsx";
import { useSwipeLeftRight } from "../hooks/useSwipeLeftRight.ts";
import { useI18n } from "../i18n.tsx";
import { useViewport } from "./useViewport.ts";
import { ZoomControls } from "./ZoomControls.tsx";
import type { AgentInfo } from "../../shared/types.ts";
import { DESK_COUNT } from "../../shared/desks.ts";
import { buildCommitNotice } from "../../shared/update-notice.ts";

// Pixel size of a single ghost (width). ~50% of the agent character
// (52×68) so it reads as "small floating watcher" against the desks.
// Height scales proportionally inside the SVG viewBox.
const GHOST_SIZE = 40;

export const LOBBY_CHAT_WIDTH = DEFAULT_MEMBERS_CHAT_WIDTH;

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
      data-door-drop={side}
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
  // The single settings door in the bar.
  onOpenSettings: () => void;
  // Click on a ghost: open user settings preopened to that user. Distinct
  // from `onOpenUserSettings` (which opens to the current user / the
  // generic flow). Optional so other consumers of OfficeView aren't
  // forced to thread a handler they don't need.
  onOpenUserSettingsForUser?: (userId: string) => void;
  // The vent on the wall opens the settings page at the office's own row.
  onEditOfficePrompt: () => void;
  onEditRoomSettings?: (roomId: string) => void;
  onOpenThemePicker: () => void;
  onOpenTasks: () => void;
  onOpenCronjobs: () => void;
  onOpenApps: () => void;
  onOpenUpdate: () => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  viewportControlsRef?: React.RefObject<ViewportControls | null>;
}

export function OfficeView({
  onSpawn,
  onContextMenu,
  onOpenSettings,
  onOpenUserSettingsForUser,
  onEditOfficePrompt,
  onEditRoomSettings,
  onOpenThemePicker,
  onOpenTasks,
  onOpenCronjobs,
  onOpenApps,
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
    rooms: allRooms,
    isMobile,
    updateAvailable,
    updateInfo,
    presences,
    sessionContext,
    lobbyOpen,
  } = useAppState();
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const closeNewRoom = useCallback(() => setNewRoomOpen(false), []);
  const rooms = useMemo(() => ordinaryRooms(allRooms), [allRooms]);
  const roomCount = rooms.length;
  // Employee of the Minute for the lobby plaque: the last agent to act,
  // office-wide, with a hold so a streaming agent's restamps do not swap the
  // face every second (ui/office/lobby/employee.ts).
  // The receptionist stands in the lobby next to the plaque; the plaque is
  // for the coworkers at the desks.
  const leader = employeeOfTheMinute(
    agents.filter((a) => a.roomId !== "lobby"),
    stateChangedAt,
    rooms.map((r) => r.id),
  );
  const receptionist = agents.find((a) => a.roomId === "lobby");
  const leaderAt = leader ? (stateChangedAt.get(leader.id) ?? 0) : 0;
  // Render-phase derived state, the pattern GhostBody uses: the render that
  // sees a new holder records it and React re-renders once with it.
  const [held, setHeld] = useState<{ id: string; at: number } | null>(null);
  const nextHolder = crownHolder(
    held,
    leader ? { id: leader.id, at: leaderAt } : null,
  );
  if (nextHolder !== (held?.id ?? null)) {
    setHeld(
      nextHolder
        ? { id: nextHolder, at: stateChangedAt.get(nextHolder) ?? 0 }
        : null,
    );
  }
  const starAgent = held ? agents.find((a) => a.id === held.id) : undefined;
  const lobbyStar = starAgent
    ? { name: starAgent.name, outfit: starAgent.outfit }
    : null;
  const roomNames = rooms.map((r) => r.name);
  // Dense index of the selected room within the visible projection. Drives
  // positional door nav (prev/next neighbour); -1 when nothing is selected.
  const currentRoomIndex = rooms.findIndex((r) => r.id === currentRoomId);
  const dispatch = useDispatch();
  const { mode, cycleTheme } = useTheme();
  const { embed } = useFeatures();
  const { loadFailed: membersChatLoadFailed, retry: retryMembersChat } =
    useMembersChatHydration(!embed);
  const [chatHidden, setChatHidden] = useState(getMembersChatHidden);
  const [chatViewportWidth, setChatViewportWidth] = useState(() => typeof window === "undefined" ? 1440 : window.innerWidth);
  const [preferredChatWidth, setPreferredChatWidth] = useState<number | null>(() => isMobile ? null : getMembersChatWidth(chatViewportWidth));
  // A phone does not read the desktop preference, including on first mount.
  if (!isMobile && preferredChatWidth === null) setPreferredChatWidth(getMembersChatWidth(chatViewportWidth));
  const chatWidth = clampMembersChatWidth(preferredChatWidth ?? LOBBY_CHAT_WIDTH, chatViewportWidth);
  useEffect(() => {
    const resize = () => setChatViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  function changeChatWidth(width: number) {
    const next = clampMembersChatWidth(width, chatViewportWidth);
    setPreferredChatWidth(next);
  }
  function commitChatWidth(width: number) {
    const next = clampMembersChatWidth(width, chatViewportWidth);
    setPreferredChatWidth(next);
    setMembersChatWidth(next);
  }
  const desktopChatVisible = lobbyOpen && !isMobile && !embed && !chatHidden;
  function changeChatHidden(hidden: boolean) {
    setChatHidden(hidden);
    setMembersChatHidden(hidden);
  }
  const i18n = useI18n();
  const { t } = i18n;
  const newRoomDoor = embed
    ? null
    : {
        label: t("office.newRoom.door"),
        onClick: () => setNewRoomOpen(true),
      };
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

  const roomAgents = agents.filter((a) => a.roomId === currentRoomId);
  // Final ghost placement list - natural desk / lobby positions, plus
  // door-slide overrides for ghosts whose presence just crossed into / out
  // of our current room. The hook owns all per-ghost coordinate state;
  // OfficeView just renders the result.
  const {
    placements: ghostPlacements,
    leftDoorUses,
    rightDoorUses,
  } = useGhostTransitions(
    presences,
    roomAgents,
    lobbyOpen ? LOBBY_ROOM_ID : currentRoomId,
    rooms,
    sessionContext?.connectionId ?? null,
    LEFT_DOOR_COORD,
    RIGHT_DOOR_COORD,
  );
  const [leftDoorDragOver, setLeftDoorDragOver] = useState(false);
  const [rightDoorDragOver, setRightDoorDragOver] = useState(false);
  const [leftDoorReject, setLeftDoorReject] = useState(false);
  const [rightDoorReject, setRightDoorReject] = useState(false);
  const counts = getRoomCounts(roomAgents);

  const officeActions: NavAction[] = [
    {
      id: "tasks",
      icon: TasksIcon,
      label: t("common.tasks"),
      title: t("nav.tasksShortcut"),
      onClick: onOpenTasks,
    },
    {
      id: "cronjobs",
      icon: ClockIcon,
      label: t("common.schedules"),
      onClick: onOpenCronjobs,
    },
    {
      id: "apps",
      icon: AppsIcon,
      label: t("common.apps"),
      title: t("nav.appsShortcut"),
      onClick: onOpenApps,
    },
    // One gear for every setting. The office, room, user and device buttons
    // that used to sit here are sidebar rows on the settings page now, and the
    // vent on the wall opens the same page.
    {
      id: "settings",
      icon: SettingsIcon,
      label: t("common.settings"),
      onClick: onOpenSettings,
      title: t("nav.settingsShortcut"),
    },
    {
      id: "theme",
      icon: mode === "dark" ? <MoonIcon size={15} /> : <SunIcon size={15} />,
      label: t("common.theme"),
      onClick: onOpenThemePicker,
      title: t("common.changeTheme"),
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
      {newRoomOpen && <NewRoomDialog onClose={closeNewRoom} />}
      {/* Top HUD bar */}
      {embed ? null : isMobile ? (
        <MobileHeader
          counts={counts}
          actions={officeActions}
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
                    ? buildCommitNotice(i18n, updateInfo)?.notice
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
                  ? (buildCommitNotice(i18n, updateInfo)?.pill ??
                    t("updateNotice.pill.updateAvailable"))
                  : t("updateNotice.pill.newRelease")}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            {(
              [
                {
                  n: counts.working,
                  c: "var(--green)",
                  l: "office.status.working",
                },
                {
                  n: counts.waiting,
                  c: "var(--purple)",
                  l: "office.status.waiting",
                },
                { n: counts.error, c: "var(--red)", l: "office.status.error" },
                {
                  n: counts.idle,
                  c: "var(--text-muted)",
                  l: "office.status.idle",
                },
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
                  {s.n} {t(s.l)}
                </div>
              ))}
          </div>
          <NavActions actions={officeActions} viewport="desktop" />
        </div>
      )}

      {!embed && (
        <RoomTabBar
          onOpenRoomSettings={onEditRoomSettings}
          membersChatLoadFailed={membersChatLoadFailed}
          onRetryMembersChat={retryMembersChat}
          onShowMembersChat={
            lobbyOpen && !isMobile && chatHidden
              ? () => changeChatHidden(false)
              : undefined
          }
        />
      )}

      {/* Chat overlays the scene without changing the viewport's fit or origin.
          It stays outside the gesture container so chat scrolling and text
          selection cannot pan or zoom the scene. */}
      <div
        style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}
      >
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
              {lobbyOpen ? (
                <LobbyScene
                  ownConnectionId={sessionContext?.connectionId ?? null}
                  presences={presences}
                  onMoveGhost={
                    sessionContext &&
                    presences.some(
                      (p) =>
                        p.connectionId === sessionContext.connectionId &&
                        p.currentRoomId === LOBBY_ROOM_ID,
                    )
                      ? (spotId) => send({ type: "lobby_move", spotId })
                      : undefined
                  }
                  onOpenUser={onOpenUserSettingsForUser}
                  rooms={rooms.map((r) => ({ id: r.id, name: r.name }))}
                  officeName={office.name}
                  star={lobbyStar}
                  mode={mode}
                  layout="nilo"
                  receptionist={
                    /* eslint-disable react-hooks/refs -- viewport.wrapClick is a stable callback */
                    receptionist ? (
                      <ReceptionistFigure
                        agent={receptionist}
                        needsAttention={needsAttention.has(receptionist.id)}
                        onClick={viewport.wrapClick(() =>
                          dispatch({ type: "focus", agentId: receptionist.id }),
                        )}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          onContextMenu(e.clientX, e.clientY, receptionist);
                        }}
                      />
                    ) : undefined
                    /* eslint-enable react-hooks/refs */
                  }
                  rightDoor={
                    rooms[0]
                      ? {
                          label: rooms[0].name,
                          onClick: () =>
                            dispatch({
                              type: "set_current_room",
                              roomId: rooms[0].id,
                            }),
                        }
                      : newRoomDoor
                  }
                  onToggleTheme={cycleTheme}
                  onOpenApps={embed ? undefined : onOpenApps}
                  onOpenCronjobs={onOpenCronjobs}
                />
              ) : (
                <>
                  <Walls
                    onToggleTheme={cycleTheme}
                    onOpenSettings={embed ? undefined : onEditOfficePrompt}
                    onOpenApps={embed ? undefined : onOpenApps}
                    onOpenTasks={onOpenTasks}
                    onOpenCronjobs={onOpenCronjobs}
                    taskCount={
                      tasks.filter(
                        (t) => t.status !== "done" && t.status !== "backlog",
                      ).length
                    }
                  />
                  <Floor desk8Cable={roomAgents.some((a) => a.desk === 7)} />
                  <GroundShadows />
                  <WallDoors
                    leftDoor={
                      currentRoomIndex > 0
                        ? {
                            label:
                              roomNames[currentRoomIndex - 1] ??
                              t("common.roomFallback", {
                                number: currentRoomIndex,
                              }),
                            onClick: () =>
                              dispatch({
                                type: "set_current_room",
                                roomId: rooms[currentRoomIndex - 1].id,
                              }),
                            dragOver: leftDoorDragOver,
                            reject: leftDoorReject,
                            passCount: leftDoorUses,
                          }
                        : currentRoomIndex === 0
                          ? {
                              label: t("common.lobby"),
                              passCount: leftDoorUses,
                              onClick: () =>
                                dispatch({
                                  type: "set_lobby_open",
                                  open: true,
                                }),
                            }
                          : null
                    }
                    rightDoor={
                      currentRoomIndex >= 0 && currentRoomIndex < roomCount - 1
                        ? {
                            label:
                              roomNames[currentRoomIndex + 1] ??
                              t("common.roomFallback", {
                                number: currentRoomIndex + 2,
                              }),
                            onClick: () =>
                              dispatch({
                                type: "set_current_room",
                                roomId: rooms[currentRoomIndex + 1].id,
                              }),
                            dragOver: rightDoorDragOver,
                            reject: rightDoorReject,
                            passCount: rightDoorUses,
                          }
                        : currentRoomIndex === roomCount - 1
                          ? newRoomDoor
                          : null
                    }
                  />
                  <RoomProps />
                  <Seasonal />
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
                          agents.filter((x) => x.roomId === targetRoomId)
                            .length >= DESK_COUNT
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
                  {currentRoomIndex >= 0 &&
                    currentRoomIndex < roomCount - 1 && (
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
                          const a = roomAgents.find(
                            (a) => a.desk === deskIndex,
                          );
                          if (!a) {
                            setRightDoorReject(true);
                            setTimeout(() => setRightDoorReject(false), 400);
                            return false;
                          }
                          const targetRoomId = rooms[currentRoomIndex + 1]?.id;
                          if (
                            !targetRoomId ||
                            agents.filter((x) => x.roomId === targetRoomId)
                              .length >= DESK_COUNT
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
                </>
              )}
            </div>
          </div>

          {/* Zoom controls */}
          {!embed && (
            /* eslint-disable react-hooks/refs -- stable callbacks from useViewport */
            <ZoomControls
              onZoomIn={viewport.zoomIn}
              onZoomOut={viewport.zoomOut}
              onReset={viewport.resetView}
              rightInset={desktopChatVisible ? chatWidth : 0}
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
        </div>
        {desktopChatVisible && (
          <MembersChatPanel
            resizeHandle={<ChatWidthHandle width={chatWidth} viewportWidth={chatViewportWidth} onChange={changeChatWidth} onCommit={commitChatWidth} />}
            onHide={() => changeChatHidden(true)}
            loadFailed={membersChatLoadFailed}
            onRetry={retryMembersChat}
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              zIndex: 1,
              width: chatWidth,
              borderLeft: "1px solid var(--border)",
            }}
          />
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
            ? ([
                "office.hints.tap",
                "office.hints.longPress",
                "office.hints.pinch",
                "office.hints.dragZoomed",
              ] as const)
            : ([
                "office.hints.click",
                "office.hints.dragSwap",
                "office.hints.wheel",
                "office.hints.drag",
                "office.hints.rightClick",
                "office.hints.resetView",
              ] as const)
          ).map((key, i) => (
            <span
              key={i}
              style={{
                fontSize: 10,
                color: "var(--text-hint)",
                fontFamily: "'JetBrains Mono',monospace",
                letterSpacing: "0.04em",
              }}
            >
              {t(key)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
