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
const settingsOpen = (view: View) =>
  view.queryByText(/Select a setting from the list/) !== null;
// The office is the only view that renders the nav bar.
const officeShowing = (view: View) => view.queryByTitle("Tasks") !== null;

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

  it("closes back to the office in place, leaving history the same length", async () => {
    const view = mountAt("/tasks");
    const before = window.history.length;

    // The task page's own Close control, not a keyboard shortcut: it is the
    // one a reader of a shared link actually reaches for.
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
  // Both cases below are about the ownership ref staying honest. They matter
  // because ruling 8's whole promise - Close works on a cold-loaded link -
  // rests on the app knowing it never pushed the entry it is sitting on.

  it("stays unpushed when a foreign entry sends us back to it", async () => {
    const view = mountAt("/tasks");
    // Something else on the page - an extension, an embedded widget - pushes
    // its own entry. Ours is still the bottom one, and still unpushed.
    window.history.pushState({ someoneElse: true }, "");

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(taskPageOpen(view)).toBe(true);

    await act(async () => {
      view.getByText("←").click();
    });

    // If that popstate had marked the entry pushed, Close would call back(),
    // which from the bottom of the stack does nothing and strands the reader.
    expect(officeShowing(view)).toBe(true);
    expect(window.location.pathname).toBe("/");
  });

  it("falls back to the path when an owned entry names something unknown", async () => {
    const view = mountAt("/tasks");

    // An entry written by an older build, or by a newer one whose page names
    // this build does not have.
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

