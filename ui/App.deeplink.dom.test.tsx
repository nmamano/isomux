// Close and history-entry coverage live in sibling files so each real App file
// stays below half of the DOM per-file budget under load.
// Arriving ON a page path: a shared link, its aliases, and who owns the entry
// underneath it. Loads that arrive on "/" or on a path that is not a route are
// in ui/App.boot.dom.test.tsx.
//
// The case that drives the design is ruling 8 in
// internal-docs/url-routing-loop.md: a shared /tasks link opened in a new tab
// is ONE history entry. Nothing synthetic is pushed underneath it, so the
// browser's Back leaves the site as it would anywhere else - but Close, Escape
// and the office button must still work, which they do by replacing that entry
// with the office instead of calling history.back().

import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
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
const settingsOpen = (view: View) =>
  view.queryByText(/Select a setting from the list/) !== null;
describe("a link straight to a page", () => {
  it("opens the page and keeps its path, without pushing an entry", () => {
    const pushState = spyOn(window.history, "pushState");
    const before = window.history.length;

    const view = mountAt("/tasks");

    expect(taskPageOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/tasks");
    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.length).toBe(before);
    pushState.mockRestore();
  });

  it("canonicalises the /users alias to /settings", () => {
    const view = mountAt("/users");

    expect(settingsOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/settings");
  });

  it("tolerates a trailing slash", () => {
    const view = mountAt("/tasks/");

    expect(taskPageOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/tasks");
  });

});
