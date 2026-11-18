// The desktop sidebar's head while it loads (task 73b5c130): the Inbox
// badge's hold ends when the asks read fails, and the head's drawn widths are
// stored on a page hide. Split from ui/App.chat-sidebar-head.dom.test.tsx,
// which holds the placeholders, because the 5 s cap is per file. The parse
// checks are in ui/chat-sidebar.test.ts.
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

const { act } = await import("@testing-library/react");
const { ask, holdAsks, scout, setAsks, setUpChatSidebarTests } =
  await import("./test-support/chat-sidebar-fixture.tsx");
const { frame, fullState, hidePage, mount, selfFrame, sessionContext, size } =
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
const storedHead = (): unknown => {
  const raw = window.localStorage.getItem(SHAPE_KEY);
  return raw === null ? null : (JSON.parse(raw) as { head?: unknown }).head;
};

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

// Let GET /api/asks, sent after full_state, land.
const asksLand = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function boot(): Promise<View> {
  const view = await mount();
  await frame(sessionContext);
  await frame(selfFrame([]));
  return view;
}

it("ends the badge hold when the asks read fails, and a reconnect does not bring the placeholders back", async () => {
  storeHead({ name: 117, working: 64, inbox: 22 });
  setAsks([ask("q1", scout.id)]);
  const first = holdAsks();
  const view = await boot();
  await frame(workingState);
  expect(held(view).badge).toBe("22px");

  // The read fails: no placeholder and no badge (nothing is known).
  await first.release(true);
  expect(held(view)).toEqual(NONE);
  expect(realBadge(view)).toBeNull();

  // A reconnect: full_state again, and the asks are read again. While that
  // read waits, the head keeps its real parts, with no placeholder.
  const again = holdAsks();
  await frame(workingState);
  expect(held(view)).toEqual(NONE);
  expect(realName(view)?.textContent).toBe(fullState.office.name);
  expect(realWorking(view)).not.toBeNull();
  await again.release();
  expect(held(view)).toEqual(NONE);
  expect(realBadge(view)?.textContent).toBe("1");
});

it("stores the head's drawn widths on a page hide once the state is in, the badge's only once the asks are read, 0 for a part not drawn, and the next load holds them", async () => {
  const before = { name: 50, working: 40, inbox: 20 };
  storeHead(before);
  setAsks([ask("q1", scout.id)]);
  const asks = holdAsks();
  let view = await boot();
  // The lists need a place for the shape to be stored at all.
  const lists = () => inNav(view, '[data-sidebar-block="lists"]')!;

  // Before full_state the head is placeholders: nothing is measured.
  expect(held(view)).toEqual({ name: "50px", working: "40px", badge: "20px" });
  for (const part of ["name", "working", "badge"] as const)
    size(placeholder(view, part)!, 99);
  size(lists(), 240, 300);
  await hidePage();
  expect(storedHead()).toEqual(before);

  // full_state, the asks still being read: the name and the count are
  // measured; no badge yet says nothing, so the stored badge width stays.
  await frame(workingState);
  expect(held(view)).toEqual({ name: null, working: null, badge: "20px" });
  size(realName(view)!, 103.4);
  size(realWorking(view)!, 61);
  size(lists(), 240, 300);
  await hidePage();
  expect(storedHead()).toEqual({ name: 103, working: 61, inbox: 20 });

  await asks.release();
  expect(realBadge(view)).not.toBeNull();
  size(realBadge(view)!, 18);
  await hidePage();
  expect(storedHead()).toEqual({ name: 103, working: 61, inbox: 18 });
  view.unmount();

  // The next load holds them.
  view = await boot();
  expect(held(view)).toEqual({ name: "103px", working: "61px", badge: "18px" });

  // Nothing working and no open ask: both stored as 0.
  setAsks([]);
  await frame(fullState);
  await asksLand();
  expect(realWorking(view)).toBeNull();
  expect(realBadge(view)).toBeNull();
  size(realName(view)!, 88);
  size(lists(), 240, 300);
  await hidePage();
  expect(storedHead()).toEqual({ name: 88, working: 0, inbox: 0 });
});
