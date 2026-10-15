// GET /agents and back room agents (task 5b503e32).
//
// A room's back room can hold up to 100 agents. For an agent reading the
// office list, that is noise, so its default list shows each back room as ONE
// entry: a summary with a name ("34 in the back room") and no id. The name is
// a string so that jq filters such as `select(.name|test("Worker"))` keep
// working over the whole list; the missing id keeps it from being a message
// target. `?back=1` (and every caller that is not an agent) gets every agent,
// with `backRoom: true` on back agents.

import { isBackSeat } from "../shared/desks.ts";

export interface BackRoomSummary {
  name: string;
  backRoom: true;
  roomId: string;
  roomName: string;
  room: number | null;
  agents: number;
  busy: number;
  pendingPrompt: number;
}

interface ManifestLike {
  desk: number;
  roomId: string;
  roomName: string;
  room: number | null;
  inFlightTurn?: unknown;
  pendingPrompt?: unknown;
}

export const backRoomSummaryName = (agents: number) =>
  `${agents} in the back room`;

/** Marks back agents, and with `collapse` replaces each room's back agents
 *  with one summary at the place of the first of them. Front entries are
 *  returned as they are. */
export function projectBackRooms<T extends ManifestLike>(
  entries: readonly T[],
  collapse: boolean,
): Array<T | (T & { backRoom: true }) | BackRoomSummary> {
  const out: Array<T | (T & { backRoom: true }) | BackRoomSummary> = [];
  const summaries = new Map<string, BackRoomSummary>();
  for (const entry of entries) {
    if (!isBackSeat(entry.desk)) {
      out.push(entry);
      continue;
    }
    if (!collapse) {
      out.push({ ...entry, backRoom: true });
      continue;
    }
    let summary = summaries.get(entry.roomId);
    if (!summary) {
      summary = {
        name: "",
        backRoom: true,
        roomId: entry.roomId,
        roomName: entry.roomName,
        room: entry.room,
        agents: 0,
        busy: 0,
        pendingPrompt: 0,
      };
      summaries.set(entry.roomId, summary);
      out.push(summary);
    }
    summary.agents++;
    if (entry.inFlightTurn) summary.busy++;
    if (entry.pendingPrompt) summary.pendingPrompt++;
  }
  for (const summary of summaries.values())
    summary.name = backRoomSummaryName(summary.agents);
  return out;
}
