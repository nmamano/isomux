// The desktop sidebar's per-room "+" (task c61316be; Nil, 2026-11-11, on the
// single New agent row: "not clear what room it goes to"): each room section
// has its own, which opens the spawn dialog for THAT room, at its first free
// front desk, else its back room, whichever chat is open. The Lobby has none.
// A member whose pack does not give agent management write has none. The
// spawn the dialog sends (POST /api/agents) is the outcome. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { DESK_COUNT } = await import("../shared/desks.ts");
const {
  agentAt,
  agentRow,
  boot,
  builder,
  click,
  currentRows,
  navRow,
  openFirstDesk,
  receptionist,
  setAgents,
  setSelfPack,
  setUpChatSidebarTests,
  spawns,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const plus = (view: View, roomId: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `nav[data-chat-sidebar] button[data-sidebar-new-agent="${roomId}"]`,
  );
const anyPlus = (view: View) =>
  view.container.querySelectorAll(
    "nav[data-chat-sidebar] button[data-sidebar-new-agent]",
  ).length;

/** The room's "+", then the dialog's save as it opened; the spawn it sent. */
async function spawnIn(
  view: View,
  roomId: string,
): Promise<{ roomId: unknown; desk: unknown }> {
  await click(plus(view, roomId));
  const dialog = view.baseElement.querySelector(".spawn-agent-dialog-desktop");
  expect(dialog).not.toBeNull();
  const buttons = dialog!.querySelectorAll("button");
  await act(async () => fireEvent.click(buttons[buttons.length - 1]));
  await act(async () => {});
  expect(spawns.length).toBe(1);
  return { roomId: spawns[0].roomId, desk: spawns[0].desk };
}

it("spawns in the room of the + clicked, at its first free front desk, not in the open agent's room", async () => {
  // r1 holds desks 0 and 1 (Scout's chat is open); r2 holds desk 0.
  const view = await boot();
  await openFirstDesk(view);
  expect(await spawnIn(view, "r2")).toEqual({ roomId: "r2", desk: 1 });
});

it("spawns in the room's back room when every front desk is taken", async () => {
  setAgents([
    ...Array.from({ length: DESK_COUNT }, (_, desk) =>
      agentAt(`d${desk}`, "r1", desk),
    ),
    builder,
  ]);
  const view = await boot();
  await openFirstDesk(view);
  expect(await spawnIn(view, "r1")).toEqual({ roomId: "r1", desk: null });
});

it("from the receptionist's chat, the + of a room spawns in that room; the Lobby has no +", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await click(agentRow(view, receptionist.id));
  expect(currentRows(view)).toEqual([receptionist.id]);
  expect(plus(view, "lobby")).toBeNull();
  expect(await spawnIn(view, "r1")).toEqual({ roomId: "r1", desk: 2 });
});

it("has no + for a member whose pack gives agent management read only; its page rows follow the pack, as the office bar does", async () => {
  setSelfPack({
    areas: { agentManagement: "read", tasks: "read" },
    agentCeiling: "web",
  });
  const view = await boot();
  await openFirstDesk(view);
  // The sidebar and the room sections are there; only the + is not.
  expect(navRow(view, "office")).not.toBeNull();
  expect(
    view.container.querySelector('button[data-sidebar-room="r1"]'),
  ).not.toBeNull();
  expect(anyPlus(view)).toBe(0);
  // Tasks is in the pack; Automations, Apps and Skills are not. Settings
  // has no gate, as the office bar's Settings has none.
  const pages = ["tasks", "cronjobs", "apps", "skills", "settings"] as const;
  expect(pages.map((row) => navRow(view, row) !== null)).toEqual([
    true,
    false,
    false,
    false,
    true,
  ]);
});
