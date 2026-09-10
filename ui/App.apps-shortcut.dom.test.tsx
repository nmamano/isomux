import { afterAll, beforeEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
setApiShim(async () => ({ text: "", version: "v", size: 0, cap: 1000 }));
afterAll(() => setApiShim(null));
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});
async function press(
  key: string,
  target: EventTarget = document.body,
  modifiers: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}
function mount() {
  return render(
    onLanguage("en", <App />, {
      hasReceivedInitialState: true,
      connected: true,
      appsLoaded: true,
    }),
  );
}

it("a opens Apps from the office and toggles back like Close", async () => {
  const view = mount();
  expect(window.location.pathname).toBe("/");
  expect(view.queryByText("No apps yet.") === null).toBe(true);
  await press("a");
  expect(window.location.pathname).toBe("/apps");
  expect(view.queryByText("No apps yet.") !== null).toBe(true);
  const back = spyOn(window.history, "back");
  await press("a");
  expect(back).toHaveBeenCalledTimes(1);
  back.mockRestore();
  // history.back() lands asynchronously (popstate); wait for the route to
  // settle instead of a fixed delay, which loses under box load.
  const deadline = Date.now() + 2000;
  while (window.location.pathname !== "/" && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  expect(window.location.pathname).toBe("/");
  expect(view.queryByText("No apps yet.") === null).toBe(true);
});
