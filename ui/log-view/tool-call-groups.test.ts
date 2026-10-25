import { describe, expect, test } from "bun:test";
import type { LogEntry } from "../../shared/types.ts";
import {
  commandForPermissionDenial,
  detachedSubagentSteps,
  findRawToolCallGroups,
  liveTailEntryIds,
  MAX_LIVE_TAIL_ENTRIES,
  lastVisibleEntryIndex,
} from "./tool-call-groups.ts";

function entry(
  id: string,
  kind: LogEntry["kind"],
  content: string,
  metadata?: Record<string, unknown>,
): LogEntry {
  return { id, agentId: "agent-1", timestamp: 1, kind, content, metadata };
}

function call(id: string, name = "Read", input: unknown = { file_path: id }) {
  return entry(id, "tool_call", name, { toolId: `${id}-tool`, input });
}

function result(id: string, callId: string, isError = false) {
  return entry(id, "tool_result", "result", {
    toolUseId: `${callId}-tool`,
    isError,
  });
}

describe("raw tool-call groups", () => {
  test("groups consecutive raw calls across their folded results", () => {
    const entries = [
      call("a"),
      result("ar", "a"),
      call("b"),
      result("br", "b"),
    ];
    expect(
      findRawToolCallGroups(entries).map((group) =>
        group.entries.map((e) => e.id),
      ),
    ).toEqual([["a", "b"]]);
  });

  test("structured curls, errors, visible entries, and subagent identities break runs", () => {
    const a = call("a");
    const curl = call("curl", "Bash", {
      command: "curl -s localhost:4000/api/tasks",
    });
    const failed = call("failed");
    const sub1 = call("sub1");
    sub1.metadata!.subagent = { parentToolUseId: "parent-1" };
    const sub2 = call("sub2");
    sub2.metadata!.subagent = { parentToolUseId: "parent-2" };
    const entries = [
      a,
      call("b"),
      curl,
      failed,
      result("failed-r", "failed", true),
      call("c"),
      entry("text", "text", "hello"),
      sub1,
      sub2,
    ];
    expect(
      findRawToolCallGroups(entries).map((group) =>
        group.entries.map((e) => e.id),
      ),
    ).toEqual([["a", "b"]]);
  });

  test("a visible attachment result breaks the group", () => {
    const attachmentResult = result("ar", "a");
    attachmentResult.attachments = [
      {
        filename: "hash.png",
        originalName: "shot.png",
        mediaType: "image/png",
        size: 10,
      },
    ];
    const entries = [call("a"), attachmentResult, call("b"), result("br", "b")];
    expect(findRawToolCallGroups(entries)).toEqual([]);
  });

  test("a visible result without toolUseId breaks the group", () => {
    const orphan = entry("orphan", "tool_result", "visible result");
    const entries = [call("a"), orphan, call("b"), result("br", "b")];
    expect(findRawToolCallGroups(entries)).toEqual([]);
  });

  test("a completed turn stays grouped while the active turn is excluded", () => {
    const entries = [
      entry("user-1", "user_message", "first"),
      call("old-a"),
      result("old-ar", "old-a"),
      call("old-b"),
      result("old-br", "old-b"),
      entry("user-2", "user_message", "next"),
      call("live-a"),
      call("live-b"),
    ];
    const activeIds = new Set(["live-a", "live-b"]);
    expect(
      findRawToolCallGroups(entries, activeIds).map((group) =>
        group.entries.map((item) => item.id),
      ),
    ).toEqual([["old-a", "old-b"]]);
  });

  test("a long autonomous tail keeps only its trailing tool batch live", () => {
    const sub1 = call("sub-1");
    const sub2 = call("sub-2");
    sub1.metadata!.subagent = { parentToolUseId: "parent" };
    sub2.metadata!.subagent = { parentToolUseId: "parent" };
    const entries = [
      call("old-a"),
      result("old-ar", "old-a"),
      call("old-b"),
      result("old-br", "old-b"),
      sub1,
      sub2,
      result("sub-1-r", "sub-1"),
      entry("parent-text", "text", "parent agent speaks"),
      result("sub-2-r", "sub-2"),
      call("live-a"),
      call("live-b"),
    ];

    const busyGroups = findRawToolCallGroups(
      entries,
      liveTailEntryIds(entries, true),
    );
    const idleGroups = findRawToolCallGroups(
      entries,
      liveTailEntryIds(entries, false),
    );
    expect(
      busyGroups.map((group) => group.entries.map((item) => item.id)),
    ).toEqual([
      ["old-a", "old-b"],
      ["sub-1", "sub-2"],
    ]);
    expect(
      idleGroups
        .slice(0, 2)
        .map((group) => group.entries.map((item) => item.id)),
    ).toEqual([
      ["old-a", "old-b"],
      ["sub-1", "sub-2"],
    ]);
    const busyChildren = new Set(
      busyGroups.flatMap((group) =>
        group.entries.slice(1).map((item) => item.id),
      ),
    );
    const idleChildren = new Set(
      idleGroups.flatMap((group) =>
        group.entries.slice(1).map((item) => item.id),
      ),
    );
    expect(lastVisibleEntryIndex(entries, busyChildren)).toBe(10);
    expect(lastVisibleEntryIndex(entries, idleChildren)).toBe(9);
  });

  test("the live tool tail is capped without a user-message boundary", () => {
    const entries = Array.from(
      { length: MAX_LIVE_TAIL_ENTRIES + 20 },
      (_, index) => call(`call-${index}`),
    );
    const liveIds = liveTailEntryIds(entries, true);
    expect(liveIds.size).toBe(MAX_LIVE_TAIL_ENTRIES);
    expect(liveIds.has("call-19")).toBe(false);
    expect(liveIds.has("call-20")).toBe(true);
  });
});

describe("permission-denied command recovery", () => {
  test("returns a matching single-line Bash command", () => {
    const bash = call("bash", "Bash", { command: "bun test" });
    expect(commandForPermissionDenial({ toolUseId: "bash-tool" }, [bash])).toBe(
      "bun test",
    );
  });

  test("rejects newline and carriage-return execution bytes", () => {
    for (const command of ["echo safe\necho run", "echo safe\recho run"]) {
      const bash = call("bash", "Bash", { command });
      expect(
        commandForPermissionDenial({ toolUseId: "bash-tool" }, [bash]),
      ).toBeNull();
    }
  });

  test("rejects missing matches and non-Bash calls", () => {
    expect(
      commandForPermissionDenial({ toolUseId: "x" }, [call("a")]),
    ).toBeNull();
    expect(commandForPermissionDenial({}, [call("a")])).toBeNull();
  });
});

describe("detached subagent steps", () => {
  // The call that starts a subagent (Claude's Agent tool) and one step of it.
  function start(id: string, background: boolean) {
    return entry(id, "tool_call", "Agent", {
      toolId: `${id}-tool`,
      input: {
        description: "Submit the listing",
        run_in_background: background,
      },
    });
  }
  function step(e: LogEntry, parent: string): LogEntry {
    e.metadata!.subagent = {
      parentToolUseId: `${parent}-tool`,
      type: "general-purpose",
      description: "Submit the listing",
    };
    return e;
  }
  const member = (id: string) => entry(id, "user_message", "go on");
  const steps = (entries: LogEntry[]) =>
    detachedSubagentSteps(entries, findRawToolCallGroups(entries));

  test("only steps after a member message that came after the starting call are detached", () => {
    const entries = [
      member("u0"),
      start("agent", true),
      result("agent-r", "agent"),
      step(call("s0"), "agent"),
      step(result("s0-r", "s0"), "agent"),
      step(call("s1"), "agent"),
      member("u1"),
      // The incident: the result of a call made before u1 lands after it.
      step(result("s1-r", "s1", true), "agent"),
      // Two later steps fold into one raw group: both carry the state.
      step(call("s2"), "agent"),
      step(result("s2-r", "s2"), "agent"),
      step(call("s3"), "agent"),
      step(result("s3-r", "s3"), "agent"),
    ];
    const groups = findRawToolCallGroups(entries);
    expect(groups.map((g) => g.entries.map((e) => e.id))).toContainEqual([
      "s2",
      "s3",
    ]);
    const map = detachedSubagentSteps(entries, groups);
    const detached = { target: "agent", background: true };
    expect(map.get("s1-r")).toEqual(detached);
    expect(map.get("s2")).toEqual(detached);
    expect(map.get("s3")).toEqual(detached);
    // u0 sits before the starting call, so it separates nothing.
    for (const id of ["s0", "s0-r", "s1", "agent", "u1"]) {
      expect(map.has(id)).toBe(false);
    }
  });

  test("a foreground subagent whose turn took a steer is detached, not background", () => {
    const entries = [
      start("agent", false),
      member("steer"),
      step(call("s1"), "agent"),
    ];
    expect(steps(entries).get("s1")).toEqual({
      target: "agent",
      background: false,
    });
  });

  test("a starting call hidden in a collapsed group jumps to the group", () => {
    const entries = [
      call("a"),
      result("a-r", "a"),
      start("agent", true),
      result("agent-r", "agent"),
      member("u1"),
      step(call("s1"), "agent"),
    ];
    const groups = findRawToolCallGroups(entries);
    expect(groups.map((g) => g.entries.map((e) => e.id))).toEqual([
      ["a", "agent"],
    ]);
    expect(detachedSubagentSteps(entries, groups).get("s1")).toEqual({
      target: "a",
      background: true,
    });
    // Without the group (a live tail, say) the call itself is the target.
    expect(detachedSubagentSteps(entries, []).get("s1")?.target).toBe("agent");
  });

  test("a step whose starting call is not in the chat is not detached", () => {
    const entries = [member("u1"), step(call("s1"), "agent")];
    expect(steps(entries).size).toBe(0);
  });
});
