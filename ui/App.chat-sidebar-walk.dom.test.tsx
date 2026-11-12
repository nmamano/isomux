// No entry of the desktop sidebar hides it (task c61316be; Nil, 2026-11-11:
// "the general principle is that clicking something on the side bar does not
// close the sidebar"). Only its own hide button does. The walk clicks every
// button the sidebar draws, whatever it is, so an entry added later is walked
// too. And while the sidebar is open, a top-bar button that does the same as a
// sidebar entry is hidden (Nil: "the nav bar buttons become redundant with
// the side bar"); with it hidden, the bars are as before. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { BACK_SEAT_BASE } = await import("../shared/desks.ts");
const {
  ALL_ROOMS,
  agentAt,
  boot,
  builder,
  click,
  faraway,
  openFirstDesk,
  ranger,
  receptionist,
  backbencher,
  scout,
  setAgents,
  setRooms,
  setSelfUser,
  setUpChatSidebarTests,
  sidebar,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

// A third room the member tucked, with one agent at a desk and one in its
// back room.
const third = agentAt("a7", "r3", 0);
const thirdBack = agentAt("a8", "r3", BACK_SEAT_BASE);

/** A button's identity: its data-sidebar-* attributes. Every sidebar button
 *  carries one, so the walk can tell entries apart. */
function entryKey(button: Element): string {
  return button
    .getAttributeNames()
    .filter((name) => name.startsWith("data-sidebar-"))
    .sort()
    .map((name) => `${name}=${button.getAttribute(name)}`)
    .join(" ");
}

const COLLAPSE = "data-sidebar-collapse=";

it("no entry hides the sidebar: the walk clicks every button it draws, opening closed sections first", async () => {
  setRooms(ALL_ROOMS);
  setAgents([
    scout,
    ranger,
    builder,
    faraway,
    backbencher,
    receptionist,
    third,
    thirdBack,
  ]);
  setSelfUser({ tucked: ["r3"] });
  const view = await boot();
  expect(sidebar(view)).not.toBeNull();

  const visited = new Set<string>();
  for (let step = 0; step < 200; step++) {
    const buttons = [
      ...sidebar(view)!.querySelectorAll<HTMLButtonElement>("button"),
    ];
    // Every button names itself.
    expect(buttons.filter((b) => entryKey(b) === "").length).toBe(0);
    const fresh = buttons.filter(
      (b) => !visited.has(entryKey(b)) && entryKey(b) !== COLLAPSE,
    );
    if (fresh.length === 0) break;
    // A closed section header or a plain entry first; an open header (whose
    // click would close it and hide entries not walked yet) last.
    const next =
      fresh.find((b) => b.getAttribute("aria-expanded") !== "true") ?? fresh[0];
    const key = entryKey(next);
    visited.add(key);
    await click(next);
    expect({ key, sidebar: sidebar(view) !== null }).toEqual({
      key,
      sidebar: true,
    });
  }

  // The walk reached every kind of entry (its enabling condition).
  const expected = [
    ...[
      "office",
      "members-chat",
      "asks",
      "tasks",
      "cronjobs",
      "apps",
      "skills",
      "integrations",
      "settings",
    ].map((row) => `data-sidebar-nav=${row}`),
    "data-sidebar-more-rooms=",
    ...["lobby", "r1", "r2", "r3"].map((id) => `data-sidebar-room=${id}`),
    // Task c921308f: a room's settings button. Task 5dac6b9b: an agent
    // row's pin button; task c921308f: its settings button.
    ...["r1", "r2", "r3"].map((id) => `data-sidebar-room-settings=${id}`),
    ...[
      scout,
      ranger,
      builder,
      faraway,
      backbencher,
      receptionist,
      third,
      thirdBack,
    ].flatMap((a) => [
      `data-sidebar-pin=${a.id}`,
      `data-sidebar-agent-settings=${a.id}`,
    ]),
    ...["r1", "r2", "r3"].map((id) => `data-sidebar-back-room=${id}`),
    ...["r1", "r2", "r3"].map((id) => `data-sidebar-new-agent=${id}`),
    ...[
      scout,
      ranger,
      builder,
      faraway,
      backbencher,
      receptionist,
      third,
      thirdBack,
    ].map((a) => `data-sidebar-agent=${a.id}`),
  ];
  expect(expected.filter((key) => !visited.has(key))).toEqual([]);
});

/** The ids of the top-bar buttons (NavActions marks each with
 *  data-nav-action) outside the sidebar. */
function barActions(view: View): string[] {
  return [...view.container.querySelectorAll("[data-nav-action]")]
    .filter((el) => el.closest("nav[data-chat-sidebar]") === null)
    .map((el) => el.getAttribute("data-nav-action")!)
    .sort();
}

async function hideSidebar(view: View): Promise<void> {
  await click(
    view.container.querySelector(
      "nav[data-chat-sidebar] button[data-sidebar-collapse]",
    ),
  );
  expect(sidebar(view)).toBeNull();
}

// The top-bar buttons with a sidebar twin (agreed with the worker,
// 2026-11-11).
const OFFICE_TWINS = new Set([
  "tasks",
  "cronjobs",
  "apps",
  "skills",
  "integrations",
  "inbox",
  "settings",
]);
const CHAT_TWINS = new Set(["tasks", "inbox"]);

it("office top bar: with the sidebar open, the buttons it repeats are gone and the rest stay; hidden, the bar is whole", async () => {
  const view = await boot();
  const open = barActions(view);
  await hideSidebar(view);
  const whole = barActions(view);
  // Today's bar has every twin, so the open bar's gaps are real.
  expect(whole.filter((id) => OFFICE_TWINS.has(id)).length).toBe(
    OFFICE_TWINS.size,
  );
  expect(open).toEqual(whole.filter((id) => !OFFICE_TWINS.has(id)));
  // Something with no twin stays (the theme switch).
  expect(open.length).toBeGreaterThan(0);
});

it("chat header: with the sidebar open, its Tasks and Inbox buttons are gone and the rest stay; hidden, the header is whole", async () => {
  const view = await boot();
  await openFirstDesk(view);
  const open = barActions(view);
  await hideSidebar(view);
  const whole = barActions(view);
  expect(whole.filter((id) => CHAT_TWINS.has(id)).length).toBe(CHAT_TWINS.size);
  expect(open).toEqual(whole.filter((id) => !CHAT_TWINS.has(id)));
  expect(open.length).toBeGreaterThan(0);
});
