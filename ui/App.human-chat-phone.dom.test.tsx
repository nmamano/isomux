// The lobby and the human chats (task 019e4d7c; Nil, 2026-11-12: "i'd obsolete
// the lobby pannel, and make human chats full screen"): on a desktop the
// lobby has no Members chat panel and no chat button (the sidebar lists the
// chats); on a phone the lobby's chat button opens the same full-screen chat,
// counts the unread of every human chat, and the chat's title switches
// between them; the header's Back returns to the lobby. The setup is in
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
const switcherOptions = (view: View) =>
  [...view.baseElement.querySelectorAll("[data-chat-switcher-option]")].map(
    (o) => o.getAttribute("data-chat-switcher-option"),
  );

it("on a desktop, the lobby has no Members chat panel, no chat button and no unread dot on its tab", async () => {
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
    view.container.querySelector("[data-lobby-tab] [data-lobby-unread]"),
  ).toBeNull();
  expect(
    view.container.querySelector(
      'nav[data-chat-sidebar] button[data-sidebar-member="u3"] [data-sidebar-badge]',
    ),
  ).not.toBeNull();
});

it("on a phone, the lobby's chat button counts Members chat and every 1:1 chat", async () => {
  seedOffice();
  const view = await phone();
  await act(async () => {
    const { shimEmit } = await import("./ws.ts");
    shimEmit({
      type: "members_chat_message",
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
  expect(
    fab(view)?.querySelector("[data-lobby-unread]")?.getAttribute("aria-label"),
  ).toBe(en.tn("membersChat.unreadCount", 3));
});

it("on a phone, the chat button opens Members chat full screen, the title switches to a 1:1 chat, and Back returns to the lobby", async () => {
  seedOffice();
  const view = await phone();
  expect(fab(view)).not.toBeNull();
  expect(humanChat(view)).toBeNull();

  await click(fab(view));
  expect(humanChat(view)).toBe("members");
  // Full screen: no dialog over the lobby.
  expect(view.baseElement.querySelector('[role="dialog"]')).toBeNull();
  expect(fab(view)).toBeNull();

  await click(view.container.querySelector("[data-chat-switcher]"));
  expect(switcherOptions(view)).toEqual(["members", "u3", "u4"]);
  await click(
    view.baseElement.querySelector('[data-chat-switcher-option="u3"]'),
  );
  expect(humanChat(view)).toBe("u3");
  expect(
    requests.filter(
      (r) => r.method === "GET" && r.path.startsWith("/api/users/u3/chat"),
    ).length,
  ).toBe(1);

  await click(view.container.querySelector("[data-human-chat-back]"));
  expect(humanChat(view)).toBeNull();
  expect(fab(view)).not.toBeNull();
});
