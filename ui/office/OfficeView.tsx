import { useState, useEffect, useCallback } from "react";
import { useAppState, useDispatch, useTheme, useFeatures } from "../store.tsx";
import { Floor, Walls } from "./Floor.tsx";
import { RoomProps } from "./RoomProps.tsx";
import { RoomTabBar } from "./RoomTabBar.tsx";
import { DeskUnit } from "./DeskUnit.tsx";
import { EmptySlot } from "./EmptySlot.tsx";
import { StatusLight } from "./StatusLight.tsx";
import { SCENE_W, SCENE_H } from "./grid.ts";
import { send } from "../ws.ts";
import { SunIcon, MoonIcon } from "../components/ThemeIcons.tsx";
import { MobileHeader, getRoomCounts } from "../components/MobileHeader.tsx";
import { NavActions, type NavAction } from "../components/NavActions.tsx";
import { TasksIcon, BuildingIcon, DoorIcon, ListIcon, DeviceIcon, ClockIcon } from "../components/NavIcons.tsx";
import { useSwipeLeftRight } from "../hooks/useSwipeLeftRight.ts";
import { useViewport } from "./useViewport.ts";
import { ZoomControls } from "./ZoomControls.tsx";
import type { AgentInfo } from "../../shared/types.ts";

/** HTML drop zone positioned over an SVG door — SVG elements are unreliable drag-and-drop targets */
function DoorDropZone({ side, onDrop, onDragOverChange, onClick }: { side: "left" | "right"; onDrop: (deskIndex: number) => boolean; onDragOverChange: (over: boolean) => void; onClick: () => void }) {
  const [reject, setReject] = useState(false);
  // Pixel positions within the 950×700 scene container, derived from the SVG door transforms
  const style: React.CSSProperties = side === "left"
    ? { position: "absolute", left: 0, top: 225, width: 85, height: 155, zIndex: 200 }
    : { position: "absolute", right: 0, top: 225, width: 85, height: 155, zIndex: 200 };
  return (
    <div
      data-no-pan
      style={{ ...style, cursor: "pointer", background: reject ? "rgba(255,60,60,0.08)" : "transparent" }}
      onClick={onClick}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDragEnter={() => onDragOverChange(true)}
      onDragLeave={() => onDragOverChange(false)}
      onDrop={(e) => {
        e.preventDefault();
        onDragOverChange(false);
        const src = parseInt(e.dataTransfer.getData("text/plain"), 10);
        if (!isNaN(src)) {
          const ok = onDrop(src);
          if (!ok) { setReject(true); setTimeout(() => setReject(false), 400); }
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

export function OfficeView({ onSpawn, onContextMenu, onOpenDeviceSettings, onEditOfficePrompt, onEditRoomSettings, onOpenTasks, onOpenCronjobs, onOpenUpdate, onSwipeLeft, onSwipeRight, viewportControlsRef }: OfficeViewProps) {
  const { agents, needsAttention, stateChangedAt, office, tasks, currentRoom, rooms, isMobile, updateAvailable } = useAppState();
  const roomCount = rooms.length;
  const roomNames = rooms.map((r) => r.name);
  const officePrompt = office.prompt;
  const dispatch = useDispatch();
  const { theme, toggleTheme } = useTheme();
  const { embed } = useFeatures();
  const mobileScale = isMobile ? screen.width / (SCENE_W - 200) : 1;
  // layoutKey changes whenever the centered-scene static transform changes, so
  // useViewport re-measures pan-clamp bounds (ResizeObserver alone won't catch
  // transform-only updates).
  const layoutKey = `${embed ? 1 : 0}|${isMobile ? 1 : 0}|${mobileScale}`;
  const currentRoomId = rooms[currentRoom]?.id ?? "";
  const roomIds = rooms.map((r) => r.id);
  const viewport = useViewport(currentRoomId, roomIds, layoutKey, !embed);
  // Cede one-finger swipes to pan once the user zooms in (iOS-gallery pattern).
  const swipeRef = useSwipeLeftRight(
    onSwipeLeft ?? (() => {}),
    onSwipeRight ?? (() => {}),
    isMobile,
    () => !viewport.isZoomedIn(),
  );
  const attachContainer = useCallback((node: HTMLDivElement | null) => {
    swipeRef(node);
    viewport.setContainer(node);
  }, [swipeRef, viewport.setContainer]);

  // Expose viewport controls to parent for keyboard shortcuts (0, +, -). Skip
  // in embed mode — the zoom UI is hidden there, and the keyboard parity
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
    return () => { viewportControlsRef.current = null; };
  }, [viewportControlsRef, embed, viewport.resetView, viewport.zoomIn, viewport.zoomOut]);

  // Filter agents to current room for rendering
  const roomAgents = agents.filter((a) => a.room === currentRoom);
  const [leftDoorDragOver, setLeftDoorDragOver] = useState(false);
  const [rightDoorDragOver, setRightDoorDragOver] = useState(false);
  const [leftDoorReject, setLeftDoorReject] = useState(false);
  const [rightDoorReject, setRightDoorReject] = useState(false);
  const counts = getRoomCounts(roomAgents);

  const officeActions: NavAction[] = [
    { id: "tasks", icon: TasksIcon, label: "Tasks", onClick: onOpenTasks },
    { id: "cronjobs", icon: ClockIcon, label: "Cronjobs", onClick: onOpenCronjobs },
    { id: "device", icon: DeviceIcon, label: "Device settings", onClick: onOpenDeviceSettings },
    { id: "office", icon: BuildingIcon, label: "Office settings", onClick: onEditOfficePrompt },
    ...(onEditRoomSettings ? [{ id: "room", icon: DoorIcon, label: "Room settings", onClick: onEditRoomSettings }] : []),
    { id: "theme", icon: theme === "dark" ? <SunIcon size={15} /> : <MoonIcon size={15} />, label: theme === "dark" ? "Light mode" : "Dark mode", onClick: toggleTheme },
  ];

  const mobileOfficeActions: NavAction[] = [
    ...officeActions,
    { id: "list", icon: ListIcon, label: "Show agent list", onClick: () => dispatch({ type: "toggle_mobile_view" }) },
  ];

  return (
    <div
      style={{
        height: isMobile ? "calc(100dvh - var(--banner-h, 0px))" : "calc(100vh - var(--banner-h, 0px))",
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
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text-primary)" }}>Isomux</span>
            {updateAvailable && (
              <span
                onClick={onOpenUpdate}
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
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--blue, #58a6ff)", boxShadow: "0 0 8px var(--blue, #58a6ff)" }} />
                update available
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
        style={{ flex: 1, position: "relative", overflow: "hidden", touchAction: "none" }}
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

        {/* Viewport layer — zoom/pan transform applies here, wrapping the centered scene */}
        <div
          ref={viewport.setScene}
          style={{
            position: "absolute",
            inset: 0,
            transformOrigin: "0 0",
          }}
        >
          {/* Centered scene container — static centering transform */}
          <div
            ref={viewport.setContent}
            style={{
              position: "absolute",
              left: "50%",
              top: embed ? (isMobile ? "55%" : "64%") : isMobile ? "45%" : "50%",
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
              onEditOfficePrompt={onEditOfficePrompt}
              hasOfficePrompt={!!officePrompt}
              onOpenTasks={onOpenTasks}
              onOpenCronjobs={onOpenCronjobs}
              taskCount={tasks.filter(t => t.status !== "done").length}
              leftDoor={currentRoom > 0 ? { label: roomNames[currentRoom - 1] ?? `Room ${currentRoom}`, onClick: () => dispatch({ type: "set_current_room", room: currentRoom - 1 }), dragOver: leftDoorDragOver, reject: leftDoorReject } : null}
              rightDoor={currentRoom < roomCount - 1 ? { label: roomNames[currentRoom + 1] ?? `Room ${currentRoom + 2}`, onClick: () => dispatch({ type: "set_current_room", room: currentRoom + 1 }), dragOver: rightDoorDragOver, reject: rightDoorReject } : null}
            />
            <Floor />
            <RoomProps />
            {currentRoom > 0 && (
              <DoorDropZone
                side="left"
                onClick={viewport.wrapClick(() => dispatch({ type: "set_current_room", room: currentRoom - 1 }))}
                onDragOverChange={(over) => setLeftDoorDragOver(over)}
                onDrop={(deskIndex) => {
                  const a = roomAgents.find((a) => a.desk === deskIndex);
                  if (!a) { setLeftDoorReject(true); setTimeout(() => setLeftDoorReject(false), 400); return false; }
                  const targetRoom = currentRoom - 1;
                  const targetRoomId = rooms[targetRoom]?.id;
                  if (!targetRoomId || agents.filter((x) => x.room === targetRoom).length >= 8) { setLeftDoorReject(true); setTimeout(() => setLeftDoorReject(false), 400); return false; }
                  send({ type: "move_agent", agentId: a.id, targetRoomId });
                  return true;
                }}
              />
            )}
            {currentRoom < roomCount - 1 && (
              <DoorDropZone
                side="right"
                onClick={viewport.wrapClick(() => dispatch({ type: "set_current_room", room: currentRoom + 1 }))}
                onDragOverChange={(over) => setRightDoorDragOver(over)}
                onDrop={(deskIndex) => {
                  const a = roomAgents.find((a) => a.desk === deskIndex);
                  if (!a) { setRightDoorReject(true); setTimeout(() => setRightDoorReject(false), 400); return false; }
                  const targetRoom = currentRoom + 1;
                  const targetRoomId = rooms[targetRoom]?.id;
                  if (!targetRoomId || agents.filter((x) => x.room === targetRoom).length >= 8) { setRightDoorReject(true); setTimeout(() => setRightDoorReject(false), 400); return false; }
                  send({ type: "move_agent", agentId: a.id, targetRoomId });
                  return true;
                }}
              />
            )}
            {Array.from({ length: 8 }, (_, i) => {
              const agent = roomAgents.find((a) => a.desk === i);
              if (agent) {
                return (
                  <DeskUnit
                    key={agent.id}
                    agent={agent}
                    onClick={viewport.wrapClick(() => dispatch({ type: "focus", agentId: agent.id }))}
                    onContextMenu={(e) => onContextMenu(e.clientX, e.clientY, agent)}
                    needsAttention={needsAttention.has(agent.id)}
                    onSwap={(a, b) => { const rid = rooms[currentRoom]?.id; if (rid) send({ type: "swap_desks", deskA: a, deskB: b, roomId: rid }); }}
                    stateChangedAt={stateChangedAt.get(agent.id)}
                  />
                );
              }
              return <EmptySlot key={`empty-${i}`} deskIndex={i} onClick={viewport.wrapClick(() => onSpawn(i))} onSwap={(a, b) => { const rid = rooms[currentRoom]?.id; if (rid) send({ type: "swap_desks", deskA: a, deskB: b, roomId: rid }); }} />;
            })}
          </div>
        </div>

        {/* Zoom controls */}
        {!embed && <ZoomControls onZoomIn={viewport.zoomIn} onZoomOut={viewport.zoomOut} onReset={viewport.resetView} />}

        {/* Vignette */}
        {!embed && <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            boxShadow: "inset 0 0 120px var(--vignette)",
          }}
        />}
      </div>

      {/* Bottom HUD */}
      {!embed && <div
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
          ? ["TAP → open", "LONG-PRESS → actions", "PINCH → zoom", "DRAG (zoomed) → pan"]
          : ["CLICK → open agent", "DRAG → swap desks or move to door", "WHEEL / +- → zoom", "DRAG → pan", "RIGHT-CLICK → actions", "0 → reset view"]
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
      </div>}
    </div>
  );
}
