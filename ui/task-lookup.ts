// The tasks the summary board leaves out (task 9ebe887d). A socket that asks
// for the summary board (TASKS_SUMMARY_WS_PARAM) gets open and in-progress
// tasks with no description; this module fetches the rest over GET /api/tasks
// and hands each result to the store as tasks_fetched:
// - "open": the descriptions of the summary rows (the Tasks view, on open);
// - "closed": every done and obsolete task (a closed status checked, or a
//   search);
// - ids: the tasks that chat text names (task chips), in batches.
// The fetch state is per epoch (tasksEpoch) and lives here, not in a
// component, so a remount never sends a second request for the same epoch.

import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import { MAX_TASK_IDS_PER_LOOKUP } from "../shared/task-board.ts";
import type { TaskItem } from "../shared/types.ts";
import { apiFetch } from "./api.ts";
import { useCan } from "./hooks/useCan.ts";
import { useAppState, useDispatch, type Action } from "./store.tsx";

export type TaskFetchKind = "open" | "closed";

// "failed" counts as idle: the next start (a retry, a remount) sends again.
export type TaskFetchState = "idle" | "in_flight" | "done" | "failed";

// The store as of the bridge's last commit. A delta dispatched since then
// makes seq lower than the store's, which only makes that delta win.
interface Snapshot {
  dispatch: Dispatch<Action>;
  canRead: boolean;
  epoch: number;
  seq: number;
  tasksLoaded: boolean;
  closedTasksLoaded: boolean;
  summaryTaskIds: ReadonlySet<string>;
  tasks: readonly TaskItem[];
  held: ReadonlySet<string>;
}

let snap: Snapshot | null = null;
// The bridge that writes snap: the last one mounted. An older tree that is
// still mounted (a test file's App left behind) must not write its store in.
let owner: object | null = null;
// The epoch the caches below belong to.
let cacheEpoch: number | null = null;
const fetches: Record<TaskFetchKind, TaskFetchState> = {
  open: "idle",
  closed: "idle",
};
// Ids a lookup of this epoch found as tasks, or as no task the member sees.
const found = new Set<string>();
const misses = new Set<string>();
const asking = new Set<string>();
// Ids waiting for the next send (or for the first tasks frame).
const queued = new Set<string>();
let flushQueued = false;
// Callers waiting to hear which of their ids are no task (the ask lookup).
// Told as soon as a read settles, not on the next render.
const missWaiters: { ids: Set<string>; onMiss: (ids: string[]) => void }[] = [];
// The epoch before the first tasks frame, once that frame came. A chip can
// look up ids before the frame (an ask card drawn first); those answers stay
// good for the first frame's epoch, so they are not asked again.
let preFrameEpoch: number | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function enterEpoch(epoch: number, fromPreFrame: boolean) {
  preFrameEpoch = fromPreFrame ? cacheEpoch : null;
  cacheEpoch = epoch;
  fetches.open = "idle";
  fetches.closed = "idle";
  if (!fromPreFrame) {
    found.clear();
    misses.clear();
    asking.clear();
    missWaiters.length = 0;
  }
  notify();
}

// The epoch a lookup's answer belongs to now: its own, or the first frame's
// when it was asked before that frame.
function answerEpoch(asked: number): number {
  return asked === preFrameEpoch && cacheEpoch !== null ? cacheEpoch : asked;
}

/** Mounted once inside the StoreProvider (App): gives this module the store's
 *  dispatch, the epoch and delta seq of the moment, and whether the member may
 *  read tasks. With no bridge, nothing is fetched. */
export function TaskLookupBridge(): ReactNode {
  const state = useAppState();
  const dispatch = useDispatch();
  const canRead = useCan("tasks", "read");
  const [token] = useState(() => ({}));
  useLayoutEffect(() => {
    owner = token;
    return () => {
      if (owner !== token) return;
      owner = null;
      snap = null;
    };
  }, [token]);
  // A layout effect, so the snapshot is fresh before any passive effect of
  // the same commit starts a fetch.
  useLayoutEffect(() => {
    if (owner !== token) return;
    const fromPreFrame =
      cacheEpoch !== null && snap !== null && !snap.tasksLoaded;
    const held =
      snap && snap.tasks === state.tasks
        ? snap.held
        : new Set(state.tasks.map((t) => t.id));
    snap = {
      dispatch,
      canRead,
      epoch: state.tasksEpoch,
      seq: state.taskDeltaSeq,
      tasksLoaded: state.tasksLoaded,
      closedTasksLoaded: state.closedTasksLoaded,
      summaryTaskIds: state.summaryTaskIds,
      tasks: state.tasks,
      held,
    };
    if (cacheEpoch !== state.tasksEpoch)
      enterEpoch(state.tasksEpoch, fromPreFrame && state.tasksLoaded);
    if (queued.size > 0) scheduleFlush();
  });
  return null;
}

/** The state of one fetch kind in the current epoch. */
export function taskFetchState(kind: TaskFetchKind): TaskFetchState {
  return fetches[kind];
}

/** Start one fetch kind for the current epoch, unless it is in flight or done. */
export function startTaskFetch(kind: TaskFetchKind): void {
  const s = snap;
  if (!s || !s.canRead || !s.tasksLoaded) return;
  if (fetches[kind] === "in_flight" || fetches[kind] === "done") return;
  let path: string;
  if (kind === "open") {
    const ids = [...s.summaryTaskIds];
    if (ids.length === 0) {
      fetches.open = "done";
      notify();
      return;
    }
    path =
      ids.length <= MAX_TASK_IDS_PER_LOOKUP
        ? `/api/tasks?ids=${ids.join(",")}`
        : "/api/tasks?status=open,in_progress";
  } else {
    if (s.closedTasksLoaded) {
      fetches.closed = "done";
      notify();
      return;
    }
    path = "/api/tasks?status=done,obsolete";
  }
  const { epoch, seq, dispatch } = s;
  fetches[kind] = "in_flight";
  notify();
  apiFetch<TaskItem[]>("GET", path).then(
    (tasks) => {
      dispatch({
        type: "tasks_fetched",
        tasks,
        epoch,
        seqAtRequest: seq,
        ...(kind === "closed" ? { closed: true as const } : {}),
      });
      if (cacheEpoch !== epoch) return;
      fetches[kind] = "done";
      notify();
    },
    () => {
      if (cacheEpoch !== epoch) return;
      fetches[kind] = "failed";
      notify();
    },
  );
}

/** Start the fetch while `wanted`, and re-render on each change of its state. */
export function useTaskFetch(
  kind: TaskFetchKind,
  wanted: boolean,
): { state: TaskFetchState; retry: () => void } {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const { tasksEpoch } = useAppState();
  useEffect(() => subscribeTaskLookup(rerender), []);
  useEffect(() => {
    if (wanted) startTaskFetch(kind);
  }, [kind, wanted, tasksEpoch]);
  return { state: fetches[kind], retry: () => startTaskFetch(kind) };
}

// A microtask: the chips of one commit look up their ids in its effects, so
// they share one read.
function scheduleFlush() {
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    flush();
  });
}

function serveWaiters() {
  for (let i = missWaiters.length - 1; i >= 0; i--) {
    const waiter = missWaiters[i];
    const missed: string[] = [];
    for (const id of waiter.ids) {
      const result = taskLookupResult(id);
      if (result === undefined) continue;
      waiter.ids.delete(id);
      if (result === "miss") missed.push(id);
    }
    if (waiter.ids.size === 0) missWaiters.splice(i, 1);
    if (missed.length > 0) waiter.onMiss(missed);
  }
}

function flush() {
  const s = snap;
  if (!s) return;
  const ask: string[] = [];
  let changed = false;
  for (const id of queued) {
    if (s.held.has(id) || found.has(id) || misses.has(id) || asking.has(id))
      continue;
    // The whole board is in the store: an id it lacks is no task.
    if (!s.canRead || (s.tasksLoaded && s.closedTasksLoaded)) {
      misses.add(id);
      changed = true;
    } else ask.push(id);
  }
  queued.clear();
  const { epoch, seq, dispatch } = s;
  for (let i = 0; i < ask.length; i += MAX_TASK_IDS_PER_LOOKUP) {
    const batch = ask.slice(i, i + MAX_TASK_IDS_PER_LOOKUP);
    for (const id of batch) asking.add(id);
    apiFetch<TaskItem[]>("GET", `/api/tasks?ids=${batch.join(",")}`)
      .then(
        (tasks) => {
          const at = answerEpoch(epoch);
          dispatch({
            type: "tasks_fetched",
            tasks,
            epoch: at,
            seqAtRequest: seq,
          });
          if (cacheEpoch !== at) return;
          const got = new Set(tasks.map((t) => t.id));
          for (const id of batch) (got.has(id) ? found : misses).add(id);
        },
        // A failed read (a 403 included) is a miss: the id may be an ask.
        () => {
          if (cacheEpoch !== answerEpoch(epoch)) return;
          for (const id of batch) misses.add(id);
        },
      )
      .finally(() => {
        if (cacheEpoch !== answerEpoch(epoch)) return;
        for (const id of batch) asking.delete(id);
        serveWaiters();
        notify();
      });
  }
  // Only a change is told: a reader that asks again for an id in flight
  // re-renders on the notice, and would ask again.
  if (changed || ask.length > 0) {
    serveWaiters();
    notify();
  }
}

/** Look up ids the store does not hold, in batches of at most
 *  MAX_TASK_IDS_PER_LOOKUP. Each id is asked once per epoch. onMiss hears
 *  the ids that are no task the member can see, once each. */
export function lookUpTaskIds(
  ids: readonly string[],
  onMiss?: (ids: string[]) => void,
): void {
  if (ids.length === 0) return;
  for (const id of ids) queued.add(id);
  if (onMiss) {
    // One waiter per callback: a chat that re-renders while a read is in
    // flight asks for the same ids again.
    const waiter = missWaiters.find((w) => w.onMiss === onMiss);
    if (waiter) for (const id of ids) waiter.ids.add(id);
    else missWaiters.push({ ids: new Set(ids), onMiss });
  }
  scheduleFlush();
}

/** What the lookup found for an id in this epoch: a task, a miss (no task the
 *  member can see, so the id may be an ask), or undefined while not known. */
export function taskLookupResult(id: string): "task" | "miss" | undefined {
  const s = snap;
  // No bridge, or no tasks read: chat ids go to the ask lookup as before.
  if (!s || !s.canRead) return "miss";
  if (s.held.has(id) || found.has(id)) return "task";
  if (misses.has(id)) return "miss";
  if (s.tasksLoaded && s.closedTasksLoaded) return "miss";
  return undefined;
}

/** Called when a lookup or a fetch settles. */
export function subscribeTaskLookup(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetTaskLookupForTests(): void {
  snap = null;
  owner = null;
  cacheEpoch = null;
  preFrameEpoch = null;
  fetches.open = "idle";
  fetches.closed = "idle";
  found.clear();
  misses.clear();
  asking.clear();
  queued.clear();
  missWaiters.length = 0;
  flushQueued = false;
}
