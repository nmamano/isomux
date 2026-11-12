// Each unread shows once in the desktop sidebar (task 3cf03055; Nil,
// 2026-11-12: "This looks like 2 notifications but it's really only 1. it's
// the same agent, pinned and in room", and "pinned agents should have a more
// visible showing of that, since we'll often want to just skip them visually
// when looking for other agents"). A folded room's summary, and a folded back
// room's, leave out the agents shown in an open Pinned or Recent section. A
// pinned agent's row in its room (or in the Lobby) carries a pin marker and
// is muted, and while Pinned is open it shows no badge and no unread dot: its
// Pinned row carries them. With Pinned folded, nothing is shown elsewhere, so
// the room counts it again. The counting rule is in ui/chat-sidebar.test.ts;
// the setup in ui/test-support/chat-sidebar-fixture.tsx.
//
// Hooks added by this task (agreed with the worker, 2026-11-12):
//   [data-sidebar-pinned-mark]   the pin marker on a pinned agent's room row
//   button[data-sidebar-muted]   a muted agent row (a pinned agent's room row)

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const {
  agentAt,
  ask,
  backbencher,
  backRoomRow,
  boot,
  builder,
  click,
  currentRows,
  faraway,
  openFirstDesk,
  ranger,
  receptionist,
  roomHeader,
  scout,
  setAgents,
  setAsks,
  setSelfUser,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;
type AgentInfo = import("../shared/types.ts").AgentInfo;

setUpChatSidebarTests();

type Summary = { working: string | null; badge: string | null } | null;
function read(el: Element | null): Summary {
  if (!el) return null;
  return {
    working:
      el
        .querySelector("[data-sidebar-room-working]")
        ?.getAttribute("data-sidebar-room-working") ?? null,
    badge: el.querySelector("[data-sidebar-badge]")?.textContent ?? null,
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
const sectionHeader = (view: View, name: "pinned" | "recent") =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-section="${name}"]`,
  );
const expanded = (el: Element | null) => el?.getAttribute("aria-expanded");
async function setOpen(view: View, header: Element | null, open: boolean) {
  expect(header).not.toBeNull();
  if ((expanded(header) === "true") !== open) await click(header);
  expect(expanded(header)).toBe(open ? "true" : "false");
}

// An agent's row in a Pinned or Recent list, and its row outside them (its
// room, back room or the Lobby).
const rowsOf = (view: View, agentId: string) => [
  ...view.container.querySelectorAll<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-agent="${agentId}"]`,
  ),
];
const listRow = (view: View, list: "pinned" | "recent", agentId: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] [data-sidebar-section-agents="${list}"] button[data-sidebar-agent="${agentId}"]`,
  );
const roomRow = (view: View, agentId: string) => {
  const rows = rowsOf(view, agentId).filter(
    (row) => row.closest("[data-sidebar-section-agents]") === null,
  );
  // At most one room row per agent.
  expect(rows.length <= 1).toBe(true);
  return rows[0] ?? null;
};
// What a row shows: its orange badge, its blue unread dot, the pin marker,
// and whether it is muted. The marker may sit in the row button or beside it
// in the row's wrapper, so look in the wrapper.
function marks(row: HTMLButtonElement | null) {
  expect(row).not.toBeNull();
  const wrap = row!.parentElement!;
  return {
    badge: row!.querySelector("[data-sidebar-badge]")?.textContent ?? null,
    dot: row!.querySelector("[data-sidebar-unread]") !== null,
    pinMark: wrap.querySelector("[data-sidebar-pinned-mark]") !== null,
    muted: row!.hasAttribute("data-sidebar-muted"),
  };
}

// A turn the member started ends while the member is not on the agent: its
// row gets the blue unread dot (ui/store.tsx agent_updated).
const myTurn = (a: AgentInfo): AgentInfo =>
  ({ ...a, state: "thinking", turnMemberIds: ["u1"] }) as unknown as AgentInfo;
async function endTurn(agentId: string) {
  await act(async () => {
    shimEmit({
      type: "agent_updated",
      agentId,
      changes: { state: "waiting_for_response" },
    } as never);
  });
}

it("a folded room and a folded back room leave out the agents shown in an open Pinned; folded, Pinned shows nothing and the room counts them again", async () => {
  // Scout (front) and Builder (back) are pinned, work and ask; Ranger is not
  // pinned, works and waits on a permission prompt.
  setAgents([
    { ...scout, state: "thinking" },
    { ...ranger, state: "tool_executing", pendingPrompt: "permission" },
    { ...builder, state: "thinking" },
    faraway,
    backbencher,
    receptionist,
  ]);
  setAsks([ask("q1", scout.id), ask("q2", builder.id)]);
  setSelfUser({ pinnedAgents: [scout.id, builder.id] });
  const view = await boot();
  await setOpen(view, sectionHeader(view, "pinned"), true);
  await setOpen(view, roomHeader(view, "r1"), false);

  // Only Ranger is left: one working, one prompt.
  expect(roomSummary(view, "r1")).toEqual({ working: "1", badge: "1" });
  expect({
    scout: marks(listRow(view, "pinned", scout.id)).badge,
    builder: marks(listRow(view, "pinned", builder.id)).badge,
  }).toEqual({ scout: "1", builder: "1" });

  // The back room alone: Builder is its only agent, and Pinned shows it.
  await setOpen(view, roomHeader(view, "r1"), true);
  await setOpen(view, backRoomRow(view, "r1"), false);
  expect(backSummary(view, "r1")).toEqual({ working: null, badge: null });
  // Unfolded, Builder's back-room row is a room row: marked and muted.
  await setOpen(view, backRoomRow(view, "r1"), true);
  expect(marks(roomRow(view, builder.id))).toEqual({
    badge: null,
    dot: false,
    pinMark: true,
    muted: true,
  });
  await setOpen(view, backRoomRow(view, "r1"), false);

  // Pinned folded: its rows are gone, so the room and back room count all.
  await setOpen(view, sectionHeader(view, "pinned"), false);
  expect(listRow(view, "pinned", scout.id)).toBeNull();
  expect(backSummary(view, "r1")).toEqual({ working: "1", badge: "1" });
  await setOpen(view, roomHeader(view, "r1"), false);
  expect(roomSummary(view, "r1")).toEqual({ working: "3", badge: "3" });
});

it("a folded room leaves out the agents shown in an open Recent, and counts them while Recent is folded", async () => {
  setAgents([
    scout,
    ranger,
    builder,
    { ...faraway, state: "thinking" },
    { ...backbencher, state: "tool_executing" },
    receptionist,
  ]);
  setAsks([ask("q1", faraway.id), ask("q2", backbencher.id)]);
  // Faraway is recent; Backbencher, r2's back agent, is not.
  setSelfUser({ recentAgents: [faraway.id] });
  const view = await boot();
  await setOpen(view, sectionHeader(view, "recent"), true);
  await setOpen(view, roomHeader(view, "r2"), false);

  expect(roomSummary(view, "r2")).toEqual({ working: "1", badge: "1" });
  expect(marks(listRow(view, "recent", faraway.id)).badge).toBe("1");

  await setOpen(view, sectionHeader(view, "recent"), false);
  expect(roomSummary(view, "r2")).toEqual({ working: "2", badge: "2" });
});

it("a pinned agent's room row is muted and marked; while Pinned is open its badge and unread dot show only on its Pinned row", async () => {
  // Scout asks, Ranger gets an unread dot; both are pinned. Other, unpinned,
  // also asks in the same room.
  const other = agentAt("a7", "r1", 2);
  setAgents([
    scout,
    myTurn(ranger),
    other,
    builder,
    faraway,
    backbencher,
    receptionist,
  ]);
  setAsks([ask("q1", scout.id), ask("q2", other.id)]);
  setSelfUser({ pinnedAgents: [scout.id, ranger.id] });
  const view = await boot();
  await endTurn(ranger.id);
  await setOpen(view, sectionHeader(view, "pinned"), true);
  await setOpen(view, roomHeader(view, "r1"), true);

  expect({
    scout: marks(roomRow(view, scout.id)),
    ranger: marks(roomRow(view, ranger.id)),
    other: marks(roomRow(view, other.id)),
  }).toEqual({
    scout: { badge: null, dot: false, pinMark: true, muted: true },
    ranger: { badge: null, dot: false, pinMark: true, muted: true },
    other: { badge: "1", dot: false, pinMark: false, muted: false },
  });
  // The Pinned rows carry them, unmarked and not muted.
  expect({
    scout: marks(listRow(view, "pinned", scout.id)),
    ranger: marks(listRow(view, "pinned", ranger.id)),
  }).toEqual({
    scout: { badge: "1", dot: false, pinMark: false, muted: false },
    ranger: { badge: null, dot: true, pinMark: false, muted: false },
  });

  // Pinned folded: the room rows show them again, still marked and muted.
  await setOpen(view, sectionHeader(view, "pinned"), false);
  expect({
    scout: marks(roomRow(view, scout.id)),
    ranger: marks(roomRow(view, ranger.id)),
  }).toEqual({
    scout: { badge: "1", dot: false, pinMark: true, muted: true },
    ranger: { badge: null, dot: true, pinMark: true, muted: true },
  });
});

it("a pinned receptionist's Lobby row is marked and muted too, and the open pinned agent's room row stays the current row", async () => {
  setAgents([scout, ranger, builder, faraway, backbencher, receptionist]);
  setAsks([ask("q1", receptionist.id)]);
  setSelfUser({ pinnedAgents: [receptionist.id, scout.id] });
  const view = await boot();
  await setOpen(view, sectionHeader(view, "pinned"), true);
  await setOpen(
    view,
    view.container.querySelector(
      `nav[data-chat-sidebar] button[data-sidebar-room="lobby"]`,
    ),
    true,
  );
  expect(marks(roomRow(view, receptionist.id))).toEqual({
    badge: null,
    dot: false,
    pinMark: true,
    muted: true,
  });
  expect(marks(listRow(view, "pinned", receptionist.id)).badge).toBe("1");

  // Scout, pinned, is the open agent: both its rows are the current row.
  await openFirstDesk(view);
  await setOpen(view, roomHeader(view, "r1"), true);
  expect(currentRows(view)).toEqual([scout.id, scout.id]);
  expect(marks(roomRow(view, scout.id)).muted).toBe(true);
});
