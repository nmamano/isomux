// Each page's door in the office bar: the button opens its page, puts the
// page's own path in the address bar, and pushes exactly one entry carrying
// that page; Back returns to the office. One render walks every door, since
// each render is most of a file's DOM budget. The path table is in
// ui/routes.test.ts; the rest of App's history wiring is in
// ui/App.history.dom.test.tsx, and the cold-load half in
// ui/App.deeplink.dom.test.tsx.

import { afterAll, beforeEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { pathForPage } = await import("./routes.ts");
const { en } = await import("../shared/i18n/en.ts");
const { createElement } = await import("react");
type Page = import("./routes.ts").Page;

// The pages fetch when they mount; without the shim happy-dom opens real
// sockets to localhost. Settings reads a memory text from it.
setApiShim(async () => ({ text: "", version: "v", size: 0, cap: 1000 }));
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

// Each door's title and a marker only that page renders, so the test proves
// the right page came up and not just the path. Settings last: it only opens.
const DOORS: Array<{ page: Page; title: string; marker: string }> = [
  {
    page: "tasks",
    title: en["nav.tasksShortcut"],
    marker: "[data-tasks-page]",
  },
  { page: "apps", title: en["nav.appsShortcut"], marker: "[data-apps-page]" },
  {
    page: "cronjobs",
    title: en["common.automations"],
    marker: "[data-schedules-tab]",
  },
  {
    page: "integrations",
    title: en["nav.integrationsShortcut"],
    marker: "[data-integrations-page]",
  },
  {
    page: "settings",
    title: en["nav.settingsShortcut"],
    marker: '[data-testid="settings-content"]',
  },
];

it("opens each page from its office door at its own path, in one pushed entry, and Back returns to the office", async () => {
  const view = render(createElement(App, {}));
  const shown = (marker: string) =>
    view.baseElement.querySelector(marker) !== null;
  for (const { page, title, marker } of DOORS) {
    const pushState = spyOn(window.history, "pushState");
    try {
      await act(async () => {
        view.getByTitle(title).click();
      });
      expect([page, shown(marker)]).toEqual([page, true]);
      expect(window.location.pathname).toBe(pathForPage(page));
      expect(pushState.mock.calls).toEqual([
        [{ isomux: true, page }, "", pathForPage(page)],
      ]);
    } finally {
      pushState.mockRestore();
    }
    if (page === "settings") break;
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect([page, shown(marker), window.location.pathname]).toEqual([
      page,
      false,
      "/",
    ]);
  }
});
