// The "i" shortcut (Nil, 2026-10-13): it opens the Integrations page like
// "a" opens Apps, clearing every other page flag in one update, never the
// lone flip of "t" (task f55581c3), and closes it only when it is the page
// shown.

import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
// The pages fetch on mount; without the shim happy-dom opens real sockets.
// The settings page reads a memory text from it.
setApiShim(async () => ({ text: "", version: "v", size: 0, cap: 1000 }));
afterAll(() => setApiShim(null));
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

let typingField: HTMLTextAreaElement | null = null;
afterEach(() => {
  typingField?.remove();
  typingField = null;
});

async function press(key: string, target: EventTarget = document.body) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
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

const integrations = (view: ReturnType<typeof mount>) =>
  view.baseElement.querySelector("[data-integrations-page]");

it("i opens Integrations from the office and closes it again", async () => {
  const view = mount();
  expect(integrations(view)).toBeNull();
  await press("i");
  expect(window.location.pathname).toBe("/integrations");
  expect(integrations(view)).not.toBeNull();
  const back = spyOn(window.history, "back");
  await press("i");
  expect(back).toHaveBeenCalledTimes(1);
  back.mockRestore();
});

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

it("Integrations, then t, then i shows Integrations again", async () => {
  mount();
  await press("i");
  await press("t");
  expect(window.location.pathname).toBe("/tasks");
  await press("i");
  expect(window.location.pathname).toBe("/integrations");
});

it("i does nothing in a text field or with Settings open", async () => {
  const view = mount();
  typingField = document.createElement("textarea");
  document.body.appendChild(typingField);
  typingField.focus();
  await press("i", typingField);
  expect(window.location.pathname).toBe("/");
  expect(integrations(view)).toBeNull();
  await press("s");
  expect(window.location.pathname).toBe("/settings");
  await press("i");
  expect(window.location.pathname).toBe("/settings");
  expect(integrations(view)).toBeNull();
});
