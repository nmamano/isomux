// The task board's unsaved-edit guard under its real path, and what Back does
// to it. The settings page's half is in ui/App.settings-dirty.dom.test.tsx -
// separate files because each mounts a full page and the 5 s cap is per file.
//
// The guard is a capture-phase keydown listener on window that calls
// stopPropagation before App's own bubble listener can reach goHome
// (ui/components/TaskView.tsx:840). That mechanism is the enabling
// condition for these tests, and it dictates how the key is sent: Escape is
// dispatched from document.body with bubbles:true, never on window.
// stopPropagation stops an event reaching other NODES, not other listeners on
// the same node, so an event dispatched directly on window would run the
// guard's listener AND App's - which no browser does, and the test would pass
// while proving nothing.
//
// The second case pins today's Back behaviour rather than asserting a design:
// nothing in ui/ listens to popstate except App, so Back unmounts the page and
// the edits go without a prompt. Reported to Nil as a question, unchanged here.
// Reload is not the same story for both forms: UserSettingsView guards it with
// beforeunload (:1139) and TaskView does not, so this panel is silent on reload
// as well as on Back.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
});

/** The real event path: capture at window, stopPropagation, App never sees it. */
async function escapeFromPage(): Promise<void> {
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

const discardPrompt = (view: View) =>
  view.queryByText(/Discard unsaved changes/) !== null;

/** Open the task board's create panel, seeded with a title, so it is dirty. */
async function openDirtyTaskPanel(view: View, title: string): Promise<void> {
  const quickAdd = view.getByPlaceholderText(/Quick add a task/);
  await act(async () => {
    fireEvent.change(quickAdd, { target: { value: title } });
    fireEvent.keyDown(quickAdd, { key: "Enter", bubbles: true });
  });
}

describe("a dirty task edit panel", () => {
  it("shows the discard prompt on Escape and stays on /tasks", async () => {
    window.history.replaceState(null, "", "/tasks");
    const view = render(createElement(App, {}));

    await openDirtyTaskPanel(view, "unsaved title");

    // The panel is open and carries the unsaved value - without this the
    // Escape below would be testing a clean board.
    expect(view.getByDisplayValue("unsaved title")).toBeDefined();
    expect(discardPrompt(view)).toBe(false);

    await escapeFromPage();

    expect(discardPrompt(view)).toBe(true);
    expect(window.location.pathname).toBe("/tasks");
  });
});

describe("Back with unsaved edits", () => {
  // CHARACTERISATION, not a design. Back discards this edit silently, and so
  // does a reload, because TaskView registers no beforeunload. The settings
  // page behaves differently - it does register one - and the loop note records
  // that difference and the decision it is waiting on. This test exists so the
  // answer is a decision rather than an accident.
  it("discards them without a prompt, closes the page, and returns to /", async () => {
    window.history.replaceState(null, "", "/");
    const view = render(createElement(App, {}));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
    });
    await openDirtyTaskPanel(view, "unsaved title");
    expect(view.getByDisplayValue("unsaved title")).toBeDefined();
    expect(window.location.pathname).toBe("/tasks");

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(discardPrompt(view)).toBe(false);
    expect(window.location.pathname).toBe("/");
    expect(view.queryByPlaceholderText(/Quick add a task/)).toBeNull();
    expect(view.queryByDisplayValue("unsaved title")).toBeNull();
  });
});
