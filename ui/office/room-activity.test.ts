// A room tab's dot (task 89d17270): green while any agent works, a back agent
// included; unread output lights none; never on the active room's own tab.
import { expect, it } from "bun:test";
import type { AgentInfo } from "../../shared/types.ts";
import { deskOfBackSeat } from "../../shared/desks.ts";
import { roomActivityDotColor } from "./room-activity.ts";

const agent = (id: string, desk: number, state = "idle") =>
  ({ id, desk, state }) as unknown as AgentInfo;

it("lights the dot only for work, and hides it on the active room", () => {
  const back = deskOfBackSeat({ table: 0, stool: 0 });
  const rows: [
    AgentInfo[],
    boolean,
    ReturnType<typeof roomActivityDotColor>,
  ][] = [
    [[agent("b", back, "thinking")], false, "var(--green)"],
    [[agent("i", 0), agent("t", 1, "thinking")], false, "var(--green)"],
    [
      [agent("x", 0, "tool_executing"), agent("s", 1, "stopped")],
      false,
      "var(--green)",
    ],
    [[agent("i", 0), agent("w", 1, "waiting_for_response")], false, null],
    [[agent("t", 0, "thinking")], true, null],
  ];
  for (const [agents, active, color] of rows)
    expect(roomActivityDotColor(agents, active)).toBe(color);
});
