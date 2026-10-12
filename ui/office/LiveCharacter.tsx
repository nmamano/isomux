import { useEffect, useState } from "react";
import type { AgentInfo } from "../../shared/types.ts";
import { Character } from "./Character.tsx";
import { SWEAT_AFTER_MS } from "./DeskUnit.tsx";
import { isWorkingState, useAppState } from "../store.tsx";

/** True once the agent has worked for SWEAT_AFTER_MS without a break. One
 *  timer per stretch, set for the moment the threshold passes. */
export function useSweating(agent: AgentInfo): boolean {
  const { workingSince } = useAppState();
  const since = isWorkingState(agent.state)
    ? workingSince.get(agent.id)
    : undefined;
  const due = since === undefined ? undefined : since + SWEAT_AFTER_MS;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (due === undefined) return;
    const id = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, due - Date.now()),
    );
    return () => clearTimeout(id);
  }, [due]);
  return due !== undefined && now >= due;
}

/** The agent's character outside a desk (chat header, app widget, lobby),
 *  with the same sweat as at its desk. */
export function LiveCharacter({
  agent,
  height,
}: {
  agent: AgentInfo;
  height?: number;
}) {
  const sweating = useSweating(agent);
  return (
    <Character
      key={agent.state}
      state={agent.state}
      outfit={agent.outfit}
      height={height}
      sweating={sweating}
    />
  );
}
