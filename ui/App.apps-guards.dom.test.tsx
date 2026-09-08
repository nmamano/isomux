import { afterAll, beforeEach, expect, it } from "bun:test";
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
