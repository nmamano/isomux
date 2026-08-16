import { describe, expect, it } from "bun:test";
import type { PresenceInfo } from "../../shared/types.ts";
import { selectMiniGhosts } from "./MiniGhostCluster.tsx";

function presence(
  connectionId: string,
  viewMode: PresenceInfo["viewMode"],
  focusedAgentId: string | null,
): PresenceInfo {
  return {
    connectionId,
    userId: `user-${connectionId}`,
    username: connectionId,
    device: null,
    avatarColor: "#abcdef",
    avatarVariant: "classic",
    currentRoomId: "room-1",
    focusedAgentId,
    viewMode,
  };
}

describe("selectMiniGhosts", () => {
  it("filters self and non-log viewers before applying the cap", () => {
    const entries = [
      presence("self", "log", "agent-1"),
      presence("office", "office", "agent-1"),
      presence("away", "away", "agent-1"),
      presence("other-agent", "log", "agent-2"),
      presence("reader-1", "log", "agent-1"),
      presence("reader-2", "log", "agent-1"),
      presence("reader-3", "log", "agent-1"),
      presence("reader-4", "log", "agent-1"),
    ];

    const selected = selectMiniGhosts(entries, "self", 3, (entry) => {
      return entry.viewMode === "log" && entry.focusedAgentId === "agent-1";
    });

    expect(selected.map((entry) => entry.connectionId)).toEqual([
      "reader-1",
      "reader-2",
      "reader-3",
    ]);
  });
});
