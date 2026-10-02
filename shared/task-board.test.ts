import { describe, expect, it } from "bun:test";
import { inDefaultTaskList, taskVersion } from "./task-board.ts";
import { OfficeState } from "./office-state.ts";
import type { TaskItem } from "./types.ts";

const base: Omit<TaskItem, "version"> = {
  id: "aaaaaaaa",
  title: "T",
  status: "open",
  createdBy: "Nil",
  createdAt: 1,
};

describe("taskVersion", () => {
  it("is the same for the same task and differs when any field differs", () => {
    expect(taskVersion({ ...base })).toBe(taskVersion(base));
    const variants: Omit<TaskItem, "version">[] = [
      { ...base, title: "T2" },
      { ...base, description: "d" },
      { ...base, priority: "P4" },
      { ...base, status: "done" },
      { ...base, assignee: "A" },
      { ...base, username: "Nil" },
      { ...base, roomId: "r1" },
    ];
    const versions = new Set(variants.map(taskVersion));
    expect(versions.size).toBe(variants.length);
    expect(versions.has(taskVersion(base))).toBe(false);
  });
});

describe("inDefaultTaskList", () => {
  it("leaves out done tasks and open P4 tasks only", () => {
    expect(inDefaultTaskList({ status: "open" })).toBe(true);
    expect(inDefaultTaskList({ status: "open", priority: "P3" })).toBe(true);
    expect(inDefaultTaskList({ status: "in_progress", priority: "P4" })).toBe(
      true,
    );
    expect(inDefaultTaskList({ status: "open", priority: "P4" })).toBe(false);
    expect(inDefaultTaskList({ status: "done" })).toBe(false);
  });
});

describe("OfficeState task versions", () => {
  it("stamps loaded tasks, overriding a stored value", () => {
    const s = new OfficeState();
    const stored: TaskItem = { ...base, id: "bbbbbbbb", version: "stale" };
    s.setTasksDirect([base, stored]);
    for (const t of s.tasks) expect(t.version).toBe(taskVersion(t));
  });

  it("restamps on create and on update", () => {
    const s = new OfficeState();
    s.addTask("T", "Nil");
    const t = s.tasks[0];
    expect(t.version).toBe(taskVersion(t));
    const before = t.version;
    s.updateTask(t.id, { status: "in_progress" });
    expect(s.tasks[0].version).toBe(taskVersion(s.tasks[0]));
    expect(s.tasks[0].version).not.toBe(before);
  });
});
