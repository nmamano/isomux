// The "s" shortcut: it opens the settings page from the office, the way "t"
// reaches the task board, and it never closes it again - leaving that way
// would skip the page's unsaved-edits check, which is also why "t" stands
// down while settings is open.
//
// Its own file because it renders the office plus the settings page and the
// 5 s cap is per file; the page's own paths and history entries are in
// ui/App.pages.cronjobs-settings.dom.test.tsx, and the modifier guards - three
// more renders of the same office - in ui/App.settings-modifiers.dom.test.tsx.
// These two cases ran 2.5 s of the 5 s (measured 2026-09-05).

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

// The settings page fetches on mount; without the shim happy-dom opens real
// sockets to localhost.
setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

let typingField: HTMLInputElement | null = null;

afterEach(() => {
  typingField?.remove();
  typingField = null;
});

async function pressS(
  from?: EventTarget,
  modifiers: KeyboardEventInit = {},
): Promise<void> {
  await act(async () => {
    (from ?? window).dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", bubbles: true, ...modifiers }),
    );
  });
}

type View = ReturnType<typeof render>;

// The enabling precondition, asserted before every press: the office is up
// (its Tasks button is only in the office bar) and the settings page is not.
const settingsOpen = (view: View) =>
  view.queryByText(/Select a setting from the list/) !== null;
const officeShowing = (view: View) =>
  view.queryByTitle("Tasks") !== null && !settingsOpen(view);

describe("the settings shortcut", () => {
  it("opens settings, and a second press does not close it", async () => {
    const view = render(createElement(App));
    expect(officeShowing(view)).toBe(true);

    await pressS();

    expect(settingsOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/settings");

    await pressS();

    expect(settingsOpen(view)).toBe(true);
    expect(window.location.pathname).toBe("/settings");
  });

  it("stays out of the way while you are typing", async () => {
    const view = render(createElement(App));
    expect(officeShowing(view)).toBe(true);
    typingField = document.createElement("input");
    document.body.appendChild(typingField);

    await pressS(typingField);

    expect(settingsOpen(view)).toBe(false);
    expect(window.location.pathname).toBe("/");
  });
});
