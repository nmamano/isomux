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

it("still shows a working back agent as the room's activity", () => {
  const back = agent(
    "back",
    deskOfBackSeat({ table: 0, stool: 0 }),
    "thinking",
  );
  expect(roomActivityDotColor([back], false, false)).toBe("var(--green)");
});
