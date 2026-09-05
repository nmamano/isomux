// A modified "s" belongs to the browser or the OS - Ctrl/Cmd+S is Save, Alt+S
// opens a menu on Windows - so the office must not answer it. One case per
// modifier: a single press carrying all three would still pass with two of the
// three guards gone.
//
// Split from ui/App.settings-shortcut.dom.test.tsx, which holds the same
// shortcut's opening behaviour: three more renders of the office put that file
// at 3.8 s of the per-file 5 s cap, and these three cost 2.6 s on their own
// (measured 2026-09-05).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

// The settings page fetches on mount; without the shim happy-dom opens real
// sockets to localhost.
setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

// The enabling precondition, asserted before every press: the office is up
// (its Tasks button is only in the office bar) and the settings page is not.
const settingsOpen = (view: View) =>
  view.queryByText(/Select a setting from the list/) !== null;
const officeShowing = (view: View) =>
  view.queryByTitle("Tasks") !== null && !settingsOpen(view);

describe("the settings shortcut, modified", () => {
  for (const [name, modifier] of [
    ["ctrl", { ctrlKey: true }],
    ["meta", { metaKey: true }],
    ["alt", { altKey: true }],
  ] as const) {
    it(`leaves ${name}+s to the browser`, async () => {
      const view = render(createElement(App));
      expect(officeShowing(view)).toBe(true);

      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "s", bubbles: true, ...modifier }),
        );
      });

      expect(settingsOpen(view)).toBe(false);
      expect(window.location.pathname).toBe("/");
    });
  }
});
