// TaskBreadcrumbTracker - background-task lifecycle breadcrumbs (b4cafa53 C).
//
// Freezes the filter/dedupe/sanitize behavior of the tracker that turns the
// SDK's system/task_* messages into task_lifecycle NormalizedEvents. Fixtures
// mirror a live probe against SDK 0.3.170 / bundled binary 2.1.170 (background
// Bash emits task_started{task_type:"local_bash"} then task_notification;
// foreground subagents emit the SAME message pair with task_type:"local_agent"
// and must stay silent to avoid double-rendering every Agent call).
import { describe, expect, it } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TaskBreadcrumbTracker, sanitizeTaskLabel } from "./claude";

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

describe("TaskBreadcrumbTracker - background Bash", () => {
  it("emits started + settle breadcrumbs for local_bash", () => {
    const t = new TaskBreadcrumbTracker();
    const started = t.observe(taskStarted());
    expect(started).toEqual([
      {
        kind: "task_lifecycle",
        phase: "started",
        taskId: "b123",
        label: "Background task started: Poll the gate log",
      },
    ]);
    const settled = t.observe(taskNotification());
    expect(settled).toEqual([
      {
        kind: "task_lifecycle",
        phase: "completed",
        taskId: "b123",
        label: 'Background command "Poll the gate log" completed (exit code 0)',
      },
    ]);
  });

  it("maps failed/stopped statuses to matching phases", () => {
    for (const status of ["failed", "stopped"] as const) {
      const t = new TaskBreadcrumbTracker();
      t.observe(taskStarted());
      const [ev] = t.observe(taskNotification({ status, summary: "" }));
      expect(ev).toMatchObject({
        phase: status,
        label: `Background task ${status}: Poll the gate log`,
      });
    }
  });

  it("dedupes: repeated task_started and repeated notifications", () => {
    const t = new TaskBreadcrumbTracker();
    expect(t.observe(taskStarted())).toHaveLength(1);
    expect(t.observe(taskStarted())).toHaveLength(0);
    expect(t.observe(taskNotification())).toHaveLength(1);
    expect(t.observe(taskNotification())).toHaveLength(0);
  });
});

describe("TaskBreadcrumbTracker - foreground-subagent filtering", () => {
  it("stays silent for foreground local_agent start AND settle", () => {
    const t = new TaskBreadcrumbTracker();
    // Foreground Agent call: tool_use WITHOUT run_in_background.
    t.observe(assistantToolUse("toolu_fg", "Task", { prompt: "explore" }));
    const started = t.observe(
      taskStarted({
        task_id: "a900",
        tool_use_id: "toolu_fg",
        task_type: "local_agent",
        subagent_type: "general-purpose",
      }),
    );
    expect(started).toHaveLength(0);
    const settled = t.observe(
      taskNotification({ task_id: "a900", tool_use_id: "toolu_fg" }),
    );
    expect(settled).toHaveLength(0);
  });

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
    expect(started).toEqual([
      {
        kind: "task_lifecycle",
        phase: "started",
        taskId: "a901",
        label: "Background agent started: Audit the codebase",
      },
    ]);
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
    expect(started[0]).toMatchObject({
      phase: "started",
      label: "Workflow started: review-changes",
    });
  });
});

describe("TaskBreadcrumbTracker - mid-run backgrounding", () => {
  it("tracks + breadcrumbs task_updated with is_backgrounded", () => {
    const t = new TaskBreadcrumbTracker();
    const moved = t.observe(
      taskUpdated({ is_backgrounded: true, description: "Long build" }),
    );
    expect(moved).toEqual([
      {
        kind: "task_lifecycle",
        phase: "started",
        taskId: "b123",
        label: "Task moved to background: Long build",
      },
    ]);
    // Its settle is now breadcrumb-worthy.
    expect(t.observe(taskNotification())).toHaveLength(1);
  });

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
    expect(t.observe(taskStarted({ skip_transcript: true }))).toHaveLength(0);
    expect(t.observe(taskNotification())).toHaveLength(0);
  });

  it("mutes the settle when the notification has skip_transcript", () => {
    const t = new TaskBreadcrumbTracker();
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
    t3.observe(taskStarted());
    const [sum] = t3.observe(taskNotification({ summary: "s".repeat(400) }));
    expect(sum.kind === "task_lifecycle" && sum.label.length).toBe(200);
  });

  it("labels via description fallback to task_id and multiline squashing", () => {
    const t = new TaskBreadcrumbTracker();
    const [ev] = t.observe(
      taskStarted({ description: "line1\nline2   spaced" }),
    );
    expect(ev).toMatchObject({
      label: "Background task started: line1 line2 spaced",
    });
    const t2 = new TaskBreadcrumbTracker();
    const [ev2] = t2.observe(taskStarted({ task_id: "bzz", description: "" }));
    expect(ev2).toMatchObject({ label: "Background task started: bzz" });
  });
});
