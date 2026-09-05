// App's history wiring: Back and Forward step between the office and a page the
// way they do on any site, and a page opened over a chat comes back to that
// chat. The four pages' own paths are in ui/App.pages.dom.test.tsx; arriving on
// a page path, including ruling 8's replace-instead-of-back, in
// ui/App.deeplink.dom.test.tsx; and every other cold load in
// ui/App.boot.dom.test.tsx. Four files rather than one because each case
// renders a full page: measured 2026-09-05, a file of App renders runs 2.4-4.8
// s for the same tests depending on what else the box is doing, and the 5 s cap
// is per file.
//
// App mounts bare on purpose. StateCtx, DispatchCtx and FeaturesCtx all carry
// defaults (ui/store.tsx), and it is StoreProvider - not App - that opens the
// websocket, so this needs no provider tree and no fake store. With the default
// state, sessionContext is null, which parks the view-persistence effect and
// the language seed before either touches localStorage.
//
// The API shim is not optional: the settings page fetches when it mounts, and
// without it happy-dom's fetch opens real sockets to localhost (observed as
// ECONNREFUSED noise, and worse on a box with something listening on port 80).
//
// history.back() and forward() are the real thing: happy-dom moves the URL and
// fires popstate with the entry's state, so these tests exercise the same path
// a browser button does rather than a hand-dispatched event.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");
type AgentInfo = import("../shared/types.ts").AgentInfo;

type View = ReturnType<typeof render>;

setApiShim(async () => ({}));
// The shim is a module singleton and outlives this file's DOM, so it has to be
// handed back explicitly.
afterAll(() => setApiShim(null));

// The spy is what proves App pushed the entry; history.length only shows that
// something did. spyOn calls through, so the entry is really created.
function spyOnPushState() {
  return spyOn(window.history, "pushState");
}

let pushState: ReturnType<typeof spyOnPushState>;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  pushState = spyOnPushState();
});

afterEach(() => {
  pushState.mockRestore();
});

async function press(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}

async function go(move: "back" | "forward"): Promise<void> {
  await act(async () => {
    window.history[move]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const taskPageOpen = (view: View) =>
  view.queryByPlaceholderText(/Quick add a task/) !== null;

describe("back and forward", () => {
  it("forgets which settings row was open when the page is restored", async () => {
    const view = render(createElement(App));

    // The theme button is one of the doors that opens Settings ON a row.
    await act(async () => {
      view.getByTitle("Change theme").click();
    });
    expect(window.location.pathname).toBe("/settings");
    expect(view.queryByText(/Select a setting from the list/)).toBeNull();

    await go("back");
    await go("forward");

    // Sections are not routes (ruling 3), so the entry names the page and
    // nothing else. Restoring it lands on the generic page rather than
    // resurrecting the row from the visit before.
    expect(window.location.pathname).toBe("/settings");
    expect(view.queryByText(/Select a setting from the list/)).not.toBeNull();
  });

  it("returns to the office at / and then reopens the page", async () => {
    const view = render(createElement(App));
    await press("t");
    expect(taskPageOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/tasks");

    await go("back");

    expect(taskPageOpen(view)).toBe(false);
    expect(window.location.pathname).toBe("/");

    await go("forward");

    expect(taskPageOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/tasks");
  });
});

describe("a page opened over a chat", () => {
  // Agent chats are not routes (ruling 3), so a chat is "/" like the office.
  // Back out of tasks-over-a-chat lands on the chat - the one case where a page
  // closes without the office coming back.
  const AGENT = {
    id: "a1",
    name: "Tester",
    desk: 0,
    roomId: "r1",
    cwd: "~",
    state: "idle",
    agentType: "claude",
    modelFamily: "opus",
    topic: null,
    outfit: {
      color: "#4A90D9",
      hair: "#222",
      hairStyle: "short",
      skin: "#FFD5B8",
      beard: "none",
      accessory: "none",
      hat: "none",
    },
  } as unknown as AgentInfo;

  // DispatchCtx is not exported, so this fixture cannot change focus. That is
  // why it covers tasks-over-chat only, and not a plain chat clearing focus.
  const WITH_CHAT = {
    ...initialState,
    agents: [AGENT],
    focusedAgentId: "a1",
    currentRoomId: "r1",
    rooms: [{ id: "r1", name: "Room" }],
  } as unknown as typeof initialState;

  it("lands back on the chat at /", async () => {
    const view = render(
      createElement(
        StateCtx.Provider,
        { value: WITH_CHAT },
        createElement(App),
      ),
    );
    expect(window.location.pathname).toBe("/");

    // The chat pushed the only entry. Opening a page on top of it is a
    // deep-to-deep move, so ruling 5's one-entry-per-page-change means the
    // path changes by replacement, not by a second push.
    expect(pushState).toHaveBeenCalledTimes(1);

    await press("t");
    expect(taskPageOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/tasks");
    expect(pushState).toHaveBeenCalledTimes(1);

    await go("back");

    expect(taskPageOpen(view)).toBe(false);
    expect(window.location.pathname).toBe("/");
  });
});
