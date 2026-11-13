// The Inbox tray on the office scene's wall (task b8d5e90f), through the real
// App and store: in a room it holds one letter per open ask, up to three, and
// draws no count (task a4b04ffd); a click opens the Inbox;
// the lobby draws no tray (task 878da607); in the landing-page embed, where
// the bar is hidden, it shows the letters but does not open the Inbox. The bar
// entry itself is in ui/App.inbox.dom.test.tsx, the setup in
// ui/test-support/inbox-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { ask, boot, inboxButton, setAsks, setUpInboxTests } =
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
const letters = (view: View) =>
  tray(view)?.querySelectorAll("[data-inbox-letter]").length ?? 0;
// The tray draws no count: no text in the drawing (its tooltip is a <title>).
const trayText = (view: View) => tray(view)!.querySelectorAll("text").length;
const barBadge = (view: View) =>
  inboxButton(view)?.querySelector(".nav-action-badge")?.textContent ?? null;
// The tab title without the unseen count in front (task 91a69e4c; its format
// is in ui/inbox.test.ts).
const titleLabel = () => document.title.replace(/^\(\d+\) /, "");
// The tray is drawn in room r1's walls, under room r1's title.
const inRoomWalls = (view: View) =>
  tray(view)?.closest('[data-turn="walls"]') != null &&
  titleLabel() === "First room | Isomux";
// The lobby scene is drawn: the office name as title, and the scene's doors
// without a room's walls.
const inLobby = (view: View) =>
  titleLabel() === "Test Office | Isomux" &&
  view.container.querySelector('svg[data-turn="doors"]') !== null &&
  view.container.querySelector('svg[data-turn="walls"]') === null;

it("in a room, holds a letter per visible ask and opens the Asks view", async () => {
  // Two visible asks (the fixture's third is in a hidden room).
  inRoom();
  const view = await boot();
  expect(inRoomWalls(view)).toBe(true);
  expect(barBadge(view)).toBe("2");
  expect(letters(view)).toBe(2);
  expect(trayText(view)).toBe(0);
  await act(async () => fireEvent.click(tray(view)!));
  expect(window.location.pathname).toBe("/inbox/asks");
});

it("in the lobby, draws no tray while the bar counts open items", async () => {
  const view = await boot();
  expect(inLobby(view)).toBe(true);
  expect(barBadge(view)).toBe("2");
  expect(view.container.querySelector("[data-inbox-tray]")).toBeNull();
});

it("with nothing open, is empty and still opens the Inbox", async () => {
  setAsks([]);
  inRoom();
  const view = await boot();
  expect(inRoomWalls(view)).toBe(true);
  expect(barBadge(view)).toBeNull();
  expect(letters(view)).toBe(0);
  expect(trayText(view)).toBe(0);
  expect(tray(view)!.getAttribute("aria-label")).not.toBeNull();
  await act(async () => fireEvent.click(tray(view)!));
  expect(window.location.pathname).toBe("/inbox/asks");
});

it("holds at most three letters and no count, however many asks are open", async () => {
  setAsks(Array.from({ length: 120 }, (_, i) => ask(`q${i}`, "a1")));
  inRoom();
  const view = await boot();
  expect(barBadge(view)).toBe("99+");
  expect(letters(view)).toBe(3);
  expect(trayText(view)).toBe(0);
});

it("in the embed, holds the letters but does not open the Inbox", async () => {
  // One visible ask: one letter.
  setAsks([ask("q1", "a1")]);
  inRoom();
  const view = await boot("/", { ...PRODUCTION_FEATURES, embed: true });
  expect(inRoomWalls(view)).toBe(true);
  // The embed hides the bar; the tray still holds the ask's letter.
  expect(inboxButton(view)).toBeUndefined();
  expect(letters(view)).toBe(1);
  expect(trayText(view)).toBe(0);
  await act(async () => fireEvent.click(tray(view)!));
  expect(window.location.pathname).toBe("/");
  expect(tray(view)!.getAttribute("aria-label")).toBeNull();
});
