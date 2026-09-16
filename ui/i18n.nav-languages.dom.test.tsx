// Spanish-to-English desktop nav coverage split from i18n.dom.test.tsx.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));
const app = (language: "es" | null) =>
  onLanguage(language, createElement(App));
const TASKS = { ca: "Tasques", es: "Tareas", en: "Tasks" } as const;

it("moves the desktop nav from Spanish to default English", async () => {
  expect(new Set(Object.values(TASKS)).size).toBe(3);
  const view = render(app("es"));
  expect(view.queryAllByTitle(`${TASKS.es} (t)`).length).toBe(1);
  expect(view.queryByTitle(`${TASKS.ca} (t)`)).toBeNull();

  view.rerender(app(null));
  expect(view.queryAllByTitle(`${TASKS.en} (t)`).length).toBe(1);
  expect(view.queryByTitle(`${TASKS.es} (t)`)).toBeNull();
  // Flush App's pending office work before happy-dom unregisters window.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
