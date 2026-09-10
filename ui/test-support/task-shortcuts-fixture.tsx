import { afterAll, beforeEach, expect } from "bun:test";
const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { SceneDecorationContext } = await import("../office/scene-decoration.tsx");
const { App } = await import("../App.tsx");
const { setApiShim } = await import("../api.ts");
const { onLanguage } = await import("./language-fixture.tsx");

export function setupTaskShortcutTests() {
setApiShim(async (_method, path) =>
  path.startsWith("/api/members-chat")
    ? { messages: [], hasMore: false, readPointer: null, unread: 0 }
    : { text: "", version: "v", size: 0, cap: 1000 },
);
afterAll(() => setApiShim(null));
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

}

export async function checkTaskShortcuts(lobbyOpen: boolean) {
    const view = render(
      onLanguage("en", createElement(SceneDecorationContext.Provider, { value: false }, createElement(App)), {
        lobbyOpen,
        currentRoomId: "r1",
        rooms: [
          { id: "r1", name: "Isomux", prompt: null, canCloseWhenEmpty: true },
        ],
        hasReceivedInitialState: true,
        connected: true,
        tasksLoaded: true,
        appsLoaded: true,
      }),
    );
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "t", bubbles: true });
    });
    expect(window.location.pathname).toBe("/tasks");
    const scope = view.container.querySelector(
      'select:has(option[value="all"])',
    ) as HTMLSelectElement;
    expect(scope !== null).toBe(true);
    expect(scope.value).toBe(lobbyOpen ? "all" : "r1");
    expect(scope.selectedOptions[0].textContent).toBe(
      lobbyOpen ? "All rooms" : "Isomux",
    );
    // Scope rendering stays in DOM. The complete sequence is in routes.test.ts.
    if (lobbyOpen) return;
    // Keep one direct page-to-page switch through the real keyboard binding.
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "a", bubbles: true });
    });
    expect(window.location.pathname).toBe("/apps");
    expect(view.queryByText("No apps yet.") !== null).toBe(true);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "t", bubbles: true });
    });
    expect(window.location.pathname).toBe("/tasks");
    expect(view.queryByText("No apps yet.") === null).toBe(true);
}
