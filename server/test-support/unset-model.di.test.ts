// Task eecaaedc: an OpenCode agent with no model set (modelFamily "") gets
// the OpenCode default model before its session starts, and one chat line
// names the model. Before this, every wake threw in the OpenCode adapter and
// the queued messages stayed queued with a line that told the wrong fix.
// When OpenCode lists no model the agent can use, one error line says so and
// the queue waits for a model pick.
//
// The model list is the office's discovery: here a test lister stands in for
// it (setOpenCodeModelLister), so a test can count its calls and hold it
// open. The backend refuses a session with no model, as the OpenCode adapter
// does. Boot replay and the Claude/Codex restore: unset-model-boot.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { FakeBackend } from "./fake-backend.ts";
import { removeStateDir } from "./temp-state.ts";
import { OfficeState } from "../../shared/office-state.ts";
import {
  DEFAULT_AGENT_CAPABILITIES,
  LOBBY_ROOM,
  OPENCODE_DEFAULT_MODEL,
  type AgentInfo,
  type BackendModelWire,
  type LogEntry,
  type RoomWire,
} from "../../shared/types.ts";
import { createAgentManager } from "../agent-manager.ts";
import type {
  BackendSession,
  CreateSessionOptions,
} from "../backends/types.ts";
import { STATE_ROOT } from "../config.ts";

const ROOM: RoomWire = {
  id: "room-unset-model",
  name: "room-unset-model",
  prompt: null,
  canCloseWhenEmpty: true,
};
const MANAGER = "user-unset-model";
const SET_MODEL = "prov/set-model";
const MEMBER_PICK = "prov/member-pick";

const model = (
  id: string,
  extra: Partial<BackendModelWire> = {},
): BackendModelWire => ({
  id,
  label: `Label of ${id}`,
  supportedEfforts: [],
  ...extra,
});
// The office's preferred free model is in the list: the fill takes it and
// marks it as the office's pick.
const WITH_FREE = [
  model("prov/paid-default", { isDefault: true }),
  model(OPENCODE_DEFAULT_MODEL, { isFree: true }),
];
// No free model: the fill takes the model OpenCode marks default.
const NO_FREE = [
  model("prov/first"),
  model("prov/reported-default", { isDefault: true }),
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

// Refuses a session with no model, as productionModel in the OpenCode adapter
// does, so a wake that skips the fill fails here as it does in production.
class ModelCheckingBackend extends FakeBackend {
  readonly requiresModel = true;
  override createSession(opts: CreateSessionOptions): BackendSession {
    if (!opts.modelFamily)
      throw new Error("OpenCode model must use provider/model form.");
    return super.createSession(opts);
  }
  override resumeSession(
    sessionId: string,
    opts: CreateSessionOptions,
  ): BackendSession {
    if (!opts.modelFamily)
      throw new Error("OpenCode model must use provider/model form.");
    return super.resumeSession(sessionId, opts);
  }
}

const fakes: FakeBackend[] = [];
const skillDirs: string[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0))
    for (const session of fake.sessions) session.close();
  for (const dir of skillDirs.splice(0)) removeStateDir(dir);
});

interface Held {
  promise: Promise<BackendModelWire[]>;
  resolve: (models: BackendModelWire[]) => void;
}
function held(): Held {
  let resolve!: (models: BackendModelWire[]) => void;
  const promise = new Promise<BackendModelWire[]>((r) => (resolve = r));
  return { promise, resolve };
}

// The catalog key of an entry's message, if it has one.
function keyOf(entry: LogEntry): string | undefined {
  const parts = entry.message;
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts)
    if (part && typeof part === "object" && "key" in part)
      return String(part.key);
  return undefined;
}

function harness() {
  const fake = new ModelCheckingBackend({
    storedSessionState: "durable",
    capabilities: { ...DEFAULT_AGENT_CAPABILITIES, topicGen: false },
    session: {
      onSend: (_text, _attachments, session) =>
        session.completeTurn({ text: "answered" }),
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
  // The office's discovery. `answer` decides each call: a list, a throw, or
  // a held promise the test settles.
  const lister = {
    calls: [] as string[],
    answer: (): Promise<BackendModelWire[]> => Promise.resolve(WITH_FREE),
  };
  mgr.setOpenCodeModelLister((agent: Readonly<AgentInfo>) => {
    lister.calls.push(agent.id);
    return lister.answer();
  });

  let desk = 0;
  const spawn = async (modelFamily: string): Promise<string> => {
    const info = await mgr.spawn(
      `Agent ${desk}`,
      STATE_ROOT,
      "default",
      desk++,
      undefined,
      ROOM.id,
      undefined,
      modelFamily,
      undefined,
      undefined,
      "opencode",
      undefined,
      MANAGER,
    );
    expect(info, "the agent spawned").not.toBeNull();
    // The state under test: an OpenCode agent whose model is not set.
    expect(mgr.getAgent(info!.id)?.modelFamily).toBe(modelFamily);
    return info!.id;
  };
  // What reached the backend for this agent, with the model it ran on.
  const sends = (agentId: string) =>
    fake.sessions
      .filter((s) => s.opts.agentId === agentId)
      .flatMap((s) =>
        s.sent.map((m) => ({ model: s.opts.modelFamily, text: m.text })),
      );
  const sessionCount = (agentId: string) =>
    fake.sessions.filter((s) => s.opts.agentId === agentId).length;
  const lines = (agentId: string, key: string) =>
    mgr.getAgentLogs(agentId).filter((e) => keyOf(e) === key);
  const filledLines = (agentId: string) =>
    lines(agentId, "systemEntries.unsetModelFilled");
  const noneLines = (agentId: string) =>
    lines(agentId, "systemEntries.unsetModelNone");
  const queued = (agentId: string) =>
    mgr.getAllAgents().find((a) => a.id === agentId)?.queue.length ?? 0;
  const agentMessage = (agentId: string, text: string) =>
    mgr.enqueueMessage(agentId, {
      sender: {
        kind: "agent",
        agentId: "agent-sender",
        agentName: "Sender",
        roomName: ROOM.name,
      },
      text,
    });
  const writeSkill = (name: string) => {
    const dir = join(STATE_ROOT, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "Do the thing.");
    skillDirs.push(dir);
  };
  return {
    mgr,
    fake,
    lister,
    spawn,
    sends,
    sessionCount,
    lines,
    filledLines,
    noneLines,
    queued,
    agentMessage,
    writeSkill,
  };
}

// The filled line names the model, by id or by label.
function namesModel(entry: LogEntry, id: string): boolean {
  return entry.content.includes(id) || entry.content.includes(`Label of ${id}`);
}

describe("an OpenCode agent with no model set", () => {
  it("runs a member's message on the OpenCode default, and one line names it", async () => {
    const h = harness();
    const id = await h.spawn("");
    await h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.sends(id).length === 1, "sent");
    expect(h.lister.calls).toEqual([id]);
    expect(h.sends(id)[0].model).toBe(OPENCODE_DEFAULT_MODEL);
    expect(h.sends(id)[0].text).toContain("alpha message");
    expect(h.mgr.getAgent(id)?.modelFamily).toBe(OPENCODE_DEFAULT_MODEL);
    // The office picked a free model: the refused-free-model switch may
    // move it later.
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBe(OPENCODE_DEFAULT_MODEL);
    const filled = h.filledLines(id);
    expect(filled).toHaveLength(1);
    expect(filled[0].kind).toBe("system");
    expect(namesModel(filled[0], OPENCODE_DEFAULT_MODEL)).toBe(true);
    expect(h.mgr.getAgentLogs(id).filter((e) => e.kind === "error")).toEqual(
      [],
    );
  });

  it("runs a queued message from another agent on the model OpenCode marks default, not marked as the office's pick", async () => {
    const h = harness();
    h.lister.answer = () => Promise.resolve(NO_FREE);
    const id = await h.spawn("");
    h.agentMessage(id, "bravo message");
    await waitUntil(() => h.sends(id).length === 1, "sent");
    expect(h.lister.calls).toEqual([id]);
    expect(h.sends(id)[0].model).toBe("prov/reported-default");
    expect(h.sends(id)[0].text).toContain("bravo message");
    expect(h.mgr.getAgent(id)?.modelFamily).toBe("prov/reported-default");
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBeUndefined();
    expect(h.filledLines(id)).toHaveLength(1);
    expect(namesModel(h.filledLines(id)[0], "prov/reported-default")).toBe(
      true,
    );
    await waitUntil(() => h.queued(id) === 0, "queue drained");
  });

  it("runs a skill on the OpenCode default", async () => {
    const h = harness();
    const skill = "unsetmodelskill";
    h.writeSkill(skill);
    const id = await h.spawn("");
    expect(h.mgr.getAgent(id)?.dormant).toBe(true);
    void h.mgr.sendMessage(id, `/${skill}`, "tester").catch(() => {});
    await waitUntil(() => h.sends(id).length === 1, "skill sent");
    expect(h.lister.calls).toEqual([id]);
    expect(h.sends(id)[0].model).toBe(OPENCODE_DEFAULT_MODEL);
    expect(h.filledLines(id)).toHaveLength(1);
    expect(h.mgr.getAgent(id)?.state).not.toBe("error");
  });

  for (const first of ["member", "agent"] as const) {
    it(`runs one discovery and writes one line when ${first === "member" ? "a member's send, then an agent's message" : "an agent's message, then a member's send"} wake it together`, async () => {
      const h = harness();
      const hold = held();
      h.lister.answer = () => hold.promise;
      const id = await h.spawn("");
      const member = () =>
        void h.mgr.sendMessage(id, "alpha message", "tester").catch(() => {});
      const agent = () => h.agentMessage(id, "bravo message");
      if (first === "member") member();
      else agent();
      await waitUntil(() => h.lister.calls.length === 1, "discovery started");
      if (first === "member") agent();
      else member();
      await sleep(50);
      expect(h.lister.calls).toHaveLength(1);
      expect(h.sessionCount(id)).toBe(0);
      hold.resolve(WITH_FREE);
      await waitUntil(
        () =>
          h.sends(id).some((m) => m.text.includes("alpha message")) &&
          h.sends(id).some((m) => m.text.includes("bravo message")),
        "both sent",
      );
      expect(h.lister.calls).toHaveLength(1);
      expect(h.filledLines(id)).toHaveLength(1);
      expect(new Set(h.sends(id).map((m) => m.model))).toEqual(
        new Set([OPENCODE_DEFAULT_MODEL]),
      );
      expect(h.mgr.getAgentLogs(id).filter((e) => e.kind === "error")).toEqual(
        [],
      );
    });
  }

  it("keeps a model the member picks during discovery, with no line", async () => {
    const h = harness();
    const hold = held();
    h.lister.answer = () => hold.promise;
    const id = await h.spawn("");
    void h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.lister.calls.length === 1, "discovery started");
    await h.mgr.editAgent(id, { modelFamily: MEMBER_PICK });
    hold.resolve(WITH_FREE);
    await waitUntil(() => h.sends(id).length >= 1, "sent");
    await sleep(50);
    expect(h.mgr.getAgent(id)?.modelFamily).toBe(MEMBER_PICK);
    expect(h.mgr.getAgent(id)?.officeFreeModel).toBeUndefined();
    expect(h.sends(id).map((m) => m.model)).toEqual([MEMBER_PICK]);
    expect(h.filledLines(id)).toEqual([]);
  });

  it("drops the fill of an agent killed during discovery", async () => {
    const h = harness();
    const hold = held();
    h.lister.answer = () => hold.promise;
    const id = await h.spawn("");
    void h.mgr.sendMessage(id, "alpha message", "tester").catch(() => {});
    await waitUntil(() => h.lister.calls.length === 1, "discovery started");
    await h.mgr.kill(id);
    hold.resolve(WITH_FREE);
    await sleep(50);
    expect(h.mgr.getAgent(id)).toBeUndefined();
    expect(h.sessionCount(id)).toBe(0);
    // Nothing is written for the killed agent.
    expect(h.filledLines(id)).toEqual([]);
  });

  for (const outcome of ["an empty list", "a failed discovery"] as const) {
    it(`says so in one error line when OpenCode gives ${outcome}, keeps the queue, and runs it after a model pick`, async () => {
      const h = harness();
      h.lister.answer = () =>
        outcome === "an empty list"
          ? Promise.resolve([])
          : Promise.reject(new Error("discovery failed"));
      const id = await h.spawn("");
      h.agentMessage(id, "bravo message");
      await waitUntil(() => h.mgr.getAgent(id)?.state === "error", "error");
      await sleep(50);
      expect(h.lister.calls).toEqual([id]);
      expect(h.noneLines(id)).toHaveLength(1);
      expect(h.noneLines(id)[0].kind).toBe("error");
      // Not the start failure that points at /clear and /resume.
      expect(h.lines(id, "systemEntries.flushStartFailed")).toEqual([]);
      expect(
        h.mgr.getAgentLogs(id).filter((e) => e.kind === "error"),
      ).toHaveLength(1);
      expect(h.filledLines(id)).toEqual([]);
      expect(h.sessionCount(id)).toBe(0);
      expect(h.mgr.getAgent(id)?.modelFamily).toBe("");
      expect(h.queued(id)).toBe(1);

      await h.mgr.editAgent(id, { modelFamily: MEMBER_PICK });
      await waitUntil(() => h.sends(id).length === 1, "sent after the pick");
      expect(h.sends(id)[0].model).toBe(MEMBER_PICK);
      expect(h.sends(id)[0].text).toContain("bravo message");
      await waitUntil(() => h.queued(id) === 0, "queue drained");
      expect(h.mgr.getAgent(id)?.state).not.toBe("error");
    });
  }

  it("says so in one error line when no model lister is registered", async () => {
    const h = harness();
    h.mgr.setOpenCodeModelLister(null);
    const id = await h.spawn("");
    await h.mgr.sendMessage(id, "alpha message", "tester");
    await waitUntil(() => h.mgr.getAgent(id)?.state === "error", "error");
    await sleep(50);
    expect(h.noneLines(id)).toHaveLength(1);
    expect(h.lines(id, "systemEntries.flushStartFailed")).toEqual([]);
    expect(h.sessionCount(id)).toBe(0);
  });
});

describe("an OpenCode agent with a model set", () => {
  it("runs on its model with no discovery and no line", async () => {
    const h = harness();
    const id = await h.spawn(SET_MODEL);
    await h.mgr.sendMessage(id, "alpha message", "tester");
    h.agentMessage(id, "bravo message");
    await waitUntil(() => h.sends(id).length === 2, "both sent");
    expect(h.lister.calls).toEqual([]);
    expect(h.sends(id).map((m) => m.model)).toEqual([SET_MODEL, SET_MODEL]);
    expect(h.filledLines(id)).toEqual([]);
    expect(h.noneLines(id)).toEqual([]);
  });
});
