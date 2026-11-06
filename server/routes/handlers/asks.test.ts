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
import {
  AGENT_CAPABILITIES,
  API_CAPABILITIES,
  APP_CAPABILITIES,
  USER_CAPABILITIES,
} from "../../identity/index.ts";
import type { MessagingAnswerResult } from "../../messaging/replies.ts";
import type { UserSendAcceptance } from "../../internal-types.ts";
import type { AskRunResult } from "../../ask-command-runner.ts";
import {
  ASK_SIMPLIFY_TEXT,
  ASK_SIMPLIFY_UNDO_TEXT,
  type AskEntry,
  type TaskItem,
} from "../../../shared/types.ts";

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
  // Each delivery's dismiss and simplify flags.
  const deliveredFlags: Array<{ dismissed: boolean; simplify: boolean }> = [];
  // Each delivery's simplify-withdrawn flag.
  const deliveredUndone: boolean[] = [];
  const board = new Map<string, TaskItem>();
  const filed: string[] = [];
  const deleted: string[] = [];
  const deps: AsksDeps = {
    store,
    history: {
      record: () => {},
      recordEvent: () => {},
      members: () => [],
      has: () => false,
      get: () => null,
      getById: () => null,
      list: () => ({ items: [], nextBefore: null }),
      listEvents: () => ({ items: [], nextBefore: null }),
    },
    agent: () => ({ roomId: "r1", managerUserId: "u1" }),
    // Every app registered at the same moment: only the name tells two apart.
    app: () => ({ createdAt: 1, ownerUserId: "u1", targetAgentId: "a1" }),
    memberByName: () => null,
    memberName: () => "pat",
    memberCanSeeRoom: () => true,
    memberRoomHidden: () => false,
    roomMemberIds: () => [],
    isOfficeOwner: () => false,
    canReadAgentLogs: () => false,
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
    filePath: () => null,
    contentTypeFor: () => "application/octet-stream",
    untrustedFileHeaders: () => ({}),
    deliver: (_identity, _entry, text, opts) => {
      delivered.push(text);
      deliveredTaskIds.push(opts.taskId);
      deliveredFlags.push({
        dismissed: opts.dismissed,
        simplify: opts.simplify === true,
      });
      deliveredUndone.push(opts.simplifyUndone === true);
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
    deliveredFlags,
    deliveredUndone,
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

  // A shared ask (task 9461c464): the guard is per ask, not per member.
  it("refuses a second member's reply or dismiss while the first member's is delivered, and sends once", async () => {
    const { store, handlers, ctx, held, delivered, outcome } = rig();
    const made = store.create({
      agentId: "a1",
      memberUserId: "u1",
      otherMemberUserIds: ["u2"],
      prompt: "Who locks up?",
    });
    if (!made.ok) throw new Error(made.code);
    const as = (userId: string, text?: string): RouteHandlerContext => ({
      ...ctx(text),
      identity: { ...member, userId },
      params: { askId: made.entry.id },
    });
    const first = outcome(handlers["asks.reply"](as("u1", "me")));
    await Promise.resolve();
    expect(delivered).toEqual(["me"]);
    const other = outcome(handlers["asks.reply"](as("u2", "me too")));
    const dismissed = outcome(handlers["asks.dismiss"](as("u2")));
    expect(delivered).toHaveLength(1);
    expect(await other).toBe("409 ask_busy");
    expect(await dismissed).toBe("409 ask_busy");
    held[0].resolve({ ok: true });
    expect(await first).toBe("noContent");
    expect(store.get(made.entry.id)).toBeNull();
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

describe("a simplify request (task 30915188)", () => {
  it("sends the fixed words once, flagged as a simplify; marks the ask only when the agent took it, and refuses a second while one waits", async () => {
    const {
      store,
      entry,
      handlers,
      ctx,
      held,
      delivered,
      deliveredFlags,
      outcome,
    } = rig();
    const first = outcome(handlers["asks.simplify"](ctx()));
    await Promise.resolve();
    expect(delivered).toEqual([ASK_SIMPLIFY_TEXT]);
    expect(deliveredFlags).toEqual([{ dismissed: false, simplify: true }]);
    // Not marked while the delivery is held open.
    expect(store.get(entry.id)?.simplifyRequestedAt).toBeUndefined();
    const busy = [
      outcome(handlers["asks.simplify"](ctx())),
      outcome(handlers["asks.reply"](ctx("Dwight"))),
      outcome(handlers["asks.dismiss"](ctx())),
      outcome(handlers["asks.fileTask"](ctx())),
    ];
    await Promise.resolve();
    // Checked before awaiting them: a second delivery would wait forever on
    // the held promise.
    expect(delivered).toHaveLength(1);
    expect(await Promise.all(busy)).toEqual([
      "409 ask_busy",
      "409 ask_busy",
      "409 ask_busy",
      "409 ask_busy",
    ]);

    held[0].resolve({ ok: true });
    expect(await first).toBe("noContent");
    expect(typeof store.get(entry.id)?.simplifyRequestedAt).toBe("number");
    // Open, and waiting for the rewrite: no second message.
    const pending = outcome(handlers["asks.simplify"](ctx()));
    await Promise.resolve();
    expect(delivered).toHaveLength(1);
    expect(await pending).toBe("409 simplify_pending");
    // The member can still answer it.
    const reply = outcome(handlers["asks.reply"](ctx("Dwight")));
    await Promise.resolve();
    held[1].resolve({ ok: true });
    expect(await reply).toBe("noContent");
    expect(store.get(entry.id)).toBeNull();
  });

  it("is refused while a reply is being delivered", async () => {
    const { handlers, ctx, held, delivered, outcome } = rig();
    const reply = outcome(handlers["asks.reply"](ctx("Dwight")));
    await Promise.resolve();
    const simplify = outcome(handlers["asks.simplify"](ctx()));
    await Promise.resolve();
    expect(delivered).toEqual(["Dwight"]);
    expect(await simplify).toBe("409 ask_busy");
    held[0].resolve({ ok: true });
    expect(await reply).toBe("noContent");
  });

  it("leaves the ask unmarked when the delivery is refused, and the member can ask again", async () => {
    const { store, entry, handlers, ctx, held, delivered, outcome } = rig();
    const first = outcome(handlers["asks.simplify"](ctx()));
    await Promise.resolve();
    held[0].resolve({
      ok: false,
      status: 429,
      code: "usage_cap",
      message: "capped",
    });
    expect(await first).toBe("429 usage_cap");
    expect(store.get(entry.id)?.simplifyRequestedAt).toBeUndefined();

    const retry = outcome(handlers["asks.simplify"](ctx()));
    await Promise.resolve();
    expect(delivered).toEqual([ASK_SIMPLIFY_TEXT, ASK_SIMPLIFY_TEXT]);
    held[1].resolve({ ok: true });
    expect(await retry).toBe("noContent");
    expect(typeof store.get(entry.id)?.simplifyRequestedAt).toBe("number");
  });

  it("takes no text, not even a blank one, and sends nothing", async () => {
    const { store, entry, handlers, ctx, delivered, outcome } = rig();
    for (const text of ["Say it shorter", "", " "]) {
      const refused = outcome(handlers["asks.simplify"](ctx(text)));
      await Promise.resolve();
      expect([text, delivered]).toEqual([text, []]);
      expect(await refused).toBe("400 invalid_text");
    }
    expect(store.get(entry.id)?.simplifyRequestedAt).toBeUndefined();
  });

  it("answers 204 and brings back no ask the agent withdrew while the message was delivered", async () => {
    const { store, entry, handlers, ctx, held, outcome } = rig();
    const first = outcome(handlers["asks.simplify"](ctx()));
    await Promise.resolve();
    store.remove(entry.id, { outcome: "withdrawn" });
    held[0].resolve({ ok: true });
    expect(await first).toBe("noContent");
    expect(store.get(entry.id)).toBeNull();
    expect(store.listAll()).toEqual([]);
  });

  it("answers 204 and logs it when the mark cannot be written after the agent took the message", async () => {
    const { store, entry, handlers, ctx, held, delivered, outcome } = rig();
    const logged: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    store.requestSimplify = () => {
      throw new Error("disk full");
    };
    try {
      const first = outcome(handlers["asks.simplify"](ctx()));
      await Promise.resolve();
      held[0].resolve({ ok: true });
      expect(await first).toBe("noContent");
    } finally {
      console.error = error;
    }
    expect(delivered).toHaveLength(1);
    expect(logged.map((args) => args.join(" ")).join("\n")).toContain(entry.id);
  });
});

describe("a simplify request withdrawn (task fc2021b7)", () => {
  it("is refused with nothing sent when no request waits; sends the fixed words once, flagged, and clears the mark only when the agent took them; the ask stays open", async () => {
    const {
      store,
      entry,
      handlers,
      ctx,
      held,
      delivered,
      deliveredFlags,
      deliveredUndone,
      outcome,
    } = rig();
    const none = outcome(handlers["asks.simplifyUndo"](ctx()));
    await Promise.resolve();
    expect(await none).toBe("409 simplify_not_pending");
    // Takes no text, as a simplify request.
    store.requestSimplify(entry.id, "u1");
    const texted = outcome(handlers["asks.simplifyUndo"](ctx("Keep it")));
    await Promise.resolve();
    expect(await texted).toBe("400 invalid_text");
    expect(delivered).toEqual([]);

    const undo = outcome(handlers["asks.simplifyUndo"](ctx()));
    await Promise.resolve();
    expect(delivered).toEqual([ASK_SIMPLIFY_UNDO_TEXT]);
    expect(deliveredFlags).toEqual([{ dismissed: false, simplify: false }]);
    expect(deliveredUndone).toEqual([true]);
    // Still marked while the delivery is held open, and nothing else goes.
    expect(typeof store.get(entry.id)?.simplifyRequestedAt).toBe("number");
    const busy = [
      outcome(handlers["asks.simplifyUndo"](ctx())),
      outcome(handlers["asks.reply"](ctx("Dwight"))),
    ];
    await Promise.resolve();
    expect(delivered).toHaveLength(1);
    expect(await Promise.all(busy)).toEqual(["409 ask_busy", "409 ask_busy"]);

    held[0].resolve({ ok: true });
    expect(await undo).toBe("noContent");
    expect(store.get(entry.id)?.simplifyRequestedAt).toBeUndefined();
    expect(store.get(entry.id)?.prompt).toBe("Who gives the toast?");
    // Nothing waits any more: no second withdrawal, and a new simplify goes.
    const again = outcome(handlers["asks.simplifyUndo"](ctx()));
    await Promise.resolve();
    expect(await again).toBe("409 simplify_not_pending");
    expect(delivered).toHaveLength(1);
    const simplify = outcome(handlers["asks.simplify"](ctx()));
    await Promise.resolve();
    expect(delivered).toEqual([ASK_SIMPLIFY_UNDO_TEXT, ASK_SIMPLIFY_TEXT]);
    held[1].resolve({ ok: true });
    expect(await simplify).toBe("noContent");
  });

  it("keeps the mark when the delivery is refused, and the member can withdraw again", async () => {
    const { store, entry, handlers, ctx, held, delivered, outcome } = rig();
    store.requestSimplify(entry.id, "u1");
    const first = outcome(handlers["asks.simplifyUndo"](ctx()));
    await Promise.resolve();
    held[0].resolve({
      ok: false,
      status: 429,
      code: "usage_cap",
      message: "capped",
    });
    expect(await first).toBe("429 usage_cap");
    expect(typeof store.get(entry.id)?.simplifyRequestedAt).toBe("number");

    const retry = outcome(handlers["asks.simplifyUndo"](ctx()));
    await Promise.resolve();
    expect(delivered).toEqual([ASK_SIMPLIFY_UNDO_TEXT, ASK_SIMPLIFY_UNDO_TEXT]);
    held[1].resolve({ ok: true });
    expect(await retry).toBe("noContent");
    expect(store.get(entry.id)?.simplifyRequestedAt).toBeUndefined();
  });

  it("answers 204 and keeps the rewrite when the agent rewrote the ask while the withdrawal was delivered", async () => {
    const { store, entry, handlers, ctx, held, outcome } = rig();
    store.requestSimplify(entry.id, "u1");
    const undo = outcome(handlers["asks.simplifyUndo"](ctx()));
    await Promise.resolve();
    const rewritten = store.edit(entry.id, "Toast: Dwight or Jim?");
    // A later clock, so a write after the rewrite would show in updatedAt.
    await new Promise((r) => setTimeout(r, 5));
    held[0].resolve({ ok: true });
    expect(await undo).toBe("noContent");
    expect(store.get(entry.id)).toEqual(rewritten);
    expect(rewritten?.originalPrompt).toBe("Who gives the toast?");
  });

  it("answers 204 and brings back no ask the agent withdrew while the message was delivered", async () => {
    const { store, entry, handlers, ctx, held, outcome } = rig();
    store.requestSimplify(entry.id, "u1");
    const undo = outcome(handlers["asks.simplifyUndo"](ctx()));
    await Promise.resolve();
    store.remove(entry.id, { outcome: "withdrawn" });
    held[0].resolve({ ok: true });
    expect(await undo).toBe("noContent");
    expect(store.listAll()).toEqual([]);
  });

  it("answers 204 and logs it when the mark cannot be cleared after the agent took the message", async () => {
    const { store, entry, handlers, ctx, held, delivered, outcome } = rig();
    store.requestSimplify(entry.id, "u1");
    const logged: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    store.cancelSimplify = () => {
      throw new Error("disk full");
    };
    try {
      const undo = outcome(handlers["asks.simplifyUndo"](ctx()));
      await Promise.resolve();
      held[0].resolve({ ok: true });
      expect(await undo).toBe("noContent");
    } finally {
      console.error = error;
    }
    expect(delivered).toEqual([ASK_SIMPLIFY_UNDO_TEXT]);
    expect(logged.map((args) => args.join(" ")).join("\n")).toContain(entry.id);
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
        agentId: "a1",
        roomId: "r1",
        managerUserId: "u1",
        memberUserId: "u1",
        memberNamed: false,
      },
      {
        step: STEP,
        agentId: "a1",
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

// A WhatsApp reply draft (task d03a61d8, slice 2b): only the row's member,
// signed in, answers it, and the answer goes to the replies module before the
// agent is told. The dispatch by app is server/messaging/replies.test.ts; what
// each answer sends is server/whatsapp/replies.test.ts;
// here the module is a fake whose results the test picks.
describe("a WhatsApp reply draft", () => {
  const DRAFT = { app: "whatsapp", routeId: "r1", text: "see you at 5" };
  const settle = () => new Promise((r) => setImmediate(r));
  // A refusal answers before any delivery: one held open shows as pending
  // instead of hanging the test.
  const quick = (p: Promise<string>) =>
    Promise.race([p, settle().then(() => "still pending")]);
  const as = (
    identity: Identity,
    t: ReturnType<typeof rig>,
    id: string,
    text?: string,
  ) => ({
    ...t.ctx(text),
    identity,
    params: { askId: id },
  });
  const owner: Identity = { ...member, userId: "u-owner", role: "owner" };
  const apiToken: Identity = {
    scope: "api",
    userId: "u1",
    role: "member",
    apiTokenId: "tok1",
    apiTokenName: "laptop",
    capabilities: API_CAPABILITIES,
  };
  const agent: Identity = {
    scope: "agent",
    userId: "u1",
    agentId: "a1",
    role: "member",
    capabilities: AGENT_CAPABILITIES,
  };

  function draftRig() {
    const calls: {
      askId: string;
      dismissed: boolean;
      text: string | undefined;
    }[] = [];
    const results: Array<
      MessagingAnswerResult | Promise<MessagingAnswerResult>
    > = [];
    const t = rig({
      isOfficeOwner: (userId) => userId === "u-owner",
      messaging: {
        answer: async (entry, input) => {
          calls.push({ askId: entry.id, ...input });
          return (
            results.shift() ?? {
              kind: "deliver",
              text: "SENT NOTICE",
              outcome: "replied",
            }
          );
        },
      },
    });
    const made = t.store.create({
      agentId: "a1",
      memberUserId: "u1",
      prompt: "Send to Mom?",
      options: ["Send", "Don't send"],
      messaging: DRAFT,
    });
    if (!made.ok) throw new Error(made.code);
    return { ...t, draft: made.entry, calls, results };
  }

  it("an owner, the member's API token and an agent get 404 for Send, Don't send and a dismiss: nothing sent, nobody told; the member's Send goes", async () => {
    const t = draftRig();
    for (const [who, identity] of [
      ["owner", owner],
      ["api token", apiToken],
      ["agent", agent],
    ] as const) {
      for (const [opId, text] of [
        ["asks.reply", "Send"],
        ["asks.reply", "Don't send"],
        ["asks.dismiss", undefined],
      ] as const)
        expect(
          `${who} ${opId} ${await quick(t.outcome(t.handlers[opId](as(identity, t, t.draft.id, text))))}`,
        ).toBe(`${who} ${opId} 404 not_found`);
    }
    expect(t.calls).toEqual([]);
    expect(t.delivered).toEqual([]);
    expect(t.store.get(t.draft.id)).not.toBeNull();

    // The same owner and token answer a plain ask: the draft refused them.
    for (const identity of [owner, apiToken]) {
      const plain = t.store.create({
        agentId: "a1",
        memberUserId: "u1",
        prompt: "Toast?",
      });
      if (!plain.ok) throw new Error(plain.code);
      const pending = t.outcome(
        t.handlers["asks.reply"](as(identity, t, plain.entry.id, "Send")),
      );
      await settle();
      t.held.at(-1)!.resolve({ ok: true });
      expect(await pending).toBe("noContent");
    }
    // A plain ask never reaches WhatsApp, whatever its words.
    expect(t.calls).toEqual([]);

    const sent = t.outcome(
      t.handlers["asks.reply"](as(member, t, t.draft.id, "Send")),
    );
    await settle();
    expect(t.calls).toEqual([
      { askId: t.draft.id, dismissed: false, text: "Send" },
    ]);
    expect(t.delivered.at(-1)).toBe("SENT NOTICE");
    t.held.at(-1)!.resolve({ ok: true });
    expect(await sent).toBe("noContent");
    expect(t.store.get(t.draft.id)).toBeNull();
  });

  it("a dismiss goes to the module with the member's note, and the agent gets the module's words", async () => {
    const t = draftRig();
    t.results.push({
      kind: "deliver",
      text: "NOT SENT: not now",
      outcome: "dismissed",
    });
    const pending = t.outcome(
      t.handlers["asks.dismiss"](as(member, t, t.draft.id, "not now")),
    );
    await settle();
    expect(t.calls).toEqual([
      { askId: t.draft.id, dismissed: true, text: "not now" },
    ]);
    expect(t.delivered).toEqual(["NOT SENT: not now"]);
    expect(t.deliveredFlags).toEqual([{ dismissed: true, simplify: false }]);
    t.held[0].resolve({ ok: true });
    expect(await pending).toBe("noContent");
    expect(t.store.get(t.draft.id)).toBeNull();
  });

  it("a send that fails answers its status and keeps the ask open, with nothing told; the next Send can go", async () => {
    const t = draftRig();
    t.results.push({
      kind: "fail",
      status: 504,
      code: "whatsapp_unknown",
      error: "no answer",
    });
    expect(
      await quick(
        t.outcome(t.handlers["asks.reply"](as(member, t, t.draft.id, "Send"))),
      ),
    ).toBe("504 whatsapp_unknown");
    expect(t.delivered).toEqual([]);
    expect(t.store.get(t.draft.id)).not.toBeNull();
    const again = t.outcome(
      t.handlers["asks.reply"](as(member, t, t.draft.id, "Send")),
    );
    await settle();
    t.held[0].resolve({ ok: true });
    expect(await again).toBe("noContent");
    expect(t.calls).toHaveLength(2);
  });

  it("a row gone at Send time: the agent gets the notice, the ask closes and the member gets the 409", async () => {
    const t = draftRig();
    t.results.push({
      kind: "deliver",
      text: "ROW GONE",
      outcome: "replied",
      refusal: {
        status: 409,
        code: "messaging_route_gone",
        error: "the row is gone",
      },
    });
    const pending = t.outcome(
      t.handlers["asks.reply"](as(member, t, t.draft.id, "Send")),
    );
    await settle();
    expect(t.delivered).toEqual(["ROW GONE"]);
    t.held[0].resolve({ ok: true });
    expect(await pending).toBe("409 messaging_route_gone");
    expect(t.store.get(t.draft.id)).toBeNull();
  });

  it("a second answer while the first is with WhatsApp is 409 ask_busy: one send", async () => {
    const t = draftRig();
    let release!: (r: MessagingAnswerResult) => void;
    t.results.push(new Promise((r) => (release = r)));
    const first = t.outcome(
      t.handlers["asks.reply"](as(member, t, t.draft.id, "Send")),
    );
    await settle();
    expect(t.calls).toHaveLength(1);
    expect(
      await quick(
        t.outcome(t.handlers["asks.reply"](as(member, t, t.draft.id, "Send"))),
      ),
    ).toBe("409 ask_busy");
    expect(
      await quick(
        t.outcome(t.handlers["asks.dismiss"](as(member, t, t.draft.id))),
      ),
    ).toBe("409 ask_busy");
    expect(t.calls).toHaveLength(1);
    release({ kind: "deliver", text: "SENT NOTICE", outcome: "replied" });
    await settle();
    t.held[0].resolve({ ok: true });
    expect(await first).toBe("noContent");
    expect(t.calls).toHaveLength(1);
  });

  it("filing it as a task, a simplify request and its withdrawal are 409 messaging_draft: nothing filed, sent or told", async () => {
    const t = draftRig();
    for (const opId of [
      "asks.fileTask",
      "asks.simplify",
      "asks.simplifyUndo",
    ] as const)
      expect(
        `${opId} ${await quick(t.outcome(t.handlers[opId](as(member, t, t.draft.id))))}`,
      ).toBe(`${opId} 409 messaging_draft`);
    expect([t.filed, t.delivered, t.calls]).toEqual([[], [], []]);
    expect(t.store.get(t.draft.id)).not.toBeNull();
  });

  it("the agent cannot edit it, only withdraw it, and cannot make one through a plain ask", async () => {
    const t = draftRig();
    const agentCtx = (
      askId: string | undefined,
      body: unknown,
    ): RouteHandlerContext => {
      const params: Record<string, string> = { id: "a1" };
      if (askId) params.askId = askId;
      return { ...t.ctx(), identity: agent, params, body };
    };
    expect(
      await t.outcome(
        t.handlers["agents.editAsk"](
          agentCtx(t.draft.id, { text: "Send to Mom now?" }),
        ),
      ),
    ).toBe("409 messaging_draft");
    expect(t.store.get(t.draft.id)).toMatchObject({
      prompt: "Send to Mom?",
      messaging: DRAFT,
    });

    // A create or an edit naming a draft does not get one.
    expect(
      await t.outcome(
        t.handlers["agents.createAsk"](
          agentCtx(undefined, { text: "Send?", messaging: DRAFT }),
        ),
      ),
    ).toBe("json 201");
    expect(
      await t.outcome(
        t.handlers["agents.editAsk"](
          agentCtx(t.entry.id, { text: "Toast?", messaging: DRAFT }),
        ),
      ),
    ).toBe("json 200");
    expect(
      t.store
        .listAll()
        .filter((e) => e.messaging)
        .map((e) => e.id),
    ).toEqual([t.draft.id]);

    expect(
      await t.outcome(t.handlers["agents.deleteAsk"](agentCtx(t.draft.id, {}))),
    ).toBe("noContent");
    expect(t.store.get(t.draft.id)).toBeNull();
    expect(t.calls).toEqual([]);
  });
});

// An action step (task e3d1bc63): the member the ask is for runs the step's
// own route from the card. The handler hands the route to the dispatch with
// the caller's own identity and holds one run per ask at a time. The run
// through the real executor and the close are
// server/test-support/routes-action-asks.test.ts.
describe("an action step run from the card", () => {
  const ROUTE = {
    method: "PUT" as const,
    path: "/api/agents/a2/access",
    body: { access: "privileged" },
  };
  // The caller as the office builds it: a session with its member pack. A
  // run with an identity built again from the user id would lose it.
  const caller: Identity = {
    ...member,
    apiTokenLimits: { areas: { asks: "write" } },
    memberPack: {
      pack: { areas: { asks: "write" }, agentCeiling: "standard" },
      rooms: ["r1"],
    },
  };
  function runRig() {
    const dispatched: Array<{
      identity: Identity;
      route: unknown;
      opts: unknown;
    }> = [];
    const held: Array<{
      resolve: (r: { status: number; body: unknown }) => void;
      reject: (err: Error) => void;
    }> = [];
    const t = rig({
      stepRuns: {
        routeOf: (step) =>
          step.kind === "agent-access" ? { ok: true, routes: [ROUTE] } : null,
        dispatch: (identity, route, opts) => {
          dispatched.push({ identity, route, opts });
          return new Promise((resolve, reject) =>
            held.push({ resolve, reject }),
          );
        },
      },
    });
    const open = (step?: AskEntry["step"], memberUserId = "u1") => {
      const made = t.store.create({
        agentId: "a1",
        memberUserId,
        prompt: "Make Curator privileged?",
        ...(step ? { step } : {}),
      });
      if (!made.ok) throw new Error(made.code);
      return made.entry.id;
    };
    const run = (askId: string, identity: Identity = caller) =>
      t.handlers["asks.runAction"]({
        identity,
        params: { askId },
        body: undefined,
        rawBody: "",
        query: new URLSearchParams(),
        req: new Request("http://localhost/"),
        callerSessionIdHash: "sess-hash",
      });
    return { ...t, dispatched, held, open, run };
  }
  const ACTION = {
    kind: "agent-access" as const,
    agentId: "a2",
    access: "privileged" as const,
  };

  it("dispatches the step's route once with the caller's own identity and session, the ask id, and passes the route's answer back", async () => {
    const t = runRig();
    const askId = t.open(ACTION);
    const first = t.run(askId);
    await Promise.resolve();
    expect(t.dispatched).toEqual([
      {
        identity: caller,
        route: ROUTE,
        opts: { askId, callerSessionIdHash: "sess-hash" },
      },
    ]);
    t.held[0].resolve({ status: 200, body: { agent: { id: "a2" } } });
    const r = await first;
    expect(r).toMatchObject({
      kind: "json",
      body: { agent: { id: "a2" } },
    });
    expect((r as { status?: number }).status ?? 200).toBe(200);
    // The run does not close the ask: the change does, through reconcile.
    expect(t.store.get(askId)).not.toBeNull();
  });

  it("refuses a second run while the first is in flight, and runs again once it settled or failed", async () => {
    const t = runRig();
    const askId = t.open(ACTION);
    // The second run comes with no await between: the claim is made before
    // the handler's first await, or a second dispatch is a second change.
    const first = t.outcome(t.run(askId));
    const again = t.outcome(t.run(askId));
    expect(t.dispatched).toHaveLength(1);
    expect(await again).toBe("409 action_in_flight");
    t.held[0].resolve({
      status: 422,
      body: { error: { code: "engine_below_standard", message: "no" } },
    });
    await first;
    const second = t.run(askId);
    await Promise.resolve();
    expect(t.dispatched).toHaveLength(2);
    t.held[1].reject(new Error("dispatch broke"));
    await Promise.resolve(second).catch(() => {});
    const third = t.run(askId);
    await Promise.resolve();
    expect(t.dispatched).toHaveLength(3);
    t.held[2].resolve({ status: 200, body: {} });
    await third;
  });

  it("is 404 for another member and an unknown ask, and 409 not_runnable for a link step or no step, with nothing dispatched", async () => {
    const t = runRig();
    const askId = t.open(ACTION);
    const other: Identity = { ...member, userId: "u2" };
    expect(await t.outcome(t.run(askId, other))).toBe("404 not_found");
    expect(await t.outcome(t.run("nope"))).toBe("404 not_found");
    const linkStep = t.open({ kind: "browser-pairing" });
    expect(await t.outcome(t.run(linkStep))).toBe("409 not_runnable");
    const plain = t.open();
    expect(await t.outcome(t.run(plain))).toBe("409 not_runnable");
    expect(t.dispatched).toEqual([]);
  });
});

describe("a command run from the card (task c3b91695)", () => {
  type Done = {
    resolve: (r: AskRunResult) => void;
    reject: (err: Error) => void;
  };
  const OK: AskRunResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 2100,
    output: "all green\n",
  };
  function runRig(
    opts: {
      refusal?: "terminal_forbidden" | "agent_limited" | null;
      startFails?: boolean;
    } = {},
  ) {
    const started: Array<{ agentId: string; command: string }> = [];
    const runs: Done[] = [];
    const notices: Array<{ agentId: string; text: string }> = [];
    const t = rig({
      commandRuns: {
        refusal: () => opts.refusal ?? null,
        start: async (agentId, command) => {
          started.push({ agentId, command });
          if (opts.startFails) throw new Error("spawn ENOENT");
          return {
            done: new Promise<AskRunResult>((resolve, reject) =>
              runs.push({ resolve, reject }),
            ),
          };
        },
        notify: (agentId, text) => notices.push({ agentId, text }),
        now: () => 1000,
      },
    });
    const open = (commands: string[], memberUserId = "u1") => {
      const made = t.store.create({
        agentId: "a1",
        memberUserId,
        prompt: "Run the checks?",
        affordances: { commands },
      });
      if (!made.ok) throw new Error(made.code);
      return made.entry.id;
    };
    const run = (askId: string, command: string, identity: Identity = member) =>
      t.handlers["asks.runCommand"]({
        identity,
        params: { askId },
        body: { command },
        rawBody: "",
        query: new URLSearchParams(),
        req: new Request("http://localhost/"),
      });
    const reply = (askId: string, text: string) =>
      t.handlers["asks.reply"]({
        identity: member,
        params: { askId },
        body: { text },
        rawBody: "",
        query: new URLSearchParams(),
        req: new Request("http://localhost/"),
      });
    const runOf = (askId: string, command: string) =>
      t.store.get(askId)?.runs?.find((r) => r.command === command);
    return { ...t, started, runs, notices, open, run, reply, runOf };
  }
  // Until the run's end has gone through the store and the delivery.
  async function settle(pred: () => boolean, label: string) {
    const deadline = Date.now() + 2000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`settle timed out: ${label}`);
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  it("answers 202 with the running run, started once with the agent and the exact command", async () => {
    const t = runRig();
    const askId = t.open(["bun test"]);
    const r = await t.run(askId, "bun test");
    expect(r).toMatchObject({
      kind: "json",
      status: 202,
      body: { command: "bun test", by: "u1", state: "running" },
    });
    expect(t.started).toEqual([{ agentId: "a1", command: "bun test" }]);
    expect(t.runOf(askId, "bun test")?.state).toBe("running");
  });

  it("refuses, with nothing started: 404 for another member or an unknown ask, before the caller's refusal", async () => {
    const t = runRig({ refusal: "terminal_forbidden" });
    const askId = t.open(["bun test"]);
    const other: Identity = { ...member, userId: "u2" };
    expect(await t.outcome(t.run(askId, "bun test", other))).toBe(
      "404 not_found",
    );
    expect(await t.outcome(t.run("nope", "bun test"))).toBe("404 not_found");
    expect(await t.outcome(t.run(askId, "bun test"))).toBe(
      "403 terminal_forbidden",
    );
    expect(t.started).toEqual([]);
  });

  it("refuses an agent below Standard access", async () => {
    const t = runRig({ refusal: "agent_limited" });
    const askId = t.open(["bun test"]);
    expect(await t.outcome(t.run(askId, "bun test"))).toBe("403 agent_limited");
    expect(t.started).toEqual([]);
  });

  it("runs only a command the ask lists, byte for byte, and only one that shows as it runs", async () => {
    const t = runRig();
    const askId = t.open(["bun test", "ls \u001b[8mrm -rf ~\u001b[0m"]);
    for (const command of ["bun test ", "bun  test", "bun lint", ""])
      expect({
        command,
        outcome: await t.outcome(t.run(askId, command)),
      }).toEqual({ command, outcome: "409 command_changed" });
    const hidden = await t.outcome(
      t.run(askId, "ls \u001b[8mrm -rf ~\u001b[0m"),
    );
    expect(hidden.startsWith("409 ")).toBe(true);
    expect(hidden).not.toBe("409 command_changed");
    expect(t.started).toEqual([]);
  });

  it("refuses a second run of the ask while one runs, and runs again once it ended", async () => {
    const t = runRig();
    const askId = t.open(["bun test", "bun lint"]);
    // No await between the taps: the claim comes before the first await.
    const first = t.outcome(t.run(askId, "bun test"));
    const again = t.outcome(t.run(askId, "bun lint"));
    expect(await again).toBe("409 run_in_progress");
    expect(await first).toBe("json 202");
    expect(t.started).toHaveLength(1);
    t.runs[0].resolve({ ...OK, exitCode: 1 });
    await settle(() => t.runOf(askId, "bun test")?.state === "done", "done");
    expect(await t.outcome(t.run(askId, "bun lint"))).toBe("json 202");
    expect(t.started).toHaveLength(2);
  });

  it("a start that fails answers 500 and leaves no running run", async () => {
    const t = runRig({ startFails: true });
    const askId = t.open(["bun test"]);
    expect(await t.outcome(t.run(askId, "bun test"))).toBe("500 run_failed");
    expect(t.runOf(askId, "bun test")).toBeUndefined();
    expect(t.store.get(askId)).not.toBeNull();
  });

  it("a success writes the done run, then answers the ask as the member with the command and its output, and closes it", async () => {
    const t = runRig();
    const askId = t.open(["bun test"]);
    await t.run(askId, "bun test");
    t.runs[0].resolve(OK);
    await settle(() => t.delivered.length === 1, "the reply");
    // The run is on the entry before the agent is answered.
    expect(t.runOf(askId, "bun test")).toMatchObject({
      state: "done",
      exitCode: 0,
      output: "all green\n",
      durationMs: 2100,
    });
    expect(t.delivered[0]).toContain("bun test");
    expect(t.delivered[0]).toContain("all green");
    expect(t.deliveredFlags[0].dismissed).toBe(false);
    // A member reply while the run's answer is delivered: one answer. The
    // reply would deliver at once, before its first await.
    const busy = t.outcome(t.reply(askId, "Done"));
    expect(t.delivered).toHaveLength(1);
    expect(await busy).toBe("409 ask_busy");
    t.held[0].resolve({ ok: true });
    await settle(() => t.store.get(askId) === null, "the close");
    expect(t.delivered).toHaveLength(1);
    expect(t.notices).toEqual([]);
  });

  it("a refused answer leaves the ask open with its done run", async () => {
    const t = runRig();
    const askId = t.open(["bun test"]);
    await t.run(askId, "bun test");
    t.runs[0].resolve(OK);
    await settle(() => t.held.length === 1, "the reply");
    t.held[0].resolve({
      ok: false,
      status: 429,
      code: "usage_cap",
      message: "capped",
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.store.get(askId)).not.toBeNull();
    expect(t.runOf(askId, "bun test")).toMatchObject({
      state: "done",
      exitCode: 0,
    });
  });

  it("a failure keeps the ask open, and the agent gets a notice with the command, how it ended and the output", async () => {
    for (const [name, result] of [
      ["exit 3", { ...OK, exitCode: 3, output: "3 failed\n" }],
      [
        "signal",
        { ...OK, exitCode: null, signal: "SIGKILL", output: "3 failed\n" },
      ],
      [
        "timeout",
        {
          ...OK,
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          output: "3 failed\n",
        },
      ],
    ] as const) {
      const t = runRig();
      const askId = t.open(["bun test"]);
      await t.run(askId, "bun test");
      t.runs[0].resolve(result);
      await settle(() => t.notices.length === 1, `${name}: the notice`);
      expect({ name, agent: t.notices[0].agentId }).toEqual({
        name,
        agent: "a1",
      });
      expect(t.notices[0].text).toContain("bun test");
      expect(t.notices[0].text).toContain("3 failed");
      expect(t.delivered).toEqual([]);
      expect(t.store.get(askId)).not.toBeNull();
      expect({ name, run: t.runOf(askId, "bun test") }).toMatchObject({
        name,
        run: {
          state: "done",
          exitCode: result.exitCode,
          signal: result.signal,
          ...(result.timedOut ? { timedOut: true } : {}),
        },
      });
    }
  });

  it("closes only when every command succeeded, with each command in the answer", async () => {
    const t = runRig();
    const askId = t.open(["bun test", "bun lint"]);
    await t.run(askId, "bun test");
    t.runs[0].resolve(OK);
    await settle(() => t.notices.length === 1, "the first notice");
    expect(t.delivered).toEqual([]);
    expect(t.store.get(askId)).not.toBeNull();
    await t.run(askId, "bun lint");
    t.runs[1].resolve({ ...OK, output: "no lint\n" });
    await settle(() => t.delivered.length === 1, "the reply");
    expect(t.delivered[0]).toContain("bun test");
    expect(t.delivered[0]).toContain("bun lint");
    t.held[0].resolve({ ok: true });
    await settle(() => t.store.get(askId) === null, "the close");
  });

  it("a run that ends after the ask closed: the agent gets the notice, nothing is answered or written", async () => {
    const t = runRig();
    const askId = t.open(["bun test"]);
    await t.run(askId, "bun test");
    const dismiss = t.handlers["asks.dismiss"]({
      identity: member,
      params: { askId },
      body: {},
      rawBody: "",
      query: new URLSearchParams(),
      req: new Request("http://localhost/"),
    });
    await settle(() => t.held.length === 1, "the dismiss");
    t.held[0].resolve({ ok: true });
    await dismiss;
    expect(t.store.get(askId)).toBeNull();
    t.runs[0].resolve(OK);
    await settle(() => t.notices.length === 1, "the notice");
    expect(t.notices[0].text).toContain("bun test");
    expect(t.delivered).toHaveLength(1);
    expect(t.store.get(askId)).toBeNull();
  });

  it("a run whose command the agent dropped meanwhile: the notice, and the run is not written back", async () => {
    const t = runRig();
    const askId = t.open(["bun test"]);
    await t.run(askId, "bun test");
    t.store.edit(askId, "Run the lint?", undefined, undefined, {
      commands: ["bun lint"],
    });
    expect(t.runOf(askId, "bun test")).toBeUndefined();
    t.runs[0].resolve(OK);
    await settle(() => t.notices.length === 1, "the notice");
    expect(t.runOf(askId, "bun test")).toBeUndefined();
    expect(t.delivered).toEqual([]);
    expect(t.store.get(askId)).not.toBeNull();
  });
});
