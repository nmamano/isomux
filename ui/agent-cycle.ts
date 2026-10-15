// Next and Prev agent (Tab / Shift+Tab and the log view's arrows).
import type { AgentInfo } from "../shared/types.ts";
import { isBackSeat } from "../shared/desks.ts";

/** Cycle to the next/previous agent in the current room, matching Tab/Shift+Tab logic. */
export function cycleAgent(
  agents: AgentInfo[],
  drafts: Map<string, string>,
  currentRoomId: string | null,
  focusedAgentId: string | null,
  direction: "next" | "prev",
): string | null {
  // Cycle within one area of the room: the back room when a back agent is
  // focused, else the front desks (task 5b503e32).
  const focused = agents.find((a) => a.id === focusedAgentId);
  const inBack = focused ? isBackSeat(focused.desk) : false;
  const roomAgents = agents.filter(
    (a) => a.roomId === currentRoomId && isBackSeat(a.desk) === inBack,
  );
  const sorted = [...roomAgents].sort((a, b) => a.desk - b.desk);
  const nonIdle = sorted.filter(
    (a) =>
      (a.state !== "idle" && a.state !== "stopped") ||
      (drafts.get(a.id) ?? "").length > 0,
  );
  const pool = nonIdle.length > 0 ? nonIdle : sorted;
  if (pool.length === 0) return null;
  const idx = pool.findIndex((a) => a.id === focusedAgentId);
  if (idx !== -1 && pool.length <= 1) return null;
  const next =
    idx === -1
      ? direction === "prev"
        ? pool[pool.length - 1]
        : pool[0]
      : direction === "prev"
        ? pool[(idx - 1 + pool.length) % pool.length]
        : pool[(idx + 1) % pool.length];
  return next.id;
}
