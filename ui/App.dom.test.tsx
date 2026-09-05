// App's history behaviour as it stands today, pinned before the URL-routing
// work changes it (internal-docs/url-routing-loop.md). Two of these assertions
// are baselines S2 is expected to flip; the one that must survive is the shape
// - one history entry per page, and Back returns where the user came from.
//
// App mounts bare on purpose. StateCtx, DispatchCtx and FeaturesCtx all carry
// defaults (ui/store.tsx), and it is StoreProvider - not App - that opens the
// websocket, so this needs no provider tree and no fake store. With the default
// state, sessionContext is null, which parks the view-persistence effect and
// the language seed before either touches localStorage or the network.
//
// The task page is opened with the "t" shortcut rather than by clicking through
// OfficeView: the shortcut is App's own key handler, so the test states what it
// means (open a page) instead of depending on the office's layout.

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");

type View = ReturnType<typeof render>;

// The spy is what proves App pushed the entry; history.length only shows that
// something did. spyOn calls through, so the entry is really created.
function spyOnPushState() {
  return spyOn(window.history, "pushState");
}

let pushState: ReturnType<typeof spyOnPushState>;

beforeEach(() => {
  pushState = spyOnPushState();
});

afterEach(() => {
  pushState.mockRestore();
});

/** TaskView's quick-add field: present exactly when the task page is open. */
function taskPageOpen(view: View): boolean {
  return view.queryByPlaceholderText(/Quick add a task/) !== null;
}

async function press(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}

async function popState(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  });
}

describe("App history", () => {
  it("opens the task page on a page shortcut and pushes one history entry", async () => {
    const view = render(<App />);
    const before = window.history.length;
    expect(taskPageOpen(view)).toBe(false);

    await press("t");

    expect(taskPageOpen(view)).toBe(true);
    // Today's call, argument for argument: one entry, a marker state, and no
    // path. S2 replaces the third argument with "/tasks".
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(pushState.mock.calls[0]).toEqual([{ isomux: true }, ""]);
    expect(window.history.length).toBe(before + 1);
  });

  it("leaves the URL at the office while a page is open", async () => {
    const view = render(<App />);

    await press("t");

    // The pushed entry carries no path, so the address bar never leaves the
    // office. This is the line S2 changes - the task page becomes /tasks.
    expect(taskPageOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/");
  });

  it("closes the page on popstate", async () => {
    const view = render(<App />);
    await press("t");
    expect(taskPageOpen(view)).toBe(true);

    await popState();

    expect(taskPageOpen(view)).toBe(false);
  });
});
