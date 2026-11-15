// The member's Run of a refused command (task 0faacc4e), against the handler
// with its deps faked: the run starts only for a refusal in the agent's log,
// with the exact command that call was refused, and its end reaches the
// agent's chat and the agent.

import { describe, expect, it } from "bun:test";

import {
  deniedCommandRunHandlers,
  type DeniedCommandRunDeps,
} from "./denied-command-runs.ts";
import type { Identity } from "../../identity/index.ts";
import { USER_CAPABILITIES } from "../../identity/index.ts";
import type { AskRunResult } from "../../ask-command-runner.ts";
import type { LogEntry } from "../../../shared/types.ts";

const member: Identity = {
  scope: "user",
  userId: "u1",
  role: "member",
  capabilities: USER_CAPABILITIES,
};

const OK: AskRunResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 2100,
  output: "all green\n",
};

let seq = 0;
function entry(kind: LogEntry["kind"], content: string, metadata?: object) {
  return {
    id: `e${++seq}`,
    agentId: "a1",
    timestamp: seq,
    kind,
    content,
    ...(metadata ? { metadata } : {}),
  } as LogEntry;
}
const call = (toolId: string, tool: string, input: Record<string, unknown>) =>
  entry("tool_call", tool, { toolId, input });
const denial = (toolUseId: string, toolName = "Bash") =>
  entry("system", `${toolName} was refused`, {
    permissionDenied: { toolUseId, toolName, message: "refused" },
  });

// toolu-1: a refused Bash call. toolu-2: a Bash call that ran. toolu-3: a
// refused Read. toolu-4: a refused Bash call on two lines. toolu-5: another
// refused Bash call. toolu-6: a refused command that hides text.
const HIDDEN = "ls \u001b[8mrm -rf ~\u001b[0m";
function agentLog(): LogEntry[] {
  return [
    call("toolu-1", "Bash", { command: "rm -rf ./build" }),
    denial("toolu-1"),
    entry("tool_result", "BLOCKED", { toolId: "toolu-1" }),
    call("toolu-2", "Bash", { command: "ls" }),
    entry("tool_result", "a b", { toolId: "toolu-2" }),
    call("toolu-3", "Read", { file_path: "/x/.env" }),
    denial("toolu-3", "Read"),
    call("toolu-4", "Bash", { command: "cd /x\nrm -rf y" }),
    denial("toolu-4"),
    call("toolu-5", "Bash", { command: "git reset --hard" }),
    denial("toolu-5"),
    call("toolu-6", "Bash", { command: HIDDEN }),
    denial("toolu-6"),
  ];
}

type Done = {
  resolve: (r: AskRunResult) => void;
  reject: (err: Error) => void;
};

function rig(
  opts: {
    refusal?: "terminal_forbidden" | "agent_limited" | null;
    startFails?: boolean;
  } = {},
) {
  const started: Array<{ agentId: string; command: string }> = [];
  const runs: Done[] = [];
  const reports: Array<{
    agentId: string;
    metadata: Record<string, unknown>;
    memberUserId: string;
    notice: string;
  }> = [];
  const log = agentLog();
  const deps: DeniedCommandRunDeps = {
    refusal: () => opts.refusal ?? null,
    logEntries: (agentId) => (agentId === "a1" ? log : null),
    start: async (agentId, command) => {
      started.push({ agentId, command });
      if (opts.startFails) throw new Error("spawn ENOENT");
      return {
        done: new Promise<AskRunResult>((resolve, reject) =>
          runs.push({ resolve, reject }),
        ),
      };
    },
    report: (agentId, _line, metadata, memberUserId, notice) =>
      reports.push({ agentId, metadata, memberUserId, notice }),
    memberName: () => "pat",
    now: () => 1000,
  };
  const handler = deniedCommandRunHandlers(deps)["agents.runDeniedCommand"];
  const run = (body: unknown, agentId = "a1", identity: Identity = member) =>
    handler({
      identity,
      params: { id: agentId },
      body,
      rawBody: "",
      query: new URLSearchParams(),
      req: new Request("http://localhost/"),
    });
  const outcome = async (pending: ReturnType<typeof run>) => {
    const r = await pending;
    if (r.kind === "error") return `${r.status} ${r.code}`;
    return r.kind === "json" ? `json ${r.status ?? 200}` : r.kind;
  };
  return { started, runs, reports, run, outcome };
}

// Until the run's end has gone through the report.
async function settle(pred: () => boolean, label: string) {
  const deadline = Date.now() + 2000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`settle timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("a refused command run from its card", () => {
  it("answers 202 with the running run, started once with the agent and the exact command", async () => {
    const t = rig();
    const r = await t.run({ toolUseId: "toolu-1", command: "rm -rf ./build" });
    expect(r).toMatchObject({
      kind: "json",
      status: 202,
      body: { command: "rm -rf ./build", by: "u1", state: "running" },
    });
    expect(t.started).toEqual([{ agentId: "a1", command: "rm -rf ./build" }]);
  });

  it("runs only the command that call was refused, byte for byte", async () => {
    const t = rig();
    for (const body of [
      { toolUseId: "toolu-1", command: "rm -rf ./build " },
      { toolUseId: "toolu-1", command: "rm -rf ./src" },
      { toolUseId: "toolu-1", command: "" },
      // The command of another refusal, under this one's id.
      { toolUseId: "toolu-1", command: "git reset --hard" },
      { toolUseId: "toolu-1" },
      { command: "rm -rf ./build" },
      null,
    ]) {
      const result = await t.outcome(t.run(body));
      expect({ body, refused: result !== "json 202" }).toEqual({
        body,
        refused: true,
      });
    }
    expect(t.started).toEqual([]);
  });

  it("runs only a refusal the agent's log holds, of a one-line Bash command that shows as it runs", async () => {
    const t = rig();
    for (const [label, body] of [
      ["an unknown call", { toolUseId: "toolu-9", command: "rm -rf ./build" }],
      ["a call that was not refused", { toolUseId: "toolu-2", command: "ls" }],
      ["a refused Read", { toolUseId: "toolu-3", command: "/x/.env" }],
      [
        "a command on two lines",
        { toolUseId: "toolu-4", command: "cd /x\nrm -rf y" },
      ],
      ["a command that hides text", { toolUseId: "toolu-6", command: HIDDEN }],
    ] as const) {
      const result = await t.outcome(t.run(body));
      expect({ label, refused: result !== "json 202" }).toEqual({
        label,
        refused: true,
      });
    }
    expect(t.started).toEqual([]);
  });

  it("answers 404 for an agent that does not exist", async () => {
    const t = rig();
    expect(
      await t.outcome(
        t.run({ toolUseId: "toolu-1", command: "rm -rf ./build" }, "nope"),
      ),
    ).toBe("404 not_found");
    expect(t.started).toEqual([]);
  });

  it("refuses with the ask Run's refusal: no terminal, or an agent below Standard", async () => {
    for (const refusal of ["terminal_forbidden", "agent_limited"] as const) {
      const t = rig({ refusal });
      expect(
        await t.outcome(
          t.run({ toolUseId: "toolu-1", command: "rm -rf ./build" }),
        ),
      ).toBe(`403 ${refusal}`);
      expect(t.started).toEqual([]);
    }
  });

  it("refuses a second run of the same refusal while one runs, and runs again once it ended", async () => {
    const t = rig();
    const body = { toolUseId: "toolu-1", command: "rm -rf ./build" };
    // No await between the taps: the claim comes before the first await.
    const first = t.outcome(t.run(body));
    const again = t.outcome(t.run(body));
    expect(await again).toBe("409 run_in_progress");
    expect(await first).toBe("json 202");
    // Another refusal is not held up by it.
    expect(
      await t.outcome(
        t.run({ toolUseId: "toolu-5", command: "git reset --hard" }),
      ),
    ).toBe("json 202");
    expect(t.started.length).toBe(2);
    t.runs[0].resolve({ ...OK, exitCode: 1 });
    await settle(() => t.reports.length === 1, "the first end");
    expect(await t.outcome(t.run(body))).toBe("json 202");
    expect(t.started.length).toBe(3);
  });

  it("a start that fails answers 500 and holds nothing", async () => {
    const t = rig({ startFails: true });
    const body = { toolUseId: "toolu-1", command: "rm -rf ./build" };
    expect(await t.outcome(t.run(body))).toBe("500 run_failed");
    expect(await t.outcome(t.run(body))).toBe("500 run_failed");
    expect(t.started.length).toBe(2);
    expect(t.reports.length).toBe(0);
  });

  it("at the end, writes the done run to the agent's chat and tells the agent the command, how it ended and the output", async () => {
    const t = rig();
    await t.run({ toolUseId: "toolu-1", command: "rm -rf ./build" });
    t.runs[0].resolve({ ...OK, exitCode: 3, output: "rm: cannot remove\n" });
    await settle(() => t.reports.length === 1, "the end");
    const [report] = t.reports;
    expect(report.agentId).toBe("a1");
    expect(report.memberUserId).toBe("u1");
    expect(report.metadata.deniedCommandRun).toMatchObject({
      command: "rm -rf ./build",
      by: "u1",
      startedAt: 1000,
      state: "done",
      exitCode: 3,
      durationMs: 2100,
      output: "rm: cannot remove\n",
    });
    expect(report.notice).toContain("rm -rf ./build");
    expect(report.notice).toContain("3");
    expect(report.notice).toContain("rm: cannot remove");
  });

  it("a run that fails after it started still ends in a report, and frees its refusal", async () => {
    const t = rig();
    const body = { toolUseId: "toolu-1", command: "rm -rf ./build" };
    await t.run(body);
    t.runs[0].reject(new Error("pipe closed"));
    await settle(() => t.reports.length === 1, "the end");
    expect(t.reports[0].metadata.deniedCommandRun).toMatchObject({
      command: "rm -rf ./build",
      state: "done",
      exitCode: null,
    });
    expect(t.reports[0].notice).toContain("pipe closed");
    expect(await t.outcome(t.run(body))).toBe("json 202");
  });
});
