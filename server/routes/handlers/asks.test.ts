// The asks.reply, asks.dismiss and asks.fileTask handlers against a delivery
// the test holds open. The office's own delivery reaches its acceptance
// decision without a step a test can hold, so the double-send guard and the
// filed task's rollback are proven here, where the second request can land
// while the first is still in flight.

import { describe, expect, it } from "bun:test";

import { askHandlers, type AsksDeps } from "./asks.ts";
import { createAskStore } from "../../asks.ts";
import type { RouteHandlerContext } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import { USER_CAPABILITIES } from "../../identity/index.ts";
import type { UserSendAcceptance } from "../../internal-types.ts";
import type { TaskItem } from "../../../shared/types.ts";

const member: Identity = {
  scope: "user",
  userId: "u1",
  role: "member",
  capabilities: USER_CAPABILITIES,
};

function rig() {
  const store = createAskStore({
    persistence: {
      load: () => ({ kind: "missing" }),
      save: () => {},
      quarantine: () => true,
    },
  });
  const held: Array<{
    resolve: (result: UserSendAcceptance) => void;
    reject: (err: Error) => void;
  }> = [];
  const delivered: string[] = [];
  // The task id each delivery named, and the board as the handler left it.
  const deliveredTaskIds: Array<string | undefined> = [];
  const board = new Map<string, TaskItem>();
  const filed: string[] = [];
  const deleted: string[] = [];
  const deps: AsksDeps = {
    store,
    agent: () => ({ roomId: "r1", managerUserId: "u1" }),
    memberByName: () => null,
    memberName: () => "pat",
    memberCanSeeRoom: () => true,
    isOfficeOwner: () => false,
    affordances: {
      checkCommand: () => ({ ok: true }) as never,
      probeEditFile: () => null,
      probeReadFile: () => null,
      copyReadFile: () => null,
    },
    deliver: (_identity, _entry, text, opts) => {
      delivered.push(text);
      deliveredTaskIds.push(opts.taskId);
      return new Promise((resolve, reject) => held.push({ resolve, reject }));
    },
    agentName: () => "Asker",
    createTask: (input) => {
      const task: TaskItem = {
        id: `task${filed.length + 1}`,
        title: input.title,
        description: input.description,
        status: "open",
        createdBy: input.createdBy,
        username: input.username,
        roomId: input.roomId,
        createdAt: 1,
        version: "v",
      };
      filed.push(task.id);
      board.set(task.id, task);
      return task;
    },
    deleteTask: (id) => {
      deleted.push(id);
      return board.delete(id);
    },
    attributionFor: () => ({ createdBy: "pat", username: "pat" }),
  };
  const handlers = askHandlers(deps);
  const made = store.create({
    agentId: "a1",
    memberUserId: "u1",
    prompt: "Who gives the toast?",
  });
  if (!made.ok) throw new Error(made.code);
  const { entry } = made;
  const ctx = (text?: string): RouteHandlerContext => ({
    identity: member,
    params: { askId: entry.id },
    body: text === undefined ? {} : { text },
    rawBody: "",
    query: new URLSearchParams(),
    req: new Request("http://localhost/"),
  });
  const outcome = async (pending: ReturnType<(typeof handlers)[string]>) => {
    const r = await pending;
    if (r.kind === "error") return `${r.status} ${r.code}`;
    return r.kind === "json" ? `json ${r.status ?? 200}` : r.kind;
  };
  return {
    store,
    entry,
    handlers,
    ctx,
    held,
    delivered,
    deliveredTaskIds,
    board,
    filed,
    deleted,
    outcome,
  };
}

describe("an answer in flight", () => {
  it("refuses a second reply or dismiss while the first is being delivered, and sends once", async () => {
    const { store, entry, handlers, ctx, held, delivered, outcome } = rig();
    const first = outcome(handlers["asks.reply"](ctx("Dwight")));
    await Promise.resolve();
    // The first delivery is held open: the guard, not a closed ask, answers.
    expect(delivered).toEqual(["Dwight"]);
    expect(store.get(entry.id)).not.toBeNull();
    const again = outcome(handlers["asks.reply"](ctx("Dwight")));
    const dismissed = outcome(handlers["asks.dismiss"](ctx()));
    // Checked before awaiting them: a second delivery would wait forever on
    // the held promise.
    expect(delivered).toHaveLength(1);
    expect(await again).toBe("409 ask_busy");
    expect(await dismissed).toBe("409 ask_busy");

    held[0].resolve({ ok: true });
    expect(await first).toBe("noContent");
    expect(store.get(entry.id)).toBeNull();
  });

  it("lets the member answer again when the delivery is refused", async () => {
    const { store, entry, handlers, ctx, held, delivered, outcome } = rig();
    const first = outcome(handlers["asks.reply"](ctx("Dwight")));
    await Promise.resolve();
    held[0].resolve({
      ok: false,
      status: 429,
      code: "usage_cap",
      message: "capped",
    });
    expect(await first).toBe("429 usage_cap");
    expect(store.get(entry.id)).not.toBeNull();

    const retry = outcome(handlers["asks.reply"](ctx("Jim")));
    await Promise.resolve();
    expect(delivered).toEqual(["Dwight", "Jim"]);
    held[1].resolve({ ok: true });
    expect(await retry).toBe("noContent");
  });
});

describe("an ask filed as a task", () => {
  it("files one task in the agent's room, names it to the agent, and closes the ask", async () => {
    const { store, entry, handlers, ctx, held, deliveredTaskIds, board } =
      rig();
    const pending = handlers["asks.fileTask"](ctx());
    await Promise.resolve();
    // The task is on the board before the agent hears of it, and the
    // delivery names that task.
    expect([...board.keys()]).toEqual(["task1"]);
    expect(deliveredTaskIds).toEqual(["task1"]);
    expect(board.get("task1")).toMatchObject({
      roomId: "r1",
      createdBy: "pat",
      username: "pat",
    });
    expect(board.get("task1")!.priority).toBeUndefined();
    held[0].resolve({ ok: true });
    const r = await pending;
    expect(r.kind === "json" ? [r.status, (r.body as TaskItem).id] : r).toEqual(
      [201, "task1"],
    );
    expect(store.get(entry.id)).toBeNull();
    expect([...board.keys()]).toEqual(["task1"]);
  });

  it("takes the task back when the agent refuses the message, and the ask stays open for a retry", async () => {
    const {
      store,
      entry,
      handlers,
      ctx,
      held,
      board,
      filed,
      deleted,
      outcome,
    } = rig();
    const first = outcome(handlers["asks.fileTask"](ctx()));
    await Promise.resolve();
    held[0].resolve({
      ok: false,
      status: 429,
      code: "usage_cap",
      message: "capped",
    });
    expect(await first).toBe("429 usage_cap");
    expect(deleted).toEqual(["task1"]);
    expect(board.size).toBe(0);
    expect(store.get(entry.id)).not.toBeNull();

    // The retry files one task and keeps it.
    const retry = outcome(handlers["asks.fileTask"](ctx()));
    await Promise.resolve();
    held[1].resolve({ ok: true });
    expect(await retry).toBe("json 201");
    expect(filed).toEqual(["task1", "task2"]);
    expect([...board.keys()]).toEqual(["task2"]);
    expect(store.get(entry.id)).toBeNull();
  });

  it("takes the task back when the delivery throws, and the ask stays open", async () => {
    const { store, entry, handlers, ctx, held, board, deleted } = rig();
    const pending = Promise.resolve(handlers["asks.fileTask"](ctx())).then(
      () => "resolved",
      (err: Error) => `rejected ${err.message}`,
    );
    await Promise.resolve();
    expect(board.size).toBe(1);
    held[0].reject(new Error("send blew up"));
    expect(await pending).toBe("rejected send blew up");
    expect(deleted).toEqual(["task1"]);
    expect(board.size).toBe(0);
    expect(store.get(entry.id)).not.toBeNull();
  });

  it("is refused while a reply is in flight, and refuses a reply or dismiss while it is, filing nothing twice", async () => {
    const { handlers, ctx, held, delivered, filed, outcome } = rig();
    // A reply in flight: filing it now would answer it twice.
    const reply = outcome(handlers["asks.reply"](ctx("Dwight")));
    await Promise.resolve();
    expect(await outcome(handlers["asks.fileTask"](ctx()))).toBe(
      "409 ask_busy",
    );
    expect(filed).toEqual([]);
    held[0].resolve({ ok: false, status: 429, code: "usage_cap", message: "" });
    expect(await reply).toBe("429 usage_cap");

    // A file-task in flight: the other answers wait for it.
    const file = outcome(handlers["asks.fileTask"](ctx()));
    await Promise.resolve();
    expect(filed).toEqual(["task1"]);
    const again = [
      outcome(handlers["asks.reply"](ctx("Jim"))),
      outcome(handlers["asks.dismiss"](ctx())),
      outcome(handlers["asks.fileTask"](ctx())),
    ];
    await Promise.resolve();
    // Checked before awaiting them: a second delivery would wait forever on
    // the held promise.
    expect(delivered).toHaveLength(2);
    expect(filed).toEqual(["task1"]);
    expect(await Promise.all(again)).toEqual([
      "409 ask_busy",
      "409 ask_busy",
      "409 ask_busy",
    ]);
    held[1].resolve({ ok: true });
    expect(await file).toBe("json 201");
  });
});
