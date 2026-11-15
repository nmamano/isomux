import { describe, expect, test } from "bun:test";
import type { LogEntry } from "../../shared/types.ts";
import { commandForPermissionDenial } from "../../shared/permission-denial.ts";
import {
  detachedSubagentSteps,
  findHiddenToolRuns,
  findRawToolCallGroups,
  hiddenRunSteps,
  isomuxRequestForToolCall,
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

// The chat of a member who does not show tool calls (task e7579473): every
// tool step that is not an office action folds into one "N steps" run.
describe("hidden tool runs", () => {
  const CURL = "curl -s localhost:4000/api/tasks";
  const officeCall = (id: string, name = "Bash") =>
    call(id, name, { command: CURL });
  const system = (id: string, metadata: Record<string, unknown> = {}) =>
    entry(id, "system", "line", metadata);
  const sub = (e: LogEntry, parent: string) => {
    e.metadata!.subagent = { parentToolUseId: `${parent}-tool` };
    return e;
  };
  const image = (e: LogEntry) => {
    e.attachments = [
      {
        filename: "hash.png",
        originalName: "shot.png",
        mediaType: "image/png",
        size: 10,
      },
    ];
    return e;
  };
  // Each run's entries, without the results paired to a call in the chat:
  // those fold into their call on screen whether or not the run holds them.
  function shape(entries: LogEntry[]): string[][] {
    const callIds = new Set(
      entries
        .filter((e) => e.kind === "tool_call")
        .map((e) => e.metadata?.toolId),
    );
    const paired = (e: LogEntry) =>
      e.kind === "tool_result" &&
      !e.attachments?.length &&
      callIds.has(e.metadata?.toolUseId);
    const runs = findHiddenToolRuns(entries);
    for (const run of runs) expect(run.firstId).toBe(run.entries[0].id);
    return runs.map((run) =>
      run.entries.filter((e) => !paired(e)).map((e) => e.id),
    );
  }

  test("every hidden kind joins one run: calls, errored calls, subagent steps of two subagents, denials, task breadcrumbs, Codex stderr and an unpaired result", () => {
    const entries = [
      entry("u", "user_message", "go"),
      call("a"),
      result("a-r", "a"),
      call("b", "Bash", { command: "ls" }),
      result("b-r", "b", true),
      sub(call("s1"), "p1"),
      sub(result("s1-r", "s1"), "p1"),
      sub(call("s2"), "p2"),
      system("denied", {
        permissionDenied: { toolUseId: "b-tool", toolName: "Bash" },
      }),
      system("task", { taskEvent: { taskId: "t1", phase: "started" } }),
      entry("stderr", "system", "[codex stderr] warning: x"),
      // Its call sits in an earlier, unloaded part of the chat.
      entry("orphan", "tool_result", "late", { toolUseId: "gone-tool" }),
      entry("orphan2", "tool_result", "no id"),
      entry("x", "text", "Done."),
    ];
    expect(shape(entries)).toEqual([
      ["a", "b", "s1", "s2", "denied", "task", "stderr", "orphan", "orphan2"],
    ]);
  });

  const splitters: [string, LogEntry][] = [
    ["a member message", entry("X", "user_message", "go on")],
    ["a text reply", entry("X", "text", "Here it is.")],
    ["thinking", entry("X", "thinking", "hmm")],
    ["a turn error", entry("X", "error", "The turn failed.")],
    ["an office action (Claude, Codex)", officeCall("X")],
    ["an office action (OpenCode shell)", officeCall("X", "shell")],
    ["an office action (OpenCode bash)", officeCall("X", "bash")],
    ["a notice", system("X", { notice: "settings" })],
    ["a plain system line", system("X")],
    ["a diff", entry("X", "diff", "diff")],
    ["a file view", entry("X", "file-view", "file")],
    ["an edit request", entry("X", "edit-request", "edit")],
    ["a terminal command", entry("X", "terminal-command", "cmd")],
    ["a secret request", entry("X", "secret-request", "secret")],
  ];
  for (const [label, splitter] of splitters)
    test(`${label} stays out of the runs and splits one`, () => {
      expect(shape([call("a"), splitter, call("b")])).toEqual([["a"], ["b"]]);
    });

  test("a result with images stays out of the runs and splits one; the same result without them is hidden", () => {
    const withImage = [
      call("a"),
      image(result("a-r", "a")),
      call("b"),
      result("b-r", "b"),
    ];
    expect(shape(withImage)).toEqual([["a"], ["b"]]);
    expect(
      findHiddenToolRuns(withImage).some((run) =>
        run.entries.some((e) => e.id === "a-r"),
      ),
    ).toBe(false);
    expect(
      shape([call("a"), result("a-r", "a"), call("b"), result("b-r", "b")]),
    ).toEqual([["a", "b"]]);
  });

  // A result paired with a call in the chat folds into that call's card, so
  // it neither starts a run nor splits one: a run of folded results alone
  // would draw an empty "1 step" line.
  test("a folded result never makes a run of its own", () => {
    const firstIds = (entries: LogEntry[]) =>
      findHiddenToolRuns(entries).map((run) => run.firstId);
    expect(
      firstIds([
        officeCall("o"),
        result("o-r", "o"),
        entry("x", "text", "Done."),
      ]),
    ).toEqual([]);
    // Parallel calls: both results land after the office card.
    expect(
      firstIds([
        call("a"),
        officeCall("o"),
        result("a-r", "a"),
        result("o-r", "o"),
        entry("x", "text", "Done."),
      ]),
    ).toEqual(["a"]);
    // An unpaired result is hidden on its own.
    expect(
      firstIds([
        officeCall("o"),
        result("o-r", "o"),
        entry("late", "tool_result", "x", { toolUseId: "old-tool" }),
      ]),
    ).toEqual(["late"]);
  });

  test("the shell tool names of every engine reach the office card parser", () => {
    for (const name of ["Bash", "bash", "shell"])
      expect({
        name,
        office: isomuxRequestForToolCall(name, { command: CURL }) !== null,
      }).toEqual({ name, office: true });
    // Not a shell tool, or not an office call.
    expect(isomuxRequestForToolCall("Read", { command: CURL })).toBeNull();
    expect(isomuxRequestForToolCall("shell", { command: "ls" })).toBeNull();
  });

  test("a long run is one run: no live tail cap splits it", () => {
    const entries = Array.from(
      { length: MAX_LIVE_TAIL_ENTRIES + 50 },
      (_, index) => call(`call-${index}`),
    );
    const runs = findHiddenToolRuns(entries);
    expect(runs).toHaveLength(1);
    expect(runs[0].entries).toHaveLength(MAX_LIVE_TAIL_ENTRIES + 50);
  });

  test("N steps counts the top-level calls, at least 1", () => {
    const steps = (entries: LogEntry[]) => {
      const runs = findHiddenToolRuns(entries);
      expect(runs).toHaveLength(1);
      return hiddenRunSteps(runs[0].entries);
    };
    expect(
      steps([
        call("a"),
        result("a-r", "a"),
        call("b"),
        result("b-r", "b", true),
        sub(call("s1"), "a"),
        sub(call("s2"), "a"),
        system("task", { taskEvent: { taskId: "t1", phase: "started" } }),
      ]),
    ).toBe(2);
    // A run with no top-level call still reads as one step.
    expect(
      steps([system("task", { taskEvent: { taskId: "t1", phase: "done" } })]),
    ).toBe(1);
    expect(steps([sub(call("s1"), "a"), sub(call("s2"), "a")])).toBe(1);
  });

  test("a detached subagent step whose starting call is in a hidden run jumps to the run", () => {
    const start = entry("agent", "tool_call", "Agent", {
      toolId: "agent-tool",
      input: { description: "x", run_in_background: true },
    });
    const entries = [
      call("a"),
      start,
      result("agent-r", "agent"),
      entry("u1", "user_message", "go on"),
      sub(call("s1"), "agent"),
    ];
    const runs = findHiddenToolRuns(entries);
    expect(runs.map((run) => run.firstId)).toEqual(["a", "s1"]);
    expect(detachedSubagentSteps(entries, runs).get("s1")).toEqual({
      target: "a",
      background: true,
    });
  });
});
