// A chat opened from a page follows its agent into the agent's room (task
// 1faeb586), through the real App and store: out of that chat, the office
// shows the agent's room, not the room the member was in. The Inbox doors
// here; the Apps page and a chat's agent link in
// ui/App.agent-chat-room-links.dom.test.tsx, one file each because the 5 s cap
// is per file. The ask's own agent link is in ui/App.ask-agent-link.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { en } = await import("../shared/i18n/en.ts");
const { shimEmit } = await import("./ws.ts");
const {
  activeRoom,
  backScreen,
  boot,
  escape,
  setAsks,
  setPages,
  setUpAgentLinkTests,
} = await import("./test-support/agent-link-fixture.tsx");
type AskEntry = import("../shared/types.ts").AskEntry;
type PagerEntry = import("../shared/types.ts").PagerEntry;
type TaskItem = import("../shared/types.ts").TaskItem;
type View = import("./test-support/agent-link-fixture.tsx").View;

setUpAgentLinkTests();

const ask = (id: string, agentId: string, link?: string): AskEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...(link ? { link } : {}),
});

// The office opens on the Lobby: go to the first room, away from the room of
// the agents the doors lead to.
async function enterFirstRoom(view: View) {
  const tab = view.container.querySelector<HTMLElement>(
    '[data-room-tab-button="r1"]',
  );
  expect(tab).not.toBeNull();
  await act(async () => fireEvent.click(tab!));
  expect(activeRoom(view)).toBe("r1");
}

const inboxOpen = (view: View) =>
  view.container.querySelector('[role="tablist"]') !== null;

// Open the Inbox from the office bar, on its Asks tab.
async function openInbox(view: View) {
  const inbox = [...view.container.querySelectorAll("button")].find(
    (b) =>
      b.querySelector(".nav-action-label")?.textContent === en["nav.inbox"],
  )!;
  await act(async () => fireEvent.click(inbox));
  expect(inboxOpen(view)).toBe(true);
}

// The Inbox's chat panel (task e3c25581) opens the agent's full chat.
async function openFullChat(view: View) {
  const button = view.container.querySelector<HTMLButtonElement>(
    "[data-agent-chat-panel] button[data-agent-chat-full]",
  );
  expect(button).not.toBeNull();
  await act(async () => fireEvent.click(button!));
}

// Out of the chat named `name`, the office shows `room`, at the front or on
// its back screen.
async function leaveChat(view: View, name: string, room: string, back = false) {
  expect(document.title).toContain(name);
  expect(inboxOpen(view)).toBe(false);
  await escape();
  expect(document.title).not.toContain(name);
  expect(activeRoom(view)).toBe(room);
  expect(backScreen(view)).toBe(back);
}

it("leaves a chat opened from the Inbox's chat panel, after Discuss in chat, for the agent's room", async () => {
  setAsks([ask("q1", "a2")]);
  const view = await boot();
  await enterFirstRoom(view);
  await openInbox(view);
  const discuss = view.container.querySelector<HTMLButtonElement>(
    '[data-ask="q1"] button[data-ask-about]',
  );
  expect(discuss).not.toBeNull();
  await act(async () => fireEvent.click(discuss!));
  await openFullChat(view);
  await leaveChat(view, "Faraway", "r2");
  view.unmount();
});

it("leaves a back agent's chat opened from the Inbox for its room's back screen", async () => {
  setAsks([ask("q1", "a3")]);
  const view = await boot();
  await enterFirstRoom(view);
  expect(backScreen(view)).toBe(false);
  await openInbox(view);
  // The ask's agent name opens the panel too.
  const name = view.container.querySelector<HTMLButtonElement>(
    '[data-asks-agent="a3"]',
  );
  expect(name).not.toBeNull();
  await act(async () => fireEvent.click(name!));
  await openFullChat(view);
  await leaveChat(view, "Backbencher", "r2", true);
  view.unmount();
});

it("leaves a chat opened from a page on the Inbox's Pages tab for the agent's room", async () => {
  const page: PagerEntry = {
    id: "p1",
    createdAt: 1_000,
    lastRaisedAt: 1_000,
    raiseCount: 1,
    source: { kind: "agent", agentId: "a2", name: "Faraway", roomId: "r2" },
    targetUserId: "u1",
    title: "Title p1",
    state: "open",
    delivery: { state: "delivered", sends: 1 },
  };
  setPages([page]);
  const view = await boot();
  await enterFirstRoom(view);
  await openInbox(view);
  // A notification of a page opens this tab too.
  const tab = view.container.querySelector<HTMLElement>(
    '[role="tab"][data-inbox-tab="pager"]',
  );
  expect(tab).not.toBeNull();
  await act(async () => fireEvent.click(tab!));
  const source =
    view.container.querySelector<HTMLButtonElement>(".pager-source-link");
  expect(source).not.toBeNull();
  await act(async () => fireEvent.click(source!));
  await leaveChat(view, "Faraway", "r2");
  view.unmount();
});

it("opens a chat from the Tasks page stacked on the Inbox over both pages, and leaves it for the agent's room", async () => {
  setAsks([ask("q1", "a1", "/tasks")]);
  const view = await boot();
  await enterFirstRoom(view);
  await act(async () => {
    shimEmit({
      type: "tasks",
      tasks: [
        {
          id: "0a1b2c3d",
          title: "Faraway's task",
          status: "open",
          createdBy: "Faraway",
          createdByAgentId: "a2",
          createdAt: 1_000,
          // A task of the first room, which the board shows by default.
          roomId: "r1",
          version: "v1",
        } as TaskItem,
      ],
    } as never);
  });
  await openInbox(view);
  // The ask's link opens Tasks on top of the Inbox.
  const link = view.container.querySelector<HTMLButtonElement>(
    '[data-ask="q1"] [data-ask-office-link]',
  );
  expect(link).not.toBeNull();
  await act(async () => fireEvent.click(link!));
  const board = view.container.querySelector("[data-tasks-page]");
  expect(board).not.toBeNull();
  // The task's creator links to its chat.
  const creator = [...board!.querySelectorAll<HTMLElement>("span")].find(
    (s) => s.textContent === "Faraway" && s.style.cursor === "pointer",
  );
  expect(creator).toBeDefined();
  await act(async () => fireEvent.click(creator!));
  // Both pages closed: the chat shows, not the Inbox that was under Tasks.
  expect(view.container.querySelector("[data-tasks-page]")).toBeNull();
  await leaveChat(view, "Faraway", "r2");
  view.unmount();
});
