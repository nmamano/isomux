// A human chat full screen (task 019e4d7c), through the real App, store and
// socket shim: each chat keeps its own draft; a failed page load shows the
// error and Retry loads again, and the error stays with its chat; a chat
// opened from the sidebar puts the caret in its message box. Split from
// ui/App.human-chat-view.dom.test.tsx, which holds the peer: the header, the
// settings and a removed peer, because the 5 s cap is per file. The setup is
// in ui/test-support/chat-sidebar-fixture.tsx.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { translatorFor } = await import("../shared/i18n/translate.ts");
const { primaryPointer } = await import("./test-support/pointer.ts");
const {
  boot,
  click,
  memberWire,
  requests,
  setDmFail,
  setMemberDms,
  setMembers,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const en = translatorFor("en");

// Bea (u3) is a member with a chat; Zed (u9) was removed and has one.
function seedOffice(): void {
  setMembers([memberWire("u3", "Bea")]);
  setMemberDms([
    {
      peerId: "u3",
      peerName: "Bea",
      removed: false,
      readPointer: null,
      unread: 0,
      lastAt: 100,
    },
    {
      peerId: "u9",
      peerName: "Zed",
      removed: true,
      readPointer: null,
      unread: 0,
      lastAt: 10,
    },
  ]);
}

const memberRow = (view: View, id: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-member="${id}"]`,
  );
const chatRoot = (view: View) =>
  view.container.querySelector<HTMLElement>("[data-human-chat]");
const composer = (view: View) =>
  chatRoot(view)?.querySelector<HTMLTextAreaElement>("textarea") ?? null;

async function type(view: View, text: string): Promise<void> {
  const box = composer(view);
  expect(box).not.toBeNull();
  await act(async () => fireEvent.change(box!, { target: { value: text } }));
}

// Each room chat row, by room (task 5b055cf3).
const roomRow = (view: View, roomId: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-nav="room-chat"][data-room-chat="${roomId}"]`,
  );

it("each chat keeps its own draft, each room's chat its own", async () => {
  seedOffice();
  const view = await boot();
  await click(memberRow(view, "u3"));
  await type(view, "to bea");
  await click(roomRow(view, "lobby"));
  expect(chatRoot(view)?.getAttribute("data-human-chat")).toBe("room:lobby");
  expect(composer(view)?.value).toBe("");
  await type(view, "to all");
  await click(roomRow(view, "r1"));
  expect(chatRoot(view)?.getAttribute("data-human-chat")).toBe("room:r1");
  expect(composer(view)?.value).toBe("");
  await type(view, "to the first room");

  await click(memberRow(view, "u3"));
  expect(composer(view)?.value).toBe("to bea");
  await click(roomRow(view, "lobby"));
  expect(composer(view)?.value).toBe("to all");
  await click(roomRow(view, "r1"));
  expect(composer(view)?.value).toBe("to the first room");
});

it("a failed page load shows the error, and Retry loads the page again", async () => {
  seedOffice();
  setDmFail(true);
  const view = await boot();
  await click(memberRow(view, "u3"));
  await act(async () => {});
  const loads = () =>
    requests.filter(
      (r) => r.method === "GET" && r.path.startsWith("/api/users/u3/chat"),
    ).length;
  expect(loads()).toBe(1);
  expect(chatRoot(view)?.querySelector('[role="alert"]')).not.toBeNull();

  setDmFail(false);
  const retry = [...(chatRoot(view)?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent === en.t("membersChat.retry"),
  );
  await click(retry ?? null);
  await act(async () => {});
  expect(loads()).toBe(2);
  expect(chatRoot(view)?.querySelector('[role="alert"]')).toBeNull();
});

it("a failed load's error stays with its chat: a switch to a loaded chat shows none", async () => {
  seedOffice();
  setMembers([memberWire("u3", "Bea"), memberWire("u4", "Cid")]);
  const view = await boot();
  await click(memberRow(view, "u3"));
  await act(async () => {});
  expect(chatRoot(view)?.querySelector('[role="alert"]')).toBeNull();

  setDmFail(true);
  await click(memberRow(view, "u4"));
  await act(async () => {});
  expect(chatRoot(view)?.getAttribute("data-human-chat")).toBe("u4");
  expect(chatRoot(view)?.querySelector('[role="alert"]')).not.toBeNull();

  // Bea's page is held: no new load, and no error from Cid's.
  await click(memberRow(view, "u3"));
  await act(async () => {});
  expect(chatRoot(view)?.getAttribute("data-human-chat")).toBe("u3");
  expect(chatRoot(view)?.querySelector('[role="alert"]')).toBeNull();
});

// Task e8ab0be5 (Nil, 2026-11-13: clicking a member in the sidebar should
// focus the input box to start typing). With a mouse, each chat opened from
// the sidebar takes the caret, so the member types at once. A touch device
// skips it (ui/touch-focus.dom.test.tsx).
it("a chat opened from the sidebar puts the caret in its message box", async () => {
  seedOffice();
  const undo = primaryPointer(false);
  try {
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(false);
    const view = await boot();
    const opens: [string, HTMLButtonElement | null][] = [
      ["u3", memberRow(view, "u3")],
      ["room:lobby", roomRow(view, "lobby")],
    ];
    for (const [id, row] of opens) {
      (document.activeElement as HTMLElement | null)?.blur?.();
      expect(document.activeElement === document.body).toBe(true);
      await click(row);
      expect(chatRoot(view)?.getAttribute("data-human-chat")).toBe(id);
      const box = composer(view);
      expect(box === null).toBe(false);
      expect(document.activeElement === box).toBe(true);
    }
  } finally {
    undo();
  }
});
