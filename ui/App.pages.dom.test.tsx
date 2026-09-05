// One test per page: opening it from the office shows it, puts its own path in
// the address bar, and pushes exactly one entry carrying that page.
//
// Its own file because each case renders the office AND a full page, and the
// four together were most of a 5 s budget. The rest of App's history wiring is
// in ui/App.dom.test.tsx, and the cold-load half in ui/App.boot.dom.test.tsx.

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
    button: "Tasks",
    showing: (v) => v.queryByPlaceholderText(/Quick add a task/) !== null,
  },
  {
    page: "cronjobs",
    button: "Cron jobs",
    showing: (v) => v.queryByText(/cron jobs/) !== null,
  },
  {
    page: "apps",
    button: "Apps",
    showing: (v) => v.queryByTitle("Hide app previews") !== null,
  },
  {
    page: "settings",
    button: "Settings",
    showing: (v) => v.queryByText(/Select a setting from the list/) !== null,
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
