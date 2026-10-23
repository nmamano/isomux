// The desktop slice of the office i18n loop (internal-docs/i18n-loop.md, S1):
// the nav bar in Catalan, then after a language change. The phone menu and
// preferences live in sibling files so each real App scene stays below half of
// the DOM budget.
//
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import {
  SHIPPED_LANGUAGE_CODES,
  translationsFor,
} from "./test-support/i18n.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

// App needs a shim so nothing reaches for a socket.
const OK = async () => ({});
setApiShim(OK);
afterEach(() => setApiShim(OK));
afterAll(() => setApiShim(null));

const TASKS_KEY = translationsFor("nav.tasksShortcut");
const APPS_KEY = translationsFor("nav.appsShortcut");
const SETTINGS_KEY = translationsFor("nav.settingsShortcut");
const AUTOMATIONS = translationsFor("common.automations");
const SETTINGS = translationsFor("common.settings");
const THEME = translationsFor("common.theme");
const CHANGE_THEME = translationsFor("common.changeTheme");
const ZOOM_IN = translationsFor("office.zoom.inShortcut");
const ZOOM_OUT = translationsFor("office.zoom.outShortcut");
const ZOOM_RESET = translationsFor("office.zoom.reset");

const app = (language: "ca" | "es" | null) =>
  onLanguage(language, createElement(App));

describe("the anchors", () => {
  it("covers every shipped language with a distinct resolved label", () => {
    for (const anchor of [TASKS_KEY, SETTINGS_KEY]) {
      expect(Object.keys(anchor).sort()).toEqual(
        [...SHIPPED_LANGUAGE_CODES].sort(),
      );
      expect(new Set(Object.values(anchor)).size).toBe(
        SHIPPED_LANGUAGE_CODES.length,
      );
    }
  });
});

describe("the office nav bar", () => {
  it("reads Catalan on desktop", async () => {
    const view = render(app("ca"));

    // Every desktop action has one Catalan tooltip in this lobby fixture.
    // Shortcut titles include the key; Schedules has no shortcut. The room's
    // matching wall controls are asserted in site-link.i18n.dom.test.tsx.
    for (const [title, count] of [
      [TASKS_KEY.ca, 1],
      [AUTOMATIONS.ca, 1],
      [APPS_KEY.ca, 1],
      [SETTINGS_KEY.ca, 1],
    ] as const)
      expect(view.queryAllByTitle(title).length, title).toBe(count);
    // The vent in the scene carries the same word as its SVG title, so the
    // label is not the only match.
    expect(view.queryAllByText(SETTINGS.ca).length).toBeGreaterThan(0);
    expect(view.queryByText(THEME.ca)).not.toBeNull();
    expect(view.queryAllByTitle(CHANGE_THEME.ca).length).toBe(1);
    expect(view.queryByTitle(ZOOM_IN.ca)).not.toBeNull();
    expect(view.queryByTitle(ZOOM_OUT.ca)).not.toBeNull();
    expect(view.queryByTitle(ZOOM_RESET.ca)).not.toBeNull();
    expect(view.queryByTitle(TASKS_KEY.en)).toBeNull();

    // A language change reaches the nav bar: Spanish, then the default
    // English of a member who never chose.
    view.rerender(app("es"));
    expect(view.queryAllByTitle(TASKS_KEY.es).length).toBe(1);
    expect(view.queryByTitle(TASKS_KEY.ca)).toBeNull();
    view.rerender(app(null));
    expect(view.queryAllByTitle(TASKS_KEY.en).length).toBe(1);
    expect(view.queryByTitle(TASKS_KEY.es)).toBeNull();

    // Flush App's pending office work before happy-dom unregisters window.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
