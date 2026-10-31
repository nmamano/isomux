// The Inbox tray on the office scene's wall (task b8d5e90f), through the real
// App and store: in a room it shows the bar entry's badge and opens the tab the
// bar entry opens; the lobby draws no tray (task 878da607); in the landing-page
// embed, where the bar is hidden, it shows the count but does not open the
// Inbox. The bar entry itself is in ui/App.inbox.dom.test.tsx, the setup in
// ui/test-support/inbox-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { ask, boot, inboxButton, page, setAsks, setPages, setUpInboxTests } =
  await import("./test-support/inbox-fixture.tsx");
const { saveView } = await import("./view-persistence.ts");
const { PRODUCTION_FEATURES } = await import("../shared/features.ts");
type View = import("./test-support/inbox-fixture.tsx").View;

setUpInboxTests();

// The fixture lands in the lobby (no saved view); a saved view opens room r1.
function inRoom() {
  saveView("member", {
    roomId: "r1",
    agentId: null,
    panel: null,
    lobby: false,
  });
}

const tray = (view: View) =>
  view.container.querySelector<SVGGElement>("svg [data-inbox-tray]");
const trayBadge = (view: View) =>
  tray(view)?.querySelector("[data-inbox-badge]")?.textContent ?? null;
const letters = (view: View) =>
  tray(view)?.querySelectorAll("[data-inbox-letter]").length ?? 0;
const barBadge = (view: View) =>
  inboxButton(view)?.querySelector(".nav-action-badge")?.textContent ?? null;
// The tray is drawn in room r1's walls, under room r1's title.
const inRoomWalls = (view: View) =>
  tray(view)?.closest('[data-turn="walls"]') != null &&
  document.title === "First room | Isomux";
// The lobby scene is drawn: the office name as title, and the scene's doors
// without a room's walls.
const inLobby = (view: View) =>
  document.title === "Test Office | Isomux" &&
  view.container.querySelector('svg[data-turn="doors"]') !== null &&
  view.container.querySelector('svg[data-turn="walls"]') === null;

it("in a room, shows the bar's count and opens the Asks tab while an ask is open", async () => {
  // Two visible asks (the fixture's third is in a hidden room) and one page.
  setPages([page("p1", "u1")]);
  inRoom();
  const view = await boot();
  expect(inRoomWalls(view)).toBe(true);
  expect(barBadge(view)).toBe("3");
  expect(trayBadge(view)).toBe(barBadge(view));
  expect(letters(view)).toBe(3);
  await act(async () => fireEvent.click(tray(view)!));
  expect(window.location.pathname).toBe("/inbox/asks");
});

it("in a room, shows the bar's count and opens the Pages tab when only pages are open", async () => {
  setAsks([]);
  setPages([page("p1", "u1")]);
  inRoom();
  const view = await boot();
  expect(inRoomWalls(view)).toBe(true);
  expect(barBadge(view)).toBe("1");
  expect(trayBadge(view)).toBe(barBadge(view));
  expect(letters(view)).toBe(1);
  await act(async () => fireEvent.click(tray(view)!));
  expect(window.location.pathname).toBe("/inbox/pages");
});

it("in the lobby, draws no tray while the bar counts open items", async () => {
  const view = await boot();
  expect(inLobby(view)).toBe(true);
  expect(barBadge(view)).toBe("2");
  expect(view.container.querySelector("[data-inbox-tray]")).toBeNull();
});

it("with nothing open, shows no badge and no letters, and still opens the Inbox", async () => {
  setAsks([]);
  inRoom();
  const view = await boot();
  expect(inRoomWalls(view)).toBe(true);
  expect(barBadge(view)).toBeNull();
  expect(tray(view)!.querySelector("[data-inbox-badge]")).toBeNull();
  expect(letters(view)).toBe(0);
  expect(tray(view)!.getAttribute("aria-label")).not.toBeNull();
  await act(async () => fireEvent.click(tray(view)!));
  expect(window.location.pathname).toBe("/inbox/asks");
});

it("caps the badge as the bar does, at three letters", async () => {
  setAsks(Array.from({ length: 120 }, (_, i) => ask(`q${i}`, "a1")));
  inRoom();
  const view = await boot();
  expect(barBadge(view)).toBe("99+");
  expect(trayBadge(view)).toBe(barBadge(view));
  expect(letters(view)).toBe(3);
});

it("in the embed, shows the count but does not open the Inbox", async () => {
  inRoom();
  const view = await boot("/", { ...PRODUCTION_FEATURES, embed: true });
  expect(inRoomWalls(view)).toBe(true);
  // The embed hides the bar; the two visible asks still show on the tray.
  expect(inboxButton(view)).toBeUndefined();
  expect(trayBadge(view)).toBe("2");
  expect(letters(view)).toBe(2);
  await act(async () => fireEvent.click(tray(view)!));
  expect(window.location.pathname).toBe("/");
  expect(tray(view)!.getAttribute("aria-label")).toBeNull();
});
