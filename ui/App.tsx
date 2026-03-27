import { useState, useEffect } from "react";
import { useAppState, useDispatch } from "./store.tsx";
import { OfficeView } from "./office/OfficeView.tsx";
import { LogView } from "./log-view/LogView.tsx";
import { SpawnDialog } from "./components/SpawnDialog.tsx";
import { ContextMenu } from "./components/ContextMenu.tsx";
import { CSS } from "./styles.ts";
import type { AgentInfo } from "../shared/types.ts";

export function App() {
  const { agents, logs, focusedAgentId } = useAppState();
  const dispatch = useDispatch();
  const [spawnDesk, setSpawnDesk] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; agent: AgentInfo } | null>(null);

  const focusedAgent = focusedAgentId ? agents.find((a) => a.id === focusedAgentId) : null;

  // Escape key returns to office
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        dispatch({ type: "focus", agentId: null });
        setSpawnDesk(null);
        setCtxMenu(null);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [dispatch]);

  return (
    <>
      <style>{CSS}</style>
      {focusedAgent ? (
        <LogView
          agent={focusedAgent}
          logs={logs.get(focusedAgent.id) ?? []}
          onBack={() => dispatch({ type: "focus", agentId: null })}
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
        />
      )}
    </>
  );
}
