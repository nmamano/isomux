// History-ownership coverage split from App.deeplink.dom.test.tsx. These cases
// keep ruling 8 honest: Close must work when the app did not push its entry.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

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

function mountAt(path: string): View {
  window.history.replaceState(null, "", path);
  return render(createElement(App, {}));
}
const taskPageOpen = (view: View) =>
  view.queryByPlaceholderText(/Quick add a task/) !== null;
const officeShowing = (view: View) => view.queryByTitle("Tasks (t)") !== null;

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
