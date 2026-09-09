// One test per page: opening it from the office shows it, puts its own path in
// the address bar, and pushes exactly one entry carrying that page. This file
// holds the task board and apps; cron jobs and settings are in
// ui/App.pages.cronjobs-settings.dom.test.tsx.
//
// Four cases of one subject do not divide by meaning, so they divide by cost:
// each renders the office AND a full page, and all four together ran 2.3-3.2 s
// of a 5 s budget (measured 2026-09-05), which is past the half a file is
// allowed before it counts as a latent flake. The rest of App's history wiring
// is in ui/App.history.dom.test.tsx, and the cold-load half in
// ui/App.boot.dom.test.tsx.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");
type Page = import("./routes.ts").Page;

type View = ReturnType<typeof render>;

// The cronjobs, apps and settings pages each fetch when they mount; without the
// shim happy-dom opens real sockets to localhost.
setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

let pushState: ReturnType<typeof spyOn<History, "pushState">>;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  pushState = spyOn(window.history, "pushState");
});

afterEach(() => {
  pushState.mockRestore();
});

/**
 * Each page: the office button that opens it (NavActions renders a label as the
 * button's title unless the action names its own) and something only that page
 * renders, so the test proves the right page came up and not just the path.
 */
const PAGES: Array<{
  page: Page;
  button: string;
  showing: (v: View) => boolean;
}> = [
  {
    page: "tasks",
    button: "Tasks (t)",
    showing: (v) => v.queryByPlaceholderText(/Quick add a task/) !== null,
  },
  {
    page: "apps",
    button: "Apps (a)",
    showing: (v) => v.queryByTitle("Hide app previews") !== null,
  },
];

describe("opening a page from the office", () => {
  for (const { page, button, showing } of PAGES) {
    it(`shows ${page} at its own path, in one pushed entry`, async () => {
      const view = render(createElement(App, {}));

      await act(async () => {
        view.getByTitle(button).click();
      });

      expect(showing(view)).toBe(true);
      expect(window.location.pathname).toBe(`/${page}`);
      expect(pushState).toHaveBeenCalledTimes(1);
      expect(pushState.mock.calls[0]).toEqual([
        { isomux: true, page },
        "",
        `/${page}`,
      ]);
    });
  }
});
