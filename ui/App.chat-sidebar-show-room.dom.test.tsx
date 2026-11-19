// A room header's show-room button in the sidebar (task 82997335; Nil,
// 2026-11-18: "a button on a room in the side bar to show that room"). It
// leaves every page, the chat and the back room screen for that room's front
// office view, or the Lobby, the way the Office row leaves them: the browser
// history ends on the load entry. A page's unsaved edits and the phone drawer
// are in ui/App.chat-sidebar-show-room-guard.dom.test.tsx (the 5 s cap is per
// file). The Office row is in ui/App.chat-sidebar-office.dom.test.tsx; the
// setup in ui/test-support/chat-sidebar-fixture.tsx.

import { afterEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const {
  LOAD_ENTRY,
  activeRoom,
  backScreen,
  backbencher,
  boot,
  chatOpen,
  click,
  goBack,
  openBackAgent,
  openFirstDesk,
  receptionist,
  setUpChatSidebarTests,
  sidebar,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

let backSpy: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  backSpy?.mockRestore();
  backSpy = null;
});
/** happy-dom fires popstate inside history.back(); a browser fires it later.
 *  Defer it as a browser does, so the room the button sets must survive the
 *  popstate that lands after it. */
function deferBack(): void {
  const realBack = window.history.back.bind(window.history);
  backSpy = spyOn(window.history, "back").mockImplementation(() => {
    setTimeout(realBack, 0);
  });
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const showButton = (view: View, roomId: string, scope = "") =>
  view.baseElement.querySelector<HTMLButtonElement>(
    `${scope} nav[data-chat-sidebar] button[data-sidebar-show-room="${roomId}"]`.trim(),
  );
const tasksOpen = (view: View) =>
  view.container.querySelector("[data-tasks-page]") !== null;
// The Lobby scene draws the receptionist's desk control.
const lobbyShown = (view: View) =>
  view.container.querySelector('[data-lobby-control="receptionist"]') !== null;

/** The view a show-room click must end on: no page, chat or back room
 *  screen; `room` in view (null for the Lobby, which has no room tab); the
 *  load entry, which a Back keeps. */
async function expectShown(
  view: View,
  room: string | null,
  lobby: boolean,
): Promise<void> {
  expect({
    chat: chatOpen(view),
    tasks: tasksOpen(view),
    back: backScreen(view),
    room: activeRoom(view),
    lobby: lobbyShown(view),
    entry: window.history.state,
    sidebar: sidebar(view) !== null,
  }).toEqual({
    chat: false,
    tasks: false,
    back: false,
    room,
    lobby,
    entry: LOAD_ENTRY,
    sidebar: true,
  });
  await goBack();
  expect({
    chat: chatOpen(view),
    tasks: tasksOpen(view),
    room: activeRoom(view),
  }).toEqual({ chat: false, tasks: false, room });
}

it("from an agent chat in one room, shows another room", async () => {
  deferBack();
  const view = await boot();
  await openFirstDesk(view);
  await click(showButton(view, "r2"));
  await settle();
  await expectShown(view, "r2", false);
});

it("from a back agent's chat, shows its room's front office, not the back room screen", async () => {
  deferBack();
  const view = await boot();
  await openBackAgent(view, "r2", backbencher.id);
  await click(showButton(view, "r2"));
  await settle();
  await expectShown(view, "r2", false);
});

it("the Lobby's button shows the Lobby, and its buttons show with no hover while it is in view; a room's button from the Lobby shows that room", async () => {
  deferBack();
  const view = await boot();
  const open = (roomId: string) =>
    view.container
      .querySelector(`nav[data-chat-sidebar] [data-sidebar-room="${roomId}"]`)
      ?.getAttribute("aria-expanded") === "true";
  // data-in-view: the buttons that show with no hover (task 4eea73fc), on
  // the open room in view. Both sections are open, so only the room in view
  // decides.
  const inView = () => ({
    r1: showButton(view, "r1")
      ?.closest(".chat-sidebar-row-actions")
      ?.hasAttribute("data-in-view"),
    lobby: showButton(view, "lobby")
      ?.closest(".chat-sidebar-row-actions")
      ?.hasAttribute("data-in-view"),
  });
  expect({ r1: open("r1"), lobby: open("lobby") }).toEqual({
    r1: true,
    lobby: true,
  });
  // The office loads on the Lobby.
  expect(inView()).toEqual({ r1: false, lobby: true });
  await openFirstDesk(view);
  expect({ inView: inView(), lobby: lobbyShown(view) }).toEqual({
    inView: { r1: true, lobby: false },
    lobby: false,
  });

  await click(showButton(view, "lobby"));
  await settle();
  expect(inView()).toEqual({ r1: false, lobby: true });
  await expectShown(view, null, true);

  // From the receptionist's chat in the Lobby, to a room.
  await click(
    view.container.querySelector(
      `nav[data-chat-sidebar] button[data-sidebar-agent="${receptionist.id}"]`,
    ),
  );
  expect(chatOpen(view)).toBe(true);
  await click(showButton(view, "r2"));
  await settle();
  await expectShown(view, "r2", false);
});
