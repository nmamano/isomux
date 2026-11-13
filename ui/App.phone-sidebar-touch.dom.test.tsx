// The phone drawer under a finger (task 3cced5be; Reviewer 1's build
// conditions, 2026-11-13). A swipe on the open drawer does not change the
// agent under it. A long press on an agent row opens its menu, which pins on
// a phone too; a finger that moves is a scroll, not a long press; the tap
// that ends a long press does not also open the chat, and the next tap does.
// The rest of the drawer is in ui/App.phone-sidebar.dom.test.tsx; the setup
// in ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  bootPhone,
  chatOpen,
  click,
  ranger,
  scout,
  setUpChatSidebarTests,
  viewWrites,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const drawer = (view: View) =>
  view.baseElement.querySelector("[data-phone-sidebar]");
const inDrawer = (view: View, selector: string) =>
  view.baseElement.querySelector<HTMLElement>(
    `[data-phone-sidebar] nav[data-chat-sidebar] ${selector}`,
  );
function showButton(view: View, scope = ""): HTMLButtonElement | null {
  const all = view.baseElement.querySelectorAll<HTMLButtonElement>(
    `${scope} button[data-show-sidebar]`.trim(),
  );
  expect(all.length).toBe(1);
  return all[0];
}
async function scoutRow(view: View): Promise<HTMLElement | null> {
  const header = inDrawer(view, 'button[data-sidebar-room="r1"]');
  if (header?.getAttribute("aria-expanded") !== "true") await click(header);
  return inDrawer(view, `button[data-sidebar-agent="${scout.id}"]`);
}
const menu = (view: View) =>
  view.baseElement.querySelector("[data-agent-menu]");
/** The chat on screen is this agent's: its name is in the chat header. */
const chatOf = (view: View, id: string) =>
  view.baseElement
    .querySelector(".log-view-shell")
    ?.textContent?.includes(`Agent ${id}`) ?? false;

/** One finger at (x, y): a touch event of `type` on `target`. */
async function finger(
  target: Element,
  type: "touchstart" | "touchmove" | "touchend",
  x: number,
  y: number,
): Promise<void> {
  const point = { clientX: x, clientY: y, target, identifier: 0 };
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    touches: { value: type === "touchend" ? [] : [point] },
    changedTouches: { value: [point] },
  });
  await act(async () => {
    target.dispatchEvent(e);
  });
}
async function swipeLeft(target: Element): Promise<void> {
  await finger(target, "touchstart", 300, 300);
  await finger(target, "touchmove", 150, 300);
  await finger(target, "touchend", 50, 300);
}
async function hold(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

it("a swipe on the open drawer, panel or backdrop, leaves the agent under it; with the drawer closed the same swipe changes it", async () => {
  const view = await bootPhone();
  await click(showButton(view));
  await click(await scoutRow(view));
  expect(chatOf(view, scout.id)).toBe(true);

  await click(showButton(view, ".log-view-shell"));
  await swipeLeft(view.baseElement.querySelector("[data-phone-sidebar] nav")!);
  await swipeLeft(
    view.baseElement.querySelector("[data-phone-sidebar-backdrop]")!,
  );
  expect(chatOf(view, scout.id)).toBe(true);

  // The enabling condition: the drawer closed, the same swipe on the chat.
  await click(view.baseElement.querySelector("[data-phone-sidebar-backdrop]"));
  expect(drawer(view)).toBeNull();
  await swipeLeft(view.baseElement.querySelector(".chat-messages")!);
  expect(chatOf(view, ranger.id)).toBe(true);
});

it("a long press on an agent row opens its menu with the pin; a moving finger does not; the tap that ends the press is dropped and the next tap opens the chat", async () => {
  const view = await bootPhone();
  await click(showButton(view));
  const row = (await scoutRow(view))!;

  // A finger that moves past 10 px scrolls the list: no menu.
  await finger(row, "touchstart", 100, 200);
  await finger(row, "touchmove", 100, 230);
  await hold(600);
  expect(menu(view)).toBeNull();
  await finger(row, "touchend", 100, 230);

  // A still finger for 500 ms: the menu, over the open drawer.
  await finger(row, "touchstart", 100, 200);
  await hold(600);
  expect(menu(view)).not.toBeNull();
  expect(drawer(view)).not.toBeNull();
  await finger(row, "touchend", 100, 200);
  await act(async () => fireEvent.click(row));
  expect(chatOpen(view)).toBe(false);

  // Pin from the menu: written, and the drawer stays open.
  await click(view.baseElement.querySelector('[data-agent-menu-pin="pin"]'));
  expect(
    viewWrites.filter((w) => w.path === "/api/me/view/pinned").length,
  ).toBe(1);
  expect(drawer(view)).not.toBeNull();

  // The next tap opens the chat.
  const again = (await scoutRow(view))!;
  await finger(again, "touchstart", 100, 200);
  await finger(again, "touchend", 100, 200);
  await act(async () => fireEvent.click(again));
  expect({
    chat: chatOf(view, scout.id),
    drawer: drawer(view) !== null,
  }).toEqual({ chat: true, drawer: false });
});
