// The Catalan desktop slice of the office i18n loop
// (internal-docs/i18n-loop.md, S1). Other nav variants and preferences live in
// sibling files so each real App scene stays below half of the DOM budget.
//
// The oracles are literal strings on purpose. An expected value read back
// through translatorFor would repeat the implementation and pass for any
// translation, including a wrong one. A literal fails when the catalog
// changes, which is the point.
//
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

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

const TASKS = { ca: "Tasques", es: "Tareas", en: "Tasks" } as const;

const app = (language: "ca") => onLanguage(language, createElement(App));

describe("the anchors", () => {
  it("differ between the three languages, so a match proves the language", () => {
    expect(new Set(Object.values(TASKS)).size).toBe(3);
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
      ["Programacions", 1],
      ["Apps (a)", 1],
      ["Configuració (s)", 1],
    ] as const)
      expect(view.queryAllByTitle(title).length, title).toBe(count);
    // The vent in the scene carries the same word as its SVG title, so the
    // label is not the only match.
    expect(view.queryAllByText("Configuració").length).toBeGreaterThan(0);
    expect(view.queryByText("Tema")).not.toBeNull();
    expect(view.queryAllByTitle("Canvia el tema").length).toBe(1);
    expect(view.queryByTitle("Apropa (+)")).not.toBeNull();
    expect(view.queryByTitle("Allunya (-)")).not.toBeNull();
    expect(view.queryByTitle("Restableix la vista (0)")).not.toBeNull();
    expect(view.queryByTitle(`${TASKS.en} (t)`)).toBeNull();

    // Flush App's pending office work before happy-dom unregisters window.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
