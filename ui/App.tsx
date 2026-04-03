import { useState, useEffect, useCallback } from "react";
import { useAppState, useDispatch } from "./store.tsx";
import { OfficeView } from "./office/OfficeView.tsx";
import { LogView } from "./log-view/LogView.tsx";
import { AgentListView } from "./components/AgentListView.tsx";
import { ContextMenu } from "./components/ContextMenu.tsx";
import { EditAgentDialog } from "./components/EditAgentDialog.tsx";
import { UsernameModal } from "./components/UsernameModal.tsx";
import { OfficePromptModal } from "./components/OfficePromptModal.tsx";
import { TodoModal } from "./components/TodoModal.tsx";
import { CSS } from "./styles.ts";
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
  const { agents, logs, focusedAgentId, isMobile, mobileViewMode, drafts, currentRoom, roomCount } = useAppState();
  const dispatch = useDispatch();
  const [spawnDesk, setSpawnDesk] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; agent: AgentInfo } | null>(null);
  const [editAgent, setEditAgent] = useState<AgentInfo | null>(null);
  const [username, setUsername] = useState<string | null>(() => {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("isomux-username");
    }
    return null;
  });
  const [editingUsername, setEditingUsername] = useState(false);
  const [editingOfficePrompt, setEditingOfficePrompt] = useState(false);
  const [todosOpen, setTodosOpen] = useState(false);

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

  // Keyboard shortcuts: Escape → office, 1-8 → jump to agent at desk
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
      if (e.key === "Escape") {
        dispatch({ type: "focus", agentId: null });
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
  }, [dispatch, focusedAgentId, agents, drafts, currentRoom, roomCount]);

  return (
    <>
      <style>{CSS}</style>
      {username === null && (
        <UsernameModal onSave={(name) => {
          localStorage.setItem("isomux-username", name);
          setUsername(name);
        }} />
      )}
      {editingUsername && username !== null && (
        <UsernameModal
          defaultValue={username}
          onSave={(name) => {
            localStorage.setItem("isomux-username", name);
            setUsername(name);
            setEditingUsername(false);
          }}
          onClose={() => setEditingUsername(false)}
        />
      )}
      {focusedAgent ? (
        <LogView
          key={focusedAgent.id}
          agent={focusedAgent}
          logs={logs.get(focusedAgent.id) ?? []}
          onBack={() => dispatch({ type: "focus", agentId: null })}
          onEditAgent={() => setEditAgent(focusedAgent)}
          username={username ?? ""}
          onSwipeLeft={swipeAgentNext}
          onSwipeRight={swipeAgentPrev}
        />
      ) : isMobile && mobileViewMode === "list" ? (
        <AgentListView
          onFocus={(agentId) => dispatch({ type: "focus", agentId })}
          onSpawn={() => setSpawnDesk(0)}
          onContextMenu={(x, y, agent) => setCtxMenu({ x, y, agent })}
          username={username ?? ""}
          onEditUsername={() => setEditingUsername(true)}
          onEditOfficePrompt={() => setEditingOfficePrompt(true)}
          onOpenTodos={() => setTodosOpen(true)}
          onToggleView={() => dispatch({ type: "toggle_mobile_view" })}
          onSwipeLeft={swipeRoomNext}
          onSwipeRight={swipeRoomPrev}
        />
      ) : (
        <OfficeView
          onSpawn={(desk) => setSpawnDesk(desk)}
          onContextMenu={(x, y, agent) => setCtxMenu({ x, y, agent })}
          username={username ?? ""}
          onEditUsername={() => setEditingUsername(true)}
          onEditOfficePrompt={() => setEditingOfficePrompt(true)}
          onOpenTodos={() => setTodosOpen(true)}
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
          username={username ?? ""}
          onSaveUsername={(name) => {
            localStorage.setItem("isomux-username", name);
            setUsername(name);
          }}
        />
      )}
      {todosOpen && (
        <TodoModal username={username ?? ""} onClose={() => setTodosOpen(false)} />
      )}
    </>
  );
}
