// The folded room summary of the desktop sidebar (task 5dac6b9b; Nil,
// 2026-11-12: "One green dot + working count, + number of Open Asks
// (including permission requests)"). A folded room, and a folded back room,
// show one green dot with the number of its working agents (none at 0) and
// an orange badge that is the sum of the badges its agent rows show when it
// unfolds: open asks, plus one for a permission prompt. The back room's
// agents sit in their own indented list, and the own-name row at the bottom
// is gone. The setup is in ui/test-support/chat-sidebar-fixture.tsx; the
// counting rules in ui/chat-sidebar.test.ts.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const {
  agentRow,
  ask,
  backbencher,
  backRoomRow,
  boot,
  builder,
  click,
  faraway,
  ranger,
  receptionist,
  roomHeader,
  scout,
  setAgents,
  setAsks,
  setUpChatSidebarTests,
  sidebar,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

type Summary = { working: string | null; badge: string | null } | null;

function read(el: Element | null): Summary {
  if (!el) return null;
  const working = el.querySelectorAll("[data-sidebar-room-working]");
  const badges = el.querySelectorAll("[data-sidebar-badge]");
  // At most one of each per summary.
  expect(working.length <= 1 && badges.length <= 1).toBe(true);
  return {
    working: working[0]?.getAttribute("data-sidebar-room-working") ?? null,
    badge: badges[0]?.textContent ?? null,
  };
}
const roomSummary = (view: View, roomId: string) =>
  read(
    view.container.querySelector(
      `nav[data-chat-sidebar] [data-sidebar-room-summary="${roomId}"]`,
    ),
  );
const backSummary = (view: View, roomId: string) =>
  read(
    view.container.querySelector(
      `nav[data-chat-sidebar] [data-sidebar-back-room-summary="${roomId}"]`,
    ),
  );
const expanded = (el: Element | null) => el?.getAttribute("aria-expanded");
const rowBadge = (view: View, agentId: string) =>
  agentRow(view, agentId)?.querySelector("[data-sidebar-badge]")?.textContent ??
  null;

it("a folded room shows its working count and the sum of its row badges; unfolded, the rows carry the badges and its folded back room the rest", async () => {
  setAgents([
    { ...scout, state: "thinking" },
    { ...ranger, state: "waiting_for_response", pendingPrompt: "permission" },
    { ...builder, state: "tool_executing" },
    faraway,
    backbencher,
    receptionist,
  ]);
  setAsks([ask("q1", scout.id)]);
  const view = await boot();
  if (expanded(roomHeader(view, "r1")) === "true")
    await click(roomHeader(view, "r1"));
  expect(expanded(roomHeader(view, "r1"))).toBe("false");

  // Folded: the front and back agents together. Scout thinks and Builder runs
  // a tool; Scout's ask and Ranger's permission prompt make the badge.
  expect(roomSummary(view, "r1")).toEqual({ working: "2", badge: "2" });
  // Nobody works and nobody asks in r2: neither the dot nor the badge.
  expect(expanded(roomHeader(view, "r2"))).toBe("false");
  expect(roomSummary(view, "r2")).toEqual({ working: null, badge: null });
  // The old per-room colored dot is gone.
  expect(
    view.container.querySelectorAll("nav [data-sidebar-room-dot]").length,
  ).toBe(0);

  await click(roomHeader(view, "r1"));
  // An open room has no summary; its rows show what it summed.
  expect(roomSummary(view, "r1")).toBeNull();
  expect({
    scout: rowBadge(view, scout.id),
    ranger: rowBadge(view, ranger.id),
  }).toEqual({ scout: "1", ranger: "1" });
  // Its back room is folded: Builder works there.
  expect(expanded(backRoomRow(view, "r1"))).toBe("false");
  expect(backSummary(view, "r1")).toEqual({ working: "1", badge: null });

  await click(backRoomRow(view, "r1"));
  expect(backSummary(view, "r1")).toBeNull();
});

it("a folded back room counts only its own agents: a permission prompt there shows in its badge", async () => {
  setAgents([
    { ...scout, state: "thinking" },
    ranger,
    { ...builder, state: "waiting_for_response", pendingPrompt: "permission" },
    faraway,
    backbencher,
    receptionist,
  ]);
  setAsks([ask("q1", builder.id), ask("q2", scout.id)]);
  const view = await boot();
  if (expanded(roomHeader(view, "r1")) !== "true")
    await click(roomHeader(view, "r1"));
  expect(expanded(backRoomRow(view, "r1"))).toBe("false");
  expect(backSummary(view, "r1")).toEqual({ working: null, badge: "2" });
});

it("the back room's agents sit in its own list, the front agents do not; no own-name row at the bottom", async () => {
  const view = await boot();
  if (expanded(roomHeader(view, "r1")) !== "true")
    await click(roomHeader(view, "r1"));
  await click(backRoomRow(view, "r1"));
  const inBackList = (agentId: string) =>
    agentRow(view, agentId)?.closest("[data-sidebar-back-room-agents]") != null;
  expect(agentRow(view, builder.id)).not.toBeNull();
  expect({
    builder: inBackList(builder.id),
    scout: inBackList(scout.id),
  }).toEqual({ builder: true, scout: false });

  expect(sidebar(view)).not.toBeNull();
  expect(view.container.querySelectorAll("[data-sidebar-self]").length).toBe(0);
});
