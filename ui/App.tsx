import { useState, useEffect, useCallback, useRef } from "react";
import { useAppState, useDispatch } from "./store.tsx";
import { OfficeView } from "./office/OfficeView.tsx";
import { LogView } from "./log-view/LogView.tsx";
import { AgentListView } from "./components/AgentListView.tsx";
import { ContextMenu } from "./components/ContextMenu.tsx";
import { EditAgentDialog } from "./components/EditAgentDialog.tsx";
import { UsernameModal } from "./components/UsernameModal.tsx";
import { OfficePromptModal } from "./components/OfficePromptModal.tsx";
import { RoomSettingsModal } from "./components/RoomSettingsModal.tsx";
import { DeviceSettingsModal } from "./components/DeviceSettingsModal.tsx";
import { TaskView } from "./components/TaskView.tsx";
import { CronjobsView } from "./components/CronjobsView.tsx";
import { UpdateModal } from "./components/UpdateModal.tsx";
import { CSS } from "./styles.ts";
import { getUsername, setUsername as saveUsername } from "./device-settings.ts";
import type { AgentInfo } from "../shared/types.ts";

/** Cycle to the next/previous agent in the current room, matching Tab/Shift+Tab logic. */
function cycleAgent(
  agents: AgentInfo[],
  drafts: Map<string, string>,
  currentRoom: number,
  focusedAgentId: string | null,
  direction: "next" | "prev",
): string | null {
  const roomAgents = agents.filter((a) => a.room === currentRoom);
  const sorted = [...roomAgents].sort((a, b) => a.desk - b.desk);
  const nonIdle = sorted.filter((a) => (a.state !== "idle" && a.state !== "stopped") || (drafts.get(a.id) ?? "").length > 0);
  const pool = nonIdle.length > 0 ? nonIdle : sorted;
  if (pool.length === 0) return null;
  const idx = pool.findIndex((a) => a.id === focusedAgentId);
  if (idx !== -1 && pool.length <= 1) return null;
  const next = idx === -1
    ? (direction === "prev" ? pool[pool.length - 1] : pool[0])
    : direction === "prev"
      ? pool[(idx - 1 + pool.length) % pool.length]
      : pool[(idx + 1) % pool.length];
  return next.id;
}

export function App() {
  const { agents, logs, focusedAgentId, isMobile, mobileViewMode, drafts, currentRoom, rooms } = useAppState();
  const roomCount = rooms.length;
  const dispatch = useDispatch();
  const [spawnDesk, setSpawnDesk] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; agent: AgentInfo } | null>(null);
  const [editAgent, setEditAgent] = useState<AgentInfo | null>(null);
  const [username, setUsername] = useState<string | null>(() => getUsername());
  const [editingDeviceSettings, setEditingDeviceSettings] = useState(false);
  const [editingOfficePrompt, setEditingOfficePrompt] = useState(false);
  const [editingRoomSettings, setEditingRoomSettings] = useState<string | null>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [cronjobsOpen, setCronjobsOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);

  const focusedAgent = focusedAgentId ? agents.find((a) => a.id === focusedAgentId) : null;

  const swipeRoomNext = useCallback(() => {
    if (roomCount <= 1) return;
    dispatch({ type: "set_current_room", room: (currentRoom + 1) % roomCount });
  }, [dispatch, currentRoom, roomCount]);

  const swipeRoomPrev = useCallback(() => {
    if (roomCount <= 1) return;
    dispatch({ type: "set_current_room", room: (currentRoom - 1 + roomCount) % roomCount });
  }, [dispatch, currentRoom, roomCount]);

  const swipeAgentNext = useCallback(() => {
    const nextId = cycleAgent(agents, drafts, currentRoom, focusedAgentId, "next");
    if (nextId) dispatch({ type: "focus", agentId: nextId });
  }, [dispatch, agents, drafts, currentRoom, focusedAgentId]);

  const swipeAgentPrev = useCallback(() => {
    const nextId = cycleAgent(agents, drafts, currentRoom, focusedAgentId, "prev");
    if (nextId) dispatch({ type: "focus", agentId: nextId });
  }, [dispatch, agents, drafts, currentRoom, focusedAgentId]);

  // Browser back button: navigate to office view instead of leaving the page.
  // Model: office = home, any other view = one level deep. Only one history
  // entry is ever pushed. All "return to office" paths go through goHome(),
  // which calls history.back() so the popstate handler does the actual cleanup.
  const deepRef = useRef(false);

  const goHome = useCallback(() => {
    if (deepRef.current) {
      window.history.back(); // popstate handler will reset state
    } else {
      // Safety fallback — shouldn't happen, but don't break if it does
      setTasksOpen(false);
      setCronjobsOpen(false);
      dispatch({ type: "focus", agentId: null });
    }
  }, [dispatch]);

  // Keyboard shortcuts: Escape → office, 1-8 → jump to agent at desk
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
      if (e.key === "Escape") {
        goHome();
        setSpawnDesk(null);
        setCtxMenu(null);
        setEditAgent(null);
      }
      // Number keys 1-8: focus agent at that desk in current room (only from office view)
      if (!isInput && !focusedAgentId && e.key >= "1" && e.key <= "8" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const deskIndex = parseInt(e.key) - 1;
        const agent = agents.find((a) => a.desk === deskIndex && a.room === currentRoom);
        if (agent) {
          e.preventDefault();
          dispatch({ type: "focus", agentId: agent.id });
        }
      }
      // Tab/Shift+Tab in office view: switch rooms
      if (!isInput && !focusedAgentId && e.key === "Tab" && roomCount > 1 && !e.defaultPrevented) {
        e.preventDefault();
        const next = e.shiftKey
          ? (currentRoom - 1 + roomCount) % roomCount
          : (currentRoom + 1) % roomCount;
        dispatch({ type: "set_current_room", room: next });
      }
      // Tab: cycle to next agent within current room (Shift+Tab: previous) when viewing an agent
      // Skip if autocomplete already consumed this Tab (it calls preventDefault)
      if (focusedAgentId && e.key === "Tab" && agents.length > 1 && !e.defaultPrevented) {
        e.preventDefault();
        const nextId = cycleAgent(agents, drafts, currentRoom, focusedAgentId, e.shiftKey ? "prev" : "next");
        if (nextId) dispatch({ type: "focus", agentId: nextId });
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [dispatch, goHome, focusedAgentId, agents, drafts, currentRoom, roomCount]);

  // Sync history stack with view state
  const isDeep = tasksOpen || cronjobsOpen || focusedAgentId !== null;
  useEffect(() => {
    if (isDeep && !deepRef.current) {
      window.history.pushState({ isomux: true }, "");
      deepRef.current = true;
    } else if (isDeep && deepRef.current) {
      // Deep → deep transition (e.g. tasks→log, agent cycling): keep one entry
      window.history.replaceState({ isomux: true }, "");
    } else if (!isDeep && deepRef.current) {
      // Returned to office — entry was consumed by history.back()
      deepRef.current = false;
    }
  }, [isDeep, focusedAgentId, tasksOpen, cronjobsOpen]);

  useEffect(() => {
    function handlePopState() {
      deepRef.current = false;
      setTasksOpen(false);
      setCronjobsOpen(false);
      dispatch({ type: "focus", agentId: null });
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [dispatch]);

  return (
    <>
      <style>{CSS}</style>
      {username === null && (
        <UsernameModal onSave={(name) => {
          saveUsername(name);
          setUsername(name);
        }} />
      )}
      {editingDeviceSettings && username !== null && (
        <DeviceSettingsModal
          username={username}
          onSaveUsername={(name) => {
            saveUsername(name);
            setUsername(name);
          }}
          onClose={() => setEditingDeviceSettings(false)}
        />
      )}
      {tasksOpen ? (
        <TaskView
          username={username ?? ""}
          onClose={goHome}
          onFocusAgent={(agentId) => { setTasksOpen(false); dispatch({ type: "focus", agentId }); }}
        />
      ) : cronjobsOpen ? (
        <CronjobsView
          username={username ?? ""}
          onClose={goHome}
        />
      ) : focusedAgent ? (
        <LogView
          key={focusedAgent.id}
          agent={focusedAgent}
          logs={logs.get(focusedAgent.id) ?? []}
          onBack={goHome}
          onEditAgent={() => setEditAgent(focusedAgent)}
          username={username ?? ""}
          onOpenTasks={() => setTasksOpen(true)}
          onSwipeLeft={swipeAgentNext}
          onSwipeRight={swipeAgentPrev}
        />
      ) : isMobile && mobileViewMode === "list" ? (
        <AgentListView
          onFocus={(agentId) => dispatch({ type: "focus", agentId })}
          onSpawn={() => setSpawnDesk(0)}
          onContextMenu={(x, y, agent) => setCtxMenu({ x, y, agent })}
          onOpenDeviceSettings={() => setEditingDeviceSettings(true)}
          onEditOfficePrompt={() => setEditingOfficePrompt(true)}
          onEditRoomSettings={() => { const rid = rooms[currentRoom]?.id; if (rid) setEditingRoomSettings(rid); }}
          onOpenTasks={() => setTasksOpen(true)}
          onOpenCronjobs={() => setCronjobsOpen(true)}
          onOpenUpdate={() => setUpdateOpen(true)}
          onToggleView={() => dispatch({ type: "toggle_mobile_view" })}
          onSwipeLeft={swipeRoomNext}
          onSwipeRight={swipeRoomPrev}
        />
      ) : (
        <OfficeView
          onSpawn={(desk) => setSpawnDesk(desk)}
          onContextMenu={(x, y, agent) => setCtxMenu({ x, y, agent })}
          onOpenDeviceSettings={() => setEditingDeviceSettings(true)}
          onEditOfficePrompt={() => setEditingOfficePrompt(true)}
          onEditRoomSettings={() => { const rid = rooms[currentRoom]?.id; if (rid) setEditingRoomSettings(rid); }}
          onOpenTasks={() => setTasksOpen(true)}
          onOpenCronjobs={() => setCronjobsOpen(true)}
          onOpenUpdate={() => setUpdateOpen(true)}
          onSwipeLeft={swipeRoomNext}
          onSwipeRight={swipeRoomPrev}
        />
      )}
      {spawnDesk !== null && (
        <EditAgentDialog
          deskIndex={spawnDesk}
          defaultCwd="~"
          onClose={() => setSpawnDesk(null)}
          room={currentRoom}
        />
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          agent={ctxMenu.agent}
          onClose={() => setCtxMenu(null)}
          onEdit={(agent) => { setEditAgent(agent); setCtxMenu(null); }}
        />
      )}
      {editAgent && (
        <EditAgentDialog
          agent={editAgent}
          onClose={() => setEditAgent(null)}
        />
      )}
      {editingOfficePrompt && (
        <OfficePromptModal
          onClose={() => setEditingOfficePrompt(false)}
        />
      )}
      {editingRoomSettings && (
        <RoomSettingsModal
          roomId={editingRoomSettings}
          onClose={() => setEditingRoomSettings(null)}
        />
      )}
      {updateOpen && (
        <UpdateModal onClose={() => setUpdateOpen(false)} />
      )}
    </>
  );
}
