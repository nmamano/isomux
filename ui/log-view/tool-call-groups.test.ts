import { describe, expect, test } from "bun:test";
import type { LogEntry } from "../../shared/types.ts";
import { commandForPermissionDenial } from "../../shared/permission-denial.ts";
import { NO_UPDATE } from "../../shared/no-update.ts";
import { logTextFields, msg } from "../../shared/i18n/log-message.ts";
import {
  detachedSubagentSteps,
  findHiddenRuns,
  findHiddenToolRuns,
  findRawToolCallGroups,
  hiddenRunCounts,
  hiddenRunPeers,
  isAgentMessageEntry,
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

  // Task fcfffe51: OpenCode's shell tool, under both of its names.
  test("returns the command of an OpenCode shell call", () => {
    for (const name of ["shell", "bash"]) {
      const shell = call("sh", name, { command: "bun test", description: "x" });
      expect({
        name,
        command: commandForPermissionDenial({ toolUseId: "sh-tool" }, [shell]),
      }).toEqual({ name, command: "bun test" });
    }
  });

  // Run runs in the terminal panel's folder: a call that ran in another
  // folder (OpenCode's workdir, a Codex call outside the session's folder)
  // has no Run.
  test("rejects a call that names its own folder", () => {
    for (const name of ["Bash", "shell", "bash"]) {
      const elsewhere = call("sh", name, {
        command: "bun test",
        workdir: "/srv/other",
      });
      expect({
        name,
        command: commandForPermissionDenial({ toolUseId: "sh-tool" }, [
          elsewhere,
        ]),
      }).toEqual({ name, command: null });
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

// Messages between agents in the chat (task d5c0f33d, Nil 2026-11-15: "just
// like we minimized function calls, we should also have a setting for
// minimizing agent messages"). An agent message is a message another agent
// sent (a user_message with sender_agent_*), or a card of this agent's that
// sends, schedules or steers one (POST /api/agents/:id/messages). With the
// fold on, a run of them is one line; with the tool fold on too, steps and
// messages share one line. The chat that draws the lines:
// LogView.hide-tool-calls.dom.test.tsx.
describe("agent-message runs", () => {
  const AUTH = `-H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"`;
  // The agent reference's form: the text in a quoted heredoc, options in
  // the query.
  const send = (id: string, to: string, query = "", name = "Bash") =>
    call(id, name, {
      command: `curl -s -X POST "localhost:4000/api/agents/${to}/messages${query}" ${AUTH} -H 'Content-Type: text/plain' --data-binary @- <<'EOF'\nHello there.\nEOF`,
    });
  const office = (id: string, method: string, path: string) =>
    call(id, "Bash", {
      command: `curl -s -X ${method} localhost:4000${path} ${AUTH} -d '{}'`,
    });
  const peer = (id: string, from: string | undefined = "a2") =>
    entry(id, "user_message", `From ${from}`, {
      ...(from ? { sender_agent_id: from } : {}),
      sender_agent_name: "Peer",
      sender_agent_room: "Room",
    });
  const member = (id: string, metadata: Record<string, unknown> = {}) =>
    entry(id, "user_message", "go", { username: "Nil", ...metadata });
  const text = (id: string) => entry(id, "text", "Here it is.");
  const sub = (e: LogEntry, parent: string) => {
    e.metadata!.subagent = { parentToolUseId: `${parent}-tool` };
    return e;
  };

  // Each run's entries without the results paired to a call in the chat:
  // those fold into their call's card wherever the run holds them.
  function shape(
    entries: LogEntry[],
    fold: { tools: boolean; messages: boolean },
  ): string[][] {
    const callIds = new Set(
      entries
        .filter((e) => e.kind === "tool_call")
        .map((e) => e.metadata?.toolId),
    );
    const paired = (e: LogEntry) =>
      e.kind === "tool_result" &&
      !e.attachments?.length &&
      callIds.has(e.metadata?.toolUseId);
    const runs = findHiddenRuns(entries, fold);
    for (const run of runs) expect(run.firstId).toBe(run.entries[0].id);
    return runs.map((run) =>
      run.entries.filter((e) => !paired(e)).map((e) => e.id),
    );
  }
  const MESSAGES = { tools: false, messages: true };
  const BOTH = { tools: true, messages: true };

  test("what counts: messages from agents, and cards that send, steer or schedule one, on every engine", () => {
    const yes: [string, LogEntry][] = [
      ["a message from another agent", peer("x")],
      ["a message from an agent with no id on record", peer("x", undefined)],
      ["a send", send("x", "a2")],
      ["a steer", send("x", "a2", "?steer=1")],
      [
        "a scheduled message",
        send("x", "a2", "?deliverAt=2026-11-16T10:00:00Z"),
      ],
      ["a send with a retry id", send("x", "a2", "?clientMessageId=c1")],
      ["a send from OpenCode's shell", send("x", "a2", "", "shell")],
      ["a send from OpenCode's older bash", send("x", "a2", "", "bash")],
    ];
    const no: [string, LogEntry][] = [
      ["a member's message", member("x")],
      [
        "a member's message through an API token",
        member("x", { device: "pat-1" }),
      ],
      [
        "an app's message",
        entry("x", "user_message", "r", {
          sender_app_name: "Monitor",
          username: "Monitor",
        }),
      ],
      [
        "a schedule's message",
        entry("x", "user_message", "r", {
          sender_cronjob_id: "c1",
          sender_cronjob_name: "Nightly",
        }),
      ],
      [
        "a webhook's message",
        entry("x", "user_message", "r", {
          sender_webhook_id: "w1",
          sender_webhook_name: "GitHub",
        }),
      ],
      [
        "a messaging app's message",
        entry("x", "user_message", "r", {
          sender_messaging_app: "whatsapp",
          sender_messaging_route_id: "r1",
          sender_messaging_route_name: "Pat",
        }),
      ],
      ["a stop", office("x", "POST", "/api/agents/a2/abort")],
      [
        "a list of scheduled messages",
        office("x", "GET", "/api/agents/a2/scheduled-messages"),
      ],
      [
        "a cancel of a scheduled message",
        office("x", "DELETE", "/api/agents/a2/scheduled-messages/s1"),
      ],
      ["an ask", office("x", "POST", "/api/asks")],
      [
        "a reply to an API token's inbox",
        office("x", "POST", "/api/api-token-inboxes/pat-1/messages"),
      ],
      [
        "a reply on a messaging route",
        office("x", "POST", "/api/messaging/routes/r1/messages"),
      ],
      ["a shell command", call("x", "Bash", { command: "ls" })],
      ["a reply to the member", text("x")],
    ];
    for (const [label, e] of yes)
      expect({ label, is: isAgentMessageEntry(e) }).toEqual({
        label,
        is: true,
      });
    for (const [label, e] of no)
      expect({ label, is: isAgentMessageEntry(e) }).toEqual({
        label,
        is: false,
      });
  });

  // Only messages fold: a step the member sees splits a run, and a run
  // goes on past the turn a message from another agent starts.
  test("messages only: a run of messages is one run across turns, and a shown step splits it", () => {
    const entries = [
      member("u"),
      text("x"),
      send("s1", "a2"),
      result("s1-r", "s1"),
      peer("p1", "a2"),
      peer("p2", "a3"),
      call("c1", "Bash", { command: "ls" }),
      result("c1-r", "c1"),
      send("s2", "a2", "?steer=1"),
      result("s2-r", "s2"),
      text("x2"),
    ];
    expect(shape(entries, MESSAGES)).toEqual([["s1", "p1", "p2"], ["s2"]]);
  });

  // The tool fold alone is today's fold, entry for entry.
  test("tools only: the runs are the tool fold's, and messages split them as before", () => {
    const entries = [
      member("u"),
      call("c1", "Bash", { command: "ls" }),
      result("c1-r", "c1"),
      send("s1", "a2"),
      result("s1-r", "s1"),
      call("c2"),
      peer("p1"),
      call("c3"),
      text("x"),
    ];
    expect(findHiddenRuns(entries, { tools: true, messages: false })).toEqual(
      findHiddenToolRuns(entries),
    );
    expect(shape(entries, { tools: true, messages: false })).toEqual([
      ["c1"],
      ["c2"],
      ["c3"],
    ]);
  });

  // Both folds: a reply chain (send, the answer, the steps it led to, the
  // next send) is one line.
  test("both: steps and messages share one run, across the turn an agent's message starts", () => {
    const entries = [
      member("u"),
      text("x"),
      call("c1", "Bash", { command: "ls" }),
      result("c1-r", "c1"),
      send("s1", "a2"),
      result("s1-r", "s1"),
      peer("p1", "a2"),
      call("c2"),
      result("c2-r", "c2"),
      send("s2", "a2", "?deliverAt=2026-11-16T10:00:00Z"),
      result("s2-r", "s2"),
      text("x2"),
    ];
    expect(shape(entries, BOTH)).toEqual([["c1", "s1", "p1", "c2", "s2"]]);
  });

  test("no fold: no runs", () => {
    const entries = [send("s1", "a2"), peer("p1"), call("c1")];
    expect(findHiddenRuns(entries, { tools: false, messages: false })).toEqual(
      [],
    );
  });

  // A message that is not from an agent stays in the chat with either fold
  // on, and splits the run it sits in.
  test("a member's, API token's, app's, schedule's, webhook's or messaging app's message splits a run", () => {
    const splitters: [string, LogEntry][] = [
      ["member", member("X")],
      ["API token", member("X", { device: "pat-1" })],
      [
        "app",
        entry("X", "user_message", "r", {
          sender_app_name: "Monitor",
          username: "Monitor",
        }),
      ],
      [
        "schedule",
        entry("X", "user_message", "r", {
          sender_cronjob_id: "c1",
          sender_cronjob_name: "Nightly",
        }),
      ],
      [
        "webhook",
        entry("X", "user_message", "r", {
          sender_webhook_id: "w1",
          sender_webhook_name: "GitHub",
        }),
      ],
      [
        "messaging app",
        entry("X", "user_message", "r", {
          sender_messaging_app: "whatsapp",
          sender_messaging_route_id: "r1",
          sender_messaging_route_name: "Pat",
        }),
      ],
    ];
    for (const [label, splitter] of splitters)
      for (const fold of [MESSAGES, BOTH])
        expect({
          label,
          fold,
          runs: shape([peer("a"), splitter, send("b", "a2")], fold),
        }).toEqual({ label, fold, runs: [["a"], ["b"]] });
  });

  // An office card that is not a message (a stop, an ask) stays a card.
  test("an office card that is not a message splits a run", () => {
    for (const card of [
      office("X", "POST", "/api/agents/a2/abort"),
      office("X", "POST", "/api/asks"),
      office("X", "GET", "/api/agents/a2/scheduled-messages"),
    ])
      for (const fold of [MESSAGES, BOTH])
        expect(shape([peer("a"), card, send("b", "a2")], fold)).toEqual([
          ["a"],
          ["b"],
        ]);
  });

  // "2 agent messages · 3 steps": messages are the agents' messages and the
  // top-level cards that send one; steps are the other top-level calls. A
  // run with no message still reads as at least one step, as before.
  test("the line counts messages and steps apart", () => {
    const counts = (entries: LogEntry[], fold = BOTH) => {
      const runs = findHiddenRuns(entries, fold);
      expect(runs).toHaveLength(1);
      return hiddenRunCounts(runs[0].entries);
    };
    expect(
      counts([
        call("c1"),
        result("c1-r", "c1"),
        send("s1", "a2"),
        result("s1-r", "s1"),
        peer("p1"),
        call("c2"),
        sub(call("sc1"), "c2"),
        send("s2", "a3", "?steer=1"),
      ]),
    ).toEqual({ messages: 3, steps: 2 });
    expect(counts([peer("p1"), peer("p2")], MESSAGES)).toEqual({
      messages: 2,
      steps: 0,
    });
    expect(
      counts([
        entry("t", "system", "line", {
          taskEvent: { taskId: "t1", phase: "done" },
        }),
      ]),
    ).toEqual({ messages: 0, steps: 1 });
  });

  // The line shows who the run talked with: the sender of each message in,
  // the receiver of each message out, first seen first, each once, three at
  // most.
  test("the peers: senders and receivers in order of first appearance, each once, at most 3", () => {
    const runs = findHiddenRuns(
      [
        send("s1", "a2"),
        peer("p1", "a3"),
        send("s2", "a2", "?steer=1"),
        peer("p2", "a3"),
        peer("p3", undefined),
        send("s3", "a4", "?deliverAt=2026-11-16T10:00:00Z"),
        peer("p4", "a5"),
      ],
      MESSAGES,
    );
    expect(runs).toHaveLength(1);
    expect(hiddenRunPeers(runs[0].entries)).toEqual(["a2", "a3", "a4"]);
    expect(hiddenRunPeers([call("c1"), text("x")])).toEqual([]);
  });
});

// A reply that is only the no-update keyword (task 51c187f4): it shows no
// card. It folds into the line around it, whatever the member shows, so
// back-to-back turns of agent traffic that end with it read as one line.
describe("no-update replies", () => {
  const AUTH = `-H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"`;
  const send = (id: string, to: string) =>
    call(id, "Bash", {
      command: `curl -s -X POST "localhost:4000/api/agents/${to}/messages" ${AUTH} -H 'Content-Type: text/plain' --data-binary @- <<'EOF'\nHello.\nEOF`,
    });
  const peer = (id: string) =>
    entry(id, "user_message", "From a2", {
      sender_agent_id: "a2",
      sender_agent_name: "Peer",
      sender_agent_room: "Room",
    });
  const member = (id: string) =>
    entry(id, "user_message", "go", { username: "Nil" });
  const quiet = (id: string) => entry(id, "text", NO_UPDATE);
  const legacy = (id: string) =>
    entry(id, "text", "_(nothing to bring to the members' attention)_");
  const reply = (id: string, content = "Here it is.") =>
    entry(id, "text", content);
  const FOLDS = [
    { tools: true, messages: true },
    { tools: true, messages: false },
    { tools: false, messages: true },
    { tools: false, messages: false },
  ];
  const ids = (entries: LogEntry[], fold: (typeof FOLDS)[number]) =>
    findHiddenRuns(entries, fold).map((run) => {
      expect(run.firstId).toBe(run.entries[0].id);
      return run.entries.map((e) => e.id);
    });

  test("with both folds on, back-to-back agent-driven turns that end with it are one run", () => {
    const entries = [
      member("u"),
      reply("x"),
      peer("p1"),
      call("c1"),
      result("c1-r", "c1"),
      quiet("q1"),
      peer("p2"),
      send("s1", "a2"),
      result("s1-r", "s1"),
      legacy("q2"),
      member("u2"),
    ];
    expect(ids(entries, FOLDS[0])).toEqual([
      ["p1", "c1", "c1-r", "q1", "p2", "s1", "s1-r", "q2"],
    ]);
  });

  test("it never breaks a run, and it can start one, on every fold", () => {
    // The run each fold makes of [a step, a message, the keyword, a step].
    const entries = [call("c1"), peer("p1"), quiet("q1"), call("c2")];
    expect(FOLDS.map((fold) => ids(entries, fold))).toEqual([
      [["c1", "p1", "q1", "c2"]],
      [["c1"], ["q1", "c2"]],
      [["p1", "q1"]],
      [["q1"]],
    ]);
    // It starts a run after a card the member sees.
    for (const fold of FOLDS)
      expect({ fold, runs: ids([reply("x"), quiet("q1")], fold) }).toEqual({
        fold,
        runs: [["q1"]],
      });
  });

  test("anything the member sees ends the run: a member's message, a reply with words", () => {
    for (const fold of FOLDS) {
      expect({
        fold,
        runs: ids([quiet("q1"), member("u"), quiet("q2")], fold),
      }).toEqual({ fold, runs: [["q1"], ["q2"]] });
      expect({
        fold,
        runs: ids([quiet("q1"), reply("x", `Done.\n\n${NO_UPDATE}`)], fold),
      }).toEqual({ fold, runs: [["q1"]] });
    }
  });

  test("the line says nothing is for the member, and a run of only that counts no step", () => {
    const counts = (entries: LogEntry[], fold = FOLDS[0]) => {
      const runs = findHiddenRuns(entries, fold);
      expect(runs.length).toBe(1);
      return hiddenRunCounts(runs[0].entries);
    };
    expect(counts([quiet("q1")])).toEqual({
      messages: 0,
      steps: 0,
      quiet: true,
    });
    expect(counts([legacy("q1"), quiet("q2")], FOLDS[3])).toEqual({
      messages: 0,
      steps: 0,
      quiet: true,
    });
    expect(counts([peer("p1"), quiet("q1")])).toEqual({
      messages: 1,
      steps: 0,
      quiet: true,
    });
    expect(counts([call("c1"), result("c1-r", "c1"), quiet("q1")])).toEqual({
      messages: 0,
      steps: 1,
      quiet: true,
    });
    // A run without it keeps today's counts, with no quiet mark.
    expect(counts([call("c1")])).toEqual({ messages: 0, steps: 1 });
    expect(counts([peer("p1")])).toEqual({ messages: 1, steps: 0 });
  });
});

// The line the office writes when it resumes an agent after a restart
// (sign-off of task 51c187f4, Nil 2026-11-16: "After a restart, fold the
// next quiet turn into the same line"). It joins a run only when the entry
// after it joins that run too, so it never splits one line in two and never
// hides inside a line that would not be there without it.
describe("the restart line in a run", () => {
  const system = (id: string, text: Parameters<typeof logTextFields>[0]) => ({
    ...entry(id, "system", ""),
    ...logTextFields(text),
  });
  const restart = (id: string) =>
    system(id, msg("systemEntries.restartWake.resumed"));
  const peer = (id: string) =>
    entry(id, "user_message", "From a2", {
      sender_agent_id: "a2",
      sender_agent_name: "Peer",
      sender_agent_room: "Room",
    });
  const quiet = (id: string) => entry(id, "text", NO_UPDATE);
  const reply = (id: string) => entry(id, "text", "Here it is.");
  const FOLDS = [
    { tools: true, messages: true },
    { tools: true, messages: false },
    { tools: false, messages: true },
    { tools: false, messages: false },
  ];
  const ids = (entries: LogEntry[], fold: (typeof FOLDS)[number]) =>
    findHiddenRuns(entries, fold).map((run) => {
      expect(run.firstId).toBe(run.entries[0].id);
      return run.entries.map((e) => e.id);
    });

  test("the fixture is the line the office writes", () => {
    const line = restart("R");
    expect(line.message).toEqual([
      { key: "systemEntries.restartWake.resumed" },
    ]);
    expect(line.content.length).toBeGreaterThan(0);
  });

  test("between two entries of one run, it joins the run, on every fold", () => {
    // Nil's sign-off image: three turns of agent traffic that each end with
    // nothing for the member; the server restarted during the third.
    const entries = [
      peer("p1"),
      call("c1"),
      result("c1-r", "c1"),
      quiet("q1"),
      peer("p2"),
      call("c2"),
      quiet("q2"),
      peer("p3"),
      call("c3"),
      restart("R"),
      quiet("q3"),
    ];
    expect(ids(entries, FOLDS[0])).toEqual([
      ["p1", "c1", "c1-r", "q1", "p2", "c2", "q2", "p3", "c3", "R", "q3"],
    ]);
    // A run of only no-update replies takes it too.
    for (const fold of FOLDS)
      expect({
        fold,
        runs: ids([quiet("q1"), restart("R"), quiet("q2")], fold),
      }).toEqual({ fold, runs: [["q1", "R", "q2"]] });
    // The resumed turn may take steps before its reply.
    expect(
      ids([call("c1"), restart("R"), call("c2"), quiet("q1")], FOLDS[1]),
    ).toEqual([["c1", "R", "c2", "q1"]]);
  });

  test("before a card the member sees, it stays out, and the run ends before it", () => {
    for (const fold of FOLDS)
      expect({
        fold,
        runs: ids([quiet("q1"), restart("R"), reply("x"), quiet("q2")], fold),
      }).toEqual({ fold, runs: [["q1"], ["q2"]] });
    expect(
      ids([peer("p1"), call("c1"), restart("R"), reply("x")], FOLDS[0]),
    ).toEqual([["p1", "c1"]]);
  });

  test("it never starts a run", () => {
    for (const fold of FOLDS) {
      expect({ fold, runs: ids([restart("R"), quiet("q1")], fold) }).toEqual({
        fold,
        runs: [["q1"]],
      });
      expect({
        fold,
        runs: ids([reply("x"), restart("R"), quiet("q1")], fold),
      }).toEqual({ fold, runs: [["q1"]] });
    }
  });

  test("at the end of the log, it stays out until the next entry comes", () => {
    const head = [peer("p1"), call("c1"), restart("R")];
    expect(ids(head, FOLDS[0])).toEqual([["p1", "c1"]]);
    // Live: the next entry folds it in, and the run keeps its first entry.
    expect(ids([...head, quiet("q1")], FOLDS[0])).toEqual([
      ["p1", "c1", "R", "q1"],
    ]);
  });

  test("a folded result after it neither breaks nor closes the wait", () => {
    // The result of a call made before the restart, written after the line.
    const entries = [call("c1"), restart("R"), result("c1-r", "c1")];
    expect(ids([...entries, quiet("q1")], FOLDS[0]).length).toBe(1);
    expect(ids([...entries, quiet("q1")], FOLDS[0])[0].sort()).toEqual(
      ["R", "c1", "c1-r", "q1"].sort(),
    );
    // Followed by a card, the line still stays out of the run.
    const out = ids([...entries, reply("x")], FOLDS[0]);
    expect(out.length).toBe(1);
    expect(out[0].includes("R")).toBe(false);
  });

  test("other system lines still break the run", () => {
    const others = [
      system(
        "B",
        msg("systemEntries.wake.backgroundEndedRestart", { tasks: "build" }),
      ),
      system("L", msg("systemEntries.limitResume.resumed")),
      system("S", "A plain system line."),
    ];
    for (const other of others)
      expect({
        id: other.id,
        runs: ids([quiet("q1"), other, quiet("q2")], FOLDS[0]),
      }).toEqual({ id: other.id, runs: [["q1"], ["q2"]] });
  });

  test("the line does not count it", () => {
    const runs = findHiddenRuns(
      [peer("p1"), call("c1"), restart("R"), quiet("q1")],
      FOLDS[0],
    );
    expect(runs.length).toBe(1);
    expect(runs[0].entries.length).toBe(4);
    expect(hiddenRunCounts(runs[0].entries)).toEqual({
      messages: 1,
      steps: 1,
      quiet: true,
    });
  });
});
