// TaskBreadcrumbTracker - background-task lifecycle breadcrumbs (b4cafa53 C).
//
// Freezes the filter/dedupe/sanitize behavior of the tracker that turns the
// SDK's system/task_* messages into task_lifecycle NormalizedEvents. Fixtures
// mirror a live probe against SDK 0.3.170 / bundled binary 2.1.170 (background
// Bash emits task_started{task_type:"local_bash"} then task_notification;
// foreground subagents emit the SAME message pair with task_type:"local_agent"
// and must stay silent to avoid double-rendering every Agent call).
//
// A FOREGROUND Bash emits the same local_bash pair as a background one - the
// only difference is run_in_background in the launching tool_use - so every
// background-Bash fixture here launches through assistantToolUse first. Task
// 0c7945cd: the tracker used to key off task_type alone and breadcrumbed both.
import { describe, expect, it } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TaskBreadcrumbTracker } from "./claude";
import { sanitizeTaskLabel } from "./task-label";

// Fixture builders - minimal shapes; the tracker only reads these fields.
function taskStarted(over: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "system",
    subtype: "task_started",
    task_id: "b123",
    tool_use_id: "toolu_1",
    description: "Poll the gate log",
    task_type: "local_bash",
    uuid: "u1",
    session_id: "s1",
    ...over,
  } as unknown as SDKMessage;
}

function taskNotification(over: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: "b123",
    tool_use_id: "toolu_1",
    status: "completed",
    output_file: "/tmp/x.output",
    summary: 'Background command "Poll the gate log" completed (exit code 0)',
    uuid: "u2",
    session_id: "s1",
    ...over,
  } as unknown as SDKMessage;
}

function taskUpdated(patch: Record<string, unknown>): SDKMessage {
  return {
    type: "system",
    subtype: "task_updated",
    task_id: "b123",
    patch,
    uuid: "u3",
    session_id: "s1",
  } as unknown as SDKMessage;
}

function assistantToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): SDKMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-x",
      content: [{ type: "tool_use", id, name, input }],
    },
    parent_tool_use_id: null,
    uuid: "u4",
    session_id: "s1",
  } as unknown as SDKMessage;
}

// The assistant turn that launches the default taskStarted() fixture as a
// BACKGROUND shell command. Without it the same fixture is an ordinary
// foreground Bash call.
function bgBashLaunch(): SDKMessage {
  return assistantToolUse("toolu_1", "Bash", {
    command: "tail -f gate.log",
    run_in_background: true,
  });
}

describe("TaskBreadcrumbTracker - background Bash", () => {
  // The started + settle pair through the session's wiring is
  // claude.session.test.ts's "interleaves task_lifecycle breadcrumbs" test.
  it("maps failed/stopped statuses to matching phases", () => {
    for (const status of ["failed", "stopped"] as const) {
      const t = new TaskBreadcrumbTracker();
      t.observe(bgBashLaunch());
      t.observe(taskStarted());
      // With no summary, the label falls back to the description.
      const [ev] = t.observe(taskNotification({ status, summary: "" }));
      expect(ev).toMatchObject({ phase: status, taskId: "b123" });
      expect((ev as { label: string }).label).toContain("Poll the gate log");
    }
  });

  it("dedupes: repeated task_started and repeated notifications", () => {
    const t = new TaskBreadcrumbTracker();
    t.observe(bgBashLaunch());
    expect(t.observe(taskStarted())).toHaveLength(1);
    expect(t.observe(taskStarted())).toHaveLength(0);
    expect(t.observe(taskNotification())).toHaveLength(1);
    expect(t.observe(taskNotification())).toHaveLength(0);
  });
});

describe("TaskBreadcrumbTracker - foreground shell filtering (0c7945cd)", () => {
  it("stays silent for a foreground Bash start AND settle", () => {
    const t = new TaskBreadcrumbTracker();
    // Ordinary foreground Bash: tool_use WITHOUT run_in_background, then the
    // same local_bash task_started/task_notification pair a background one
    // emits. Both ends must be silent - the Bash call already renders as a
    // tool call, and "Background task started" is a lie about what ran.
    t.observe(assistantToolUse("toolu_1", "Bash", { command: "bun test" }));
    expect(t.observe(taskStarted())).toHaveLength(0);
    expect(t.observe(taskNotification())).toHaveLength(0);
    // Nor with no launching tool_use at all: background is proven, not assumed.
    const bare = new TaskBreadcrumbTracker();
    expect(bare.observe(taskStarted())).toHaveLength(0);
    expect(bare.observe(taskNotification())).toHaveLength(0);
  });

  it("does not let a foreground Bash inherit an unrelated background id", () => {
    const t = new TaskBreadcrumbTracker();
    t.observe(
      assistantToolUse("toolu_bg", "Bash", {
        command: "sleep 60",
        run_in_background: true,
      }),
    );
    t.observe(assistantToolUse("toolu_fg", "Bash", { command: "ls" }));
    // Foreground task_started first: silent, and it must not consume the
    // pending background id.
    expect(
      t.observe(taskStarted({ task_id: "fg1", tool_use_id: "toolu_fg" })),
    ).toHaveLength(0);
    expect(
      t.observe(taskStarted({ task_id: "bg1", tool_use_id: "toolu_bg" })),
    ).toHaveLength(1);
  });

  it("still breadcrumbs a foreground Bash that is backgrounded mid-run", () => {
    const t = new TaskBreadcrumbTracker();
    t.observe(assistantToolUse("toolu_1", "Bash", { command: "bun test" }));
    expect(t.observe(taskStarted())).toHaveLength(0);
    // Ctrl+B / auto-background on timeout: this is the real promotion the
    // ad86462c incidents were wrongly attributed to, and it stays visible.
    const moved = t.observe(
      taskUpdated({ is_backgrounded: true, description: "bun test" }),
    );
    expect(moved).toMatchObject([
      { kind: "task_lifecycle", phase: "started", taskId: "b123" },
    ]);
    expect((moved[0] as { label: string }).label).toContain("bun test");
    // Its settle is now breadcrumb-worthy.
    expect(t.observe(taskNotification())).toHaveLength(1);
  });
});

describe("TaskBreadcrumbTracker - agents and workflows", () => {
  it("breadcrumbs a background Agent launched with run_in_background", () => {
    const t = new TaskBreadcrumbTracker();
    t.observe(
      assistantToolUse("toolu_bg", "Task", {
        prompt: "audit",
        run_in_background: true,
      }),
    );
    const started = t.observe(
      taskStarted({
        task_id: "a901",
        tool_use_id: "toolu_bg",
        task_type: "local_agent",
        description: "Audit the codebase",
      }),
    );
    expect(started).toMatchObject([
      { kind: "task_lifecycle", phase: "started", taskId: "a901" },
    ]);
    expect((started[0] as { label: string }).label).toContain(
      "Audit the codebase",
    );
  });

  it("breadcrumbs workflows via task_type local_workflow", () => {
    const t = new TaskBreadcrumbTracker();
    const started = t.observe(
      taskStarted({
        task_id: "w1",
        task_type: "local_workflow",
        description: "review-changes",
        tool_use_id: undefined,
      }),
    );
    expect(started[0]).toMatchObject({ phase: "started", taskId: "w1" });
    expect((started[0] as { label: string }).label).toContain("review-changes");
  });
});

describe("TaskBreadcrumbTracker - mid-run backgrounding", () => {
  it("ignores task_updated without is_backgrounded", () => {
    const t = new TaskBreadcrumbTracker();
    expect(t.observe(taskUpdated({ status: "completed" }))).toHaveLength(0);
    // And such a task stays untracked: its notification is filtered.
    expect(t.observe(taskNotification())).toHaveLength(0);
  });
});

describe("TaskBreadcrumbTracker - skip_transcript + sanitize", () => {
  it("mutes both ends when task_started has skip_transcript", () => {
    const t = new TaskBreadcrumbTracker();
    t.observe(bgBashLaunch());
    expect(t.observe(taskStarted({ skip_transcript: true }))).toHaveLength(0);
    expect(t.observe(taskNotification())).toHaveLength(0);
  });

  it("mutes the settle when the notification has skip_transcript", () => {
    const t = new TaskBreadcrumbTracker();
    t.observe(bgBashLaunch());
    expect(t.observe(taskStarted())).toHaveLength(1);
    expect(t.observe(taskNotification({ skip_transcript: true }))).toHaveLength(
      0,
    );
  });

  it("sanitizeTaskLabel collapses whitespace and caps length", () => {
    expect(sanitizeTaskLabel("  a\n\nb\t c  ")).toBe("a b c");
    const long = "x".repeat(500);
    const out = sanitizeTaskLabel(long);
    expect(out.length).toBe(200);
    expect(out.endsWith("…")).toBe(true);
  });

  it("caps the FINAL assembled label at 200 for every phase", () => {
    const longDesc = "d".repeat(300);
    const t = new TaskBreadcrumbTracker();
    t.observe(bgBashLaunch());
    const [started] = t.observe(taskStarted({ description: longDesc }));
    expect(started.kind === "task_lifecycle" && started.label.length).toBe(200);
    // Fallback settle label (no summary) is assembled from the stored desc.
    const [settled] = t.observe(
      taskNotification({ status: "failed", summary: "" }),
    );
    expect(settled.kind === "task_lifecycle" && settled.label.length).toBe(200);
    // Mid-run backgrounding label.
    const t2 = new TaskBreadcrumbTracker();
    const [moved] = t2.observe(
      taskUpdated({ is_backgrounded: true, description: longDesc }),
    );
    expect(moved.kind === "task_lifecycle" && moved.label.length).toBe(200);
    // Oversized SDK summary is capped too.
    const t3 = new TaskBreadcrumbTracker();
    t3.observe(bgBashLaunch());
    t3.observe(taskStarted());
    const [sum] = t3.observe(taskNotification({ summary: "s".repeat(400) }));
    expect(sum.kind === "task_lifecycle" && sum.label.length).toBe(200);
  });

  it("labels with the task_id when the description is empty", () => {
    const t = new TaskBreadcrumbTracker();
    t.observe(bgBashLaunch());
    const [ev] = t.observe(taskStarted({ task_id: "bzz", description: "" }));
    expect((ev as { label: string }).label).toContain("bzz");
  });
});
