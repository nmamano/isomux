// Phase 0.2 DI seam test for AgentManager. Proves the manager is an
// instantiable unit: collaborators (backend resolver, event sink, officeState,
// persisted-rooms snapshot) are injected, FakeBackend is used instead of a real
// backend, and the two init-order invariants hold. This is NOT the Phase 0.3
// multi-socket harness or the Phase 1.1 onboarding flow - it exercises the seam
// only, with zero LLM/provider calls.
//
// State-root isolation: STATE_ROOT is an eager import-time const resolved from
// ISOMUX_HOME. The bun test preload (server/test-support/preload.ts) presets
// ISOMUX_HOME to a temp dir before any test imports config.ts, so STATE_ROOT is
// a throwaway temp root for the whole shared `bun test` process. That is what
// lets the disk-touching assertions here (spawn, the production factory) run
// in-suite; before Phase 0.3 they were gated on an ISOLATED check and skipped,
// because this file lost the import-time race to set its own ISOMUX_HOME. The
// disk-free assertions never needed the gate: importing agent-manager pulls in
// persistence.ts, but that import is side-effect-free (state dirs are created
// lazily on first write), so neither the import nor these assertions touch real
// state. The preload removes the temp root at process exit.

import { describe, it, expect } from "bun:test";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { loadAgents, type PersistedAgent } from "../persistence.ts";
import type { AgentBackendType } from "../../shared/types.ts";
import type { Backend } from "../backends/types.ts";
import {
  createOpenCodeBackend,
  createOpenCodeTracerBackend,
} from "../backends/opencode/adapter.ts";
import { OpenCodeSupervisor } from "../backends/opencode/supervisor.ts";
import type { EventHandler } from "../internal-types.ts";
import { STATE_ROOT } from "../config.ts";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { openCodeProfilePaths } from "../backends/opencode/login-wrapper.ts";
import { environmentSourceKeyForUserId } from "../env-loader.ts";
import {
  createAgentManager,
  createProductionAgentManager,
  backendSessionHasFixedCwd,
} from "../agent-manager.ts";
import { resolveRealNode } from "../terminal.ts";

// STATE_ROOT is a temp dir (the bun test preload preset ISOMUX_HOME before
// config.ts was imported), so the disk-touching assertions below run in-suite
// instead of skipping. The preload owns temp-root cleanup at process exit.

function rooms(...ids: string[]): RoomWire[] {
  return ids.map((id, i) => ({
    id,
    name: id,
    prompt: null,
    canCloseWhenEmpty: i > 0,
  }));
}

function capture() {
  const events: Parameters<EventHandler>[0][] = [];
  const sink: EventHandler = (e) => events.push(e);
  return { events, sink };
}

async function runLoginCardThroughPty(
  command: string,
  cwd: string,
  apiKey: string,
): Promise<void> {
  const nodePath = resolveRealNode();
  if (!nodePath) {
    throw new Error(
      "Cannot run the login card through a PTY: no real Node.js binary found after searching ISOMUX_NODE_PATH, known absolute install paths, and bare node on " +
        `PATH (${process.env.PATH ?? "unset"}); Bun's node-compat is rejected.`,
    );
  }
  const sidecar = Bun.spawn(
    [nodePath, join(import.meta.dir, "..", "pty-sidecar.cjs")],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const write = (message: Record<string, unknown>) =>
    sidecar.stdin.write(`${JSON.stringify(message)}\n`);
  await write({
    type: "spawn",
    shell: "/bin/bash",
    cols: 80,
    rows: 24,
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: join(cwd, "global-home"),
      XDG_DATA_HOME: join(cwd, "global-data"),
      OPENCODE_CONFIG_CONTENT: "S2_AMBIENT_CONFIG_CANARY",
      TERM: "xterm-256color",
      SHELL: "/bin/bash",
      LANG: "C.UTF-8",
    },
  });
  await Bun.sleep(500);
  await write({ type: "input", data: `${command}\r` });
  const reader = sidecar.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let partial = "";
  let keySent = false;
  let doneAt: number | null = null;
  let exited = false;
  let pendingRead = reader.read();
  const deadline = Date.now() + 60_000;
  while (!exited && Date.now() < deadline) {
    const next = await Promise.race([
      pendingRead.then((result) => ({ kind: "read" as const, result })),
      Bun.sleep(100).then(() => ({ kind: "tick" as const })),
    ]);
    if (next.kind === "read") {
      pendingRead = reader.read();
      if (next.result.done) exited = true;
      if (!next.result.value) continue;
      partial += decoder.decode(next.result.value, { stream: true });
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const message = JSON.parse(line) as {
          type?: string;
          data?: string;
        };
        if (message.type === "output") output += message.data ?? "";
        if (message.type === "exit") exited = true;
      }
    }
    if (!keySent && output.includes("Enter your API key")) {
      keySent = true;
      await write({ type: "input", data: apiKey });
      await Bun.sleep(250);
      await write({ type: "input", data: "\r" });
    }
    if (keySent && doneAt === null && output.includes("Done")) {
      doneAt = Date.now();
    }
    if (doneAt !== null && Date.now() - doneAt >= 1000) {
      await write({ type: "kill" });
      await sidecar.exited;
      exited = true;
    }
  }
  if (!exited) {
    await write({ type: "input", data: "\u0003" });
    await Bun.sleep(250);
    await write({ type: "kill" });
    throw new Error(
      `Timed out driving the OpenCode login card through pty-sidecar. Output: ${output.slice(-1000)}`,
    );
  }
  expect(output).toContain("Enter your API key");
  expect(output).toContain("Done");
  expect(output).not.toContain(apiKey);
  await sidecar.exited;
}

// Spy resolver: records the agentTypes asked for and returns the FakeBackend.
function spyResolver(backend: Backend) {
  const calls: AgentBackendType[] = [];
  const resolveBackend = (agentType: AgentBackendType) => {
    calls.push(agentType);
    return backend;
  };
  return { calls, resolveBackend };
}

describe("AgentManager DI (disk-free seam)", () => {
  it("seeds rooms synchronously at construction (invariant 1)", () => {
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a", "room-b") }),
      initialRooms: [],
    });
    // getRooms() returns the injected ids immediately - no async restore needed.
    expect(mgr.getRooms().map((r) => r.id)).toEqual(["room-a", "room-b"]);
  });

  it("routes domain events to the injected event sink", () => {
    const { events, sink } = capture();
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [],
      eventSink: sink,
    });
    // createRoom is latched (persistence stays off until restoreAgents), so this
    // emits to the sink without any disk write.
    mgr.createRoom("Room B");
    expect(events.some((e) => e.type === "room_created")).toBe(true);
  });

  it("onEvent() overrides the default noop sink", () => {
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [],
    });
    const { events, sink } = capture();
    mgr.onEvent(sink);
    mgr.renameRoom("room-a", "Renamed");
    expect(events.some((e) => e.type === "room_renamed")).toBe(true);
  });

  it("constructs with the default noop sink without throwing", () => {
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [],
    });
    expect(() => mgr.createRoom("No sink")).not.toThrow();
  });
});

describe("AgentManager DI (temp-state isolated)", () => {
  it("classifies OpenCode and Codex sessions as fixed to their birth cwd", () => {
    expect(backendSessionHasFixedCwd("opencode")).toBe(true);
    expect(backendSessionHasFixedCwd("codex")).toBe(true);
    expect(backendSessionHasFixedCwd("claude")).toBe(false);
  });

  it("maps the backend edit capability into the OpenCode agent payload", async () => {
    for (const edit of [true, false]) {
      const fake = new FakeBackend({
        capabilities: {
          ...new FakeBackend().capabilities,
          edit,
          fork: edit,
        },
      });
      const mgr = createAgentManager({
        resolveBackend: () => fake,
        officeState: new OfficeState({ rooms: rooms(`room-edit-${edit}`) }),
        initialRooms: [],
      });
      const info = await mgr.spawn(
        `OpenCode edit ${edit}`,
        STATE_ROOT,
        "default",
        undefined,
        undefined,
        `room-edit-${edit}`,
        undefined,
        "gate/gate-model",
        "high",
        undefined,
        "opencode",
      );
      expect(info?.capabilities.edit).toBe(edit);
      expect(info?.capabilities.fork).toBe(edit);
    }
  });

  it("keeps an OpenCode composite model and capabilities through kill and revive", async () => {
    const fake = new FakeBackend({
      capabilities: {
        ...new FakeBackend().capabilities,
        edit: true,
        fork: true,
        oneShot: false,
      },
    });
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-opencode-revive") }),
      initialRooms: [],
    });
    const info = await mgr.spawn(
      "Durable OpenCode",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-opencode-revive",
      undefined,
      "gate/gate-model",
      "high",
      undefined,
      "opencode",
    );
    await mgr.kill(info!.id);
    expect(mgr.getKilledAgentSummaries()).toContainEqual(
      expect.objectContaining({
        id: info!.id,
        agentType: "opencode",
      }),
    );
    const revived = await mgr.revive(info!.id, "room-opencode-revive", 0);
    expect(revived).toMatchObject({
      ok: true,
      agent: {
        agentType: "opencode",
        modelFamily: "gate/gate-model",
        capabilities: expect.objectContaining({
          edit: true,
          fork: true,
          oneShot: false,
        }),
      },
    });
  });

  it("routes OpenCode model changes to the connected-model settings control", async () => {
    const fake = new FakeBackend();
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-opencode-model") }),
      initialRooms: [],
    });
    const info = await mgr.spawn(
      "OpenCode model",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-opencode-model",
      undefined,
      "gate/gate-model",
      "high",
      undefined,
      "opencode",
    );
    await mgr.sendMessage(info!.id, "/model", "tester");
    expect(
      mgr
        .getAgentLogs(info!.id)
        .some(
          (entry) =>
            entry.content ===
            "Open agent settings to select a connected OpenCode model.",
        ),
    ).toBe(true);
  });

  it("does not park OpenCode on an empty effort interaction", async () => {
    const fake = new FakeBackend();
    const { events, sink } = capture();
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-opencode-effort") }),
      initialRooms: [],
      eventSink: sink,
    });
    const info = await mgr.spawn(
      "OpenCode effort",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-opencode-effort",
      undefined,
      "gate/gate-model",
      "high",
      undefined,
      "opencode",
    );

    await mgr.sendMessage(info!.id, "/effort", "tester");

    expect(
      mgr
        .getAgentLogs(info!.id)
        .some(
          (entry) =>
            entry.content ===
            "OpenCode does not expose thinking effort controls.",
        ),
    ).toBe(true);
    expect(
      events.some(
        (event) => (event as { type: string }).type === "interaction_added",
      ),
    ).toBe(false);
    const getPendingInteractions = (
      mgr as unknown as { getPendingInteractions?: () => unknown[] }
    ).getPendingInteractions;
    expect(getPendingInteractions?.call(mgr) ?? []).toEqual([]);
    expect(mgr.pendingPrompt(info!.id)).toBeNull();
  });

  it("runs the OpenCode first-reply tracer through normal logs and persistence", async () => {
    const { calls, resolveBackend } = spyResolver(
      createOpenCodeTracerBackend(),
    );
    const { events, sink } = capture();
    const mgr = createAgentManager({
      resolveBackend,
      officeState: new OfficeState({ rooms: rooms("room-opencode") }),
      initialRooms: [],
      eventSink: sink,
    });
    mgr.configurePluginHooksDeps();
    const info = await mgr.spawn(
      "OpenCode tracer",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-opencode",
      undefined,
      "opencode/fake",
      "high",
      undefined,
      "opencode",
    );
    expect(info?.agentType).toBe("opencode");
    expect(info?.dormant).toBe(true);
    expect(calls).toContain("opencode");

    const queued = mgr.enqueueMessage(info!.id, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    expect(queued.ok).toBe(true);
    const deadline = Date.now() + 2000;
    while (
      !mgr
        .getAgentLogs(info!.id)
        .some((entry) => entry.content === "OpenCode tracer reply.") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(
      mgr
        .getAgentLogs(info!.id)
        .some((entry) => entry.content === "OpenCode tracer reply."),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "log_entry" &&
          event.entry.agentId === info!.id &&
          event.entry.content === "OpenCode tracer reply.",
      ),
    ).toBe(true);
    expect(mgr.listSessions(info!.id)[0]?.agentType).toBe("opencode");
    expect(
      loadAgents()
        .flatMap((room) => room.agents)
        .find((agent) => agent.id === info!.id)?.agentType,
    ).toBe("opencode");
    expect(await mgr.demoteToLazy(info!.id)).toBe(true);
  });

  it("runs the first reply end to end through the real pinned OpenCode server", async () => {
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            object: "list",
            data: [{ id: "gate-model", object: "model" }],
          });
        }
        if (url.pathname !== "/v1/chat/completions") {
          return new Response("not found", { status: 404 });
        }
        const stream = new ReadableStream({
          start(controller) {
            const send = (value: unknown) =>
              controller.enqueue(
                `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`,
              );
            send({
              id: "gate",
              object: "chat.completion.chunk",
              created: 1,
              model: "gate-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: "OpenCode real tracer reply.",
                  },
                  finish_reason: null,
                },
              ],
            });
            send({
              id: "gate",
              object: "chat.completion.chunk",
              created: 1,
              model: "gate-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            });
            send("[DONE]");
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const supervisor = new OpenCodeSupervisor({
      profileDir: `${STATE_ROOT}/opencode-success-profile`,
      serverCwd: STATE_ROOT,
      idleShutdownMs: 100,
      config: {
        autoupdate: false,
        model: "gate/gate-model",
        small_model: "gate/gate-model",
        provider: {
          gate: {
            name: "Gate mock",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            models: {
              "gate-model": {
                name: "Gate model",
                limit: { context: 100000, output: 10000 },
                cost: { input: 0, output: 0 },
              },
            },
            options: {
              apiKey: "test-only",
              baseURL: `http://127.0.0.1:${mock.port}/v1`,
            },
          },
        },
      },
    });
    try {
      const backend = createOpenCodeBackend({ supervisor });
      let reportStoredSessionAsDurable = false;
      const backendWithControlledStorage: Backend = {
        ...backend,
        inspectStoredSession: (sessionId, opts) =>
          reportStoredSessionAsDurable
            ? "durable"
            : backend.inspectStoredSession(sessionId, opts),
      };
      const mgr = createAgentManager({
        resolveBackend: () => backendWithControlledStorage,
        officeState: new OfficeState({ rooms: rooms("room-opencode-real") }),
        initialRooms: [],
      });
      mgr.configurePluginHooksDeps();
      const info = await mgr.spawn(
        "OpenCode real tracer",
        STATE_ROOT,
        "default",
        undefined,
        undefined,
        "room-opencode-real",
        undefined,
        "gate/gate-model",
        "high",
        undefined,
        "opencode",
      );
      mgr.enqueueMessage(info!.id, {
        sender: { kind: "user", username: "tester" },
        text: "hello through OC1",
      });
      const deadline = Date.now() + 15_000;
      while (
        !mgr
          .getAgentLogs(info!.id)
          .some((entry) => entry.content === "OpenCode real tracer reply.") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(
        mgr
          .getAgentLogs(info!.id)
          .some((entry) => entry.content === "OpenCode real tracer reply."),
      ).toBe(true);
      expect(mgr.listSessions(info!.id)[0]?.agentType).toBe("opencode");
      expect(mgr.getAgent(info!.id)?.state).toBe("waiting_for_response");
      expect(supervisor.profileDir).not.toBe(
        openCodeProfilePaths(environmentSourceKeyForUserId(null)).profileDir,
      );
      // This test creates the session in an injected supervisor profile, while
      // demotion checks durability in dataHome derived from the environment-key
      // profile. That test-only mismatch makes the session non-demotable.
      expect(await mgr.demoteToLazy(info!.id)).toBe(false);
      // Change only that storage fact. The same quiescent agent must now
      // demote, which proves the mismatch caused the false result above.
      reportStoredSessionAsDurable = true;
      expect(await mgr.demoteToLazy(info!.id)).toBe(true);
    } finally {
      await supervisor.shutdown();
      await mock.stop(true);
    }
  }, 25_000);

  it("uses the selected backend's stored-session fact for silent restore", async () => {
    const persisted = {
      id: "agent-opencode-empty",
      name: "OpenCode empty",
      desk: 0,
      cwd: STATE_ROOT,
      outfit: {
        hat: "none",
        color: "#000000",
        hair: "#000000",
        hairStyle: "short",
        skin: "#ffffff",
        beard: "none",
        accessory: null,
      },
      permissionMode: "default",
      modelFamily: "opencode/fake",
      effort: "high",
      agentType: "opencode",
      lastSessionId: "header-only",
      topic: null,
      customInstructions: null,
      userId: null,
      username: null,
    } as unknown as PersistedAgent;
    const fake = new FakeBackend({ storedSessionState: "empty" });
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-opencode-restore") }),
      initialRooms: [
        {
          id: "room-opencode-restore",
          name: "room-opencode-restore",
          prompt: null,
          agents: [persisted],
        },
      ],
    });

    await mgr.restoreAgents();
    expect(mgr.getCurrentSessionId(persisted.id)).toBeNull();
  });

  for (const state of ["missing", "durable"] as const) {
    it(`uses the selected backend's ${state} fact for automatic recovery`, async () => {
      const fake = new FakeBackend({
        storedSessionState: state,
        session: {
          onSend: (_text, _attachments, session) =>
            session.completeTurn({ status: "failed", error: "test failure" }),
        },
      });
      const mgr = createAgentManager({
        resolveBackend: () => fake,
        officeState: new OfficeState({ rooms: rooms(`room-${state}`) }),
        initialRooms: [],
      });
      const info = await mgr.spawn(
        `${state} recovery`,
        STATE_ROOT,
        "default",
        undefined,
        undefined,
        `room-${state}`,
        undefined,
        "opencode/fake",
        "high",
        undefined,
        "opencode",
      );
      mgr.enqueueMessage(info!.id, {
        sender: { kind: "user", username: "tester" },
        text: "first",
      });
      const errorDeadline = Date.now() + 2000;
      while (
        mgr.getAgent(info!.id)?.state !== "error" &&
        Date.now() < errorDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const recovery = mgr.enqueueMessage(info!.id, {
        sender: { kind: "user", username: "tester" },
        text: "recover",
      });
      const recoveryDeadline = Date.now() + 2000;
      while (
        state === "durable" &&
        fake.createSessionCount + fake.resumeSessionCount < 2 &&
        Date.now() < recoveryDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(recovery.ok).toBe(state === "durable");
      expect(fake.createSessionCount).toBe(1);
      expect(fake.resumeSessionCount).toBe(state === "durable" ? 1 : 0);
      fake.lastSession?.close();
    });
  }

  it("keeps the selected backend's remedy in strict resume failures", async () => {
    const remedy = "Move the stored session into the new project directory.";
    const fake = new FakeBackend({ sessionResumableError: remedy });
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-remedy") }),
      initialRooms: [],
    });
    const info = await mgr.spawn(
      "Resume remedy",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-remedy",
    );

    await mgr.resume(info!.id, "missing-session");
    expect(
      mgr
        .getAgentLogs(info!.id)
        .some(
          (entry) => entry.kind === "error" && entry.content.includes(remedy),
        ),
    ).toBe(true);
  });

  it("surfaces OpenCode missing auth with one profile-scoped terminal card", async () => {
    const backend = createOpenCodeTracerBackend({ failAuth: true });
    const mgr = createAgentManager({
      resolveBackend: () => backend,
      officeState: new OfficeState({ rooms: rooms("room-opencode-auth") }),
      initialRooms: [],
    });
    mgr.configurePluginHooksDeps();
    const info = await mgr.spawn(
      "OpenCode auth tracer",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-opencode-auth",
      undefined,
      "opencode/fake",
      "high",
      undefined,
      "opencode",
    );
    mgr.enqueueMessage(info!.id, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    const deadline = Date.now() + 2000;
    while (
      !mgr
        .getAgentLogs(info!.id)
        .some((entry) => entry.kind === "terminal-command") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const logs = mgr.getAgentLogs(info!.id);
    const cards = logs.filter((entry) => entry.kind === "terminal-command");
    expect(cards).toHaveLength(1);
    expect(cards[0].terminal?.command).toContain("opencode-login-");
    expect(await mgr.demoteToLazy(info!.id)).toBe(true);
  });

  it("recovers through the exact login card, pty-sidecar, and /clear", async () => {
    const apiKey = `sk-${"S2_MANUAL_LOGIN_CANARY"}`;
    const requestPaths: string[] = [];
    const safeErrors: Array<Record<string, unknown>> = [];
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requestPaths.push(url.pathname);
        if (url.pathname === "/v1/models") {
          return Response.json({
            object: "list",
            data: [{ id: "gate-model", object: "model" }],
          });
        }
        if (url.pathname !== "/v1/responses")
          return new Response("not found", { status: 404 });
        if (request.headers.get("authorization") !== `Bearer ${apiKey}`) {
          return Response.json(
            {
              error: {
                message: "invalid credential",
                type: "authentication_error",
              },
            },
            { status: 401, headers: { "x-provider-private": apiKey } },
          );
        }
        const response = {
          id: "resp_gate",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-4o",
          output: [
            {
              id: "msg_gate",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Recovered after login.",
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
        const stream = new ReadableStream({
          start(controller) {
            const send = (type: string, data: unknown) =>
              controller.enqueue(
                `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
              );
            send("response.created", {
              type: "response.created",
              response: { ...response, status: "in_progress", output: [] },
            });
            send("response.output_item.added", {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                ...response.output[0],
                status: "in_progress",
                content: [],
              },
            });
            send("response.content_part.added", {
              type: "response.content_part.added",
              item_id: "msg_gate",
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            });
            send("response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: "msg_gate",
              output_index: 0,
              content_index: 0,
              delta: "Recovered after login.",
            });
            send("response.output_text.done", {
              type: "response.output_text.done",
              item_id: "msg_gate",
              output_index: 0,
              content_index: 0,
              text: "Recovered after login.",
            });
            send("response.content_part.done", {
              type: "response.content_part.done",
              item_id: "msg_gate",
              output_index: 0,
              content_index: 0,
              part: response.output[0].content[0],
            });
            send("response.output_item.done", {
              type: "response.output_item.done",
              output_index: 0,
              item: response.output[0],
            });
            send("response.completed", {
              type: "response.completed",
              response,
            });
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const profile = openCodeProfilePaths("default");
    const supervisor = new OpenCodeSupervisor({
      profileDir: profile.profileDir,
      serverCwd: STATE_ROOT,
      idleShutdownMs: 100,
      launchEnv: { OPENAI_BASE_URL: `http://127.0.0.1:${mock.port}/v1` },
      config: {
        autoupdate: false,
        model: "openai/gpt-4o",
        small_model: "openai/gpt-4o",
        share: "disabled",
      },
    });
    try {
      const backend = createOpenCodeBackend({
        supervisor,
        safeErrorSink: (error) => safeErrors.push({ ...error }),
      });
      const mgr = createAgentManager({
        resolveBackend: () => backend,
        officeState: new OfficeState({
          rooms: rooms("room-opencode-recovery"),
        }),
        initialRooms: [],
      });
      mgr.configurePluginHooksDeps();
      const info = await mgr.spawn(
        "OpenCode recovery tracer",
        STATE_ROOT,
        "default",
        undefined,
        undefined,
        "room-opencode-recovery",
        undefined,
        "openai/gpt-4o",
        "high",
        undefined,
        "opencode",
      );
      mgr.enqueueMessage(info!.id, {
        sender: { kind: "user", username: "tester" },
        text: "fail before login",
      });
      const authDeadline = Date.now() + 30_000;
      while (
        !mgr
          .getAgentLogs(info!.id)
          .some((entry) => entry.kind === "terminal-command") &&
        Date.now() < authDeadline
      )
        await Bun.sleep(10);
      const card = mgr
        .getAgentLogs(info!.id)
        .find((entry) => entry.kind === "terminal-command");
      expect(card?.terminal?.command).toContain("opencode-login-");

      const globalAuth = join(
        STATE_ROOT,
        "global-data",
        "opencode",
        "auth.json",
      );
      expect(await Bun.file(globalAuth).exists()).toBe(false);
      await runLoginCardThroughPty(card!.terminal!.command, STATE_ROOT, apiKey);
      expect(await Bun.file(globalAuth).exists()).toBe(false);
      expect(
        (await stat(join(profile.dataHome, "opencode", "auth.json"))).mode &
          0o777,
      ).toBe(0o600);

      await mgr.sendMessage(info!.id, "/clear", "tester");
      await mgr.sendMessage(info!.id, "reply after login", "tester");
      const replyDeadline = Date.now() + 15_000;
      while (
        !mgr
          .getAgentLogs(info!.id)
          .some((entry) => entry.content === "Recovered after login.") &&
        Date.now() < replyDeadline
      )
        await Bun.sleep(10);
      const serialized = JSON.stringify(mgr.getAgentLogs(info!.id));
      expect(safeErrors.slice(1)).toEqual([]);
      expect(requestPaths).toContain("/v1/responses");
      expect(serialized).toContain("Recovered after login.");
      expect(serialized).not.toContain(apiKey);
      for await (const path of new Bun.Glob("**/*.jsonl").scan(STATE_ROOT)) {
        expect(await Bun.file(join(STATE_ROOT, path)).text()).not.toContain(
          apiKey,
        );
      }
      await mgr.kill(info!.id);
    } finally {
      await supervisor.shutdown();
      await mock.stop(true);
    }
  }, 130_000);

  it("drops a real provider-error canary before normalized events and agent JSONL", async () => {
    const canary = "OPENCODE_PROVIDER_ERROR_SECRET_CANARY";
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            object: "list",
            data: [{ id: "gate-model", object: "model" }],
          });
        }
        if (url.pathname === "/v1/chat/completions") {
          return Response.json(
            { error: { message: canary, type: "provider_error" } },
            { status: 400, headers: { "x-provider-secret": canary } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    const supervisor = new OpenCodeSupervisor({
      profileDir: `${STATE_ROOT}/opencode-error-profile`,
      serverCwd: STATE_ROOT,
      idleShutdownMs: 100,
      config: {
        autoupdate: false,
        model: "gate/gate-model",
        small_model: "gate/gate-model",
        provider: {
          gate: {
            name: "Gate mock",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            models: {
              "gate-model": {
                name: "Gate model",
                limit: { context: 100000, output: 10000 },
                cost: { input: 0, output: 0 },
              },
            },
            options: {
              apiKey: "invalid-test-key",
              baseURL: `http://127.0.0.1:${mock.port}/v1`,
            },
          },
        },
      },
    });
    try {
      const backend = createOpenCodeBackend({ supervisor });
      const mgr = createAgentManager({
        resolveBackend: () => backend,
        officeState: new OfficeState({ rooms: rooms("room-opencode-error") }),
        initialRooms: [],
      });
      mgr.configurePluginHooksDeps();
      const info = await mgr.spawn(
        "OpenCode error tracer",
        STATE_ROOT,
        "default",
        undefined,
        undefined,
        "room-opencode-error",
        undefined,
        "gate/gate-model",
        "high",
        undefined,
        "opencode",
      );
      mgr.enqueueMessage(info!.id, {
        sender: { kind: "user", username: "tester" },
        text: "trigger provider error",
      });
      const deadline = Date.now() + 15_000;
      while (
        !mgr
          .getAgentLogs(info!.id)
          .some((entry) =>
            entry.content.includes("provider or transport error"),
          ) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const normalized = JSON.stringify(mgr.getAgentLogs(info!.id));
      expect(normalized).not.toContain(canary);
      expect(normalized).toContain("provider or transport error");
      expect(
        mgr
          .getAgentLogs(info!.id)
          .some((entry) => entry.kind === "terminal-command"),
      ).toBe(false);
      for await (const path of new Bun.Glob("**/*.jsonl").scan(STATE_ROOT)) {
        expect(await Bun.file(`${STATE_ROOT}/${path}`).text()).not.toContain(
          canary,
        );
      }
      for (const name of ["server.stdout.log", "server.stderr.log"]) {
        const file = Bun.file(`${supervisor.profileDir}/${name}`);
        expect((await file.exists()) ? await file.text() : "").not.toContain(
          canary,
        );
      }
      await mgr.kill(info!.id);
    } finally {
      await supervisor.shutdown();
      await mock.stop(true);
    }
  }, 25_000);

  it("restore/revive install path fills absent Codex permission defaults", async () => {
    const persisted = {
      id: "agent-codex-restore",
      name: "Restored Codex",
      desk: 0,
      cwd: STATE_ROOT,
      outfit: {
        hat: "none",
        color: "#000000",
        hair: "#000000",
        hairStyle: "short",
        skin: "#ffffff",
        beard: "none",
        accessory: null,
      },
      permissionMode: undefined,
      modelFamily: "gpt-5.5",
      effort: "medium",
      agentType: "codex",
      codexSandbox: undefined,
      lastSessionId: null,
      topic: null,
      customInstructions: null,
      userId: null,
      username: null,
    } as unknown as PersistedAgent;
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [
        { id: "room-a", name: "room-a", prompt: null, agents: [persisted] },
      ],
    });

    await mgr.restoreAgents();

    expect(mgr.getAgent(persisted.id)?.permissionMode).toBe("never");
    expect(mgr.getAgent(persisted.id)?.codexSandbox).toBe("danger-full-access");
  });

  it("consults the injected resolver and drives the FakeBackend on first message (lazy spawn: no session at spawn)", async () => {
    // onSend completes the wake turn so it doesn't park; configurePluginHooksDeps
    // lets runAgentTurn run at all (it throws unconfigured) - together they make
    // the first-message wake clean instead of logging a turn error.
    const fake = new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });
    const { calls, resolveBackend } = spyResolver(fake);
    const mgr = createAgentManager({
      resolveBackend,
      officeState: new OfficeState({ rooms: rooms("room-a") }),
      initialRooms: [],
    });
    mgr.configurePluginHooksDeps();
    const info = await mgr.spawn(
      "TestAgent",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-a",
    );
    expect(info).not.toBeNull();
    // Lazy spawn: the resolver is still consulted at spawn (for the backend's
    // capabilities), but NO session is created - the agent costs zero subprocess
    // until its first message.
    expect(calls).toContain("claude");
    expect(fake.createSessionCount).toBe(0);
    expect(mgr.getAgent(info!.id)?.dormant).toBe(true);

    // First message wakes it: NOW a FakeSession is created (proving no real
    // LLM/provider call) and bound to this agent.
    const r = mgr.enqueueMessage(info!.id, {
      sender: { kind: "user", username: "tester" },
      text: "hi",
    });
    expect(r.ok).toBe(true);
    const deadline = Date.now() + 2000;
    while (fake.createSessionCount === 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(fake.createSessionCount).toBe(1);
    expect(fake.lastSession?.opts.agentId).toBe(info!.id);
    // Close the fake session so the manager's background stream consumer
    // doesn't stay parked after the test.
    fake.lastSession?.close();
  });

  it("production factory constructs against today's defaults (shallow)", () => {
    // Empty temp home → loadAgents() returns [], so OfficeState seeds the
    // default single room. Reads the temp STATE_ROOT only.
    const mgr = createProductionAgentManager();
    expect(mgr.getRooms().length).toBeGreaterThanOrEqual(1);
  });
});
