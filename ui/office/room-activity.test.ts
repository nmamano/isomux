// A room's unread dot (task f0af4677): only front agents light it; people
// rarely talk to the back room.
import { expect, it } from "bun:test";
import type { AgentInfo } from "../../shared/types.ts";
import { deskOfBackSeat } from "../../shared/desks.ts";
import { roomActivityDotColor, roomHasUnread } from "./room-activity.ts";

const agent = (id: string, desk: number, state = "idle") =>
  ({ id, desk, state }) as unknown as AgentInfo;

it("counts a front agent's unread and ignores a back agent's", () => {
  const front = agent("front", 0);
  const back = agent("back", deskOfBackSeat({ table: 0, stool: 0 }));
  expect(roomHasUnread([front, back], new Set(["front"]))).toBe(true);
  expect(roomHasUnread([front, back], new Set(["back"]))).toBe(false);
});

// The dot: green while any agent works (a back agent included), else purple
// for unread attention, else none; never on the active room's own tab.
it("colours the dot by work, then attention, and hides it on the active room", () => {
  const back = deskOfBackSeat({ table: 0, stool: 0 });
  const rows: [
    AgentInfo[],
    boolean,
    boolean,
    ReturnType<typeof roomActivityDotColor>,
  ][] = [
    [[agent("b", back, "thinking")], false, false, "var(--green)"],
    [[agent("i", 0), agent("t", 1, "thinking")], false, false, "var(--green)"],
    [
      [agent("x", 0, "tool_executing"), agent("s", 1, "stopped")],
      true,
      false,
      "var(--green)",
    ],
    [[agent("i", 0)], true, false, "var(--purple)"],
    [[agent("i", 0)], false, false, null],
    [[agent("t", 0, "thinking")], true, true, null],
  ];
  for (const [agents, attention, active, color] of rows)
    expect(roomActivityDotColor(agents, attention, active)).toBe(color);
});
