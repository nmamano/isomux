// The human chats on a phone (task 019e4d7c; Nil, 2026-11-12: "i'd obsolete
// the lobby pannel, and make human chats full screen"): on a desktop the
// lobby has no chat panel and no chat button (the sidebar lists the chats);
// on a phone each room's chat button opens that room's chat full screen
// (task 5b055cf3), counts the unread of every human chat the member sees,
// and the chat's title switches between them; the header's Back returns to
// the office. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx (a boot with no saved view lands
// in the lobby).

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { translatorFor } = await import("../shared/i18n/translate.ts");
const {
  boot,
  click,
  memberWire,
  requests,
  setMemberDms,
  setMembers,
  setRoomChats,
  setUpChatSidebarTests,
  setWindowWidth,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const en = translatorFor("en");

// Bea (u3) has a chat with 2 unread; Cid (u4) has none.
function seedOffice(): void {
  setMembers([memberWire("u3", "Bea"), memberWire("u4", "Cid")]);
  setMemberDms([
    {
      peerId: "u3",
      peerName: "Bea",
      removed: false,
      readPointer: null,
      unread: 2,
      lastAt: 100,
    },
  ]);
}

async function phone(): Promise<View> {
  setWindowWidth(390);
  const view = await boot();
  // The store reads the width again on a resize, after its 150 ms debounce.
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  return view;
}

const fab = (view: View) =>
  view.container.querySelector<HTMLButtonElement>("[data-lobby-chat-fab]");
const humanChat = (view: View) =>
  view.container
    .querySelector("[data-human-chat]")
    ?.getAttribute("data-human-chat") ?? null;
const backLabel = (view: View) =>
  view.container.querySelector("[data-human-chat-back]")?.textContent ?? null;
const switcherOptions = (view: View) =>
  [...view.baseElement.querySelectorAll("[data-chat-switcher-option]")].map(
    (o) => o.getAttribute("data-chat-switcher-option"),
  );

it("on a desktop, the lobby has no chat panel, no chat button and no dot on its tab for a 1:1 chat", async () => {
  seedOffice();
  const view = await boot();
  expect(view.container.querySelector("[data-lobby-tab]")).not.toBeNull();
  expect(view.container.querySelector("[data-floor-scene]")).not.toBeNull();
  expect(
    view.container.querySelectorAll("[data-members-chat-list]").length,
  ).toBe(0);
  expect(fab(view)).toBeNull();
  // Bea's 2 unread show in the sidebar, not on the lobby's tab.
  expect(
    view.container.querySelector("[data-lobby-tab] [data-lobby-tab-dot]"),
  ).toBeNull();
  expect(
    view.container.querySelector(
      'nav[data-chat-sidebar] button[data-sidebar-member="u3"] [data-sidebar-badge]',
    ),
  ).not.toBeNull();
});

// A hidden room (r9: its summary comes, it is not in the member's rooms)
// counts nowhere.
it("on a phone, the chat button counts the room chats the member sees and every 1:1 chat", async () => {
  seedOffice();
  setRoomChats({ lobby: 0, r1: 0, r2: 0, r9: 5 });
  const view = await phone();
  await act(async () => {
    const { shimEmit } = await import("./ws.ts");
    shimEmit({
      type: "room_chat_message",
      roomId: "r2",
      message: {
        id: "202611-000000b1",
        kind: "user",
        userId: "u4",
        userName: "Cid",
        timestamp: 200,
        content: "hi all",
        attachments: [],
      },
    } as never);
  });
  // Bea's 2 and the post in r2.
  expect(
    fab(view)?.querySelector("[data-lobby-unread]")?.getAttribute("aria-label"),
  ).toBe(en.tn("membersChat.unreadCount", 3));
});

it("on a phone, the lobby's chat button opens the lobby's chat full screen, the title switches to another room's chat and a 1:1 chat, and Back names the office and returns to the lobby", async () => {
  seedOffice();
  const view = await phone();
  expect(fab(view)).not.toBeNull();
  expect(humanChat(view)).toBeNull();

  await click(fab(view));
  expect(humanChat(view)).toBe("room:lobby");
  // Full screen: no dialog over the lobby.
  expect(view.baseElement.querySelector('[role="dialog"]')).toBeNull();
  expect(fab(view)).toBeNull();
  // Back names the screen it goes back to, as a page's Close does.
  expect(backLabel(view)).toBe(en.t("sidebar.office"));

  await click(view.container.querySelector("[data-chat-switcher]"));
  // The lobby's chat, the rooms in tab order, then the members.
  expect(switcherOptions(view)).toEqual([
    "room:lobby",
    "room:r1",
    "room:r2",
    "u3",
    "u4",
  ]);
  await click(
    view.baseElement.querySelector('[data-chat-switcher-option="room:r2"]'),
  );
  expect(humanChat(view)).toBe("room:r2");
  await click(view.container.querySelector("[data-chat-switcher]"));
  await click(
    view.baseElement.querySelector('[data-chat-switcher-option="u3"]'),
  );
  expect(humanChat(view)).toBe("u3");
  expect(
    requests.filter(
      (r) => r.method === "GET" && r.path.startsWith("/api/users/u3/chat"),
    ).length,
  ).toBe(1);
  expect(backLabel(view)).toBe(en.t("sidebar.office"));

  await click(view.container.querySelector("[data-human-chat-back]"));
  expect(humanChat(view)).toBeNull();
  expect(fab(view)).not.toBeNull();
});

// Task 5b055cf3: the button shows in every room and opens the chat of the
// room in view.
it("on a phone, the chat button in a room opens that room's chat", async () => {
  seedOffice();
  const view = await phone();
  await click(
    view.container.querySelector<HTMLButtonElement>(
      '[data-room-tab-button="r2"]',
    ),
  );
  // The condition: the room is in view, not the lobby.
  expect(
    view.container
      .querySelector('[data-room-tab-button="r2"]')
      ?.closest("[data-active-room-tab]") !== null,
  ).toBe(true);
  expect(fab(view)).not.toBeNull();
  await click(fab(view));
  expect(humanChat(view)).toBe("room:r2");
});

// U4: without room chats (a permission pack without the area) the button
// opens a 1:1 chat; with no human chat at all there is no button.
it("on a phone, without room chats the chat button opens a 1:1 chat, and without any chat it is gone", async () => {
  seedOffice();
  setRoomChats(null);
  const view = await phone();
  await click(fab(view));
  expect(humanChat(view)).toBe("u3");
  view.unmount();

  setMembers([]);
  setMemberDms(undefined);
  const bare = await phone();
  expect(fab(bare)).toBeNull();
});
