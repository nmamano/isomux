// Which chat the background prefetch loads next (task 9ebe887d slice 2):
// an agent of the room on screen with no stream, newest last entry first,
// one at a time, and none while any load is in flight. How the prefetch runs
// in the App is in ui/App.chat-on-open.dom.test.tsx.

import { describe, expect, it } from "bun:test";
import { nextPrefetchAgent } from "./log-prefetch.ts";
import type { LogStream } from "./store.tsx";
import type { AgentInfo } from "../shared/types.ts";

const agent = (
  id: string,
  roomId: string,
  desk: number,
  lastEntryAt?: number,
): AgentInfo =>
  ({
    id,
    name: id,
    roomId,
    desk,
    ...(lastEntryAt !== undefined ? { lastEntryAt } : {}),
  }) as AgentInfo;
const stream = (state: LogStream["state"]): LogStream => ({
  state,
  requestId: "r",
  replay: [],
  live: [],
});

const AGENTS = [
  agent("old", "r1", 0, 100),
  agent("newest", "r1", 1, 300),
  agent("middle", "r1", 2, 200),
  agent("never", "r1", 3),
  agent("elsewhere", "r2", 0, 999),
  agent("back", "r1", 8, 500),
];
const none = new Map<string, LogStream>();
const nobody = new Set<string>();

describe("nextPrefetchAgent", () => {
  it("picks the room's agent with the newest last entry, front desks only while the back room is closed", () => {
    expect(nextPrefetchAgent(AGENTS, none, nobody, "r1", false)).toBe("newest");
    expect(nextPrefetchAgent(AGENTS, none, nobody, "r1", true)).toBe("back");
  });

  it("skips agents with a stream or on screen, and an agent with no entry date comes last", () => {
    const streams = new Map([
      ["newest", stream("recent")],
      ["middle", stream("complete")],
    ]);
    expect(
      nextPrefetchAgent(AGENTS, streams, new Set(["old"]), "r1", false),
    ).toBe("never");
    expect(nextPrefetchAgent(AGENTS, streams, nobody, "r1", false)).toBe("old");
  });

  it("waits while any load is in flight, in any room", () => {
    const streams = new Map([["elsewhere", stream("loading")]]);
    expect(nextPrefetchAgent(AGENTS, streams, nobody, "r1", false)).toBeNull();
  });

  it("stops when every agent of the room has a stream, and with no room", () => {
    const streams = new Map(
      AGENTS.filter((a) => a.roomId === "r1").map(
        (a) => [a.id, stream("recent")] as const,
      ),
    );
    expect(nextPrefetchAgent(AGENTS, streams, nobody, "r1", true)).toBeNull();
    expect(nextPrefetchAgent(AGENTS, none, nobody, null, false)).toBeNull();
  });
});
