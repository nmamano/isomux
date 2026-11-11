// A section the member collapsed in the desktop sidebar stays collapsed after a
// page reload (task c23f23d0; Nil, 2026-11-11: "refreshing the page reopens a
// room that I have collapsed before the refresh. that's annoying."). The
// sections are kept per device, like the sidebar's own on/off choice. The
// reload goes through the real restore of the saved view: full_state first
// selects the first room with no agent open, and the saved room and chat come
// back one render later. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const {
  ALL_ROOMS,
  activeRoom,
  agentAt,
  backRoomRow,
  boot,
  chatOpen,
  click,
  currentRows,
  navRow,
  openFirstDesk,
  roomHeader,
  scout,
  ranger,
  builder,
  faraway,
  backbencher,
  receptionist,
  setAgents,
  setRooms,
  setSelfUser,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const expanded = (el: Element | null) => el?.getAttribute("aria-expanded");
const sections = (view: View) => ({
  r1: expanded(roomHeader(view, "r1")),
  r2: expanded(roomHeader(view, "r2")),
  r2back: expanded(backRoomRow(view, "r2")),
  more: expanded(
    view.container.querySelector(
      "nav[data-chat-sidebar] button[data-sidebar-more-rooms]",
    ),
  ),
  lobby: expanded(roomHeader(view, "lobby")),
});

it("a reload with a chat open keeps every section as the member left it; another anchor still opens its room", async () => {
  // A tucked third room, so the Tucked rooms section shows.
  setRooms(ALL_ROOMS);
  setAgents([
    scout,
    ranger,
    builder,
    faraway,
    backbencher,
    receptionist,
    agentAt("a7", "r3", 0),
  ]);
  setSelfUser({ tucked: ["r3"] });

  const first = await boot();
  await openFirstDesk(first);
  // Scout's chat opened its room.
  expect(expanded(roomHeader(first, "r1"))).toBe("true");
  // The member collapses it, opens the second room and its back room, opens
  // Tucked rooms and closes the Lobby.
  await click(roomHeader(first, "r1"));
  await click(roomHeader(first, "r2"));
  await click(backRoomRow(first, "r2"));
  await click(
    first.container.querySelector(
      "nav[data-chat-sidebar] button[data-sidebar-more-rooms]",
    ),
  );
  await click(roomHeader(first, "lobby"));
  const left = {
    r1: "false",
    r2: "true",
    r2back: "true",
    more: "true",
    lobby: "false",
  };
  expect(sections(first)).toEqual(left);
  first.unmount();

  const second = await boot();
  // The reload brought Scout's chat back...
  expect(chatOpen(second)).toBe(true);
  // ...and the sections as the member left them.
  expect(sections(second)).toEqual(left);
  // The chat is Scout's: its row, once the room is opened by hand, is the
  // current one.
  await click(roomHeader(second, "r1"));
  expect(currentRows(second)).toEqual([scout.id]);

  // A new anchor still opens its room after the reload: the member closes
  // the first room again and goes to the office, whose room in view is it.
  await click(roomHeader(second, "r1"));
  expect(expanded(roomHeader(second, "r1"))).toBe("false");
  await click(navRow(second, "office"));
  expect(chatOpen(second)).toBe(false);
  expect(activeRoom(second)).toBe("r1");
  expect(expanded(roomHeader(second, "r1"))).toBe("true");
});

it("a reload in the office keeps the room in view collapsed, also when it is not the first room", async () => {
  const first = await boot();
  await click(first.container.querySelector('[data-room-tab-button="r2"]'));
  expect(activeRoom(first)).toBe("r2");
  // The room in view opened.
  expect(expanded(roomHeader(first, "r2"))).toBe("true");
  await click(roomHeader(first, "r2"));
  expect(expanded(roomHeader(first, "r2"))).toBe("false");
  first.unmount();

  const second = await boot();
  // The reload came back to the second room, with no chat open...
  expect(chatOpen(second)).toBe(false);
  expect(activeRoom(second)).toBe("r2");
  // ...and its section still collapsed.
  expect(expanded(roomHeader(second, "r2"))).toBe("false");
});
