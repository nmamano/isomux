// The pager's link to its settings through the real App: the settings moved
// from Settings to Integrations (task db800fd8), so the link opens the
// Integrations page on its Pager tab. The view's side of the link is in
// ui/components/PagerView.settings-link.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { boot, settle, setupPagerAppTests } =
  await import("./test-support/pager-app-fixture.tsx");
setupPagerAppTests();

it("opens Integrations on the Pager tab from the empty pager's settings link", async () => {
  const view = await boot("/inbox/pages");
  await settle(0, []);
  const link = view.container.querySelector<HTMLElement>(
    "[data-pager-settings-link]",
  );
  expect(link).not.toBeNull();
  await act(async () => {
    fireEvent.click(link!);
  });
  expect(window.location.pathname).toBe("/integrations");
  expect(
    view.container
      .querySelector('[data-integrations-tab][aria-current="true"]')
      ?.getAttribute("data-integrations-tab"),
  ).toBe("pager");
  expect(
    view.container.querySelector('[data-testid="pager-settings"]'),
  ).not.toBeNull();
});
