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
import { join } from "node:path";
import {
  createAgentManager,
  createProductionAgentManager,
  backendSessionHasFixedCwd,
} from "../agent-manager.ts";
import { personalProviderHome } from "../provider-homes.ts";
import { setPersonalProviderActiveProvider } from "../env-loader.ts";

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

  it("spawns with an activated personal home when no env files exist", async () => {
    // onSend completes the wake turn so it doesn't park; configurePluginHooksDeps
    // lets runAgentTurn run at all (it throws unconfigured) - together they make
    // the first-message wake clean instead of logging a turn error.
    const fake = new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-personal-home") }),
      initialRooms: [],
    });
    mgr.configurePluginHooksDeps();
    try {
      setPersonalProviderActiveProvider(
        (userId, provider) => userId === "01a19e7b" && provider === "claude",
      );
      const info = await mgr.spawn(
        "Personal Claude",
        STATE_ROOT,
        "default",
        undefined,
        undefined,
        "room-personal-home",
        undefined,
        undefined,
        undefined,
        "Owner",
        "claude",
        undefined,
        "01a19e7b",
      );
      await mgr.sendMessage(info!.id, "hello", "Owner");
      expect(fake.lastSession?.opts.env?.CLAUDE_CONFIG_DIR).toBe(
        personalProviderHome("01a19e7b", "claude"),
      );
    } finally {
      setPersonalProviderActiveProvider(() => false);
    }
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

  // The gated real-server first-reply guard moved to
  // agent-manager.opencode.live.test.ts (`bun run test:opencode`).

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

  it("surfaces OpenCode missing auth as Connections guidance without a terminal card", async () => {
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
    const guidance =
      "To use your own Anthropic or OpenAI API key with OpenCode, add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` under User Settings → Connections, then `/clear`.";
    const deadline = Date.now() + 2000;
    while (
      !mgr.getAgentLogs(info!.id).some((entry) => entry.content === guidance) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const logs = mgr.getAgentLogs(info!.id);
    expect(logs.some((entry) => entry.content === guidance)).toBe(true);
    expect(logs.some((entry) => entry.kind === "terminal-command")).toBe(false);
    expect(await mgr.demoteToLazy(info!.id)).toBe(true);
  });

  it("collapses a Codex auth wake to one actionable browser notice", async () => {
    const fake = new FakeBackend({
      isAuthError: (text) => /401/.test(text),
      loginInstructions: {
        text: "terminal fallback",
        commands: ["codex login --device-auth"],
      },
      session: {
        onSend: (_text, _attachments, session) => {
          session.push({
            kind: "system_text",
            text: "[codex stderr] 401 Unauthorized",
          });
          session.push({
            kind: "system_text",
            text: "[codex stderr] 401 Unauthorized retry",
          });
          session.push({
            kind: "turn_completed",
            status: "failed",
            error:
              "Codex turn failed after an auth error; see the prior Codex auth notice.",
            causedByAuth: true,
          });
        },
      },
    });
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-codex-auth") }),
      initialRooms: [],
      listProviderAccounts: async () => [
        {
          provider: "codex",
          scope: "office",
          accountStatus: "not_connected",
          loginStatus: "idle",
          canBrowserLogin: true,
        },
      ],
    });
    mgr.configurePluginHooksDeps();
    const info = await mgr.spawn(
      "Codex auth card",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-codex-auth",
      undefined,
      "fake",
      "high",
      "tester",
      "codex",
      undefined,
      "user-a",
    );
    mgr.enqueueMessage(info!.id, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    const deadline = Date.now() + 2000;
    while (
      !mgr
        .getAgentLogs(info!.id)
        .some((entry) => entry.metadata?.providerLogin === "codex") &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));

    const logs = mgr.getAgentLogs(info!.id);
    const notice = logs.filter(
      (entry) => entry.metadata?.providerLogin === "codex",
    );
    expect(notice).toHaveLength(1);
    expect(notice[0].content).toBe(
      "Codex could not run this message because it is not signed in. Sign in below to continue.",
    );
    expect(logs.some((entry) => entry.content.includes("[codex stderr]"))).toBe(
      false,
    );
    expect(
      logs.some((entry) => entry.content.includes("prior Codex auth notice")),
    ).toBe(false);
    expect(
      logs.filter((entry) => entry.kind === "terminal-command"),
    ).toHaveLength(0);
  });

  it("emits a new Codex auth notice on a later wake", async () => {
    const fake = new FakeBackend({
      isAuthError: (text) => /401/.test(text),
      loginInstructions: {
        text: "terminal fallback",
        commands: ["codex login --device-auth"],
      },
      session: {
        onSend: (_text, _attachments, session) => {
          session.push({ kind: "system_text", text: "401 Unauthorized" });
          session.push({
            kind: "turn_completed",
            status: "failed",
            error: "auth wake failed",
            causedByAuth: true,
          });
        },
      },
    });
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-codex-auth-reset") }),
      initialRooms: [],
      listProviderAccounts: async () => [
        {
          provider: "codex",
          scope: "office",
          accountStatus: "not_connected",
          loginStatus: "idle",
          canBrowserLogin: true,
        },
      ],
    });
    mgr.configurePluginHooksDeps();
    const info = await mgr.spawn(
      "Codex auth reset",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-codex-auth-reset",
      undefined,
      "fake",
      "high",
      "tester",
      "codex",
      undefined,
      "user-a",
    );
    const send = (text: string) =>
      mgr.enqueueMessage(info!.id, {
        sender: { kind: "user", username: "tester" },
        text,
      });
    send("first");
    let deadline = Date.now() + 2000;
    while (
      mgr
        .getAgentLogs(info!.id)
        .filter((entry) => entry.metadata?.providerLogin === "codex").length <
        1 &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    send("second");
    deadline = Date.now() + 2000;
    while (
      mgr
        .getAgentLogs(info!.id)
        .filter((entry) => entry.metadata?.providerLogin === "codex").length <
        2 &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      mgr
        .getAgentLogs(info!.id)
        .filter((entry) => entry.metadata?.providerLogin === "codex"),
    ).toHaveLength(2);
  });

  it("keeps Codex terminal fallback when no browser card is actionable", async () => {
    const cases = [
      ["no user", null, async () => []],
      [
        "lookup failure",
        "user-a",
        async () => Promise.reject(new Error("bad env")),
      ],
      [
        "capability failure",
        "user-a",
        async () => [
          {
            provider: "codex" as const,
            scope: "office" as const,
            accountStatus: "unavailable" as const,
            loginStatus: "idle" as const,
            canBrowserLogin: false,
            fallbackToTerminal: true,
          },
        ],
      ],
    ] as const;
    for (const [name, userId, listProviderAccounts] of cases) {
      const fake = new FakeBackend({
        isAuthError: (text) => /401/.test(text),
        loginInstructions: {
          text: "terminal fallback",
          commands: ["codex login --device-auth"],
        },
        session: {
          onSend: (_text, _attachments, session) => {
            session.push({ kind: "system_text", text: "401 Unauthorized" });
          },
        },
      });
      const room = `room-fallback-${name.replaceAll(" ", "-")}`;
      const mgr = createAgentManager({
        resolveBackend: () => fake,
        officeState: new OfficeState({ rooms: rooms(room) }),
        initialRooms: [],
        listProviderAccounts,
      });
      mgr.configurePluginHooksDeps();
      const info = await mgr.spawn(
        `Codex ${name}`,
        STATE_ROOT,
        "default",
        undefined,
        undefined,
        room,
        undefined,
        "fake",
        "high",
        "tester",
        "codex",
        undefined,
        userId,
      );
      mgr.enqueueMessage(info!.id, {
        sender: { kind: "user", username: "tester" },
        text: "hello",
      });
      const deadline = Date.now() + 2000;
      while (
        mgr
          .getAgentLogs(info!.id)
          .filter((entry) => entry.kind === "terminal-command").length < 1 &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      const logs = mgr.getAgentLogs(info!.id);
      expect(logs.some((entry) => entry.content === "terminal fallback")).toBe(
        true,
      );
      expect(
        logs.filter((entry) => entry.kind === "terminal-command"),
      ).toHaveLength(1);
      expect(
        logs.find((entry) => entry.kind === "terminal-command")?.terminal
          ?.command,
      ).toContain("--device-auth");
      expect(
        logs.some((entry) => entry.metadata?.providerLogin === "codex"),
      ).toBe(false);
    }
  });

  it("keeps the already-authenticated Codex clear hint instead of a sign-in card", async () => {
    const fake = new FakeBackend({
      isAuthError: (text) => /401/.test(text),
      loginInstructions: { text: "Codex is signed in. Type /clear." },
      session: {
        onSend: (_text, _attachments, session) => {
          session.push({ kind: "system_text", text: "401 Unauthorized" });
        },
      },
    });
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-codex-clear") }),
      initialRooms: [],
      listProviderAccounts: async () => [
        {
          provider: "codex",
          scope: "office",
          accountStatus: "not_connected",
          loginStatus: "idle",
          canBrowserLogin: true,
        },
      ],
    });
    mgr.configurePluginHooksDeps();
    const info = await mgr.spawn(
      "Codex clear",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-codex-clear",
      undefined,
      "fake",
      "high",
      "tester",
      "codex",
      undefined,
      "user-a",
    );
    mgr.enqueueMessage(info!.id, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const logs = mgr.getAgentLogs(info!.id);
    expect(
      logs.some(
        (entry) => entry.content === "Codex is signed in. Type /clear.",
      ),
    ).toBe(true);
    expect(
      logs.some((entry) => entry.metadata?.providerLogin === "codex"),
    ).toBe(false);
  });

  it("keeps provider credentials out of Connections guidance and agent logs", async () => {
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
        if (
          request.headers.get("authorization") !== `Bearer rejected-${apiKey}`
        ) {
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
    const supervisor = new OpenCodeSupervisor({
      profileDir: join(STATE_ROOT, "opencode", "profiles", "default"),
      serverCwd: STATE_ROOT,
      idleShutdownMs: 100,
      launchEnv: {
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
      },
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
      const guidance =
        "To use your own Anthropic or OpenAI API key with OpenCode, add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` under User Settings → Connections, then `/clear`.";
      const authDeadline = Date.now() + 30_000;
      while (
        !mgr
          .getAgentLogs(info!.id)
          .some((entry) => entry.content === guidance) &&
        Date.now() < authDeadline
      )
        await Bun.sleep(10);
      const logs = mgr.getAgentLogs(info!.id);
      expect(logs.some((entry) => entry.content === guidance)).toBe(true);
      expect(logs.some((entry) => entry.kind === "terminal-command")).toBe(
        false,
      );

      const globalAuth = join(
        STATE_ROOT,
        "global-data",
        "opencode",
        "auth.json",
      );
      expect(await Bun.file(globalAuth).exists()).toBe(false);
      const serialized = JSON.stringify(mgr.getAgentLogs(info!.id));
      expect(safeErrors).toHaveLength(1);
      expect(requestPaths).toContain("/v1/responses");
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
