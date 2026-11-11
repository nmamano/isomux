// The desktop chat sidebar's New agent row (task c61316be): the spawn dialog
// for the open agent's room, at its first free front desk, else its back room;
// from a Lobby agent, the room the member last stood in. A member whose pack
// does not give agent management write has no row. The spawn the dialog sends
// (POST /api/agents) is the outcome. The setup is in
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

/** New agent, then the dialog's save as it opened; the spawn it sent. */
async function spawnFromSidebar(view: View): Promise<Record<string, unknown>> {
  await click(navRow(view, "new-agent"));
  const dialog = view.baseElement.querySelector(".spawn-agent-dialog-desktop");
  expect(dialog).not.toBeNull();
  const buttons = dialog!.querySelectorAll("button");
  await act(async () => fireEvent.click(buttons[buttons.length - 1]));
  await act(async () => {});
  expect(spawns.length).toBe(1);
  return spawns[0];
}

it("spawns at the open agent's room's first free front desk", async () => {
  // r1: desks 0 and 1 and a back agent; desk 2 is the first free one.
  const view = await boot();
  await openFirstDesk(view);
  const spawn = await spawnFromSidebar(view);
  expect({ roomId: spawn.roomId, desk: spawn.desk }).toEqual({
    roomId: "r1",
    desk: 2,
  });
});

it("spawns in the back room when every front desk of the room is taken", async () => {
  setAgents([
    ...Array.from({ length: DESK_COUNT }, (_, desk) =>
      agentAt(`d${desk}`, "r1", desk),
    ),
    builder,
  ]);
  const view = await boot();
  await openFirstDesk(view);
  const spawn = await spawnFromSidebar(view);
  expect({ roomId: spawn.roomId, desk: spawn.desk }).toEqual({
    roomId: "r1",
    desk: null,
  });
});

it("from the receptionist's chat, spawns in the room the member last stood in", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await click(agentRow(view, receptionist.id));
  expect(currentRows(view)).toEqual([receptionist.id]);
  const spawn = await spawnFromSidebar(view);
  expect({ roomId: spawn.roomId, desk: spawn.desk }).toEqual({
    roomId: "r1",
    desk: 2,
  });
});

it("has no New agent row for a member whose pack gives agent management read only", async () => {
  setSelfPack({ areas: { agentManagement: "read" }, agentCeiling: "web" });
  const view = await boot();
  await openFirstDesk(view);
  // The sidebar is there; only the row is not.
  expect(navRow(view, "office")).not.toBeNull();
  expect(navRow(view, "new-agent")).toBeNull();
});
