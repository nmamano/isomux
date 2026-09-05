// Loads that do not arrive on a page path: the office, a path that is no route
// at all, the saved spot, and a deployment that has no routing. Arriving ON a
// page path is in ui/App.deeplink.dom.test.tsx.

import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { saveView } = await import("./view-persistence.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

// The settings and cronjobs pages fetch when they mount; without the shim
// happy-dom opens real sockets to localhost.
setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** Load the app as if the browser had just arrived on `path`. */
function mountAt(
  path: string,
  { state, routing }: { state?: typeof initialState; routing?: boolean } = {},
): View {
  window.history.replaceState(null, "", path);
  const app = createElement(App, { routing });
  return state
    ? render(createElement(StateCtx.Provider, { value: state }, app))
    : render(app);
}

const taskPageOpen = (view: View) =>
  view.queryByPlaceholderText(/Quick add a task/) !== null;
// The office is the only view that renders the nav bar.
const officeShowing = (view: View) => view.queryByTitle("Tasks") !== null;

describe("deployed without routing", () => {
  // The landing demo serves this same App under /demo (ui/demo-entry.tsx),
  // where a real path would name a public URL that does not exist. Routing is
  // an input rather than something App infers, so these mount at /demo AND
  // pass routing={false}, which is exactly what the demo entry does.
  it("leaves the address bar alone instead of normalising it", () => {
    const view = mountAt("/demo", { routing: false });

    expect(officeShowing(view)).toBe(true);
    expect(window.location.pathname).toBe("/demo");
  });

  it("still opens a page, still on one entry, without writing a path", async () => {
    const view = mountAt("/demo", { routing: false });
    const pushState = spyOn(window.history, "pushState");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
    });

    expect(taskPageOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/demo");
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(pushState.mock.calls[0]).toEqual([
      { isomux: true, page: "tasks" },
      "",
    ]);
    pushState.mockRestore();
  });
});

describe("a path that is not a route", () => {
  it("shows the office and normalises the address bar to /", () => {
    const view = mountAt("/garbage");

    expect(officeShowing(view)).toBe(true);
    expect(window.location.pathname).toBe("/");
  });
});

describe("the saved spot on /", () => {
  // The restore only runs for a signed-in session that has received its first
  // full_state, so this is the one boot case that needs a state fixture.
  const RESTORED = {
    ...initialState,
    hasReceivedInitialState: true,
    sessionContext: { username: "ricky", userId: "u1" },
  } as unknown as typeof initialState;

  it("reopens the saved page on top of the office, so Back returns to it", async () => {
    saveView("ricky", { roomId: null, agentId: null, panel: "tasks" });

    const view = mountAt("/", { state: RESTORED });

    expect(taskPageOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/tasks");

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(taskPageOpen(view)).toBe(false);
    expect(officeShowing(view)).toBe(true);
    expect(window.location.pathname).toBe("/");
  });

  it("lets a page in the URL win over the saved panel", () => {
    saveView("ricky", { roomId: null, agentId: null, panel: "apps" });

    const view = mountAt("/tasks", { state: RESTORED });

    expect(taskPageOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/tasks");
  });
});
