// Task 0387b8de: an OpenCode agent that the office seeded on a free model
// (AgentInfo.officeFreeModel) moves to another free model when the provider
// refuses its model, and the refused message is sent again once. An agent
// whose model a member chose keeps today's error. The search itself (the
// owner's free models and a check of each) is the office's: here a test
// replacer stands in for it, so a test can hold it open. The office's own
// search, end to end: receptionist.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import {
  DEFAULT_AGENT_CAPABILITIES,
  LOBBY_ROOM,
  type RoomWire,
} from "../../shared/types.ts";
import { createAgentManager } from "../agent-manager.ts";
import type { NormalizedEvent } from "../backends/types.ts";
import { STATE_ROOT } from "../config.ts";

const ROOM: RoomWire = {
  id: "room-free-switch",
  name: "room-free-switch",
  prompt: null,
  canCloseWhenEmpty: true,
};
const SEEDED = "opencode/seeded-free";
const NEXT = "opencode/next-free";
const MEMBER_PICK = "opencode/member-pick";
const MANAGER = "user-free-switch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

const fakes: FakeBackend[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0))
    for (const session of fake.sessions) session.close();
});

interface Deferred {
  promise: Promise<string | null>;
  resolve: (model: string | null) => void;
}
function deferred(): Deferred {
  let resolve!: (model: string | null) => void;
  const promise = new Promise<string | null>((r) => (resolve = r));
  return { promise, resolve };
}

async function harness() {
  const backend = {
    // A turn on one of these models ends as the OpenCode transport ends a
    // provider's "Model is unavailable".
    refused: new Set<string>([SEEDED]),
    // Without the flag: a refusal that another model does not fix (a free
    // usage limit).
    flagged: true,
    // What the refused turn emitted before its end.
    before: [] as NormalizedEvent[],
  };
  const fake = new FakeBackend({
    storedSessionState: "durable",
    capabilities: { ...DEFAULT_AGENT_CAPABILITIES, topicGen: false },
    session: {
      onSend: (_text, _attachments, session) => {
        if (!backend.refused.has(session.opts.modelFamily)) {
          session.completeTurn({ text: "answered" });
          return;
        }
        session.pushAll([
          ...backend.before,
          {
            kind: "turn_completed",
            status: "failed",
            error: "The provider `opencode` refused the request.",
            ...(backend.flagged
              ? { pickModel: true as const, modelUnavailable: true as const }
              : {}),
          },
        ]);
      },
    },
  });
  fakes.push(fake);
  const mgr = createAgentManager({
    resolveBackend: () => fake,
    officeState: new OfficeState({ rooms: [LOBBY_ROOM, ROOM] }),
    initialRooms: [],
    eventSink: () => {},
  });
  mgr.configureAgentTurnDeps();
  // The office's search. `answer` decides each call: a model, null, a throw,
  // or a deferred the test settles.
  const search = {
    calls: [] as Array<{ agentId: string; refused: string }>,
    answer: (): Promise<string | null> => Promise.resolve(NEXT),
  };
  mgr.setRefusedFreeModelReplacer((agent, refusedModel) => {
    search.calls.push({ agentId: agent.id, refused: refusedModel });
    return search.answer();
  });

  let desk = 0;
  const spawn = async (opts: { seeded: boolean }): Promise<string> => {
    const info = await mgr.spawn(
      `Agent ${desk}`,
      STATE_ROOT,
      "default",
      desk++,
      undefined,
      ROOM.id,
      undefined,
      SEEDED,
      undefined,
      undefined,
      "opencode",
      undefined,
      MANAGER,
    );
    expect(info, "the agent spawned").not.toBeNull();
    if (opts.seeded) mgr.setOfficeFreeModel(info!.id, SEEDED);
    return info!.id;
  };
  // What reached the backend for this agent, with the model it ran on.
  const sends = (agentId: string) =>
    fake.sessions
      .filter((s) => s.opts.agentId === agentId)
      .flatMap((s) =>
        s.sent.map((m) => ({ model: s.opts.modelFamily, text: m.text })),
      );
  const logs = (agentId: string, kind: string) =>
    mgr.getAgentLogs(agentId).filter((e) => e.kind === kind);
  // The one line that says the agent moved from `from` to `to`.
  const switchLines = (agentId: string, from = SEEDED, to = NEXT) =>
    logs(agentId, "system").filter(
      (e) => e.content.includes(from) && e.content.includes(to),
    );
  const done = (agentId: string) => {
    const state = mgr.getAgent(agentId)?.state;
    return state === "waiting_for_response" || state === "error";
  };
  return { mgr, fake, backend, search, spawn, sends, logs, switchLines, done };
}

describe("an agent the office seeded on a free model", () => {
  it("moves to the free model the search finds and sends the refused message again, once", async () => {
    const h = await harness();
    const id = await h.spawn({ seeded: true });
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBe(SEEDED);
    await h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.sends(id).length === 2 && h.done(id), "resent");
    expect(h.search.calls).toEqual([{ agentId: id, refused: SEEDED }]);
    expect(h.sends(id).map((m) => m.model)).toEqual([SEEDED, NEXT]);
    // The same text, sender and all.
    expect(h.sends(id)[1].text).toBe(h.sends(id)[0].text);
    expect(h.mgr.getAgent(id)?.modelFamily).toBe(NEXT);
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBe(NEXT);
    expect(h.switchLines(id)).toHaveLength(1);
    expect(h.logs(id, "user_message")).toHaveLength(1);
    expect(h.logs(id, "error")).toEqual([]);
    expect(h.logs(id, "text").map((e) => e.content)).toEqual(["answered"]);
    expect(h.mgr.getAgent(id)?.state).toBe("waiting_for_response");
  });

  it("shows today's error and moves no further when the message is refused again on the new model", async () => {
    const h = await harness();
    h.backend.refused.add(NEXT);
    const id = await h.spawn({ seeded: true });
    await h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.logs(id, "error").length > 0, "error line");
    await sleep(50);
    expect(h.search.calls).toHaveLength(1);
    expect(h.sends(id).map((m) => m.model)).toEqual([SEEDED, NEXT]);
    expect(h.logs(id, "error")).toHaveLength(1);
    expect(h.mgr.getAgent(id)?.modelFamily).toBe(NEXT);
    expect(h.mgr.getAgent(id)?.state).toBe("error");
  });

  for (const outcome of ["null", "throw"] as const) {
    it(`keeps its model and shows today's error when the search ${outcome === "null" ? "finds no model" : "fails"}`, async () => {
      const h = await harness();
      h.search.answer = () =>
        outcome === "null"
          ? Promise.resolve(null)
          : Promise.reject(new Error("discovery failed"));
      const id = await h.spawn({ seeded: true });
      await h.mgr.sendMessage(id, "alpha message", "tester");
      await waitUntil(() => h.logs(id, "error").length > 0, "error line");
      await sleep(50);
      expect(h.search.calls).toHaveLength(1);
      expect(h.logs(id, "error")).toHaveLength(1);
      expect(h.sends(id)).toHaveLength(1);
      expect(h.mgr.getAgent(id)?.modelFamily).toBe(SEEDED);
      expect(h.mgr.getAgent(id)?.officeFreeModel).toBe(SEEDED);
      expect(h.switchLines(id)).toEqual([]);
      expect(h.mgr.getAgent(id)?.state).toBe("error");
    });
  }

  it("does not search for a refusal that another model does not fix", async () => {
    const h = await harness();
    h.backend.flagged = false;
    const id = await h.spawn({ seeded: true });
    await h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.logs(id, "error").length > 0, "error line");
    expect(h.search.calls).toEqual([]);
    expect(h.mgr.getAgent(id)?.modelFamily).toBe(SEEDED);
    expect(h.mgr.getAgent(id)?.state).toBe("error");
  });

  // A resend would run the turn's tools a second time.
  for (const kind of ["tool_call", "assistant_text"] as const) {
    it(`moves but does not send again a turn that emitted ${kind === "tool_call" ? "a tool call" : "text"} before the refusal`, async () => {
      const h = await harness();
      h.backend.before =
        kind === "tool_call"
          ? [
              {
                kind: "tool_call",
                toolUseId: "tool-1",
                name: "bash",
                input: { command: "echo side effect" },
              },
            ]
          : [{ kind: "assistant_text", text: "Working on it." }];
      const id = await h.spawn({ seeded: true });
      await h.mgr.sendMessage(id, "alpha message", "tester");
      await waitUntil(
        () => h.mgr.getAgent(id)?.modelFamily === NEXT && h.done(id),
        "moved",
      );
      await sleep(50);
      expect(h.sends(id).map((m) => m.model)).toEqual([SEEDED]);
      expect(h.mgr.getAgent(id)?.officeFreeModel).toBe(NEXT);
      expect(h.switchLines(id)).toHaveLength(1);
      expect(h.logs(id, "error")).toHaveLength(1);
    });
  }

  it("is busy while the search runs, and a message sent then arrives after the one sent again", async () => {
    const h = await harness();
    const held = deferred();
    h.search.answer = () => held.promise;
    const id = await h.spawn({ seeded: true });
    void h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.search.calls.length === 1, "search started");
    expect(h.mgr.getAgent(id)?.state).toBe("thinking");
    expect(h.logs(id, "error")).toEqual([]);
    void h.mgr.sendMessage(id, "bravo message", "tester");
    await sleep(50);
    expect(h.sends(id)).toHaveLength(1);
    held.resolve(NEXT);
    await waitUntil(() => h.sends(id).length === 3 && h.done(id), "both sent");
    const sent = h.sends(id);
    expect(sent.map((m) => m.model)).toEqual([SEEDED, NEXT, NEXT]);
    expect(sent[1].text).toBe(sent[0].text);
    expect(sent[2].text).toContain("bravo message");
    expect(sent[2].text).not.toContain("alpha message");
    expect(h.logs(id, "user_message")).toHaveLength(2);
  });

  it("ends the search on Stop: no move and no resend", async () => {
    const h = await harness();
    const held = deferred();
    h.search.answer = () => held.promise;
    const id = await h.spawn({ seeded: true });
    void h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.search.calls.length === 1, "search started");
    expect(await h.mgr.abort(id)).toEqual({ ok: true });
    await waitUntil(() => h.mgr.getAgent(id)?.state !== "thinking", "stopped");
    held.resolve(NEXT);
    await sleep(50);
    expect(h.mgr.getAgent(id)?.modelFamily).toBe(SEEDED);
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBe(SEEDED);
    expect(h.sends(id)).toHaveLength(1);
    expect(h.switchLines(id)).toEqual([]);
    expect(h.mgr.getAgent(id)?.state).toBe("waiting_for_response");
  });

  it("keeps a model the member picks during the search", async () => {
    const h = await harness();
    const held = deferred();
    h.search.answer = () => held.promise;
    const id = await h.spawn({ seeded: true });
    void h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.search.calls.length === 1, "search started");
    await h.mgr.editAgent(id, { modelFamily: MEMBER_PICK });
    held.resolve(NEXT);
    await sleep(50);
    expect(h.mgr.getAgent(id)?.modelFamily).toBe(MEMBER_PICK);
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBeUndefined();
    expect(h.sends(id).filter((m) => m.model === NEXT)).toEqual([]);
    expect(h.switchLines(id)).toEqual([]);
  });

  it("drops the search of an agent that is killed during it", async () => {
    const h = await harness();
    const held = deferred();
    h.search.answer = () => held.promise;
    const id = await h.spawn({ seeded: true });
    void h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.search.calls.length === 1, "search started");
    await h.mgr.kill(id);
    held.resolve(NEXT);
    await sleep(50);
    expect(h.mgr.getAgent(id)).toBeUndefined();
    expect(h.sends(id).filter((m) => m.model === NEXT)).toEqual([]);
  });

  it("runs one search for two agents refused on the same model, and moves both", async () => {
    const h = await harness();
    const held = deferred();
    h.search.answer = () => held.promise;
    const first = await h.spawn({ seeded: true });
    const second = await h.spawn({ seeded: true });
    void h.mgr.sendMessage(first, "alpha message", "tester");
    await waitUntil(() => h.search.calls.length === 1, "search started");
    void h.mgr.sendMessage(second, "alpha message", "tester");
    await waitUntil(() => h.sends(second).length === 1, "second refused");
    await sleep(50);
    held.resolve(NEXT);
    await waitUntil(
      () =>
        h.sends(first).length === 2 &&
        h.sends(second).length === 2 &&
        h.done(first) &&
        h.done(second),
      "both resent",
    );
    expect(h.search.calls).toHaveLength(1);
    for (const id of [first, second]) {
      expect(h.mgr.getAgent(id)?.modelFamily).toBe(NEXT);
      expect(h.mgr.getAgent(id)?.officeFreeModel).toBe(NEXT);
      expect(h.sends(id).map((m) => m.model)).toEqual([SEEDED, NEXT]);
      expect(h.logs(id, "error")).toEqual([]);
    }
  });
});

describe("an agent whose model a member chose", () => {
  it("is never moved: an agent the office did not seed keeps today's error", async () => {
    const h = await harness();
    const id = await h.spawn({ seeded: false });
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBeUndefined();
    await h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.logs(id, "error").length > 0, "error line");
    expect(h.search.calls).toEqual([]);
    expect(h.mgr.getAgent(id)?.modelFamily).toBe(SEEDED);
    expect(h.sends(id)).toHaveLength(1);
  });

  it("is the member's after any model change, even back to the seeded model; other edits keep the mark", async () => {
    const h = await harness();
    const id = await h.spawn({ seeded: true });
    await h.mgr.editAgent(id, { name: "Renamed" });
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBe(SEEDED);
    await h.mgr.editAgent(id, { modelFamily: MEMBER_PICK });
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBeUndefined();
    await h.mgr.editAgent(id, { modelFamily: SEEDED });
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBeUndefined();
    await h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.logs(id, "error").length > 0, "error line");
    expect(h.search.calls).toEqual([]);
    expect(h.mgr.getAgent(id)?.modelFamily).toBe(SEEDED);
  });

  it("is the member's after an engine switch, also when the agent comes back to OpenCode on the seeded model", async () => {
    const h = await harness();
    const id = await h.spawn({ seeded: true });
    await h.mgr.editAgent(id, { agentType: "claude" });
    expect(h.mgr.getAgent(id)?.agentType).toBe("claude");
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBeUndefined();
    await h.mgr.editAgent(id, { agentType: "opencode", modelFamily: SEEDED });
    expect(h.mgr.getAgent(id)?.agentType).toBe("opencode");
    expect(h.mgr.getAgent(id)?.modelFamily).toBe(SEEDED);
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBeUndefined();
    await h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.logs(id, "error").length > 0, "error line");
    expect(h.search.calls).toEqual([]);
  });
});
