// Back and Forward step between the office and a page the way they do on any
// site. What a restored page forgets is in ui/App.settings-section.dom.test.tsx;
// a page opened over a chat in ui/App.over-chat.dom.test.tsx; the pages' own
// paths in ui/App.pages.dom.test.tsx and
// ui/App.pages.cronjobs-settings.dom.test.tsx; arriving on
// a page path, including ruling 8's replace-instead-of-back, in
// ui/App.deeplink.dom.test.tsx; a cold link over a restored chat in
// ui/App.restored-chat.dom.test.tsx; and every other cold load in
// ui/App.boot.dom.test.tsx. One subject per file because each case renders a
// full page: measured 2026-09-05, a file of App renders runs 2.4-4.8 s for the
// same tests depending on what else the box is doing, and the 5 s cap is per
// file, so a file is split well before its number looks tight.
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
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

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
