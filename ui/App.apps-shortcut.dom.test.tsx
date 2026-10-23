// The page shortcuts through the real App: "a" opens Apps from the office and
// closes it again, and stays out of the way while typing, with a modifier, or
// on Settings; "i" over a stack applies its whole update.
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

// App works out "typing" itself (input, textarea, contentEditable) and passes
// the modifiers on; the guard rule is the table in ui/routes.test.ts.
it("a ignores typing, modifiers, and Settings", async () => {
  const view = mount();
  expect(window.location.pathname).toBe("/");
  for (const tag of ["input", "textarea", "div"]) {
    const field = document.createElement(tag);
    if (tag === "div") field.contentEditable = "true";
    document.body.appendChild(field);
    expect((await press("a", field)).defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe("/");
    field.remove();
  }
  for (const modifier of ["metaKey", "ctrlKey", "altKey"]) {
    expect(
      (await press("a", document.body, { [modifier]: true })).defaultPrevented,
    ).toBe(false);
    expect(window.location.pathname).toBe("/");
  }
  await press("s");
  expect(window.location.pathname).toBe("/settings");
  expect(view.queryByText("No apps yet.") === null).toBe(true);
  for (const key of ["t", "a", "s"]) {
    expect((await press(key)).defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe("/settings");
  }
});

// "i" sets every page flag in one update, never the lone flip of "t" (task
// f55581c3): App applies the whole update. Which flags each key sets is the
// table in ui/routes.test.ts.
it("i over Tasks over Apps shows Integrations, with Apps closed under it", async () => {
  mount();
  await press("a");
  await press("t");
  expect(window.location.pathname).toBe("/tasks");
  await press("i");
  expect(window.location.pathname).toBe("/integrations");
  // Tasks on and off again: what is left underneath is Integrations, not
  // Apps, which ranks above it.
  await press("t");
  await press("t");
  expect(window.location.pathname).toBe("/integrations");
});
