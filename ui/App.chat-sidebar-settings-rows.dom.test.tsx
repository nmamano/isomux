// Settings from a sidebar row (task c921308f): an agent row's settings button
// opens its settings page (task 59538509) and a member row's comes before its
// pin; only rooms, agents, members and the Office row have one. Split from
// ui/App.chat-sidebar-settings.dom.test.tsx, which holds the room header and
// the Office row, because the 5 s cap is per file. The setup is in
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
async function openRoom(view: View, roomId: string): Promise<void> {
  if (roomHeader(view, roomId)?.getAttribute("aria-expanded") !== "true")
    await click(roomHeader(view, roomId));
  expect(roomHeader(view, roomId)?.getAttribute("aria-expanded")).toBe("true");
}
/** The agent Settings is drilled into (task 1f79f2e3), or null. */
const pageAgent = (view: View) =>
  view.baseElement
    .querySelector('[data-settings-item^="agent:"]')
    ?.getAttribute("data-settings-item")
    ?.slice("agent:".length) ?? null;
it("only rooms, agents, members and the Office row have a settings button: not the Lobby, a back room, Members, Pinned, Recent or Tucked rooms", async () => {
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
  expect(settingsIds(view, "office")).toEqual([""]);

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
        !/^data-sidebar-(room|agent|member|office)-settings=/.test(attr) &&
        attr !== "data-sidebar-nav=settings",
    );
  expect(others).toEqual([]);
});

it("an agent row's settings button, before its pin, opens the agent's settings page in one click, in a room, Pinned and Recent", async () => {
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
    // The page, on this agent; its chat does not open.
    seen[where] = { order, page: pageAgent(view), chat: currentRows(view) };
    await act(async () =>
      fireEvent.keyDown(document.body, { key: "Escape", bubbles: true }),
    );
    expect(pageAgent(view)).toBeNull();
  }
  expect(seen).toEqual({
    r1: {
      order: `data-sidebar-pin=${scout.id}`,
      page: scout.id,
      chat: [],
    },
    pinned: {
      order: `data-sidebar-pin=${faraway.id}`,
      page: faraway.id,
      chat: [],
    },
    recent: {
      order: `data-sidebar-pin=${ranger.id}`,
      page: ranger.id,
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
