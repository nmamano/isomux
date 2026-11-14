// One load frame by frame (task 4843a124): an elevator ride lands in the lobby
// and never shows a room first, and a normal load over a saved room never
// shows the lobby. While the office state loads, the lobby's controls are
// inert. The first frame's view for each kind of load is in
// ui/store.first-view.dom.test.tsx; each App load here costs about a second
// of the file's 5 s cap.
//
// The real store over the WS shim: StoreProvider takes the ride the way
// ui/index.tsx hands it over, and each server message arrives on its own, so
// the test sees the frames between them.

import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("./App.tsx");
const { StoreProvider } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { setShim, shimEmit } = await import("./ws.ts");
const { saveView, loadSavedView } = await import("./view-persistence.ts");

type View = ReturnType<typeof render>;

setApiShim(async (_method, path) =>
  path.startsWith("/api/members-chat")
    ? { messages: [], hasMore: false, readPointer: null, unread: 0 }
    : {},
);

afterAll(() => {
  setApiShim(null);
  setShim(
    () => {},
    () => {},
  );
});

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

const AGENT = {
  id: "a1",
  name: "Tester",
  desk: 0,
  roomId: "r2",
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  effort: "medium",
  topic: null,
  topicState: null,
  customInstructions: null,
  customInstructionsVersion: "0",
  permissionMode: "default",
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
};
const ROOMS = [
  { id: "r1", name: "First room", prompt: null, canCloseWhenEmpty: true },
  { id: "r2", name: "Saved room", prompt: null, canCloseWhenEmpty: true },
];

// The lobby's own props layer: only the lobby scene draws it.
const lobbyProps = (view: View) =>
  view.container.querySelector("#lobby-fire-glow")?.closest("svg") ?? null;
// The window in a room's back wall: only a room draws it.
const roomDrawn = (view: View) =>
  view.container.querySelector("#window-clip") !== null;
const chatShowing = (view: View) =>
  view.container.querySelector(".log-view-shell") !== null;
const taskPageOpen = (view: View) =>
  view.queryByPlaceholderText(/Quick add a task/) !== null;
const elevatorDialogOpen = (view: View) =>
  view.baseElement.querySelector(
    '[role="dialog"][aria-labelledby="elevator-title"]',
  ) !== null;
// The drawn elevator, with or without a handler on it.
const elevator = (view: View) =>
  view.container.querySelector("#lobby-elevator-steel")?.closest("g") ?? null;
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

// What a frame shows: which scene, and the lobby scene's controls. The parent
// of the props layer holds the walls, the props and the keyboard controls.
function frame(view: View) {
  const props = lobbyProps(view);
  const root = props?.parentElement ?? null;
  const count = (selector: string) =>
    root ? root.querySelectorAll(selector).length : 0;
  return {
    lobby: props !== null,
    room: roomDrawn(view),
    elevatorDrawn: elevator(view) !== null,
    keyboard: count(
      '[data-lobby-control], [role="button"], a[href], [tabindex]',
    ),
    pointer: root
      ? [...root.querySelectorAll<HTMLElement>("*")].filter(
          (el) => el.style.cursor === "pointer",
        ).length
      : 0,
  };
}
type Frame = ReturnType<typeof frame>;

// The frames of one load: the first render, then session_context, then
// full_state, each on its own. `before` runs on the first frame, before any
// server message.
async function load(ride: boolean, before?: (view: View) => Promise<void>) {
  setShim(
    () => {},
    () => {},
  );
  const view = render(
    createElement(StoreProvider, { ride, children: createElement(App, {}) }),
  );
  const frames: Frame[] = [frame(view)];
  if (before) await before(view);
  await act(async () => {
    shimEmit({
      type: "session_context",
      context: { username: "member", userId: "u1", role: "member" },
    } as never);
  });
  frames.push(frame(view));
  await act(async () => {
    shimEmit({
      type: "full_state",
      agents: [AGENT],
      rooms: ROOMS,
      office: { name: "Test Office" },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
    } as never);
  });
  frames.push(frame(view));
  return { view, frames };
}

const INERT = { keyboard: 0, pointer: 0 };

it("lands a ride in the lobby with inert controls until full_state, the saved room behind it and no saved chat or page", async () => {
  saveView("member", {
    roomId: "r2",
    agentId: "a1",
    panel: "tasks",
    lobby: false,
  });
  let clickedEarly = true;
  const { view, frames } = await load(true, async (v) => {
    const drawn = elevator(v);
    if (drawn) await click(drawn);
    clickedEarly = elevatorDialogOpen(v);
  });
  const [first, signedIn, loaded] = frames;
  // The lobby from the first frame, the elevator drawn, and no prop a control.
  for (const f of [first, signedIn]) {
    expect(f).toMatchObject({ lobby: true, room: false, elevatorDrawn: true });
    expect(f).toMatchObject(INERT);
  }
  expect(clickedEarly).toBe(false);
  // Loaded: still the lobby, and the same scene's controls are live.
  expect(loaded).toMatchObject({ lobby: true, room: false });
  expect(loaded.keyboard).toBeGreaterThan(0);
  expect(loaded.pointer).toBeGreaterThan(0);
  await click(elevator(view)!);
  expect(elevatorDialogOpen(view)).toBe(true);
  // The saved chat and page stay shut. The save effect writes the restored
  // spot: the saved room is the current room under the open lobby.
  expect(chatShowing(view)).toBe(false);
  expect(taskPageOpen(view)).toBe(false);
  expect(loadSavedView("member")).toMatchObject({
    roomId: "r2",
    agentId: null,
    panel: null,
    lobby: true,
  });
});

// The saved chat a normal load reopens is ui/App.restored-chat.dom.test.tsx's.
it("keeps a normal load over a saved room in that room from the first frame", async () => {
  saveView("member", {
    roomId: "r2",
    agentId: null,
    panel: null,
    lobby: false,
  });
  const { frames } = await load(false);
  for (const f of frames) {
    expect(f).toMatchObject({ lobby: false, room: true });
  }
  expect(document.title).toBe("Saved room | Isomux");
});
