// One chat's log, loaded when a surface shows it (task 9ebe887d slice 2).
// LogView (the focused chat), AgentChatPanel and AppWidgetPage call
// useAgentLog for the agent they render. It is ref-counted per agent: the
// first mount sends open_log (the whole log) unless the stream is complete or
// a whole load is in flight; the last unmount while that load is in flight
// sends close_log. After a complete load the subscription stays, so live
// entries keep the stored log fresh and a reopen sends nothing.
//
// Only when the server's last full_state said logsOnOpen (W2): an older
// server keeps the connect replay, and nothing is sent.

import { useEffect } from "react";
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
// The whole open this tab sent per agent on the current socket, so two
// surfaces that mount in one commit send one (the store has not seen the
// first dispatch yet when the second effect runs).
const wholeOpens = new Map<string, { socketGen: number; requestId: string }>();
let counter = 0;
// The store's streams as of the last render of any useAgentLog: an unmount
// reads the agent it leaves, after the render that switched to another one.
let lastStreams: ReadonlyMap<string, LogStream> = new Map();

/** A request id unique in this tab. */
export function newLogRequestId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Send open_log and tell the store (the prefetch uses it too). */
export function sendOpenLog(
  dispatch: (action: Action) => void,
  agentId: string,
  tail?: number,
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
  });
  return requestId;
}

/** Load the agent's chat while the caller is mounted. Returns the stream's
 *  state, or null when there is no stream (no agent, or not asked yet). */
export function useAgentLog(agentId: string | null): LogStream["state"] | null {
  const { logStreams, logsOnOpen, logSocketGen } = useAppState();
  const dispatch = useDispatch();
  // A pack without logs would never hear its refusal (log_open_done is a
  // logs push): it asks for nothing.
  const canRead = useCan("logs", "read");
  const stream = agentId ? logStreams.get(agentId) : undefined;
  // After the cleanups of this commit: an unmount reads the commit before.
  useEffect(() => {
    lastStreams = logStreams;
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
      // The last surface left while its whole load runs: cancel it.
      const current = lastStreams.get(agentId);
      const mine = wholeOpens.get(agentId);
      wholeOpens.delete(agentId);
      if (
        current?.state === "loading" &&
        current.tail === undefined &&
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

  const streamState = stream?.state;
  const streamTail = stream?.tail;
  useEffect(() => {
    if (!agentId || !logsOnOpen || !canRead) return;
    if (streamState === "complete") return;
    if (streamState === "loading" && streamTail === undefined) return;
    const sent = wholeOpens.get(agentId);
    // This socket already asked, and the store has not caught up.
    if (sent?.socketGen === logSocketGen && streamState === undefined) return;
    const requestId = sendOpenLog(dispatch, agentId);
    wholeOpens.set(agentId, { socketGen: logSocketGen, requestId });
  }, [
    agentId,
    logsOnOpen,
    canRead,
    logSocketGen,
    streamState,
    streamTail,
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
    if (
      !streams.has(agentId) &&
      wholeOpens.get(agentId)?.socketGen !== socketGen
    )
      return true;
  return false;
}

export function resetAgentLogForTests(): void {
  lastStreams = new Map();
  mounts.clear();
  wholeOpens.clear();
}
