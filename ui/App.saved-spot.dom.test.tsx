// Reopening the spot a reload left: the saved panel opens on top of the office,
// so Back returns to it, and a page named in the URL beats the saved panel
// (ruling 4 of internal-docs/url-routing-loop.md) while the saved spot still
// supplies room and agent.
//
// Its own file because both cases mount the app twice over and the 5 s cap is
// per file; the unknown-path case is in ui/App.boot.dom.test.tsx.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { saveView } = await import("./view-persistence.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** Load the app as if the browser had just arrived on `path`. */
function mountAt(
  path: string,
  { state }: { state?: typeof initialState } = {},
): View {
  window.history.replaceState(null, "", path);
  const app = createElement(App, {});
  return state
    ? render(createElement(StateCtx.Provider, { value: state }, app))
    : render(app);
}

const taskPageOpen = (view: View) =>
  view.queryByPlaceholderText(/Quick add a task/) !== null;
// The office is the only view that renders the nav bar.
const officeShowing = (view: View) => view.queryByTitle("Tasks") !== null;

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
