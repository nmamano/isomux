// Settings from a sidebar row (task c921308f; Nil, 2026-11-12: "I'd do
// sliders directly everywhere"). A room header, an agent row and a member row
// each show a settings button at the right end, first, before the row's quick
// action (the room's plus, the pin). One click opens that thing's settings: a
// room and a member open Settings at that entry, an agent opens the agent
// dialog. The room menu is gone (drag reorders and tucks rooms), so a
// right-click on a room header is the browser's own. Only rooms, agents and
// members have a settings button. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  ALL_ROOMS,
  boot,
  click,
  currentRows,
  faraway,
  memberWire,
  ranger,
  roomHeader,
  scout,
  setMembers,
  setRole,
  setRooms,
  setSelfUser,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const inSidebar = (view: View, selector: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] ${selector}`,
  );
const settingsIds = (view: View, kind: "room" | "agent" | "member") =>
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
async function openRoom(view: View, roomId: string): Promise<void> {
  if (roomHeader(view, roomId)?.getAttribute("aria-expanded") !== "true")
    await click(roomHeader(view, roomId));
  expect(roomHeader(view, roomId)?.getAttribute("aria-expanded")).toBe("true");
}
/** The open agent dialog's name field, or null when no edit dialog shows. */
const dialogName = (view: View) =>
  view.baseElement.querySelector<HTMLInputElement>(
    ".edit-agent-dialog-desktop .agent-identity-section input",
  )?.value ?? null;

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
  // Settings' own list marks the room it opened on.
  const current = [
    ...view.baseElement.querySelectorAll('button[aria-current="true"]'),
  ].filter((el) => el.closest("nav[data-chat-sidebar]") === null);
  expect(current.map((el) => el.textContent?.trim())).toEqual(["Second room"]);
});

it("only rooms, agents and members have a settings button: not the Lobby, a back room, Members, Pinned, Recent or Tucked rooms", async () => {
  setRole("owner");
  setRooms(ALL_ROOMS);
  setSelfUser({
    role: "owner",
    tucked: ["r3"],
    pinnedAgents: [faraway.id, "member:u2"],
    recentAgents: [ranger.id],
  });
  setMembers([memberWire("u2", "Ann")]);
  const view = await boot();
  // Every section open, so every header and row is drawn.
  const more = inSidebar(view, "button[data-sidebar-more-rooms]");
  if (more?.getAttribute("aria-expanded") !== "true") await click(more);
  for (const id of ["r1", "r2", "r3"]) await openRoom(view, id);
  for (const id of ["r1", "r2"]) {
    const back = inSidebar(view, `button[data-sidebar-back-room="${id}"]`);
    if (back?.getAttribute("aria-expanded") !== "true") await click(back);
  }

  expect(settingsIds(view, "room").sort()).toEqual(["r1", "r2", "r3"]);
  // Each drawn agent row has one; Faraway and Ranger have two rows each (in
  // Pinned or Recent, and in their room).
  const agentRows = [
    ...view.container.querySelectorAll(
      "nav[data-chat-sidebar] button[data-sidebar-agent]",
    ),
  ].map((el) => el.getAttribute("data-sidebar-agent"));
  expect(agentRows.length).toBeGreaterThan(4);
  expect(settingsIds(view, "agent").sort()).toEqual(agentRows.sort());
  // Ann in Pinned and in Members.
  expect(settingsIds(view, "member")).toEqual(["u2", "u2"]);

  // No other sidebar button names settings, except the Settings page entry.
  const others = [
    ...view.container.querySelectorAll("nav[data-chat-sidebar] button"),
  ]
    .flatMap((el) =>
      el
        .getAttributeNames()
        .filter((n) => n.startsWith("data-sidebar-"))
        .map((n) => `${n}=${el.getAttribute(n)}`),
    )
    .filter(
      (attr) =>
        attr.includes("settings") &&
        !/^data-sidebar-(room|agent|member)-settings=/.test(attr) &&
        attr !== "data-sidebar-nav=settings",
    );
  expect(others).toEqual([]);
});

it("an agent row's settings button, before its pin, opens the agent dialog on that agent in one click, in a room, Pinned and Recent", async () => {
  setSelfUser({ pinnedAgents: [faraway.id], recentAgents: [ranger.id] });
  const view = await boot();
  await openRoom(view, "r1");
  const cases = [
    { where: "r1", agent: scout, scope: "" },
    {
      where: "pinned",
      agent: faraway,
      scope: '[data-sidebar-section-agents="pinned"] ',
    },
    {
      where: "recent",
      agent: ranger,
      scope: '[data-sidebar-section-agents="recent"] ',
    },
  ];
  const seen: Record<string, unknown> = {};
  for (const { where, agent, scope } of cases) {
    const button = inSidebar(
      view,
      `${scope}button[data-sidebar-agent-settings="${agent.id}"]`,
    );
    expect({ where, found: button !== null }).toEqual({ where, found: true });
    const order = nextAction(button);
    await click(button);
    // The dialog, on this agent; its chat does not open.
    seen[where] = { order, name: dialogName(view), chat: currentRows(view) };
    await act(async () =>
      fireEvent.keyDown(document.body, { key: "Escape", bubbles: true }),
    );
    expect(dialogName(view)).toBeNull();
  }
  expect(seen).toEqual({
    r1: {
      order: `data-sidebar-pin=${scout.id}`,
      name: scout.name,
      chat: [],
    },
    pinned: {
      order: `data-sidebar-pin=${faraway.id}`,
      name: faraway.name,
      chat: [],
    },
    recent: {
      order: `data-sidebar-pin=${ranger.id}`,
      name: ranger.name,
      chat: [],
    },
  });
});

it("a member row's settings button comes before its pin, in Members and in Pinned", async () => {
  setRole("owner");
  setSelfUser({ role: "owner", pinnedAgents: ["member:u2"] });
  setMembers([memberWire("u2", "Ann"), memberWire("u3", "Bea")]);
  const view = await boot();
  const orders = [
    ...view.container.querySelectorAll(
      "nav[data-chat-sidebar] button[data-sidebar-member-settings]",
    ),
  ].map(
    (el) =>
      `${el.getAttribute("data-sidebar-member-settings")}:${nextAction(el)}`,
  );
  expect(orders.sort()).toEqual([
    "u2:data-sidebar-pin=member:u2",
    "u2:data-sidebar-pin=member:u2",
    "u3:data-sidebar-pin=member:u3",
  ]);
});
