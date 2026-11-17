// The office bar's counts row and the phone menu's dot while the office loads
// (task 73b5c130; AGENTS.md "UI rules": a view keeps its layout while it
// loads). The working and error counts wait for full_state; the menu's dot
// (any badge, such as new asks) also waits for the first GET /api/asks.
// Until then the counts row draws a dim bar of its stored width, and the
// menu trigger a dim dot when the stored shape had one; a row stored as 0
// draws none. Stored in the office shape ("isomux-office-shape") on a page
// hide, as the tabs and desks are. The parse checks are in
// ui/office-shape.test.ts. Hooks and setup:
// ui/test-support/office-shape-fixture.tsx, and these agreed at the stub
// (2026-11-17):
//   [data-bar-counts]            the counts row, phone header and desktop bar
//   [data-bar-counts-skeleton]   its placeholder, width in style
//   [data-nav-dot]               the menu trigger's real dot
//   [data-nav-dot-skeleton]      its placeholder

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { initialState } = await import("./store.tsx");
const { ask, holdAsks, scout, setAsks, setUpChatSidebarTests, setWindowWidth } =
  await import("./test-support/chat-sidebar-fixture.tsx");
const {
  SHAPE,
  frame,
  fullState,
  hidePage,
  mount,
  one,
  selfFrame,
  sessionContext,
  size,
  store,
  stored,
} = await import("./test-support/office-shape-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;
type OfficeShape = import("./office-shape.ts").OfficeShape;

setUpChatSidebarTests();

// full_state with Scout (r1, in view) working.
const workingState = {
  ...fullState,
  agents: fullState.agents.map((a) =>
    a.id === scout.id ? { ...a, state: "thinking" } : a,
  ),
};

// Let GET /api/asks, sent after full_state, land.
const asksLand = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

// The office on a 390 px phone, the store started as a phone (it reads the
// width once at import; see bootPhone in the sidebar fixture).
async function bootPhone(): Promise<View> {
  setWindowWidth(390);
  const was = initialState.isMobile;
  initialState.isMobile = true;
  try {
    const view = await mount();
    await frame(sessionContext);
    await frame(selfFrame([]));
    return view;
  } finally {
    initialState.isMobile = was;
  }
}

const held = (view: View) => ({
  counts: one(view, "[data-bar-counts-skeleton]")?.style.width ?? null,
  dot: one(view, "[data-nav-dot-skeleton]") !== null,
});
// The counts row's drawn counts: 0 while it is a placeholder or empty.
const countsShown = (view: View) =>
  one(view, "[data-bar-counts]")?.childElementCount ?? 0;
const realDot = (view: View) => one(view, "[data-nav-dot]");

const phoneShape = (counts: number, dot: boolean): OfficeShape => ({
  ...SHAPE,
  counts,
  dot,
});

it("on a phone, holds the counts row and the menu dot until their data arrives: the counts at full_state, the dot once the asks are read", async () => {
  store(phoneShape(57, true));
  setAsks([ask("q1", scout.id)]);
  const asks = holdAsks();
  const view = await bootPhone();

  expect(held(view)).toEqual({ counts: "57px", dot: true });
  expect(
    one(view, "[data-bar-counts-skeleton]")!.getAttribute("aria-hidden"),
  ).toBe("true");
  expect(countsShown(view)).toBe(0);
  expect(realDot(view)).toBeNull();

  // full_state: the real count; the asks are still being read, so the dot
  // keeps its placeholder.
  await frame(workingState);
  expect(held(view)).toEqual({ counts: null, dot: true });
  expect(countsShown(view)).toBe(1);
  expect(realDot(view)).toBeNull();

  await asks.release();
  expect(held(view)).toEqual({ counts: null, dot: false });
  expect(realDot(view)).not.toBeNull();
});

it("on a phone, draws no placeholder for a counts row stored as 0, no dot when none was stored, nor for a shape stored before task 73b5c130", async () => {
  store(phoneShape(0, false));
  let view = await bootPhone();
  expect(held(view)).toEqual({ counts: null, dot: false });
  view.unmount();

  const { counts: _c, dot: _d, ...old } = phoneShape(57, true);
  store(old);
  view = await bootPhone();
  expect(held(view)).toEqual({ counts: null, dot: false });
  view.unmount();

  // A failed asks read ends the dot's hold too.
  store(phoneShape(0, true));
  const asks = holdAsks();
  view = await bootPhone();
  await frame(fullState);
  expect(held(view)).toEqual({ counts: null, dot: true });
  await asks.release(true);
  expect(held(view)).toEqual({ counts: null, dot: false });
  expect(realDot(view)).toBeNull();
});

it("on a desktop with the sidebar hidden, holds the office bar's counts row in its stored width until full_state", async () => {
  window.localStorage.setItem("isomux-chat-sidebar", "closed");
  store(phoneShape(64, false));
  const view = await mount();
  await frame(sessionContext);
  await frame(selfFrame([]));
  expect(held(view)).toEqual({ counts: "64px", dot: false });
  expect(countsShown(view)).toBe(0);
  await frame(workingState);
  expect(held(view).counts).toBeNull();
  expect(countsShown(view)).toBe(1);
});

it("on a phone, stores the counts row's width once the state is in, and whether the menu drew its dot once the asks are read, on a page hide", async () => {
  store(phoneShape(20, true));
  setAsks([ask("q1", scout.id)]);
  const asks = holdAsks();
  let view = await bootPhone();
  // Before full_state: nothing is measured.
  expect(held(view)).toEqual({ counts: "20px", dot: true });
  size(one(view, "[data-bar-counts-skeleton]")!, 99);
  await hidePage();
  expect((stored() as OfficeShape).counts).toBe(20);
  expect((stored() as OfficeShape).dot).toBe(true);

  // full_state, the asks still being read: the counts are measured; no dot
  // yet says nothing, so the stored dot stays.
  await frame(workingState);
  expect(held(view)).toEqual({ counts: null, dot: true });
  size(one(view, "[data-bar-counts]")!, 56.6);
  await hidePage();
  expect((stored() as OfficeShape).counts).toBe(57);
  expect((stored() as OfficeShape).dot).toBe(true);

  await asks.release();
  expect(realDot(view)).not.toBeNull();
  await hidePage();
  expect((stored() as OfficeShape).counts).toBe(57);
  expect((stored() as OfficeShape).dot).toBe(true);
  view.unmount();

  // The next load holds them; with nothing working and no ask, 0 and no dot.
  setAsks([]);
  view = await bootPhone();
  expect(held(view)).toEqual({ counts: "57px", dot: true });
  await frame(fullState);
  await asksLand();
  expect(countsShown(view)).toBe(0);
  expect(realDot(view)).toBeNull();
  await hidePage();
  expect((stored() as OfficeShape).counts).toBe(0);
  expect((stored() as OfficeShape).dot).toBe(false);
});
