import { describe, expect, test } from "bun:test";
import type { LogEntry } from "../../shared/types.ts";
import {
  commandForPermissionDenial,
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

  test("the group head receives the final-turn affordance", () => {
    const entries = [
      call("a"),
      call("b"),
      result("ar", "a"),
      result("br", "b"),
    ];
    expect(lastVisibleEntryIndex(entries, new Set(["b"]))).toBe(0);
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

  test("indexed and plain passes apply one grouping policy", () => {
    const attachmentResult = result("image-r", "image");
    attachmentResult.attachments = [
      {
        filename: "hash.png",
        originalName: "shot.png",
        mediaType: "image/png",
        size: 10,
      },
    ];
    const sub1a = call("sub1-a");
    const sub1b = call("sub1-b");
    const sub2a = call("sub2-a");
    const sub2b = call("sub2-b");
    for (const item of [sub1a, sub1b])
      item.metadata!.subagent = { parentToolUseId: "parent-1" };
    for (const item of [sub2a, sub2b])
      item.metadata!.subagent = { parentToolUseId: "parent-2" };
    const entries = [
      call("a"),
      result("ar", "a"),
      call("b"),
      result("br", "b"),
      call("image"),
      attachmentResult,
      entry("orphan", "tool_result", "visible without toolUseId"),
      call("failed"),
      result("failed-r", "failed", true),
      call("curl", "Bash", {
        command: "curl -s localhost:4000/api/tasks",
      }),
      sub1a,
      sub1b,
      sub2a,
      sub2b,
    ];
    const indexed = findRawToolCallGroups(entries);
    const plain = findRawToolCallGroups(entries, new Set(), null);
    expect(indexed).toEqual(plain);
    expect(
      indexed.map((group) => group.entries.map((item) => item.id)),
    ).toEqual([
      ["a", "b"],
      ["sub1-a", "sub1-b"],
      ["sub2-a", "sub2-b"],
    ]);
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
