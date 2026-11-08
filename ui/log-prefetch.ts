// Background chat loads (task 9ebe887d slice 2). While no chat load is in
// flight, LogPrefetcher sends open_log with tail PREFETCH_TAIL for the next
// agent of the room on screen that has no stream, newest lastEntryAt first,
// one at a time. A chat the member opens sends its own whole load at once;
// the server's background lane puts it ahead of any prefetch.

import { useEffect, useRef, type ReactNode } from "react";
import { isBackSeat } from "../shared/desks.ts";
import { PREFETCH_TAIL } from "../shared/log-stream.ts";
import type { AgentInfo } from "../shared/types.ts";
import {
  mountedLoadPending,
  mountedLogAgents,
  sendOpenLog,
} from "./agent-log.ts";
import { useCan } from "./hooks/useCan.ts";
import { useAppState, useDispatch, type LogStream } from "./store.tsx";

/** The next agent to prefetch, or null: the agents of `roomId` (front desks,
 *  and the back room's when `backOpen`) with no stream, not mounted, ordered
 *  by lastEntryAt, newest first; null while any stream is loading. */
export function nextPrefetchAgent(
  agents: readonly AgentInfo[],
  streams: ReadonlyMap<string, LogStream>,
  mounted: ReadonlySet<string>,
  roomId: string | null,
  backOpen: boolean,
): string | null {
  if (roomId === null) return null;
  for (const stream of streams.values())
    if (stream.state === "loading") return null;
  const candidates = agents.filter(
    (agent) =>
      agent.roomId === roomId &&
      (backOpen || !isBackSeat(agent.desk)) &&
      !streams.has(agent.id) &&
      !mounted.has(agent.id),
  );
  candidates.sort(
    (a, b) =>
      (b.lastEntryAt ?? Number.NEGATIVE_INFINITY) -
      (a.lastEntryAt ?? Number.NEGATIVE_INFINITY),
  );
  return candidates[0]?.id ?? null;
}

/** Mounted once in App: runs the prefetch from the store. */
export function LogPrefetcher({ backOpen }: { backOpen: boolean }): ReactNode {
  const state = useAppState();
  const dispatch = useDispatch();
  const canRead = useCan("logs", "read");
  const latest = useRef({ state, backOpen });
  useEffect(() => {
    latest.current = { state, backOpen };
  });
  const {
    logsOnOpen,
    connected,
    logStreams,
    agents,
    currentRoomId,
    lobbyOpen,
  } = state;
  useEffect(() => {
    if (!logsOnOpen || !connected || !canRead) return;
    // A later tick: the chats on screen send their own loads in this commit's
    // effects, which may run after this one.
    const timer = setTimeout(() => {
      const { state: now, backOpen: back } = latest.current;
      if (!now.logsOnOpen || !now.connected) return;
      // A chat on screen that has not sent its load goes first.
      if (mountedLoadPending(now.logStreams, now.logSocketGen)) return;
      const mounted = mountedLogAgents();
      const next = nextPrefetchAgent(
        now.agents,
        now.logStreams,
        mounted,
        now.lobbyOpen ? null : now.currentRoomId,
        back,
      );
      if (next) sendOpenLog(dispatch, next, PREFETCH_TAIL);
    }, 0);
    return () => clearTimeout(timer);
  }, [
    logsOnOpen,
    connected,
    canRead,
    logStreams,
    agents,
    currentRoomId,
    lobbyOpen,
    backOpen,
    dispatch,
  ]);
  return null;
}
