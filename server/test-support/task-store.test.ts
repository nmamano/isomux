import { officeAuditStore } from "../audit-store.ts";
import { withAuditContextSync } from "../audit-context.ts";
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { OfficeState } from "../../shared/office-state.ts";
import { createAgentManager } from "../agent-manager.ts";
import { STATE_ROOT } from "../config.ts";
import { createTaskStore } from "../task-store.ts";
import { FakeBackend } from "./fake-backend.ts";
import { removeStateDir } from "./temp-state.ts";

const disk = () =>
  JSON.stringify(
    officeAuditStore()
      .db.query("SELECT record FROM tasks ORDER BY rowid")
      .all()
      .map((row) => JSON.parse((row as { record: string }).record)),
  );

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
  const wrapped = {
    ...manager,
    addTask: (...args: Parameters<typeof manager.addTask>) =>
      withAuditContextSync(
        { kind: "member", id: "member", name: "member" },
        "tasks.create",
        () => manager.addTask(...args),
      ),
    updateTask: (...args: Parameters<typeof manager.updateTask>) =>
      withAuditContextSync(
        { kind: "member", id: "member", name: "member" },
        "tasks.update",
        () => manager.updateTask(...args),
      ),
    deleteTask: (...args: Parameters<typeof manager.deleteTask>) =>
      withAuditContextSync(
        { kind: "member", id: "member", name: "member" },
        "tasks.delete",
        () => manager.deleteTask(...args),
      ),
  };
  return { state, manager: wrapped, rawManager: manager };
}

function expectBoard(state: OfficeState) {
  expect(JSON.parse(disk())).toEqual(
    state.tasks.map(({ version: _version, ...task }) => task),
  );
}

describe("per-record task persistence", () => {
  it("persists create, update, clear, re-file and delete as records", () => {
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
    expect(JSON.parse(disk())[0]).not.toHaveProperty("version");
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

  it("refuses a manager update without audit context before any board change", () => {
    const { state, manager, rawManager } = setup();
    const task = manager.addTask("first", "member");
    const before = JSON.stringify(state.tasks);
    expect(() =>
      rawManager.updateTask(task.id, { title: "changed" }),
    ).toThrow();
    expect(JSON.stringify(state.tasks)).toBe(before);
    expectBoard(state);
  });

  it("loads persisted records through the store and lets OfficeState stamp versions", () => {
    const { state, manager } = setup();
    manager.addTask("saved", "member");
    const restored = new OfficeState();
    const store = createTaskStore();
    const loaded = store.load();
    expect(loaded[0]).not.toHaveProperty("version");
    restored.setTasksDirect(loaded);
    expect(restored.tasks).toEqual(state.tasks);
  });
});

it("continues agent restore after an import transaction fails", async () => {
  const source = JSON.stringify([{ id: "old", title: "old" }]);
  writeFileSync(`${STATE_ROOT}/tasks.json`, source);
  officeAuditStore().db.exec(
    "CREATE TRIGGER import_fail BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'import failure'); END",
  );
  const { state, rawManager, manager } = setup();
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await rawManager.restoreAgents();
    expect(state.tasks).toHaveLength(0);
    expect(readFileSync(`${STATE_ROOT}/tasks.json`, "utf8")).toBe(source);
    expect(log).toHaveBeenCalled();
    officeAuditStore().db.exec("DROP TRIGGER import_fail");
    manager.addTask("after boot", "member");
    expectBoard(state);
  } finally {
    log.mockRestore();
  }
});
it("continues agent restore when quarantine rename fails and preserves the source", async () => {
  writeFileSync(`${STATE_ROOT}/tasks.json`, "bad json");
  const now = spyOn(Date, "now").mockReturnValue(123456);
  const blocked = `${STATE_ROOT}/tasks.json.corrupt-123456`;
  mkdirSync(blocked);
  const { state, rawManager, manager } = setup();
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await rawManager.restoreAgents();
    expect(state.tasks).toHaveLength(0);
    expect(readFileSync(`${STATE_ROOT}/tasks.json`, "utf8")).toBe("bad json");
    expect(existsSync(blocked)).toBe(true);
    manager.addTask("after boot", "member");
    expectBoard(state);
    expect(log).toHaveBeenCalled();
  } finally {
    now.mockRestore();
    log.mockRestore();
  }
});
