// "s" opens Settings on the row of the room you stand in, and from the lobby,
// which has no room row, on the office row (Nil, 2026-09-14). That shortcuts
// reach App from the lobby at all is in ui/App.lobby-tasks.dom.test.tsx.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { en } = await import("../shared/i18n/en.ts");

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

const ROOM = "Isomux";

for (const [where, lobbyOpen, rowLabel] of [
  ["the lobby", true, en["settings.sidebar.office"]],
  ["a room", false, ROOM],
] as const) {
  it(`s opens Settings on the ${lobbyOpen ? "office" : "room"} row from ${where}`, async () => {
    const view = render(
      onLanguage("en", createElement(App), {
        lobbyOpen,
        currentRoomId: "r1",
        rooms: [
          { id: "r1", name: ROOM, prompt: null, canCloseWhenEmpty: true },
        ],
        hasReceivedInitialState: true,
        connected: true,
        tasksLoaded: true,
        appsLoaded: true,
      }),
    );
    expect(view.queryByTitle("Tasks (t)")).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "s", bubbles: true });
    });
    expect(window.location.pathname).toBe("/settings");
    const current = [
      ...view.container.querySelectorAll('button[aria-current="true"]'),
    ].map((b) => b.textContent);
    expect(current).toEqual([rowLabel]);
  });
}
