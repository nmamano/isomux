// A human chat full screen (task 019e4d7c), through the real App, store and
// socket shim: a 1:1 chat names the peer and sends to the peer's id; an owner
// gets the peer's settings, and Back from them returns to the chat; a removed
// peer's chat is read-only, and the live roster, not a stale summary, decides
// who is removed; the header names the peer before any page arrives.
// ui/App.human-chat-compose.dom.test.tsx holds the drafts, a failed page load
// and the caret. The setup is in ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  boot,
  click,
  goBack,
  memberWire,
  requests,
  setDmFail,
  setMemberDms,
  setMembers,
  setRole,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

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

it("a 1:1 chat names the peer and sends to the peer's id; a member gets no settings button", async () => {
  seedOffice();
  const view = await boot();
  await click(memberRow(view, "u3"));
  expect(chatRoot(view)?.getAttribute("data-human-chat")).toBe("u3");
  expect(chatRoot(view)?.textContent).toContain("Bea");
  expect(chatRoot(view)?.querySelector("[data-member-settings]")).toBeNull();

  await type(view, "lunch?");
  await act(async () => fireEvent.keyDown(composer(view)!, { key: "Enter" }));
  const posts = requests.filter(
    (r) => r.method === "POST" && /\/chat$/.test(r.path),
  );
  expect(posts.map((r) => [r.path, (r.body as { text: string }).text])).toEqual(
    [["/api/users/u3/chat", "lunch?"]],
  );
  // No room chat post.
  expect(
    requests.filter(
      (r) => r.method === "POST" && /^\/api\/rooms\/[^/]+\/chat$/.test(r.path),
    ).length,
  ).toBe(0);
});

it("an owner opens the peer's settings from the chat, and Back returns to the chat", async () => {
  seedOffice();
  setRole("owner");
  const view = await boot();
  await click(memberRow(view, "u3"));
  await click(chatRoot(view)?.querySelector("[data-member-settings]") ?? null);
  expect(
    view.container.querySelector("[data-testid='settings-content']"),
  ).not.toBeNull();
  expect(
    view.container.querySelector('[aria-current="true"]')?.textContent,
  ).toContain("Bea");
  expect(chatRoot(view)).toBeNull();

  await goBack();
  expect(chatRoot(view)?.getAttribute("data-human-chat")).toBe("u3");
});

it("a removed peer's chat is read-only", async () => {
  seedOffice();
  setRole("owner");
  const view = await boot();
  await click(memberRow(view, "u9"));
  expect(chatRoot(view)?.getAttribute("data-human-chat")).toBe("u9");
  expect(chatRoot(view)?.textContent).toContain("Zed");
  expect(chatRoot(view)?.querySelector("[data-peer-removed]")).not.toBeNull();
  expect(composer(view)).toBeNull();
  // No settings page to open for a removed member.
  expect(chatRoot(view)?.querySelector("[data-member-settings]")).toBeNull();
});

it("names the peer in the header before any page arrives", async () => {
  seedOffice();
  setMembers([memberWire("u3", "Bea"), memberWire("u2", "Ann")]);
  setDmFail(true);
  const view = await boot();
  // Ann has no chat yet, and her page does not load.
  await click(memberRow(view, "u2"));
  await act(async () => {});
  expect(chatRoot(view)?.getAttribute("data-human-chat")).toBe("u2");
  expect(chatRoot(view)?.textContent).toContain("Ann");
  expect(composer(view)?.getAttribute("placeholder")).toContain("Ann");
});

it("the live roster decides who is removed, not a stale summary", async () => {
  // Bea was restored after the summary was made; Zed was removed after it.
  setMembers([memberWire("u3", "Bea")]);
  setMemberDms([
    {
      peerId: "u3",
      peerName: "Bea",
      removed: true,
      readPointer: null,
      unread: 0,
      lastAt: 100,
    },
    {
      peerId: "u9",
      peerName: "Zed",
      removed: false,
      readPointer: null,
      unread: 0,
      lastAt: 10,
    },
  ]);
  const view = await boot();
  await click(memberRow(view, "u3"));
  expect(chatRoot(view)?.querySelector("[data-peer-removed]")).toBeNull();
  expect(composer(view)).not.toBeNull();

  await click(memberRow(view, "u9"));
  expect(chatRoot(view)?.getAttribute("data-human-chat")).toBe("u9");
  expect(chatRoot(view)?.querySelector("[data-peer-removed]")).not.toBeNull();
  expect(composer(view)).toBeNull();
});
