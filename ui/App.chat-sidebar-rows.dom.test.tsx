// The desktop chat sidebar's room sections, agent rows and Inbox badge (task
// c61316be). A row opens its agent's chat and is marked as the open one; the
// open agent's room, and for a back agent its Back room row, open whenever the
// open agent changes, also from outside the sidebar. The Inbox badge counts as
// the chat header's Inbox button does. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  ask,
  agentRow,
  backRoomRow,
  backbencher,
  boot,
  chatOpen,
  click,
  currentRows,
  faraway,
  navRow,
  openFirstDesk,
  press,
  ranger,
  roomHeader,
  scout,
  setAsks,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const expanded = (el: Element | null) => el?.getAttribute("aria-expanded");

it("opens the open agent's room only; a row opens its agent's chat and takes the mark; a closed room opens on its header", async () => {
  const view = await boot();
  await openFirstDesk(view);
  expect({
    r1: expanded(roomHeader(view, "r1")),
    r2: expanded(roomHeader(view, "r2")),
    rangerRow: agentRow(view, ranger.id) !== null,
    farawayRow: agentRow(view, faraway.id) !== null,
    current: currentRows(view),
  }).toEqual({
    r1: "true",
    r2: "false",
    rangerRow: true,
    farawayRow: false,
    current: [scout.id],
  });

  await click(agentRow(view, ranger.id));
  expect(chatOpen(view)).toBe(true);
  expect(currentRows(view)).toEqual([ranger.id]);

  await click(roomHeader(view, "r2"));
  expect(expanded(roomHeader(view, "r2"))).toBe("true");
  await click(agentRow(view, faraway.id));
  expect(currentRows(view)).toEqual([faraway.id]);
});

it("opens the room and the Back room row of a back agent whose chat opens from the Inbox", async () => {
  setAsks([ask("q1", backbencher.id)]);
  const view = await boot();
  await openFirstDesk(view);
  expect(expanded(roomHeader(view, "r2"))).toBe("false");

  await click(navRow(view, "asks"));
  await click(
    view.container.querySelector(`[data-asks-agent="${backbencher.id}"]`),
  );
  await click(view.container.querySelector("button[data-agent-chat-full]"));
  expect(chatOpen(view)).toBe(true);
  expect({
    r2: expanded(roomHeader(view, "r2")),
    back: expanded(backRoomRow(view, "r2")),
    current: currentRows(view),
  }).toEqual({ r2: "true", back: "true", current: [backbencher.id] });
});

it("Inbox badge: beside a chat it leaves out that agent's asks, as the chat header does; beside a page it counts every new ask", async () => {
  setAsks([ask("q1", scout.id), ask("q2", ranger.id), ask("q3", faraway.id)]);
  // The header's Inbox shows only while the sidebar is hidden, so read its
  // count first, then show the sidebar.
  window.localStorage.setItem("isomux-chat-sidebar", "closed");
  const view = await boot();
  await openFirstDesk(view);
  const badge = () =>
    navRow(view, "asks")?.querySelector("[data-sidebar-badge]")?.textContent ??
    null;
  const headerBadge = (v: View) =>
    v.container.querySelector(".log-view-shell .nav-action-badge")
      ?.textContent ?? null;
  // The header's own count, today's behavior: Scout's ask is in this chat.
  expect(headerBadge(view)).toBe("2");
  await click(view.container.querySelector("[data-show-sidebar]"));
  expect(chatOpen(view)).toBe(true);
  expect(badge()).toBe("2");

  // Tasks does not mark asks seen, so all three stay new.
  await press("t");
  expect(view.container.querySelector("[data-tasks-page]")).not.toBeNull();
  expect(badge()).toBe("3");
});

it("a right-click on a row opens the desk menu of that agent", async () => {
  const view = await boot();
  await openFirstDesk(view);
  const row = agentRow(view, ranger.id);
  expect(row).not.toBeNull();
  await act(async () =>
    fireEvent.contextMenu(row!, { clientX: 40, clientY: 200 }),
  );
  // The desk menu (ui/components/ContextMenu.tsx) marks its root with the
  // agent it is for.
  const menus = view.baseElement.querySelectorAll("[data-agent-menu]");
  expect(menus.length).toBe(1);
  expect(menus[0].getAttribute("data-agent-menu")).toBe(ranger.id);
});
