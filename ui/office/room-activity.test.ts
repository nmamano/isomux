// A room tab's dot (task 89d17270): green while any agent works, a back agent
// included; unread output lights none; never on the active room's own tab.
// The room chat's unread posts light the accent, and work wins (task 5b055cf3).
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
    number?,
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
    [[agent("i", 0)], false, "var(--accent)", 2],
    [[], false, "var(--accent)", 1],
    [[agent("t", 0, "thinking")], false, "var(--green)", 3],
    [[agent("i", 0)], true, null, 3],
    [[agent("i", 0)], false, null, 0],
  ];
  for (const [agents, active, color, chatUnread] of rows)
    expect({
      agents: agents.map((a) => a.state),
      active,
      chatUnread,
      color: roomActivityDotColor(agents, active, chatUnread),
    }).toEqual({
      agents: agents.map((a) => a.state),
      active,
      chatUnread,
      color,
    });
});
