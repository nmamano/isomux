// Settings from a sidebar row (task c921308f; Nil, 2026-11-12: "I'd do
// sliders directly everywhere"). A room header, an agent row and a member row
// each show a settings button at the right end, first, before the row's quick
// action (the room's plus, the pin). One click opens that thing's settings: a
// room and a member open Settings at that entry, an agent opens its settings
// page (task 59538509). The room menu is gone (drag reorders and tucks rooms),
// so a right-click on a room header is the browser's own. Only rooms, agents,
// members and the Office row have a settings button; the Office row's opens
// Settings on the office section, for owners only (task 4bf1571c). This file
// holds the room header and the Office row;
// ui/App.chat-sidebar-settings-rows.dom.test.tsx the agent and member rows and
// which rows have a button. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { en } = await import("../shared/i18n/en.ts");
const {
  boot,
  click,
  navRow,
  openFirstDesk,
  press,
  roomHeader,
  setRole,
  setSelfUser,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const inSidebar = (view: View, selector: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] ${selector}`,
  );
const settingsIds = (
  view: View,
  kind: "room" | "agent" | "member" | "office",
) =>
  [
    ...view.container.querySelectorAll(
      `nav[data-chat-sidebar] button[data-sidebar-${kind}-settings]`,
    ),
  ].map((el) => el.getAttribute(`data-sidebar-${kind}-settings`));
/** The quick action right after a settings button: its data-sidebar-*
 *  attribute and value, or null. */
function nextAction(button: Element | null): string | null {
  const next = button?.nextElementSibling;
  if (!next || next.tagName !== "BUTTON") return null;
  const name = next
    .getAttributeNames()
    .find((n) => n === "data-sidebar-new-agent" || n === "data-sidebar-pin");
  return name ? `${name}=${next.getAttribute(name)}` : null;
}
const officeGear = (view: View) =>
  inSidebar(view, "button[data-sidebar-office-settings]");
/** The rows Settings' own list marks as selected (not the sidebar's). */
const settingsSelection = (view: View) =>
  [...view.baseElement.querySelectorAll('button[aria-current="true"]')]
    .filter((el) => el.closest("nav[data-chat-sidebar]") === null)
    .map((el) => el.textContent?.trim());
/** The Tasks page's discard prompt (ui/components/UnsavedChangesPrompt.tsx):
 *  its box, or null. Its first button discards. */
const discardPrompt = (view: View) =>
  [...view.container.querySelectorAll("span")].find(
    (span) => span.textContent === en["common.discardPrompt"],
  )?.parentElement ?? null;

it("a room header's settings button, before the plus, opens Settings on that room in one click; a right-click on the header is the browser's own", async () => {
  setRole("owner");
  setSelfUser({ role: "owner" });
  const view = await boot();
  const button = inSidebar(view, 'button[data-sidebar-room-settings="r2"]');
  expect(button).not.toBeNull();
  expect(nextAction(button)).toBe("data-sidebar-new-agent=r2");

  // Nothing takes the right-click (fireEvent returns false when a handler
  // prevents the default), on the header or on its buttons, and no menu
  // opens.
  const header = roomHeader(view, "r1");
  expect(header).not.toBeNull();
  let allowed: boolean[] = [];
  await act(async () => {
    allowed = [
      fireEvent.contextMenu(header!, { clientX: 40, clientY: 200 }),
      fireEvent.contextMenu(
        inSidebar(view, 'button[data-sidebar-room-settings="r1"]')!,
        { clientX: 200, clientY: 200 },
      ),
    ];
  });
  expect(allowed).toEqual([true, true]);
  expect(
    view.baseElement.querySelectorAll('[role="menu"], [role="menuitem"]')
      .length,
  ).toBe(0);

  await click(button);
  expect(
    view.baseElement.querySelector('[data-testid="settings-content"]'),
  ).not.toBeNull();
  // Settings drills into the room it opened on, on its first part (task
  // 1f79f2e3).
  expect({
    item: view.baseElement
      .querySelector("[data-settings-item]")
      ?.getAttribute("data-settings-item"),
    part: view.baseElement
      .querySelector('button[data-settings-part][aria-current="true"]')
      ?.getAttribute("data-settings-part"),
  }).toEqual({ item: "room:r2", part: "general" });
});

it("an owner's Office row has a settings button beside it, shown on a touch screen while the office is in view; it leaves an unsaved page only on discard and opens Settings on the office section", async () => {
  setRole("owner");
  setSelfUser({ role: "owner" });
  const view = await boot();
  const gear = officeGear(view);
  const row = navRow(view, "office");
  expect({ gear: gear !== null, row: row !== null }).toEqual({
    gear: true,
    row: true,
  });
  // Beside the row, not in it: a button in a button is invalid, and the
  // row's own click must stay the office.
  expect(gear!.closest("button[data-sidebar-nav]")).toBeNull();
  expect(row!.contains(gear)).toBe(false);
  // With no hover, the buttons of the row in view show (as a room header's).
  const inView = () =>
    officeGear(view)!
      .closest(".chat-sidebar-row-actions")
      ?.hasAttribute("data-in-view") ?? null;
  expect(row!.getAttribute("aria-current")).toBe("page");
  expect(inView()).toBe(true);
  await openFirstDesk(view);
  expect(navRow(view, "office")!.getAttribute("aria-current")).toBeNull();
  expect(inView()).toBe(false);

  // From Tasks with an unsaved new task, the gear asks first.
  await press("t");
  const quickAdd = view.getByPlaceholderText(en["tasks.quickAdd"]);
  await act(async () => {
    fireEvent.change(quickAdd, { target: { value: "unsaved title" } });
    fireEvent.keyDown(quickAdd, { key: "Enter", bubbles: true });
  });
  expect(view.getByDisplayValue("unsaved title")).toBeDefined();
  await click(officeGear(view));
  const settingsOpen = () =>
    view.baseElement.querySelector('[data-testid="settings-content"]') !== null;
  expect({
    prompt: discardPrompt(view) !== null,
    settings: settingsOpen(),
  }).toEqual({ prompt: true, settings: false });

  await click(discardPrompt(view)!.querySelector("button"));
  expect(settingsOpen()).toBe(true);
  // On the office section, not the default (the member's own entry).
  expect(settingsSelection(view)).toEqual([en["settings.sidebar.office"]]);
});

it("a member who is not an owner has the Office row with no settings button", async () => {
  setRole("member");
  setSelfUser({ role: "member" });
  const view = await boot();
  expect(navRow(view, "office")).not.toBeNull();
  expect(settingsIds(view, "office").length).toBe(0);
});
