// The desktop chat sidebar's Office and Members chat rows (task c61316be):
// they leave every page and the chat for the room view, from a chat, from a
// page over a chat, and from a back agent's chat (its back room). The browser
// history must end where the office's own ways back leave it: on the load
// entry, so a Back after them brings no page or chat back. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const {
  LOAD_ENTRY,
  activeRoom,
  backScreen,
  backbencher,
  boot,
  chatOpen,
  click,
  goBack,
  navRow,
  openBackAgent,
  openFirstDesk,
  press,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const tasksOpen = (view: View) =>
  view.container.querySelector("[data-tasks-page]") !== null;

/** The front office of `room`, on the load entry, and a Back keeps it so. */
async function expectFrontOffice(view: View, room: string): Promise<void> {
  expect({
    chat: chatOpen(view),
    tasks: tasksOpen(view),
    back: backScreen(view),
    room: activeRoom(view),
    entry: window.history.state,
  }).toEqual({
    chat: false,
    tasks: false,
    back: false,
    room,
    entry: LOAD_ENTRY,
  });
  await goBack();
  expect({ chat: chatOpen(view), tasks: tasksOpen(view) }).toEqual({
    chat: false,
    tasks: false,
  });
}

it("from a chat, goes to the office", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await click(navRow(view, "office"));
  await expectFrontOffice(view, "r1");
});

it("from a page over a chat, goes to the office, not back to the chat", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await press("t");
  expect(tasksOpen(view)).toBe(true);
  await click(navRow(view, "office"));
  await expectFrontOffice(view, "r1");
});

it("from a back agent's chat, goes to its room's back room, and Back from there to the front office", async () => {
  const view = await boot();
  await openFirstDesk(view);
  // Backbencher sits in the back room of r2, not the room in view.
  await openBackAgent(view, "r2", backbencher.id);
  await click(navRow(view, "office"));
  expect({ chat: chatOpen(view), back: backScreen(view) }).toEqual({
    chat: false,
    back: true,
  });

  // Back steps out of the back room to its room's front: r2, so the back room
  // was r2's.
  await goBack();
  await expectFrontOffice(view, "r2");
});

it("Members chat, from a page over a chat, opens the lobby's members chat with no page or chat left", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await press("t");
  await click(navRow(view, "members-chat"));
  expect({
    chat: chatOpen(view),
    tasks: tasksOpen(view),
    membersChat:
      view.container.querySelector("[data-members-chat-list]") !== null,
    entry: window.history.state,
  }).toEqual({
    chat: false,
    tasks: false,
    membersChat: true,
    entry: LOAD_ENTRY,
  });
});
