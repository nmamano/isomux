// A cold load: arriving on a path that is no route, or ON a page path, and who
// owns the entry underneath it. The saved spot is in
// ui/App.saved-spot.dom.test.tsx, and a deployment with routing switched off
// in ui/App.no-routing.dom.test.tsx.
//
// The case that drives the design is ruling 8 in
// internal-docs/url-routing-loop.md: a shared /tasks link opened in a new tab
// is ONE history entry. Nothing synthetic is pushed underneath it, so the
// browser's Back leaves the site as it would anywhere else - but Close, Escape
// and the office button must still work, which they do by replacing that entry
// with the office instead of calling history.back(). The path table itself,
// aliases and trailing slashes included, is pinned in ui/routes.test.ts.

import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

// The settings and cronjobs pages fetch when they mount, and the settings
// detail pane reads `text` off /api/memory - a shim answering {} makes it throw.
setApiShim(async (_method, path) =>
  path.startsWith("/api/memory")
    ? { text: "", version: "0", size: 0, cap: 4000 }
    : {},
);
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** Load the app as if the browser had just arrived on `path`. */
function mountAt(path: string): View {
  window.history.replaceState(null, "", path);
  return render(createElement(App, {}));
}

const taskPageOpen = (view: View) =>
  view.queryByPlaceholderText(/Quick add a task/) !== null;
const automationsOpen = (view: View) =>
  view.container.querySelector("[data-schedules-tab]") !== null;
// The office is the only view that renders the nav bar.
const officeShowing = (view: View) => view.queryByTitle("Tasks (t)") !== null;

describe("a path that is not a route", () => {
  it("shows the office and normalises the address bar to /", () => {
    const view = mountAt("/garbage");

    expect(officeShowing(view)).toBe(true);
    expect(window.location.pathname).toBe("/");
  });
});

describe("a link straight to a page", () => {
  // An old alias, so one load proves both halves: the entry the load made is
  // adopted (no push), and it is rewritten in place to the canonical path.
  it("opens the page at its canonical path, without pushing an entry", () => {
    const pushState = spyOn(window.history, "pushState");
    const before = window.history.length;

    const view = mountAt("/cronjobs");

    expect(automationsOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/automations");
    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.length).toBe(before);
    pushState.mockRestore();
  });

  it("closes to the office in place", async () => {
    const view = mountAt("/tasks");
    const before = window.history.length;
    await act(async () => {
      view.getByText("←").click();
    });

    expect(taskPageOpen(view)).toBe(false);
    expect(officeShowing(view)).toBe(true);
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(before);
  });
});

describe("an entry this app did not push", () => {
  // Both cases keep the ownership ref honest. Ruling 8's promise that Close
  // works on a cold-loaded link depends on the app knowing it did not push the
  // entry it is sitting on.
  it("stays unpushed when a foreign entry sends us back to it", async () => {
    const view = mountAt("/tasks");
    // An extension or embedded widget can push its own entry above ours.
    window.history.pushState({ someoneElse: true }, "");

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(taskPageOpen(view)).toBe(true);

    await act(async () => {
      view.getByText("←").click();
    });
    // Marking the popped entry as ours would make Close call back() from the
    // bottom of the stack, which does nothing and strands the reader.
    expect(officeShowing(view)).toBe(true);
    expect(window.location.pathname).toBe("/");
  });

  it("falls back to the path when an owned entry names something unknown", async () => {
    const view = mountAt("/tasks");
    // An older or newer build can write a page name this build does not know.
    await act(async () => {
      window.dispatchEvent(
        new PopStateEvent("popstate", {
          state: { isomux: true, page: "nonsense" },
        }),
      );
    });

    expect(taskPageOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/tasks");
  });
});
