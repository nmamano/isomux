// Catalan phone-menu coverage split from i18n.dom.test.tsx.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import {
  SHIPPED_LANGUAGE_CODES,
  translationsFor,
} from "./test-support/i18n.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));
const TASKS = translationsFor("common.tasks");
const ZOOM_IN = translationsFor("office.zoom.in");

it("keeps the Catalan office actions in the phone menu without a view toggle", async () => {
  expect(new Set(Object.values(TASKS)).size).toBe(
    SHIPPED_LANGUAGE_CODES.length,
  );
  const view = render(onLanguage("ca", createElement(App), { isMobile: true }));
  expect(view.queryByRole("button", { name: ZOOM_IN.ca })).not.toBeNull();
  fireEvent.click(view.getByText("⋯"));
  expect(view.queryByText(TASKS.ca)).not.toBeNull();
  // Flush App's pending office work before happy-dom unregisters window.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
