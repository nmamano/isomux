import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { onLanguage } = await import("./test-support/language-fixture.tsx");

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

for (const [key, path] of [
  ["a", "/apps"],
  ["s", "/settings"],
]) {
  it(`${key} opens ${path} directly from the lobby`, async () => {
    const view = render(
      onLanguage("en", createElement(App), {
        lobbyOpen: true,
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
    expect(window.location.pathname).toBe("/");
    expect(view.queryByTitle("Tasks") !== null).toBe(true);
    await act(async () => {
      fireEvent.keyDown(document.body, { key, bubbles: true });
    });
    expect(window.location.pathname).toBe(path);
    expect(view.queryByTitle("Tasks") === null).toBe(true);
  });
}
