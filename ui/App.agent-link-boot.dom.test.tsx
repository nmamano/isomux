// An agent's chat address, /agents/<agentId>, loaded in the address bar (task
// 680747d8: the app widget's agent name opens it in a new tab). It opens that
// chat in the agent's room over whatever the saved spot would reopen, and the
// address bar shows "/": a chat is not a route (ruling 3 of
// internal-docs/url-routing-loop.md). The same path as an ask's link is
// covered in App.ask-agent-link.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { loadSavedView, saveView } = await import("./view-persistence.ts");
const {
  activeRoom,
  backbencher,
  backScreen,
  boot,
  escape,
  faraway,
  fullState,
  scout,
  setUpAgentLinkTests,
} = await import("./test-support/agent-link-fixture.tsx");

setUpAgentLinkTests();

// The spot a reload would reopen: Scout's chat in the first room, with the
// task page over it.
const SAVED_SPOT = {
  roomId: "r1",
  agentId: "a1",
  panel: "tasks",
  lobby: false,
} as const;
// The saved spot follows the office, so it tells whether the lobby is open.
const lobbyShowing = () => loadSavedView("member")?.lobby ?? null;

it("opens the chat the address names, over the saved room, chat and page", async () => {
  saveView("member", SAVED_SPOT);
  const view = await boot("/agents/a2");
  expect(document.title).toContain("Faraway");
  // No page is open over the chat, and the chat does not show its own path.
  expect(window.location.pathname).toBe("/");
  await escape();
  expect(document.title).not.toContain("Faraway");
  expect(activeRoom(view)).toBe("r2");
  expect(lobbyShowing()).toBe(false);
  view.unmount();
});

it("opens the chat the address names when nothing is saved, not the lobby", async () => {
  const view = await boot("/agents/a2");
  expect(document.title).toContain("Faraway");
  expect(window.location.pathname).toBe("/");
  await escape();
  expect(activeRoom(view)).toBe("r2");
  expect(lobbyShowing()).toBe(false);
  view.unmount();
});

it("opens a back-room agent's chat from its address, over the back screen", async () => {
  const view = await boot("/agents/a3/");
  expect(document.title).toContain("Backbencher");
  expect(window.location.pathname).toBe("/");
  await escape();
  expect(activeRoom(view)).toBe("r2");
  expect(backScreen(view)).toBe(true);
  view.unmount();
});

it("reopens the saved spot at a path below an agent's address", async () => {
  saveView("member", { ...SAVED_SPOT, panel: null });
  const view = await boot("/agents/a2/x");
  expect(document.title).toContain("Scout");
  expect(window.location.pathname).toBe("/");
  view.unmount();
});

// "a9" stands for an agent in a room the member cannot see: the member's state
// does not hold it, so the address reopens the saved spot, as "/" does.
it("tries the address once: an agent that appears later does not take the view", async () => {
  saveView("member", { ...SAVED_SPOT, panel: null });
  const view = await boot("/agents/a9");
  expect(document.title).toContain("Scout");
  expect(window.location.pathname).toBe("/");
  // A reconnect brings the agent the address named.
  const newcomer = { ...faraway, id: "a9", name: "Newcomer" };
  await act(async () => fullState([scout, faraway, backbencher, newcomer]));
  await act(async () => {});
  expect(document.title).toContain("Scout");
  expect(document.title).not.toContain("Newcomer");
  view.unmount();
});
