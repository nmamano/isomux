// Catalan phone-menu coverage split from i18n.dom.test.tsx.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));
const TASKS = { ca: "Tasques", es: "Tareas", en: "Tasks" } as const;

it("keeps the Catalan office actions in the phone menu without a view toggle", async () => {
  expect(new Set(Object.values(TASKS)).size).toBe(3);
  const view = render(
    onLanguage("ca", createElement(App), { isMobile: true }),
  );
  expect(view.queryByRole("button", { name: "Apropa" })).not.toBeNull();
  fireEvent.click(view.getByText("⋯"));
  expect(view.queryByText("Mostra la llista d'agents")).toBeNull();
  expect(view.queryByText("Mostra la vista de planta")).toBeNull();
  expect(view.queryByText(TASKS.ca)).not.toBeNull();
  // Flush App's pending office work before happy-dom unregisters window.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
