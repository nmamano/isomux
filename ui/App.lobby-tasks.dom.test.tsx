import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { onLanguage } = await import("./test-support/language-fixture.tsx");

setApiShim(async (_method, path) => path.startsWith("/api/members-chat")
  ? { messages: [], hasMore: false, readPointer: null, unread: 0 }
  : {});
afterAll(() => setApiShim(null));
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

for (const lobbyOpen of [true, false]) {
  it(`t opens ${lobbyOpen ? "All rooms from Lobby" : "the selected room from its tab"}`, async () => {
    const view = render(onLanguage("en", createElement(App), {
      lobbyOpen,
      currentRoomId: "r1",
      rooms: [{ id: "r1", name: "Isomux", prompt: null, canCloseWhenEmpty: true }],
      hasReceivedInitialState: true,
      connected: true,
      tasksLoaded: true,
    }));
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "t", bubbles: true });
    });
    expect(window.location.pathname).toBe("/tasks");
    const scope = view.container.querySelector('select:has(option[value="all"])') as HTMLSelectElement;
    expect(scope).not.toBeNull();
    expect(scope.value).toBe(lobbyOpen ? "all" : "r1");
    expect(scope.selectedOptions[0].textContent).toBe(lobbyOpen ? "All rooms" : "Isomux");
  });
}
