import {
  getMembersChatWidth,
  setMembersChatWidth,
  clampMembersChatWidth,
  DEFAULT_MEMBERS_CHAT_WIDTH,
  setMembersChatOpen,
} from "../device-settings.ts";
import { ChatWidthHandle } from "../members-chat/ChatWidthHandle.tsx";
import { useMembersChatHydration } from "../members-chat/useMembersChatHydration.ts";
import { send } from "../ws.ts";
import { LOBBY_ROOM_ID, ordinaryRooms } from "../../shared/types.ts";
import {
  useMemo,
  useState,
  useEffect,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";
import {
  beginRoomTurn,
  cancelRoomTurn,
  finishRoomTurn,
  type TurnSide,
} from "./room-turn.ts";
import {
  beginFloorMove,
  cancelFloorMove,
  finishFloorMove,
  type FloorDir,
} from "./floor-move.ts";
import { SceneDecorationContext } from "./scene-decoration.tsx";
import {
  useAppState,
  useDispatch,
  useTheme,
  useFeatures,
  useRoomList,
} from "../store.tsx";
import { useInboxCounts, useInboxNavAction } from "../inbox.ts";
import { Floor, WallDoors, Walls, type WallInbox } from "./Floor.tsx";
import { NewRoomDialog } from "./NewRoomDialog.tsx";
import { ElevatorDialog } from "../components/ElevatorDialog.tsx";
import { RoomProps } from "./RoomProps.tsx";
import { useRoomSkinVars } from "./skins/index.tsx";
import { GroundShadows } from "./GroundShadows.tsx";
import {
  Seasonal,
  deskTopItems,
  seasonalDesk,
  useSeasonalItems,
} from "./Seasonal.tsx";
import { RoomTabBar } from "./RoomTabBar.tsx";
import { DeskUnit } from "./DeskUnit.tsx";
import { EmptySlot } from "./EmptySlot.tsx";
import { GhostBody, GhostTag } from "./Ghost.tsx";
import {
  useGhostTransitions,
  LEFT_DOOR_COORD,
  RIGHT_DOOR_COORD,
} from "./useGhostTransitions.ts";
import { SCENE_W, SCENE_H, sceneFrame } from "./grid.ts";
import { LobbyScene } from "./lobby/index.ts";
import { ReceptionistFigure } from "./ReceptionistFigure.tsx";
import { crownHolder, employeeOfTheMinute } from "./lobby/employee.ts";
import { LobbyChat } from "../members-chat/LobbyChat.tsx";
import { MembersChatButton } from "../members-chat/MembersChatButton.tsx";
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
  SkillsIcon,
  PlugIcon,
  SettingsIcon,
  SidebarIcon,
} from "../components/NavIcons.tsx";
import { OFFICE_BAR_TWINS } from "../chat-sidebar.ts";
import { useSwipeLeftRight } from "../hooks/useSwipeLeftRight.ts";
import { useI18n } from "../i18n.tsx";
import { useViewport } from "./useViewport.ts";
import { ZoomControls } from "./ZoomControls.tsx";
import type { AgentInfo } from "../../shared/types.ts";
import {
  DESK_COUNT,
  BACK_ROOM_SEATS,
  isBackSeat,
  isValidDesk,
  hasBackRoom,
  roomIsFull as deskRoomIsFull,
} from "../../shared/desks.ts";
import { TrapDoor, type BackRoomAttention } from "./TrapDoor.tsx";
import { Vignette } from "./Vignette.tsx";
import { BackRoomScreen } from "./back-room/BackRoomScreen.tsx";
import { buildCommitNotice } from "../../shared/update-notice.ts";
import { inDefaultTaskList } from "../../shared/task-board.ts";
import { askCounts, openAsks } from "../asks-sync.ts";
import {
  OfficeInstallNotice,
  useInstallMode,
} from "../components/OfficeInstallNotice.tsx";
import { InstallIcon } from "../components/install-icons.tsx";
import {
  openOfficeInstallSteps,
  promptInstall,
  readInstallEnv,
} from "../app-install.ts";
import { useCan } from "../hooks/useCan.ts";

// Pixel size of a single ghost (width). ~50% of the agent character
// (52×68) so it reads as "small floating watcher" against the desks.
// Height scales proportionally inside the SVG viewBox.
const GHOST_SIZE = 40;

const LOBBY_CHAT_WIDTH = DEFAULT_MEMBERS_CHAT_WIDTH;

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
  /** Opens the current room's back room screen (the trap door). */
  onOpenBackRoom?: () => void;
  /** True while the current room's back room screen shows in place of the
   *  front scene. */
  backRoomOpen?: boolean;
  onCloseBackRoom?: () => void;
  /** Opens the spawn dialog for a back room seat. */
  onSpawnBack?: () => void;
  // The single settings door in the bar.
  onOpenSettings: () => void;
  // Click on a ghost: open user settings preopened to that user. Distinct
  // from `onOpenUserSettings` (which opens to the current user / the
  // generic flow). Optional so other consumers of OfficeView aren't
  // forced to thread a handler they don't need.
  onOpenUserSettingsForUser?: (userId: string) => void;
  // The vent on the wall opens the settings page at the current room's row
  // (Nil, 2026-09-14), falling back to the office's own row when no room
  // handler is threaded.
  onEditOfficePrompt: () => void;
  onEditRoomSettings?: (roomId: string) => void;
  onOpenThemePicker: () => void;
  onOpenTasks: () => void;
  onOpenCronjobs: () => void;
  onOpenApps: () => void;
  // Absent where there is no Skills page to open (test fixtures).
  onOpenSkills?: () => void;
  // Absent in fixtures that render the office without the Inbox.
  onOpenInbox?: () => void;
  // Absent in fixtures that render the office without the Integrations page.
  onOpenIntegrations?: () => void;
  onOpenUpdate: () => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  viewportControlsRef?: React.RefObject<ViewportControls | null>;
  // The desktop sidebar (ui/components/ChatSidebar.tsx) is open beside the
  // office: the bar leaves out the buttons the sidebar repeats.
  sidebarOpen?: boolean;
  // Given while the sidebar is hidden on a desktop: the bar's button that
  // shows it again.
  onShowSidebar?: () => void;
}

export function OfficeView({
  onSpawn,
  onContextMenu,
  onOpenBackRoom,
  backRoomOpen,
  onCloseBackRoom,
  onSpawnBack,
  onOpenSettings,
  onOpenUserSettingsForUser,
  onEditOfficePrompt,
  onEditRoomSettings,
  onOpenThemePicker,
  onOpenTasks,
  onOpenCronjobs,
  onOpenApps,
  onOpenSkills,
  onOpenInbox,
  onOpenIntegrations,
  onOpenUpdate,
  onSwipeLeft,
  onSwipeRight,
  viewportControlsRef,
  sidebarOpen = false,
  onShowSidebar,
}: OfficeViewProps) {
  const {
    agents,
    needsAttention,
    stateChangedAt,
    workingSince,
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
    asks,
    answeredAsks,
    membersChatShown,
    hasReceivedInitialState,
  } = useAppState();
  const askCountByAgent = useMemo(
    () => askCounts(openAsks(asks, answeredAsks)),
    [asks, answeredAsks],
  );
  const inboxAction = useInboxNavAction(onOpenInbox);
  const inboxCounts = useInboxCounts();
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const closeNewRoom = useCallback(() => setNewRoomOpen(false), []);
  const [elevatorOpen, setElevatorOpen] = useState(false);
  const closeElevator = useCallback(() => setElevatorOpen(false), []);
  const rooms = useMemo(() => ordinaryRooms(allRooms), [allRooms]);
  // The doors, their drop zones and the ghosts walk the room tabs, the tab
  // bar's own list (task 8070f62b); lookups by id use the full list.
  const { tabs } = useRoomList();
  // Employee of the Minute for the lobby plaque: the last agent to act,
  // office-wide, with a hold so a streaming agent's restamps do not swap the
  // face every second (ui/office/lobby/employee.ts).
  // The receptionist stands in the lobby next to the plaque; the plaque is
  // for the coworkers at the front desks; a busy back room would hold it.
  const leader = employeeOfTheMinute(
    agents.filter((a) => a.roomId !== "lobby" && !isBackSeat(a.desk)),
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
  // Index of the selected room among the tabs. Drives positional door nav
  // (prev/next neighbour); -1 when nothing is selected.
  const currentRoomIndex = tabs.findIndex((r) => r.id === currentRoomId);
  const dispatch = useDispatch();
  const openReceptionist = () => {
    if (receptionist) dispatch({ type: "focus", agentId: receptionist.id });
  };
  // A wall door between two rooms turns the room; tabs and the lobby doors
  // switch with no animation.
  const contentEl = useRef<HTMLDivElement | null>(null);
  const doorGo = (side: TurnSide, roomId: string) => {
    beginRoomTurn(contentEl.current, side, roomId);
    dispatch({ type: "set_current_room", roomId });
  };
  useLayoutEffect(() => {
    finishRoomTurn(lobbyOpen ? null : currentRoomId);
  }, [currentRoomId, lobbyOpen]);
  useEffect(() => cancelRoomTurn, []);
  const { mode, cycleTheme } = useTheme();
  const { embed } = useFeatures();
  // A room's Inbox tray holds a letter per open ask and opens the Inbox as
  // the bar entry does. In embed the bar is hidden, so the tray does not
  // open the Inbox.
  const wallInbox: WallInbox | undefined = inboxAction
    ? {
        asks: inboxCounts.asks,
        title: inboxAction.title,
        onOpen: embed ? undefined : inboxAction.onClick,
      }
    : undefined;
  const decorateScene = useContext(SceneDecorationContext);
  const seasonalItems = useSeasonalItems();
  const chatHidden = !membersChatShown;
  const [chatViewportWidth, setChatViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  const [preferredChatWidth, setPreferredChatWidth] = useState<number | null>(
    () => (isMobile ? null : getMembersChatWidth(chatViewportWidth)),
  );
  // A phone does not read the desktop preference, including on first mount.
  if (!isMobile && preferredChatWidth === null)
    setPreferredChatWidth(getMembersChatWidth(chatViewportWidth));
  const chatWidth = clampMembersChatWidth(
    preferredChatWidth ?? LOBBY_CHAT_WIDTH,
    chatViewportWidth,
  );
  // The office's own width, not the window's: the desktop sidebar takes a
  // column beside it.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const resize = () =>
      setChatViewportWidth(rootRef.current?.clientWidth || window.innerWidth);
    window.addEventListener("resize", resize);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    if (rootRef.current) observer?.observe(rootRef.current);
    resize();
    return () => {
      window.removeEventListener("resize", resize);
      observer?.disconnect();
    };
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
  // The mobile chat runs its own hydration (LobbyChat).
  const { loadFailed: membersChatLoadFailed, retry: retryMembersChat } =
    useMembersChatHydration(desktopChatVisible);
  function changeChatHidden(hidden: boolean) {
    setMembersChatOpen(!hidden);
    dispatch({ type: "set_members_chat_shown", shown: !hidden });
  }
  const i18n = useI18n();
  const { t } = i18n;
  // The current room's skin, as theme-variable overrides for the scene
  // container below. The scene already paints its floor and its walls from
  // these, so a skin repaints them with no branch in the drawing; the tab bar,
  // the HUD and the panels sit outside that container and never see them.
  const skinVars = useRoomSkinVars();
  const canWriteRooms = useCan("rooms", "write");
  const newRoomDoor =
    embed || !canWriteRooms
      ? null
      : {
          label: t("office.newRoom.door"),
          onClick: () => setNewRoomOpen(true),
        };
  // The scene box's place and static scale, shared with the back room.
  const frame = sceneFrame(embed, isMobile);
  // layoutKey changes whenever the centered-scene static transform changes, so
  // useViewport re-measures pan-clamp bounds (ResizeObserver alone won't catch
  // transform-only updates).
  const layoutKey = `${frame.top}|${frame.scale}`;
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

  // The lobby has no back screen.
  const currentHasBackRoom = hasBackRoom(
    rooms.find((r) => r.id === currentRoomId),
  );
  const showBackRoom =
    !!backRoomOpen && !lobbyOpen && !!currentRoomId && currentHasBackRoom;
  // The trap door and the ladder move between the floors; other ways to the
  // back room and out of it switch with no animation.
  const floorEl = useRef<HTMLDivElement | null>(null);
  const floorGo = (dir: FloorDir, go?: () => void) => {
    beginFloorMove(floorEl.current, dir, currentRoomId ?? null);
    go?.();
  };
  const floorRoomId = lobbyOpen ? null : (currentRoomId ?? null);
  useLayoutEffect(() => {
    finishFloorMove(floorRoomId, showBackRoom);
  }, [floorRoomId, showBackRoom]);
  useEffect(() => cancelFloorMove, []);
  // Expose viewport controls to parent for keyboard shortcuts (0, +, -). Skip
  // in embed mode - the zoom UI is hidden there, and the keyboard parity
  // should match. The back room screen registers its own view.
  useEffect(() => {
    if (!viewportControlsRef || embed || showBackRoom) {
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
    showBackRoom,
    viewport.resetView,
    viewport.zoomIn,
    viewport.zoomOut,
  ]);

  const roomAgents = agents.filter((a) => a.roomId === currentRoomId);
  // The back room is drawn on its own screen; the front view shows only the
  // desks (task 5b503e32).
  const frontAgents = roomAgents.filter((a) => !isBackSeat(a.desk));
  const backAgents = roomAgents.filter((a) => isBackSeat(a.desk));
  const backCounts = getRoomCounts(backAgents);
  const seasonDesk = decorateScene
    ? seasonalDesk(
        seasonalItems,
        roomAgents.filter((a) => isValidDesk(a.desk)).map((a) => a.desk),
      )
    : null;
  // Where a back agent dropped on the ladder goes: the first free front desk.
  const firstFreeFrontDesk =
    Array.from({ length: DESK_COUNT }, (_, d) => d).find(
      (d) => !frontAgents.some((a) => a.desk === d),
    ) ?? null;
  const backAttention: BackRoomAttention = {
    agents: backAgents.length,
    working: backCounts.working,
    asking: backAgents.filter((a) => a.pendingPrompt != null).length,
    error: backCounts.error,
  };
  // A room takes no more agents when its front, and its back room where it
  // has one, are full: a door refuses such a room at once.
  const roomIsFull = (roomId: string) =>
    deskRoomIsFull(
      rooms.find((r) => r.id === roomId),
      agents.filter((x) => x.roomId === roomId).map((x) => x.desk),
    );
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
    tabs,
    sessionContext?.connectionId ?? null,
    LEFT_DOOR_COORD,
    RIGHT_DOOR_COORD,
  );
  const [leftDoorDragOver, setLeftDoorDragOver] = useState(false);
  const [rightDoorDragOver, setRightDoorDragOver] = useState(false);
  const [leftDoorReject, setLeftDoorReject] = useState(false);
  const [rightDoorReject, setRightDoorReject] = useState(false);
  // The back room's screen counts its own agents. The front counts its own
  // agents too, except that working also takes the back room's (task 0cd2807f).
  const frontCounts = getRoomCounts(frontAgents);
  const counts = showBackRoom
    ? backCounts
    : { ...frontCounts, working: frontCounts.working + backCounts.working };

  const install = useInstallMode();
  // A member with a permission pack sees only the pages of its areas.
  const canTasks = useCan("tasks", "read");
  const canAutomations = useCan("schedules", "read");
  const canWebhooks = useCan("webhooks", "read");
  const canApps = useCan("apps", "read");
  const canSkills = useCan("skills", "read");
  const officeActions: NavAction[] = [
    ...(canTasks
      ? [
          {
            id: "tasks",
            icon: TasksIcon,
            label: t("common.tasks"),
            title: t("nav.tasksShortcut"),
            onClick: onOpenTasks,
          },
        ]
      : []),
    ...(inboxAction ? [inboxAction] : []),
    ...(canAutomations || canWebhooks
      ? [
          {
            id: "cronjobs",
            icon: ClockIcon,
            label: t("common.automations"),
            title: t("common.automations"),
            onClick: onOpenCronjobs,
          },
        ]
      : []),
    ...(canApps
      ? [
          {
            id: "apps",
            icon: AppsIcon,
            label: t("common.apps"),
            title: t("nav.appsShortcut"),
            onClick: onOpenApps,
          },
        ]
      : []),
    ...(onOpenSkills && canSkills
      ? [
          {
            id: "skills",
            icon: SkillsIcon,
            label: t("common.skills"),
            onClick: onOpenSkills,
          },
        ]
      : []),
    ...(onOpenIntegrations
      ? [
          {
            id: "integrations",
            icon: PlugIcon,
            label: t("common.integrations"),
            onClick: onOpenIntegrations,
          },
        ]
      : []),
    // The phone's permanent Install as app; on a computer, even in a narrow
    // window, it sits only in Settings > Device label.
    ...(isMobile && install && readInstallEnv().handheld
      ? [
          {
            id: "install",
            icon: <InstallIcon />,
            label: t("appWidget.install"),
            onClick:
              install === "prompt"
                ? () => void promptInstall()
                : openOfficeInstallSteps,
          },
        ]
      : []),
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
      ref={rootRef}
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
      {elevatorOpen && <ElevatorDialog onClose={closeElevator} />}
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
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {onShowSidebar && (
              <button
                type="button"
                data-show-sidebar=""
                onClick={onShowSidebar}
                title={t("sidebar.show")}
                aria-label={t("sidebar.show")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: 5,
                  borderRadius: 6,
                  border: "1px solid var(--border-subtle)",
                  background: "var(--btn-surface)",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                {SidebarIcon}
              </button>
            )}
            <div style={{ display: "flex", gap: 12 }}>
              {(
                [
                  {
                    n: counts.working,
                    c: "var(--green-text)",
                    l: "office.status.working",
                  },
                  {
                    n: counts.error,
                    c: "var(--red-text)",
                    l: "office.status.error",
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
                      fontFamily: "var(--font-ui)",
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
            {updateAvailable && (
              <span
                onClick={onOpenUpdate}
                title={
                  updateInfo?.mode === "commit"
                    ? buildCommitNotice(i18n, updateInfo)?.notice
                    : t("updateNotice.title.newRelease")
                }
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--accent-text)",
                  fontFamily: "var(--font-ui)",
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
          <NavActions
            actions={
              sidebarOpen
                ? officeActions.filter((a) => !OFFICE_BAR_TWINS.has(a.id))
                : officeActions
            }
            viewport="desktop"
          />
        </div>
      )}

      {!embed && (
        <RoomTabBar
          onOpenRoomSettings={onEditRoomSettings}
          onSelectRoom={showBackRoom ? onCloseBackRoom : undefined}
        />
      )}

      {/* Chat overlays the scene without changing the viewport's fit or origin.
          It stays outside the gesture container so chat scrolling and text
          selection cannot pan or zoom the scene. */}
      <div
        ref={floorEl}
        style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}
      >
        {/* Over the top of the scene, under the room tabs: no control there. */}
        {!embed && <OfficeInstallNotice />}
        {showBackRoom ? (
          <BackRoomScreen
            roomName={rooms.find((r) => r.id === currentRoomId)?.name ?? ""}
            agents={backAgents}
            needsAttention={needsAttention}
            askCounts={askCountByAgent}
            isMobile={isMobile}
            onBack={() => onCloseBackRoom?.()}
            onClimb={() => floorGo("up", onCloseBackRoom)}
            onSpawn={() => onSpawnBack?.()}
            onOpenAgent={(agentId) => dispatch({ type: "focus", agentId })}
            onContextMenu={onContextMenu}
            frontFull={firstFreeFrontDesk === null}
            onDropToFront={(a) => {
              if (firstFreeFrontDesk === null || !currentRoomId) return;
              apiFetch("POST", `/api/agents/${a.id}/move`, {
                targetRoomId: currentRoomId,
                desk: firstFreeFrontDesk,
              } satisfies MoveAgentReq).catch(() => {});
            }}
            viewportControlsRef={viewportControlsRef}
          />
        ) : (
          /* touch-action: none keeps iOS from turning one-finger drags into page scroll.
          Room-swipe still works because that hook reads touch coordinates directly. */
          <div
            ref={attachContainer}
            data-floor-view
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
                ref={(el) => {
                  viewport.setContent(el);
                  contentEl.current = el;
                }}
                data-floor-scene
                style={{
                  // Custom properties are legal in an inline style but absent
                  // from CSSProperties, the same cast Ghost.tsx makes.
                  ...(skinVars as React.CSSProperties),
                  position: "absolute",
                  left: "50%",
                  top: frame.top,
                  transform: `translate(-50%, -50%) scale(${frame.scale})`,
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
                    jukebox
                    starJar
                    receptionist={
                      /* eslint-disable react-hooks/refs -- viewport.wrapClick is a stable callback */
                      receptionist
                        ? {
                            node: (
                              <ReceptionistFigure
                                agent={receptionist}
                                needsAttention={needsAttention.has(
                                  receptionist.id,
                                )}
                                onClick={viewport.wrapClick(openReceptionist)}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  onContextMenu(
                                    e.clientX,
                                    e.clientY,
                                    receptionist,
                                  );
                                }}
                              />
                            ),
                            button: {
                              name: receptionist.name,
                              onOpen: openReceptionist,
                            },
                          }
                        : undefined
                      /* eslint-enable react-hooks/refs */
                    }
                    loading={!hasReceivedInitialState}
                    rightDoor={
                      // While loading, the door to the first room is drawn
                      // with no name yet.
                      !hasReceivedInitialState
                        ? { label: "" }
                        : tabs[0]
                          ? {
                              label: tabs[0].name,
                              onClick: () =>
                                dispatch({
                                  type: "set_current_room",
                                  roomId: tabs[0].id,
                                }),
                            }
                          : newRoomDoor
                    }
                    onToggleTheme={cycleTheme}
                    onOpenApps={embed ? undefined : onOpenApps}
                    onOpenCronjobs={onOpenCronjobs}
                    onOpenElevator={
                      embed ? undefined : () => setElevatorOpen(true)
                    }
                  />
                ) : (
                  <>
                    <Walls
                      onToggleTheme={cycleTheme}
                      onOpenSettings={
                        embed
                          ? undefined
                          : () =>
                              onEditRoomSettings && currentRoomId
                                ? onEditRoomSettings(currentRoomId)
                                : onEditOfficePrompt()
                      }
                      onOpenApps={embed ? undefined : onOpenApps}
                      onOpenTasks={onOpenTasks}
                      onOpenCronjobs={onOpenCronjobs}
                      inbox={wallInbox}
                      taskCount={tasks.filter(inDefaultTaskList).length}
                    />
                    {decorateScene && (
                      <Floor
                        desk8Cable={roomAgents.some((a) => a.desk === 7)}
                      />
                    )}
                    {decorateScene && <GroundShadows />}
                    <WallDoors
                      leftDoor={
                        currentRoomIndex > 0
                          ? {
                              label:
                                tabs[currentRoomIndex - 1]?.name ??
                                t("common.roomFallback", {
                                  number: currentRoomIndex,
                                }),
                              onClick: () =>
                                doorGo("left", tabs[currentRoomIndex - 1].id),
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
                        currentRoomIndex >= 0 &&
                        currentRoomIndex < tabs.length - 1
                          ? {
                              label:
                                tabs[currentRoomIndex + 1]?.name ??
                                t("common.roomFallback", {
                                  number: currentRoomIndex + 2,
                                }),
                              onClick: () =>
                                doorGo("right", tabs[currentRoomIndex + 1].id),
                              dragOver: rightDoorDragOver,
                              reject: rightDoorReject,
                              passCount: rightDoorUses,
                            }
                          : currentRoomIndex === tabs.length - 1
                            ? newRoomDoor
                            : null
                      }
                    />
                    <RoomProps />
                    {decorateScene && <Seasonal items={seasonalItems} />}
                    {currentRoomIndex > 0 && (
                      <DoorDropZone
                        side="left"
                        // viewport.wrapClick is a stable callback that wraps a click
                        // handler to suppress clicks during pan-drag.
                        // eslint-disable-next-line react-hooks/refs
                        onClick={viewport.wrapClick(() =>
                          doorGo("left", tabs[currentRoomIndex - 1].id),
                        )}
                        onDragOverChange={(over) => setLeftDoorDragOver(over)}
                        onDrop={(deskIndex) => {
                          const a = roomAgents.find(
                            (a) => a.desk === deskIndex,
                          );
                          if (!a) {
                            setLeftDoorReject(true);
                            setTimeout(() => setLeftDoorReject(false), 400);
                            return false;
                          }
                          const targetRoomId = tabs[currentRoomIndex - 1]?.id;
                          if (!targetRoomId || roomIsFull(targetRoomId)) {
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
                      currentRoomIndex < tabs.length - 1 && (
                        <DoorDropZone
                          side="right"
                          // viewport.wrapClick: same stable-callback pattern as left door.
                          // eslint-disable-next-line react-hooks/refs
                          onClick={viewport.wrapClick(() =>
                            doorGo("right", tabs[currentRoomIndex + 1].id),
                          )}
                          onDragOverChange={(over) =>
                            setRightDoorDragOver(over)
                          }
                          onDrop={(deskIndex) => {
                            const a = roomAgents.find(
                              (a) => a.desk === deskIndex,
                            );
                            if (!a) {
                              setRightDoorReject(true);
                              setTimeout(() => setRightDoorReject(false), 400);
                              return false;
                            }
                            const targetRoomId = tabs[currentRoomIndex + 1]?.id;
                            if (!targetRoomId || roomIsFull(targetRoomId)) {
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
                    {/* Every room but the lobby. */}
                    {currentHasBackRoom && (
                      <TrapDoor
                        attention={backAttention}
                        backFull={backAgents.length >= BACK_ROOM_SEATS}
                        onOpen={() => floorGo("down", onOpenBackRoom)}
                        onDropDesk={(desk) => {
                          const a = frontAgents.find((x) => x.desk === desk);
                          if (!a || !currentRoomId) return;
                          apiFetch("POST", `/api/agents/${a.id}/move`, {
                            targetRoomId: currentRoomId,
                            desk: null,
                          } satisfies MoveAgentReq).catch(() => {});
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
                            askCount={askCountByAgent.get(agent.id)}
                            onSwap={(a, b) => {
                              const rid = currentRoomId;
                              if (rid)
                                apiFetch(
                                  "POST",
                                  `/api/rooms/${rid}/swap-desks`,
                                  {
                                    deskA: a,
                                    deskB: b,
                                  } satisfies SwapDesksReq,
                                ).catch(() => {});
                            }}
                            stateChangedAt={stateChangedAt.get(agent.id)}
                            workingSince={workingSince.get(agent.id)}
                            seasonal={
                              agent.desk === seasonDesk
                                ? deskTopItems(seasonalItems)
                                : undefined
                            }
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

            {!embed && <Vignette />}
          </div>
        )}
        {!embed && lobbyOpen && isMobile && <LobbyChat />}
        {!embed && lobbyOpen && !isMobile && chatHidden && (
          <MembersChatButton onClick={() => changeChatHidden(false)} />
        )}
        {desktopChatVisible && (
          <MembersChatPanel
            resizeHandle={
              <ChatWidthHandle
                width={chatWidth}
                viewportWidth={chatViewportWidth}
                onChange={changeChatWidth}
                onCommit={commitChatWidth}
              />
            }
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
    </div>
  );
}
