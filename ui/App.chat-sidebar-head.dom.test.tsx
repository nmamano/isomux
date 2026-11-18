// The desktop sidebar's head while it loads (task 73b5c130; AGENTS.md "UI
// rules": a view keeps its layout while it loads). The office name and the
// working count wait for full_state; the Inbox badge also waits for the
// first GET /api/asks, which the store sends after it. Until then each one
// draws a dim placeholder of the width this device last drew it (stored with
// the lists' shape, "isomux-chat-sidebar-shape", on a page hide); a part
// stored as 0 (not drawn) draws none. A failed asks read and the stored
// widths are in ui/App.chat-sidebar-head-store.dom.test.tsx. The parse checks are in
// ui/chat-sidebar.test.ts; the lists' placeholders in
// ui/App.chat-sidebar-skeleton.dom.test.tsx.
//
// Hooks agreed with the worker at the stub (2026-11-17):
//   [data-sidebar-skeleton="name" | "working" | "badge"]  the placeholders,
//                                    their width in style; the badge one in
//                                    the Inbox row ([data-sidebar-nav="asks"])
//   [data-sidebar-office-name]       the real office name (measured)
//   [data-sidebar-working]           the real working count (measured)
//   [data-sidebar-badge] in the Inbox row   the real badge (measured)

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { CHAT_SIDEBAR_SHAPE_DEFAULT } = await import("./chat-sidebar.ts");
const { ask, holdAsks, scout, setAsks, setUpChatSidebarTests } =
  await import("./test-support/chat-sidebar-fixture.tsx");
const { frame, fullState, mount, selfFrame, sessionContext } =
  await import("./test-support/office-shape-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;
type ChatSidebarShapeHead = import("./chat-sidebar.ts").ChatSidebarShapeHead;

setUpChatSidebarTests();

const SHAPE_KEY = "isomux-chat-sidebar-shape";
// A lists block as stored by an earlier load; its drawing is not under test.
const LISTS = { H: 26, items: [{ kind: "header", top: 0, h: 26 }] };
const storeHead = (head: ChatSidebarShapeHead) =>
  window.localStorage.setItem(
    SHAPE_KEY,
    JSON.stringify({ lists: LISTS, head }),
  );
const inNav = (view: View, selector: string) =>
  view.container.querySelector<HTMLElement>(
    `nav[data-chat-sidebar] ${selector}`,
  );
const placeholder = (view: View, part: "name" | "working" | "badge") =>
  inNav(
    view,
    part === "badge"
      ? `[data-sidebar-nav="asks"] [data-sidebar-skeleton="badge"]`
      : `[data-sidebar-skeleton="${part}"]`,
  );
// Each placeholder's width, or null when it is not drawn.
const held = (view: View) => ({
  name: placeholder(view, "name")?.style.width ?? null,
  working: placeholder(view, "working")?.style.width ?? null,
  badge: placeholder(view, "badge")?.style.width ?? null,
});
const NONE = { name: null, working: null, badge: null };
const realName = (view: View) => inNav(view, "[data-sidebar-office-name]");
const realWorking = (view: View) => inNav(view, "[data-sidebar-working]");
const realBadge = (view: View) =>
  inNav(view, `[data-sidebar-nav="asks"] [data-sidebar-badge]`);

// full_state with Scout working.
const workingState = {
  ...fullState,
  agents: fullState.agents.map((a) =>
    a.id === scout.id ? { ...a, state: "thinking" } : a,
  ),
};

async function boot(): Promise<View> {
  const view = await mount();
  await frame(sessionContext);
  await frame(selfFrame([]));
  return view;
}

it("holds the office name, working count and Inbox badge in their stored widths; the name and count draw at full_state, the badge once the asks are read", async () => {
  storeHead({ name: 117, working: 64, inbox: 22 });
  setAsks([ask("q1", scout.id)]);
  const asks = holdAsks();
  const view = await boot();

  // Before full_state: three placeholders, nothing of the data, nothing a
  // screen reader reads.
  expect(held(view)).toEqual({ name: "117px", working: "64px", badge: "22px" });
  for (const part of ["name", "working", "badge"] as const)
    expect(placeholder(view, part)!.getAttribute("aria-hidden"), part).toBe(
      "true",
    );
  expect(realWorking(view)).toBeNull();
  expect(realBadge(view)).toBeNull();

  // full_state: the real name and count; the asks are still being read, so
  // the badge keeps its placeholder (no gap, no early 0).
  await frame(workingState);
  expect(held(view)).toEqual({ name: null, working: null, badge: "22px" });
  expect(realName(view)?.textContent).toBe(fullState.office.name);
  expect(realWorking(view)).not.toBeNull();
  expect(realWorking(view)!.textContent).toContain("1");
  expect(realBadge(view)).toBeNull();

  // The asks arrive: the real badge in the placeholder's place.
  await asks.release();
  expect(held(view)).toEqual(NONE);
  expect(realBadge(view)?.textContent).toBe("1");
});

it("draws no working or badge placeholder for a part stored as not drawn, and the default head on a first visit", async () => {
  // A first visit: the default name width only.
  let view = await boot();
  expect(held(view)).toEqual({
    name: `${CHAT_SIDEBAR_SHAPE_DEFAULT.head.name}px`,
    working: null,
    badge: null,
  });
  view.unmount();

  // A shape stored before task 73b5c130 (no head): the same.
  window.localStorage.setItem(SHAPE_KEY, JSON.stringify({ lists: LISTS }));
  view = await boot();
  expect(held(view)).toEqual({
    name: `${CHAT_SIDEBAR_SHAPE_DEFAULT.head.name}px`,
    working: null,
    badge: null,
  });
  view.unmount();

  // A head stored with nothing working and no badge.
  storeHead({ name: 80, working: 0, inbox: 0 });
  view = await boot();
  expect(held(view)).toEqual({ name: "80px", working: null, badge: null });
  await frame(fullState);
  expect(held(view)).toEqual(NONE);
  expect(realWorking(view)).toBeNull();
});
