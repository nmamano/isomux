// Task eecaaedc, across a restart: an agent whose stored engine model is
// empty gets its engine's default and says so in its chat, once.
// - OpenCode: the boot replay of a queued message fills the default from the
//   office's discovery (the listOpenCodeModels seam), starts the turn, and
//   stores the model. Seen in an office: an OpenCode agent with modelFamily
//   "" held two queued messages after a restart, and no turn ever started.
// - Claude and Codex: the restore fills the static default as before, and
//   now one chat line names it. The stored record keeps the model, so the
//   next restart writes no second line.
// Wake paths one by one, discovery races and failures: unset-model.di.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  CODEX_MODELS,
  MODEL_FAMILIES,
  OPENCODE_DEFAULT_MODEL,
  type AgentBackendType,
  type BackendModelWire,
  type LogEntry,
} from "../../shared/types.ts";
import type {
  BackendSession,
  CreateSessionOptions,
} from "../backends/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

// Refuses a session with no model, as productionModel in the OpenCode
// adapter does.
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

const FILLED = "systemEntries.unsetModelFilled";
const NONE = "systemEntries.unsetModelNone";

function keyOf(entry: { message?: unknown }): string | undefined {
  const parts = entry.message;
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts)
    if (part && typeof part === "object" && "key" in part)
      return String((part as { key: unknown }).key);
  return undefined;
}

type StoredAgent = Record<string, unknown> & { id: string };
function storedAgents(srv: TestServer): StoredAgent[] {
  const rooms = JSON.parse(
    readFileSync(join(srv.stateRoot, "agents.json"), "utf-8"),
  ) as { agents: StoredAgent[] }[];
  return rooms.flatMap((room) => room.agents);
}
function storedAgent(srv: TestServer, id: string): StoredAgent {
  const agent = storedAgents(srv).find((a) => a.id === id);
  if (!agent) throw new Error(`agent ${id} not in agents.json`);
  return agent;
}
// The stored record as an older release or a hand edit left it. The server
// must be stopped, or its next save writes the record back.
function editStoredAgent(
  srv: TestServer,
  id: string,
  edit: (agent: StoredAgent) => void,
): void {
  const path = join(srv.stateRoot, "agents.json");
  const rooms = JSON.parse(readFileSync(path, "utf-8")) as {
    agents: StoredAgent[];
  }[];
  const agent = rooms.flatMap((room) => room.agents).find((a) => a.id === id);
  if (!agent) throw new Error(`agent ${id} not in agents.json`);
  edit(agent);
  writeFileSync(path, JSON.stringify(rooms, null, 2));
}

// The entries of every session file of the agent on disk.
function entriesOnDisk(srv: TestServer, agentId: string): LogEntry[] {
  const dir = join(srv.stateRoot, "logs", agentId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf-8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as LogEntry),
    );
}

const model = (
  id: string,
  extra: Partial<BackendModelWire> = {},
): BackendModelWire => ({ id, label: id, supportedEfforts: [], ...extra });

describe("an OpenCode agent with no model set, across a restart", () => {
  it("runs its queued message at the boot replay on the OpenCode default, stores the model and keeps the line", async () => {
    const fake = new ModelCheckingBackend({
      storedSessionState: "durable",
      session: {
        onSend: (_text, _attachments, session) =>
          session.completeTurn({ text: "answered" }),
      },
    });
    // The first boot's discovery fails, so the message stays queued; the
    // second boot's lists the office's free default.
    const discovery = {
      calls: 0,
      answer: (): Promise<BackendModelWire[]> =>
        Promise.reject(new Error("discovery down")),
    };
    server = await startTestServer({
      fakeBackend: fake,
      startServer: {
        resolveBackend: () => fake,
        listOpenCodeModels: () => {
          discovery.calls++;
          return discovery.answer();
        },
      },
    });
    const room = server.agentManager.getRooms()[0];
    const info = await server.agentManager.spawn(
      "Others",
      server.workDir,
      "default",
      undefined,
      undefined,
      room.id,
      undefined,
      "",
      undefined,
      undefined,
      "opencode",
    );
    const id = info!.id;
    expect(server.agentManager.getAgent(id)?.modelFamily).toBe("");
    server.agentManager.enqueueMessage(id, {
      sender: {
        kind: "agent",
        agentId: "agent-sender",
        agentName: "Sender",
        roomName: room.name,
      },
      text: "queued before the restart",
    });
    const srv1 = server;
    await waitUntil(
      () => srv1.agentManager.getAgent(id)?.state === "error",
      "first boot: no model",
    );
    expect(discovery.calls).toBe(1);
    expect(fake.sessions.filter((s) => s.opts.agentId === id)).toHaveLength(0);

    discovery.answer = () =>
      Promise.resolve([
        model("prov/paid-default", { isDefault: true }),
        model(OPENCODE_DEFAULT_MODEL, { isFree: true }),
      ]);
    await server.stop();
    expect(storedAgent(server, id).modelFamily).toBe("");
    server = await server.restart();
    const srv2 = server;
    const sends = () =>
      fake.sessions
        .filter((s) => s.opts.agentId === id)
        .flatMap((s) =>
          s.sent.map((m) => ({ model: s.opts.modelFamily, text: m.text })),
        );
    await waitUntil(() => sends().length === 1, "boot replay sent");
    expect(sends()[0].model).toBe(OPENCODE_DEFAULT_MODEL);
    expect(sends()[0].text).toContain("queued before the restart");
    expect(discovery.calls).toBe(2);
    const agent = srv2.agentManager.getAgent(id);
    expect(agent?.modelFamily).toBe(OPENCODE_DEFAULT_MODEL);
    expect(agent?.officeFreeModel).toBe(OPENCODE_DEFAULT_MODEL);
    const filled = srv2.agentManager
      .getAgentLogs(id)
      .filter((e) => keyOf(e) === FILLED);
    expect(filled).toHaveLength(1);
    expect(filled[0].content).toContain(OPENCODE_DEFAULT_MODEL);
    await waitUntil(
      () =>
        srv2.agentManager.getAllAgents().find((a) => a.id === id)?.queue
          .length === 0,
      "queue drained",
    );

    await server.stop();
    // Stored: the next boot does not fill again.
    expect(storedAgent(server, id).modelFamily).toBe(OPENCODE_DEFAULT_MODEL);
    // The line reached the session's file once the turn started, so a
    // reader of the transcript (the logs API) sees why the model changed.
    const onDisk = entriesOnDisk(server, id);
    const filledAt = onDisk.flatMap((e, i) => (keyOf(e) === FILLED ? [i] : []));
    const noneAt = onDisk.flatMap((e, i) => (keyOf(e) === NONE ? [i] : []));
    expect(filledAt).toHaveLength(1);
    // The first boot's error line, written before any session (task
    // 9a828336), is in the transcript once, before the fill: the second boot
    // added none.
    expect(noneAt).toHaveLength(1);
    expect(noneAt[0]).toBeLessThan(filledAt[0]);
  });
});

describe("a Claude or Codex agent stored with no model", () => {
  it("restores on its engine's default, says so once, and stores the model", async () => {
    const fake = new FakeBackend({
      storedSessionState: "durable",
      session: {
        onSend: (_text, _attachments, session) =>
          session.completeTurn({ text: "answered" }),
      },
    });
    server = await startTestServer({ fakeBackend: fake });
    const room = server.agentManager.getRooms()[0];
    const spawn = async (name: string, agentType: AgentBackendType) => {
      const info = await server!.agentManager.spawn(
        name,
        server!.workDir,
        "default",
        undefined,
        undefined,
        room.id,
        undefined,
        undefined,
        undefined,
        undefined,
        agentType,
      );
      return info!.id;
    };
    const claude = await spawn("Claude agent", "claude");
    const codex = await spawn("Codex agent", "codex");
    // A turn each, so each has a session whose file can hold the line.
    for (const id of [claude, codex]) {
      await server.agentManager.sendMessage(id, "hello", "tester");
      const srv = server;
      await waitUntil(
        () => srv.agentManager.getAgent(id)?.state === "waiting_for_response",
        "turn done",
      );
    }
    await server.stop();
    // Both shapes of "no model": an empty string, and no field at all.
    editStoredAgent(server, claude, (a) => {
      a.modelFamily = "";
    });
    editStoredAgent(server, codex, (a) => {
      delete a.modelFamily;
    });
    const expected: Record<string, string> = {
      [claude]: MODEL_FAMILIES[0].family,
      [codex]: CODEX_MODELS[0].value,
    };

    server = await server.restart();
    const srv1 = server;
    const filled = (id: string) =>
      srv1.agentManager.getAgentLogs(id).filter((e) => keyOf(e) === FILLED);
    for (const id of [claude, codex]) {
      expect(srv1.agentManager.getAgent(id)?.modelFamily).toBe(expected[id]);
      expect(filled(id)).toHaveLength(1);
      expect(filled(id)[0].kind).toBe("system");
    }
    await server.stop();
    for (const id of [claude, codex])
      expect(storedAgent(server, id).modelFamily).toBe(expected[id]);

    // The second restart: the model is stored, so no new line. The first
    // line is in the session's file, so the chat still shows that one.
    server = await server.restart();
    const srv2 = server;
    for (const id of [claude, codex]) {
      expect(srv2.agentManager.getAgent(id)?.modelFamily).toBe(expected[id]);
      expect(
        srv2.agentManager.getAgentLogs(id).filter((e) => keyOf(e) === FILLED),
      ).toHaveLength(1);
    }
  });
});
