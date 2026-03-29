import { useState, useEffect } from "react";
import { useAppState, useDispatch } from "./store.tsx";
import { OfficeView } from "./office/OfficeView.tsx";
import { LogView } from "./log-view/LogView.tsx";
import { SpawnDialog } from "./components/SpawnDialog.tsx";
import { ContextMenu } from "./components/ContextMenu.tsx";
import { EditAgentDialog } from "./components/EditAgentDialog.tsx";
import { CSS } from "./styles.ts";
import type { AgentInfo } from "../shared/types.ts";

export function App() {
  const { agents, logs, focusedAgentId } = useAppState();
  const dispatch = useDispatch();
  const [spawnDesk, setSpawnDesk] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; agent: AgentInfo } | null>(null);
  const [editAgent, setEditAgent] = useState<AgentInfo | null>(null);

  const focusedAgent = focusedAgentId ? agents.find((a) => a.id === focusedAgentId) : null;

  // Keyboard shortcuts: Escape → office, 1-8 → jump to agent at desk
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        dispatch({ type: "focus", agentId: null });
        setSpawnDesk(null);
        setCtxMenu(null);
        setEditAgent(null);
      }
      // Number keys 1-8: focus agent at that desk (only from office view)
      if (!focusedAgentId && e.key >= "1" && e.key <= "8" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const deskIndex = parseInt(e.key) - 1;
        const agent = agents.find((a) => a.desk === deskIndex);
        if (agent) {
          e.preventDefault();
          dispatch({ type: "focus", agentId: agent.id });
        }
      }
      // Tab: cycle to next agent (Shift+Tab: previous) when viewing an agent
      // Skip if autocomplete already consumed this Tab (it calls preventDefault)
      if (focusedAgentId && e.key === "Tab" && agents.length > 1 && !e.defaultPrevented) {
        e.preventDefault();
        const sorted = [...agents].sort((a, b) => a.desk - b.desk);
        const idx = sorted.findIndex((a) => a.id === focusedAgentId);
        const next = e.shiftKey
          ? sorted[(idx - 1 + sorted.length) % sorted.length]
          : sorted[(idx + 1) % sorted.length];
        dispatch({ type: "focus", agentId: next.id });
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [dispatch, focusedAgentId, agents]);

  return (
    <>
      <style>{CSS}</style>
      {focusedAgent ? (
        <LogView
          key={focusedAgent.id}
          agent={focusedAgent}
          logs={logs.get(focusedAgent.id) ?? []}
          onBack={() => dispatch({ type: "focus", agentId: null })}
          onEditAgent={() => setEditAgent(focusedAgent)}
        />
      ) : (
        <OfficeView
          onSpawn={(desk) => setSpawnDesk(desk)}
          onContextMenu={(x, y, agent) => setCtxMenu({ x, y, agent })}
        />
      )}
      {spawnDesk !== null && (
        <SpawnDialog
          deskIndex={spawnDesk}
          defaultCwd="~"
          onClose={() => setSpawnDesk(null)}
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
    </>
  );
}
