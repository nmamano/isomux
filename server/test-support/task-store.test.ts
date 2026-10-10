import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { OfficeState } from "../../shared/office-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import { STATE_ROOT } from "../config.ts";
import { createTaskStore } from "../task-store.ts";
import { FakeBackend } from "./fake-backend.ts";
import { removeStateDir } from "./temp-state.ts";

const taskPath = join(STATE_ROOT, "tasks.json");
const disk = () => readFileSync(taskPath, "utf8");

beforeEach(() => {
  removeStateDir(STATE_ROOT);
  mkdirSync(STATE_ROOT, { recursive: true });
});

function setup() {
  const state = new OfficeState();
  const manager = createAgentManager({
    officeState: state,
    initialRooms: [],
    resolveBackend: () => new FakeBackend(),
  });
  return { state, manager };
}

function expectBoard(state: OfficeState) {
  expect(disk()).toBe(JSON.stringify(state.tasks, null, 2));
}

describe("per-record task persistence", () => {
  it("persists create, update, clear, re-file and delete with the existing array bytes", () => {
    const { state, manager } = setup();
    const a = manager.addTask("a", "member", {
      roomId: "room-a",
      priority: "P1",
    });
    expectBoard(state);
    const b = manager.addTask("b", "agent");
    expectBoard(state);
    manager.updateTask(a.id, { title: "edited", roomId: "room-b" });
    expectBoard(state);
    manager.updateTask(a.id, { roomId: undefined, priority: undefined });
    expectBoard(state);
    expect(JSON.parse(disk())[0]).not.toHaveProperty("roomId");
    expect(JSON.parse(disk())[0]).not.toHaveProperty("priority");
    manager.deleteTask(b.id);
    expectBoard(state);
    expect(JSON.parse(disk())[0].version).toBe(state.tasks[0].version);
    const before = disk();
    expect(manager.updateTask("missing", { title: "ignored" })).toBeNull();
    expect(manager.deleteTask("missing")).toBe(false);
    expect(disk()).toBe(before);
  });

  it("uses the current board after direct seeding and array replacement", () => {
    const { state, manager } = setup();
    state.setTasksDirect([
      {
        id: "seed",
        title: "seed",
        status: "open",
        createdBy: "member",
        createdAt: 1,
      },
    ]);
    manager.updateTask("seed", { status: "done" });
    expectBoard(state);
    manager.deleteTask("seed");
    expectBoard(state);
    manager.addTask("after replacement", "member");
    expectBoard(state);
  });

  it("saves earlier failed changes on the next successful mutation", () => {
    const { state, manager } = setup();
    // A directory at the atomic writer's temporary path forces a real write failure.
    mkdirSync(taskPath + ".tmp");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const a = manager.addTask("first", "member");
      expect(error).toHaveBeenCalled();
      expect(state.tasks).toHaveLength(1);
      rmdirSync(taskPath + ".tmp");
      manager.addTask("second", "member");
      expectBoard(state);
      expect(
        JSON.parse(disk()).map((task: { id: string }) => task.id),
      ).toContain(a.id);
    } finally {
      error.mockRestore();
    }
  });

  it("loads persisted records through the store and lets OfficeState stamp versions", () => {
    const { state, manager } = setup();
    manager.addTask("saved", "member");
    const restored = new OfficeState();
    const store = createTaskStore(() => restored.tasks);
    const loaded = store.load();
    expect(loaded[0]).not.toHaveProperty("version");
    restored.setTasksDirect(loaded);
    expect(restored.tasks).toEqual(state.tasks);
  });
});
