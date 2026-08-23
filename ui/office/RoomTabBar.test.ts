import { describe, expect, it } from "bun:test";
import type { AgentInfo } from "../../shared/types.ts";
import { roomActivityDotColor } from "./RoomTabBar.tsx";

function agent(state: AgentInfo["state"]): AgentInfo {
  return { state } as AgentInfo;
}

describe("room activity dot", () => {
  it("uses green when any agent is actively working", () => {
    expect(
      roomActivityDotColor([agent("idle"), agent("thinking")], false, false),
    ).toBe("var(--green)");
    expect(
      roomActivityDotColor(
        [agent("tool_executing"), agent("stopped")],
        true,
        false,
      ),
    ).toBe("var(--green)");
  });

  it("keeps unread attention purple without an active worker", () => {
    expect(roomActivityDotColor([agent("idle")], true, false)).toBe(
      "var(--purple)",
    );
  });

  it("hides the dot without activity or attention and in the active room", () => {
    expect(roomActivityDotColor([agent("idle")], false, false)).toBeNull();
    expect(roomActivityDotColor([agent("thinking")], true, true)).toBeNull();
  });
});
