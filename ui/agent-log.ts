// One chat's log, loaded when a surface shows it (task 9ebe887d slices 2-3).
// LogView (the focused chat), AgentChatPanel and AppWidgetPage call
// useAgentLog for the agent they render. It is ref-counted per agent: the
// first mount of an agent with no stream sends open_log with RECENT_TAIL (the
// chat's last entries), or the whole log when the chat showed the whole log
// before a reconnect (logsComplete). A stream that exists (a prefetch, an
// earlier open) is kept. loadRestOfLog asks for the whole log. The last
// unmount while the surface's own load is in flight sends close_log. After a
// load the subscription stays, so live entries keep the stored log fresh and
// a reopen sends nothing.
//
// Only when the server's last full_state said logsOnOpen (W2): an older
// server keeps the connect replay, and nothing is sent.

import { useEffect } from "react";
import { RECENT_TAIL } from "../shared/log-stream.ts";
import { send } from "./ws.ts";
import { useCan } from "./hooks/useCan.ts";
import {
  useAppState,
  useDispatch,
  type Action,
  type LogStream,
} from "./store.tsx";

// Surfaces that show each agent now.
const mounts = new Map<string, number>();
// The last open a surface sent per agent on the current socket (not a
// prefetch), so two surfaces that mount in one commit send one, and two calls
// of loadRestOfLog in one commit send one whole open (the store has not seen
// the first dispatch yet when the second runs).
const ownOpens = new Map<
  string,
  { socketGen: number; requestId: string; whole: boolean }
>();
let counter = 0;
// The store as of the last render of any useAgentLog: an unmount reads the
// agent it leaves, after the render that switched to another one, and
// loadRestOfLog reads it from a click.
let lastStreams: ReadonlyMap<string, LogStream> = new Map();
let lastSocketGen = 0;
let lastLogsOnOpen = false;

/** A request id unique in this tab. */
export function newLogRequestId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Send open_log and tell the store (the prefetch uses it too, with
 *  prefetch: true, which puts it behind the other loads on the server). */
export function sendOpenLog(
  dispatch: (action: Action) => void,
  agentId: string,
  tail?: number,
  opts: { prefetch?: true } = {},
): string {
  const requestId = newLogRequestId();
  dispatch({
    type: "log_open_sent",
    agentId,
    requestId,
    ...(tail === undefined ? {} : { tail }),
  });
  send({
    type: "open_log",
    agentId,
    requestId,
    ...(tail === undefined ? {} : { tail }),
    ...(opts.prefetch ? { prefetch: true } : {}),
  });
  return requestId;
}

// A surface's own open, recorded for the dedupe above.
function sendOwnOpen(
  dispatch: (action: Action) => void,
  agentId: string,
  whole: boolean,
): void {
  const requestId = sendOpenLog(
    dispatch,
    agentId,
    whole ? undefined : RECENT_TAIL,
  );
  ownOpens.set(agentId, { socketGen: lastSocketGen, requestId, whole });
}

/** Load the rest of a recent chat at once: the whole open_log (task 9ebe887d
 *  slice 3). It does nothing when the stream is complete, when a whole load
 *  is in flight, or on an older server (W2). A recent load in flight is
 *  replaced. The triggers: a scroll to the top, the top row, a jump to an
 *  entry that is not loaded, the Copy menu. An in-chat search, when one is
 *  added, calls this too. */
export function loadRestOfLog(
  dispatch: (action: Action) => void,
  agentId: string,
): void {
  if (!lastLogsOnOpen) return;
  const stream = lastStreams.get(agentId);
  if (stream?.state === "complete") return;
  if (stream?.state === "loading" && stream.tail === undefined) return;
  // Sent on this socket, and the store has not caught up yet.
  const own = ownOpens.get(agentId);
  if (
    own?.whole &&
    own.socketGen === lastSocketGen &&
    stream?.requestId !== own.requestId
  )
    return;
  sendOwnOpen(dispatch, agentId, true);
}

/** Load the agent's chat while the caller is mounted. Returns the stream's
 *  state, or null when there is no stream (no agent, or not asked yet). */
export function useAgentLog(agentId: string | null): LogStream["state"] | null {
  const { logStreams, logsOnOpen, logSocketGen, logsComplete } = useAppState();
  const dispatch = useDispatch();
  // A pack without logs would never hear its refusal (log_open_done is a
  // logs push): it asks for nothing.
  const canRead = useCan("logs", "read");
  const stream = agentId ? logStreams.get(agentId) : undefined;
  // After the cleanups of this commit: an unmount reads the commit before.
  useEffect(() => {
    lastStreams = logStreams;
    lastSocketGen = logSocketGen;
    lastLogsOnOpen = logsOnOpen;
  });

  useEffect(() => {
    if (!agentId) return;
    mounts.set(agentId, (mounts.get(agentId) ?? 0) + 1);
    return () => {
      const left = (mounts.get(agentId) ?? 1) - 1;
      if (left > 0) {
        mounts.set(agentId, left);
        return;
      }
      mounts.delete(agentId);
      // The last surface left while its own load runs: cancel it.
      const current = lastStreams.get(agentId);
      const mine = ownOpens.get(agentId);
      ownOpens.delete(agentId);
      if (
        current?.state === "loading" &&
        current.requestId === mine?.requestId
      ) {
        dispatch({
          type: "log_close_sent",
          agentId,
          requestId: current.requestId,
        });
        send({ type: "close_log", agentId, requestId: current.requestId });
      }
    };
  }, [agentId, dispatch]);

  const hasStream = stream !== undefined;
  const wasWhole = agentId ? logsComplete.has(agentId) : false;
  useEffect(() => {
    if (!agentId || !logsOnOpen || !canRead) return;
    // Lazy-loaded state stays as it is: a recent chat loads its rest only
    // when asked (loadRestOfLog).
    if (hasStream) return;
    const sent = ownOpens.get(agentId);
    // This socket already asked, and the store has not caught up.
    if (sent?.socketGen === logSocketGen) return;
    lastSocketGen = logSocketGen;
    sendOwnOpen(dispatch, agentId, wasWhole);
  }, [
    agentId,
    logsOnOpen,
    canRead,
    logSocketGen,
    hasStream,
    wasWhole,
    dispatch,
  ]);

  return stream?.state ?? null;
}

/** The agents some surface shows now (the mounted set), for a new socket's
 *  re-open and for the prefetch, which skips them. */
export function mountedLogAgents(): ReadonlySet<string> {
  return new Set(mounts.keys());
}

/** Whether a chat on screen has not sent its load on this socket yet: the
 *  prefetch waits for it. A load the server refused does not hold it. */
export function mountedLoadPending(
  streams: ReadonlyMap<string, LogStream>,
  socketGen: number,
): boolean {
  for (const agentId of mounts.keys())
    if (!streams.has(agentId) && ownOpens.get(agentId)?.socketGen !== socketGen)
      return true;
  return false;
}

export function resetAgentLogForTests(): void {
  lastStreams = new Map();
  mounts.clear();
  ownOpens.clear();
  lastSocketGen = 0;
  lastLogsOnOpen = false;
}
