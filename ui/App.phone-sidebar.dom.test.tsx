// The sidebar on a phone (task 3cced5be; Nil, 2026-11-13, ask f2211e56:
// Drawer). The office stays the phone's first screen; a sidebar button in the
// office bar and in the chat headers slides the same sidebar in over the view.
// A row opens its target and closes the drawer; the backdrop and the
// sidebar's hide button close it. The drawer always starts closed and never
// reads or writes the desktop sidebar choice. History is in
// ui/App.phone-sidebar-history.dom.test.tsx, touch in
// ui/App.phone-sidebar-touch.dom.test.tsx. Row sizes and the 360 px chat
// header need layout: checked in a browser at review. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const {
  boot,
  bootPhone,
  chatOpen,
  click,
  press,
  scout,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const KEY = "isomux-chat-sidebar";

const drawer = (view: View) =>
  view.baseElement.querySelector("[data-phone-sidebar]");
const inDrawer = (view: View, selector: string) =>
  view.baseElement.querySelector<HTMLElement>(
    `[data-phone-sidebar] nav[data-chat-sidebar] ${selector}`,
  );
const backdrop = (view: View) =>
  view.baseElement.querySelector("[data-phone-sidebar-backdrop]");
/** The one sidebar button on screen, inside `scope` when given. */
function showButton(view: View, scope = ""): HTMLButtonElement | null {
  const all = view.baseElement.querySelectorAll<HTMLButtonElement>(
    `${scope} button[data-show-sidebar]`.trim(),
  );
  expect(all.length).toBe(1);
  return all[0];
}
const humanChat = (view: View) =>
  view.baseElement
    .querySelector("[data-human-chat]")
    ?.getAttribute("data-human-chat") ?? null;
const tasksOpen = (view: View) =>
  view.baseElement.querySelector("[data-tasks-page]") !== null;

/** Scout's row in the drawer, with its room's section open. */
async function scoutRow(view: View): Promise<HTMLButtonElement | null> {
  const header = inDrawer(view, 'button[data-sidebar-room="r1"]');
  if (header?.getAttribute("aria-expanded") !== "true") await click(header);
  return inDrawer(
    view,
    `button[data-sidebar-agent="${scout.id}"]`,
  ) as HTMLButtonElement | null;
}

it("the office bar, the agent chat and the members chat each have a sidebar button that opens the drawer; backdrop and hide close it; the desktop choice is never read or written", async () => {
  // The desktop choice says open; the phone ignores it.
  window.localStorage.setItem(KEY, "open");
  const view = await bootPhone();
  expect(drawer(view)).toBeNull();
  expect(
    view.baseElement.querySelectorAll("nav[data-chat-sidebar]").length,
  ).toBe(0);

  // The office bar.
  await click(showButton(view));
  expect(drawer(view)).not.toBeNull();
  expect(inDrawer(view, "button[data-sidebar-collapse]")).not.toBeNull();
  await click(backdrop(view));
  expect(drawer(view)).toBeNull();
  await click(showButton(view));
  await click(inDrawer(view, "button[data-sidebar-collapse]"));
  expect(drawer(view)).toBeNull();

  // An agent row: the chat opens full screen, the drawer closes, and the
  // chat header has the button.
  await click(showButton(view));
  await click(await scoutRow(view));
  expect({ chat: chatOpen(view), drawer: drawer(view) !== null }).toEqual({
    chat: true,
    drawer: false,
  });
  await click(showButton(view, ".log-view-shell"));
  expect(drawer(view)).not.toBeNull();
  await click(backdrop(view));
  expect({ chat: chatOpen(view), drawer: drawer(view) !== null }).toEqual({
    chat: true,
    drawer: false,
  });

  // The Members chat row: the same, from the members chat's header.
  await click(showButton(view));
  await click(inDrawer(view, 'button[data-sidebar-nav="members-chat"]'));
  expect({ chat: humanChat(view), drawer: drawer(view) !== null }).toEqual({
    chat: "members",
    drawer: false,
  });
  await click(showButton(view, "[data-human-chat]"));
  expect(drawer(view)).not.toBeNull();

  expect(window.localStorage.getItem(KEY)).toBe("open");
});

it("folding a section keeps the drawer open; a page row and the Office row close it on their target", async () => {
  const view = await bootPhone();
  await click(showButton(view));
  const header = inDrawer(view, 'button[data-sidebar-room="r1"]');
  const was = header?.getAttribute("aria-expanded");
  await click(header);
  expect(
    inDrawer(view, 'button[data-sidebar-room="r1"]')?.getAttribute(
      "aria-expanded",
    ),
  ).not.toBe(was);
  expect(drawer(view)).not.toBeNull();

  await click(inDrawer(view, 'button[data-sidebar-nav="tasks"]'));
  expect({ tasks: tasksOpen(view), drawer: drawer(view) !== null }).toEqual({
    tasks: true,
    drawer: false,
  });

  // From a chat, the Office row: the office, drawer closed.
  await press("Escape");
  expect(tasksOpen(view)).toBe(false);
  await click(showButton(view));
  await click(await scoutRow(view));
  expect(chatOpen(view)).toBe(true);
  await click(showButton(view, ".log-view-shell"));
  await click(inDrawer(view, 'button[data-sidebar-nav="office"]'));
  expect({ chat: chatOpen(view), drawer: drawer(view) !== null }).toEqual({
    chat: false,
    drawer: false,
  });
  expect(view.baseElement.querySelector("[data-floor-scene]")).not.toBeNull();
});

it("a desktop keeps its sidebar: Show sidebar opens it beside the view, never the drawer", async () => {
  window.localStorage.setItem(KEY, "closed");
  const view = await boot();
  await click(showButton(view));
  expect(
    view.baseElement.querySelectorAll("nav[data-chat-sidebar]").length,
  ).toBe(1);
  expect(drawer(view)).toBeNull();
  expect(window.localStorage.getItem(KEY)).toBe("open");
});
