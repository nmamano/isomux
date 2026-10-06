// Shared mount for the room settings pane's "Your view" DOM tests (task
// 83d34b44). The store is the real reducer, so a record or room-list change
// reaches the pane the way the server's frames do. It imports ui/store.tsx,
// which touches the window at module scope: load it with `await import(...)`
// after setUpDomTestFile().

import { act, fireEvent, render } from "@testing-library/react";
import { createElement, useEffect, useReducer } from "react";
import { RoomPane } from "../components/RoomPane.tsx";
import { StateCtx, reducer, type AppState } from "../store.tsx";
import { LanguageProvider } from "../i18n.tsx";
import { selfUserRecord, stateWithSelfUser } from "./language-fixture.tsx";
import { setApiShim } from "../api.ts";
import type { RoomWire, UserRecord } from "../../shared/types.ts";

type Action = Parameters<typeof reducer>[1];

export const room = (id: string, extra: Partial<RoomWire> = {}): RoomWire => ({
  id,
  name: id,
  type: "office",
  prompt: null,
  canCloseWhenEmpty: false,
  ...extra,
});
export const WARD = room("ward");
export const OTHER = room("other");
export const LOBBY = room("lobby", { type: "lobby" });

export type Call = { method: string; path: string; body: unknown };
export const calls: Call[] = [];
// Per-test hook on each request, after it is logged: may dispatch, throw to
// fail that request, or return a promise to hold its response (see hold()).
let onCall: (c: Call) => unknown = () => undefined;
export function setOnCall(fn: (c: Call) => unknown) {
  onCall = fn;
}
let dispatch: (a: Action) => void = () => {};
export function dispatchToStore(a: Action) {
  dispatch(a);
}

export function installApiShim() {
  setApiShim(async (method, path, body) => {
    const c = { method, path, body };
    calls.push(c);
    const answer = await onCall(c);
    if (answer !== undefined) return answer;
    if (path.endsWith("/settings")) return { prompt: "", version: "0" };
    if (path.startsWith("/api/memory"))
      return { text: "", version: "0", size: 0, cap: 4000 };
    if (path === "/api/me/rooms")
      return {
        rooms: [WARD, OTHER, room("granted")].map(({ id, name }) => ({
          id,
          name,
        })),
      };
    return undefined;
  });
}

export function resetCalls() {
  calls.length = 0;
  onCall = () => undefined;
}

export const viewWrites = () =>
  calls
    .filter((c) => c.path.startsWith("/api/me/"))
    .map((c) => `${c.method} ${c.path}`);
export const bodyOf = (path: string) =>
  calls.find((c) => c.method === "PUT" && c.path === path)?.body;

// A response the test releases by hand, so a step can land between a request
// and its response without betting on timers.
export function hold() {
  let release: () => void = () => {};
  const response = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  return { response, release };
}

// One act() that also lets queued timers run inside it. The pane's
// unsaved-changes prompt closes on a 0 ms timer when the form turns clean,
// and that state update must not land after the test.
const settleRound = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

// Flush React until `done` holds, then one more round for what the last
// commit queued.
export async function settleUntil(done: () => boolean, rounds = 50) {
  for (let i = 0; i < rounds; i++) {
    if (done()) {
      await settleRound();
      return;
    }
    await settleRound();
  }
  throw new Error("settleUntil: condition never held");
}

// The store as of the last commit whose effects have run. RoomPane's effects
// run before this parent's, so a record seen here has reached the pane's ref.
let committed: AppState | null = null;
export const committedSelf = () =>
  [...(committed?.users.values() ?? [])].find((u) => u.id === record.id);

let record: UserRecord;
export function setRecord(over: Partial<UserRecord>) {
  record = { ...record, ...over };
  dispatch({ type: "user_self_updated", user: record });
}

function Harness({
  rooms,
  roomId,
  onDeleted,
}: {
  rooms: RoomWire[];
  roomId: string;
  onDeleted: () => void;
}) {
  const [state, d] = useReducer(
    reducer,
    stateWithSelfUser(null, {
      rooms,
      users: new Map([[record.name.toLowerCase(), record]]),
    }),
  );
  useEffect(() => {
    dispatch = d;
  }, [d]);
  useEffect(() => {
    committed = state;
  }, [state]);
  return createElement(
    StateCtx.Provider,
    { value: state },
    createElement(
      LanguageProvider,
      null,
      createElement(RoomPane, { roomId, onDeleted }),
    ),
  );
}

export async function mount(
  over: Partial<UserRecord>,
  { rooms = [WARD, OTHER], roomId = "ward" } = {},
) {
  record = { ...selfUserRecord(null), ...over };
  let deleted = 0;
  const view = render(
    createElement(Harness, { rooms, roomId, onDeleted: () => deleted++ }),
  );
  await act(async () => {}); // settings GET lands; Save enables
  return { view, deletedCount: () => deleted };
}

export type View = Awaited<ReturnType<typeof mount>>["view"];
export const box = (view: View, key: string) =>
  view.container.querySelector<HTMLInputElement>(`[data-view-choice="${key}"]`);
export async function click(view: View, key: string) {
  await act(async () => fireEvent.click(box(view, key)!));
}
// Save is the last button in the pane's footer.
const saveButton = (view: View): HTMLButtonElement | undefined => {
  const buttons = view.container.querySelectorAll("button");
  return buttons[buttons.length - 1];
};
// The save has run to its end: Save is disabled while one is in flight, and
// a hide that landed takes the whole pane, Save included.
export const saveIdle = (view: View) => !saveButton(view)?.disabled;
// Click Save and leave it running, for a test that holds a response.
export async function startSave(view: View) {
  await act(async () => fireEvent.click(saveButton(view)!));
}
// Click Save and flush until the whole save has run, so none of its state
// updates land after the test.
export async function save(view: View) {
  await startSave(view);
  await settleUntil(() => saveIdle(view));
}
