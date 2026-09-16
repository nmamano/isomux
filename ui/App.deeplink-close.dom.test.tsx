// Cold-loaded task-page Close coverage split from App.deeplink.dom.test.tsx.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

setApiShim(async (_method, path) =>
  path.startsWith("/api/memory")
    ? { text: "", version: "0", size: 0, cap: 4000 }
    : {},
);
afterAll(() => setApiShim(null));
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/tasks");
});

it("closes a cold-loaded task page to the office in place", async () => {
  const view = render(createElement(App, {}));
  const before = window.history.length;
  await act(async () => {
    view.getByText("←").click();
  });

  expect(view.queryByPlaceholderText(/Quick add a task/)).toBeNull();
  expect(view.queryByTitle("Tasks (t)")).not.toBeNull();
  expect(window.location.pathname).toBe("/");
  expect(window.history.length).toBe(before);
});
