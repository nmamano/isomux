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
import { APP_CAPABILITIES, USER_CAPABILITIES } from "../../identity/index.ts";
import type { UserSendAcceptance } from "../../internal-types.ts";
import type { TaskItem } from "../../../shared/types.ts";

const member: Identity = {
  scope: "user",
  userId: "u1",
  role: "member",
  capabilities: USER_CAPABILITIES,
};

function rig(over: Partial<AsksDeps> = {}) {
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
    history: {
      record: () => {},
      has: () => false,
      get: () => null,
      list: () => ({ items: [], nextBefore: null }),
    },
    agent: () => ({ roomId: "r1", managerUserId: "u1" }),
    // Every app registered at the same moment: only the name tells two apart.
    app: () => ({ createdAt: 1, ownerUserId: "u1", targetAgentId: "a1" }),
    memberByName: () => null,
    memberName: () => "pat",
    memberCanSeeRoom: () => true,
    isOfficeOwner: () => false,
    // Step asks (task c71cb60f): unused here.
    steps: {
      check: () => {
        throw new Error("unused");
      },
    },
    affordances: {
      checkCommand: () => ({ ok: true }) as never,
      probeEditFile: () => null,
      probeReadFile: () => null,
      copyReadFile: () => null,
    },
    contentTypeFor: () => "application/octet-stream",
    untrustedFileHeaders: () => ({}),
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
    ...over,
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

// Step asks (task c71cb60f): the create hands the step to the step check
// and stores the step and the link it gives; the agent sends no link with
// a step, and neither changes after the create. The check itself is
// server/step-asks.test.ts.
describe("a step ask", () => {
  const STEP = { kind: "browser-pairing" };
  const CHECKED = {
    ok: true as const,
    step: { kind: "browser-pairing" as const },
    link: "/integrations/browser",
  };
  function stepRig(answer: Awaited<ReturnType<AsksDeps["steps"]["check"]>>) {
    const inputs: unknown[] = [];
    const t = rig({
      memberByName: (name) =>
        name === "nil" ? { id: "u-owner", name: "nil" } : null,
      steps: {
        check: async (input) => {
          inputs.push(input);
          return answer;
        },
      },
    });
    const create = (body: Record<string, unknown>) =>
      t.handlers["agents.createAsk"]({
        ...t.ctx(),
        params: { id: "a1" },
        body,
      });
    return { ...t, inputs, create };
  }

  it("stores the step and the link the check gives, and passes the check who the ask is for", async () => {
    const t = stepRig(CHECKED);
    const made = await t.create({ text: "Pair your Chrome?", step: STEP });
    expect([made.kind, made.kind === "json" ? made.status : null]).toEqual([
      "json",
      201,
    ]);
    const stored = t.store
      .listAll()
      .find((e) => e.prompt === "Pair your Chrome?")!;
    expect([stored.step, stored.link, stored.memberUserId]).toEqual([
      { kind: "browser-pairing" },
      "/integrations/browser",
      "u1",
    ]);
    await t.create({ text: "Sign in?", step: STEP, member: "nil" });
    expect(t.inputs).toEqual([
      {
        step: STEP,
        roomId: "r1",
        managerUserId: "u1",
        memberUserId: "u1",
        memberNamed: false,
      },
      {
        step: STEP,
        roomId: "r1",
        managerUserId: "u1",
        memberUserId: "u-owner",
        memberNamed: true,
      },
    ]);
  });

  it("answers the check's refusal, and refuses a link with a step before checking it", async () => {
    const t = stepRig({
      ok: false,
      status: 409,
      code: "step_done",
      message: "done",
    });
    const before = t.store.listAll().length;
    expect(await t.outcome(t.create({ text: "Pair?", step: STEP }))).toBe(
      "409 step_done",
    );
    expect(
      await t.outcome(
        t.create({ text: "Pair?", step: STEP, link: "/integrations/browser" }),
      ),
    ).toBe("400 invalid_request");
    expect(t.inputs).toHaveLength(1);
    expect(t.store.listAll()).toHaveLength(before);
  });

  it("keeps the step and its link through an edit; the rest of the ask still edits", async () => {
    const t = stepRig(CHECKED);
    await t.create({ text: "Pair your Chrome?", step: STEP });
    const stored = t.store
      .listAll()
      .find((e) => e.prompt === "Pair your Chrome?")!;
    const edit = (body: Record<string, unknown>) =>
      t.outcome(
        t.handlers["agents.editAsk"]({
          ...t.ctx(),
          params: { id: "a1", askId: stored.id },
          body,
        }),
      );
    expect(await edit({ text: "Pair?", step: { kind: "github-link" } })).toBe(
      "400 invalid_request",
    );
    expect(await edit({ text: "Pair?", link: "/integrations/mcp" })).toBe(
      "400 invalid_request",
    );
    expect(await edit({ text: "Pair?", link: "" })).toBe("400 invalid_request");
    // A plain ask cannot gain a step either.
    expect(
      await t.outcome(
        t.handlers["agents.editAsk"]({
          ...t.ctx(),
          params: { id: "a1", askId: t.entry.id },
          body: { text: "Toast?", step: STEP },
        }),
      ),
    ).toBe("400 invalid_request");
    expect(await edit({ text: "Pair your Chrome now?" })).toBe("json 200");
    expect(t.store.get(stored.id)).toMatchObject({
      prompt: "Pair your Chrome now?",
      step: { kind: "browser-pairing" },
      link: "/integrations/browser",
    });
  });
});

// Two apps registered in the same millisecond have the same createdAt, which
// the real server cannot set up on purpose; only the name tells their asks
// apart (task 1f453011).
describe("an app's own asks", () => {
  const asApp = (appName: string): Identity => ({
    scope: "app",
    userId: "u1",
    role: "member",
    appName,
    capabilities: APP_CAPABILITIES,
  });

  it("reach only the app of the same name, at the same registration time", async () => {
    const { store, handlers, outcome } = rig();
    const made = store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Merge the queue?",
      app: { name: "one", createdAt: 1 },
    });
    if (!made.ok) throw new Error(made.code);
    const id = made.entry.id;
    const ctx = (appName: string, body: unknown = {}): RouteHandlerContext => ({
      identity: asApp(appName),
      params: { askId: id },
      body,
      rawBody: "",
      query: new URLSearchParams(),
      req: new Request("http://localhost/"),
    });
    const listed = async (appName: string) => {
      const r = await handlers["asks.appList"](ctx(appName));
      return r.kind === "json"
        ? (r.body as Array<{ id: string }>).map((e) => e.id)
        : r;
    };
    expect(await listed("one")).toEqual([id]);
    expect(await outcome(handlers["asks.appGet"](ctx("one")))).toBe("json 200");

    expect(await listed("two")).toEqual([]);
    for (const [opId, body] of [
      ["asks.appGet", {}],
      ["asks.appEdit", { text: "spoof" }],
      ["asks.appDelete", {}],
    ] as const)
      expect(`${opId} ${await outcome(handlers[opId](ctx("two", body)))}`).toBe(
        `${opId} 404 not_found`,
      );
    expect(store.get(id)?.prompt).toBe("Merge the queue?");
  });
});
