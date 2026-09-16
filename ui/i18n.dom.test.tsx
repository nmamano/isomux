// The Catalan desktop slice of the office i18n loop
// (internal-docs/i18n-loop.md, S1). Other nav variants and preferences live in
// sibling files so each real App scene stays below half of the DOM budget.
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

const TASKS = translationsFor("common.tasks");
const SCHEDULES = translationsFor("common.schedules");
const SETTINGS = translationsFor("common.settings");
const THEME = translationsFor("common.theme");
const CHANGE_THEME = translationsFor("common.changeTheme");
const ZOOM_IN = translationsFor("office.zoom.inShortcut");
const ZOOM_OUT = translationsFor("office.zoom.outShortcut");
const ZOOM_RESET = translationsFor("office.zoom.reset");

const app = (language: "ca") => onLanguage(language, createElement(App));

describe("the anchors", () => {
  it("covers every shipped language with a distinct resolved label", () => {
    expect(Object.keys(TASKS).sort()).toEqual(
      [...SHIPPED_LANGUAGE_CODES].sort(),
    );
    expect(new Set(Object.values(TASKS)).size).toBe(
      SHIPPED_LANGUAGE_CODES.length,
    );
  });
});

describe("the office nav bar", () => {
  it("reads Catalan on desktop", async () => {
    const view = render(app("ca"));

    // Every desktop action has one Catalan tooltip in this lobby fixture.
    // Shortcut titles include the key; Schedules has no shortcut. The room's
    // matching wall controls are asserted in site-link.i18n.dom.test.tsx.
    for (const [title, count] of [
      [`${TASKS.ca} (t)`, 1],
      [SCHEDULES.ca, 1],
      ["Apps (a)", 1],
      [`${SETTINGS.ca} (s)`, 1],
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
    expect(view.queryByTitle(`${TASKS.en} (t)`)).toBeNull();

    // Flush App's pending office work before happy-dom unregisters window.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
