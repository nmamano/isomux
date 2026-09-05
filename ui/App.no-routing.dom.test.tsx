// A deployment that does not own its origin's root, which is how the landing
// demo runs: ui/demo-entry.tsx serves this same App under /demo and passes
// routing={false}, where a real path would name a public URL that does not
// exist. Its own file because each case renders the office and the 5 s cap is
// per file; the rest of the cold-load behaviour is in
// ui/App.boot.dom.test.tsx.
//
// Routing is an INPUT rather than something App infers from the URL. Inferring
// it would mean a real office loaded at an unknown path silently stopped having
// real URLs for the rest of the session.

import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** Load the app as if the browser had just arrived on `path`. */
function mountAt(path: string, { routing }: { routing?: boolean } = {}): View {
  window.history.replaceState(null, "", path);
  return render(createElement(App, { routing }));
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

