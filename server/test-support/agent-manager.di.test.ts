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

import { afterAll, afterEach, describe, it, expect } from "bun:test";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import type { RoomWire } from "../../shared/types.ts";
import { DEFAULT_EFFORT, effortLevelsFor } from "../../shared/types.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import {
  ensureSessionClaudeConfigDir,
  type PersistedAgent,
} from "../persistence.ts";
import type { AgentBackendType } from "../../shared/types.ts";
import type { Backend } from "../backends/types.ts";
import { createOpenCodeBackend } from "../backends/opencode/adapter.ts";
import { OPENCODE_AUTH_FAILURE } from "../backends/opencode/transport.ts";
import { authSignal } from "../backends/auth-signal.ts";
import { openCodeSupervisorForEnvironment } from "../backends/opencode/supervisor.ts";
import { openCodeProfilePaths } from "../backends/opencode/profile-paths.ts";
import { processIsRunning } from "../backends/opencode/process-identity.ts";
import { writeManagedUserEnv, removeManagedUserEnv } from "../user-env.ts";
import type { EventHandler } from "../internal-types.ts";
import { STATE_ROOT } from "../config.ts";
import { join } from "node:path";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { getBackupStatus } from "../backup.ts";
import { claimUser, deleteUser } from "../users.ts";
import { readUpdateConf } from "../update-conf.ts";
import {
  createAgentManager,
  createProductionAgentManager,
  backendSessionHasFixedCwd,
} from "../agent-manager.ts";
import { personalProviderHome } from "../provider-homes.ts";
import {
  setPersonalProviderActiveProvider,
  buildEnvForUserId,
  environmentSourceKeyForUserId,
  environmentSourceRevisionForUserId,
} from "../env-loader.ts";

// STATE_ROOT is a temp dir (the bun test preload preset ISOMUX_HOME before
// config.ts was imported), so the disk-touching assertions below run in-suite
// instead of skipping. The preload owns temp-root cleanup at process exit.

import { createOpenCodeTestReaper } from "./opencode-test-reaper.ts";

const LIVE = process.env.ISOMUX_TEST_OPENCODE === "1";

const reaper = createOpenCodeTestReaper();
afterEach(reaper.afterEach);
afterAll(reaper.afterAll);

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
  it("passes the managing user id to the browser profile", async () => {
    const calls: Array<{ agentId: string; profileId: string | null }> = [];
    const mgr = createAgentManager({
      resolveBackend: () => new FakeBackend(),
      officeState: new OfficeState({ rooms: rooms("room-browser-profile") }),
      initialRooms: [],
      runBrowserAction: async (agentId, _body, profileId) => {
        calls.push({ agentId, profileId });
        return { ok: true, url: "", title: "" };
      },
    });
    const info = await mgr.spawn(
      "Browser agent",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-browser-profile",
      undefined,
      undefined,
      undefined,
      "Owner",
      "claude",
      undefined,
      "user-stable-id",
    );
    expect(info).not.toBeNull();
    await mgr.runAgentBrowserAction(info!.id, { action: "close" });
    expect(calls).toEqual([{ agentId: info!.id, profileId: "user-stable-id" }]);
  });

  // A DI manager is a test fixture: with no storage roots injected,
  // /isomux-storage measures the state root only and never reads the host's
  // backup dir or the snapshot dir an update.conf names.
  it("measures no backup or snapshot dir when no storage roots are injected", async () => {
    const owner = "StorageRootsOwner";
    const fixture = mkdtempSync(join(tmpdir(), "isomux-storage-roots-"));
    const snapshots = join(fixture, "snapshots");
    mkdirSync(snapshots);
    writeFileSync(join(snapshots, "snap.tar"), "x".repeat(4096));
    const conf = join(fixture, "update.conf");
    writeFileSync(conf, `SNAPSHOT_DIR=${snapshots}\n`);
    const previous = process.env.ISOMUX_UPDATE_CONF;
    process.env.ISOMUX_UPDATE_CONF = conf;
    claimUser(owner, { role: "owner", allowedRooms: [], notifRooms: [] });
    try {
      // The host-side read would find the fixture snapshot dir.
      expect(readUpdateConf()).toEqual({
        state: "parsed",
        values: { SNAPSHOT_DIR: snapshots },
      });
      const mgr = createAgentManager({
        resolveBackend: () => new FakeBackend(),
        officeState: new OfficeState({ rooms: rooms("room-storage-roots") }),
        initialRooms: [],
      });
      const info = await mgr.spawn(
        "Storage agent",
        STATE_ROOT,
        "default",
        undefined,
        undefined,
        "room-storage-roots",
        undefined,
        undefined,
        undefined,
        undefined,
        "claude",
      );
      await mgr.sendMessage(info!.id, "/isomux-storage", owner);
      const report = mgr
        .getAgentLogs(info!.id)
        .filter((entry) => entry.kind === "system")
        .map((entry) => entry.content)
        .join("\n");
      // The owner's report names the measured state root (backticked: the
      // host backup dir is the state root's sibling and shares its prefix)...
      expect(report).toContain(`\`${STATE_ROOT}\``);
      // ...and neither host-side root.
      expect(report).not.toContain(getBackupStatus().backupDir);
      expect(report).not.toContain(snapshots);
    } finally {
      deleteUser(owner);
      if (previous === undefined) delete process.env.ISOMUX_UPDATE_CONF;
      else process.env.ISOMUX_UPDATE_CONF = previous;
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("classifies OpenCode and Codex sessions as fixed to their birth cwd", () => {
    expect(backendSessionHasFixedCwd("opencode")).toBe(true);
    expect(backendSessionHasFixedCwd("codex")).toBe(true);
    expect(backendSessionHasFixedCwd("claude")).toBe(false);
  });

  it("spawns with an activated personal home when no env files exist", async () => {
    // onSend completes the wake turn so it doesn't park; configureAgentTurnDeps
    // lets runAgentTurn run at all (it throws unconfigured) - together they make
    // the first-message wake clean instead of logging a turn error.
    const fake = new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    });
    const boxClaude = join(STATE_ROOT, "fixture-box-claude");
    const boxSkill = join(boxClaude, "skills", "fixture-skill");
    mkdirSync(boxSkill, { recursive: true });
    writeFileSync(join(boxSkill, "SKILL.md"), "fixture prompt");
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-personal-home") }),
      initialRooms: [],
      providerSkillSourceRoots: {
        claude: boxClaude,
        codex: join(STATE_ROOT, "fixture-box-codex"),
      },
    });
    mgr.configureAgentTurnDeps();
    const previousProvider = setPersonalProviderActiveProvider(
      (userId, provider) => userId === "01a19e7b" && provider === "claude",
    );
    try {
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
      expect(
        lstatSync(
          join(
            personalProviderHome("01a19e7b", "claude"),
            "skills",
            "fixture-skill",
          ),
        ).isSymbolicLink(),
      ).toBe(true);
    } finally {
      setPersonalProviderActiveProvider(previousProvider);
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
        }),
      },
    });
  });

  it("offers Codex models in /model and applies the selected slug", async () => {
    const fake = new FakeBackend();
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-codex-model") }),
      initialRooms: [],
    });
    const info = await mgr.spawn(
      "Codex model",
      STATE_ROOT,
      "never",
      undefined,
      undefined,
      "room-codex-model",
      undefined,
      "gpt-5.6-sol",
      "medium",
      undefined,
      "codex",
    );
    await mgr.sendMessage(info!.id, "/model", "tester");
    const interaction = mgr.getPendingInteractions()[0];
    expect(interaction.choices.map((choice) => choice.value)).toContain(
      "gpt-5.6-terra",
    );
    expect(interaction.choices.map((choice) => choice.value)).not.toContain(
      "opus",
    );
    const terra = interaction.choices.findIndex(
      (choice) => choice.value === "gpt-5.6-terra",
    );
    await mgr.sendMessage(info!.id, String(terra + 1), "tester");
    expect(mgr.getAgent(info!.id)?.modelFamily).toBe("gpt-5.6-terra");
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
            "OpenCode effort choices are available in agent settings for models that expose them.",
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

  it("offers Haiku its effort levels", async () => {
    const fake = new FakeBackend();
    const { sink } = capture();
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-haiku-effort") }),
      initialRooms: [],
      eventSink: sink,
    });
    const info = await mgr.spawn(
      "Haiku effort",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-haiku-effort",
      undefined,
      "haiku",
      "low",
      undefined,
      "claude",
    );

    await mgr.sendMessage(info!.id, "/effort", "tester");

    const interaction = mgr.getPendingInteractions()[0];
    expect(interaction?.kind).toBe("effort");
    expect(interaction?.choices.map((choice) => choice.value)).toEqual(
      effortLevelsFor("claude", "haiku").map((option) => option.level),
    );
    // A stored Haiku effort is kept, not migrated.
    expect(mgr.getAgent(info!.id)?.effort).toBe("low");
  });

  describe("haiku on Vertex", () => {
    // The agent owner's env selects Vertex with no 5.x pin, so haiku is
    // limited: no effort, and Auto is corrected to default.
    async function withVertex(run: () => Promise<void>) {
      const saved = process.env.CLAUDE_CODE_USE_VERTEX;
      process.env.CLAUDE_CODE_USE_VERTEX = "1";
      try {
        await run();
      } finally {
        if (saved === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX;
        else process.env.CLAUDE_CODE_USE_VERTEX = saved;
      }
    }

    function manager(room: string) {
      const fake = new FakeBackend();
      const { sink } = capture();
      const mgr = createAgentManager({
        resolveBackend: () => fake,
        officeState: new OfficeState({ rooms: rooms(room) }),
        initialRooms: [],
        eventSink: sink,
      });
      const spawn = (
        modelFamily: string,
        permissionMode: "auto" | "default",
        effort: "low" | "max",
      ) =>
        mgr.spawn(
          `${modelFamily} on Vertex`,
          STATE_ROOT,
          permissionMode,
          undefined,
          undefined,
          room,
          undefined,
          modelFamily,
          effort,
          undefined,
          "claude",
        );
      return { mgr, spawn };
    }

    it("corrects a spawn with Auto and max to default and the default effort", async () => {
      await withVertex(async () => {
        const { mgr, spawn } = manager("room-vertex-spawn");
        const haiku = await spawn("haiku", "auto", "max");
        expect(mgr.getAgent(haiku!.id)?.permissionMode).toBe("default");
        expect(mgr.getAgent(haiku!.id)?.effort).toBe(DEFAULT_EFFORT);
        const opus = await spawn("opus", "auto", "max");
        expect(mgr.getAgent(opus!.id)?.permissionMode).toBe("auto");
        expect(mgr.getAgent(opus!.id)?.effort).toBe("max");
      });
    });

    it("corrects an edit to Auto against the post-edit family", async () => {
      await withVertex(async () => {
        const { mgr, spawn } = manager("room-vertex-edit");
        const info = await spawn("opus", "default", "low");
        await mgr.editAgent(info!.id, {
          modelFamily: "haiku",
          permissionMode: "auto",
        });
        expect(mgr.getAgent(info!.id)?.permissionMode).toBe("default");
        await mgr.editAgent(info!.id, {
          modelFamily: "opus",
          permissionMode: "auto",
        });
        expect(mgr.getAgent(info!.id)?.permissionMode).toBe("auto");
      });
    });

    it("answers /effort as unsupported and keeps the stored effort", async () => {
      await withVertex(async () => {
        const { mgr, spawn } = manager("room-vertex-effort");
        const info = await spawn("haiku", "default", "low");
        await mgr.sendMessage(info!.id, "/effort", "tester");
        expect(mgr.getPendingInteractions()).toEqual([]);
        // Named with the version the agent runs, not FAMILY_TO_MODEL's.
        const notice = translatorFor("en").t("commands.effort.unsupported", {
          model: "Haiku 4.5",
        });
        expect(
          mgr.getAgentLogs(info!.id).some((entry) => entry.content === notice),
        ).toBe(true);
        expect(mgr.getAgent(info!.id)?.effort).toBe("low");
      });
    });
  });

  it("redacts new entries before the agent cache and event stream", async () => {
    const secret = "sk-proj-" + "R".repeat(24);
    const safe = "sk-proj-...REDACTED";
    const fake = new FakeBackend({
      session: {
        onSend: (_text, _attachments, session) =>
          session.completeTurn({ text: secret }),
      },
    });
    const { events, sink } = capture();
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-redaction") }),
      initialRooms: [],
      eventSink: sink,
    });
    mgr.configureAgentTurnDeps();
    const info = await mgr.spawn(
      "Redaction",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-redaction",
    );
    try {
      await mgr.sendMessage(info!.id, secret, "tester");
      const deadline = Date.now() + 2000;
      while (
        !mgr
          .getAgentLogs(info!.id)
          .some((log) => log.kind === "text" && log.content === safe) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const logs = mgr.getAgentLogs(info!.id);
      expect(
        logs.some((log) => log.kind === "text" && log.content === safe),
      ).toBe(true);
      expect(
        logs.some(
          (log) => log.kind === "user_message" && log.content.includes(safe),
        ),
      ).toBe(true);
      expect(JSON.stringify(logs)).not.toContain(secret);
      const streamed = events.filter((event) => event.type === "log_entry");
      expect(JSON.stringify(streamed)).toContain(safe);
      expect(JSON.stringify(streamed)).not.toContain(secret);
    } finally {
      fake.sessions.forEach((session) => session.close());
    }
  });

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

    // A known root isolates this test from legacy root discovery.
    ensureSessionClaudeConfigDir(
      info!.id,
      "missing-session",
      join(STATE_ROOT, "remedy-root"),
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

  it("surfaces OpenCode missing auth as the backend's guidance without a terminal card", async () => {
    // The production OpenCode auth detection and guidance behind a scripted
    // session that fails its turn the way the OpenCode transport does.
    const opencode = createOpenCodeBackend();
    const fake = new FakeBackend({
      session: {
        onSend: (_text, _attachments, session) => {
          for (const event of authSignal(
            {
              kind: "turn_completed",
              status: "failed",
              error: OPENCODE_AUTH_FAILURE,
            },
            (text) => opencode.detectAuthError(text),
          ))
            session.push(event);
        },
      },
    });
    Object.assign(fake, {
      detectAuthError: (text: string) => opencode.detectAuthError(text),
      getLoginInstructions: (
        opts?: Parameters<Backend["getLoginInstructions"]>[0],
      ) => opencode.getLoginInstructions(opts),
    });
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-opencode-auth") }),
      initialRooms: [],
    });
    mgr.configureAgentTurnDeps();
    const info = await mgr.spawn(
      "OpenCode auth",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-opencode-auth",
      undefined,
      undefined,
      undefined,
      undefined,
      "opencode",
    );
    mgr.enqueueMessage(info!.id, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    const { text: guidance } = await opencode.getLoginInstructions();
    const deadline = Date.now() + 2000;
    while (
      !mgr.getAgentLogs(info!.id).some((entry) => entry.content === guidance) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const logs = mgr.getAgentLogs(info!.id);
    expect(
      logs.some((entry) => entry.content === guidance),
      "the OpenCode guidance is logged",
    ).toBe(true);
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
          // The Codex adapter's shape for a stderr 401 burst: a signal per
          // auth-shaped line it let through, then a failed turn with no error.
          session.push({ kind: "auth_needed" });
          session.push({ kind: "auth_needed" });
          session.push({ kind: "turn_completed", status: "failed" });
        },
      },
    });
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-codex-auth") }),
      initialRooms: [],
      // An owner manager: a member's office card says to ask an owner.
      findUser: () => ({ id: "user-a", role: "owner" }),
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
    mgr.configureAgentTurnDeps();
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
          session.push({ kind: "auth_needed" });
          session.push({ kind: "turn_completed", status: "failed" });
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
    mgr.configureAgentTurnDeps();
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

  // Task 2bd836d5: a provider refusal is the provider's words. Its text can
  // say "unauthorized" or "at capacity", so the orchestrator shows it as it
  // is: once, with no sign-in card and no capacity rewrite, and the failed
  // turn leaves the agent in error.
  it("shows a flagged provider refusal once, as it is", async () => {
    const providerWords =
      "Selected model is at capacity for unauthorized clients.";
    const line = translatorFor("en").t("systemEntries.providerRefused", {
      provider: "openai",
      message: providerWords,
    });
    const fake = new FakeBackend({
      isAuthError: (text) => /unauthorized/i.test(text),
      loginInstructions: {
        text: "terminal fallback",
        commands: ["codex login --device-auth"],
      },
      session: {
        onSend: (_text, _attachments, session) => {
          session.push({
            kind: "turn_completed",
            status: "failed",
            error: line,
            providerRefusal: true,
          });
        },
      },
    });
    const mgr = createAgentManager({
      resolveBackend: () => fake,
      officeState: new OfficeState({ rooms: rooms("room-codex-refusal") }),
      initialRooms: [],
      findUser: () => ({ id: "user-a", role: "owner" }),
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
    mgr.configureAgentTurnDeps();
    const info = await mgr.spawn(
      "Codex refusal",
      STATE_ROOT,
      "default",
      undefined,
      undefined,
      "room-codex-refusal",
      undefined,
      "fake",
      "high",
      "tester",
      "codex",
      undefined,
      "user-a",
    );
    // A queued message: the flush that delivers it is the caller whose catch
    // would print a rejected turn's error a second time.
    mgr.enqueueMessage(info!.id, {
      sender: { kind: "user", username: "tester" },
      text: "hello",
    });
    const deadline = Date.now() + 2000;
    while (
      !(
        fake.sessionForAgent(info!.id)?.sent.length &&
        mgr.getAgent(info!.id)?.state !== "thinking" &&
        mgr.getAgentLogs(info!.id).some((entry) => entry.kind === "error")
      ) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    // Let a second writer, if any, land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const logs = mgr.getAgentLogs(info!.id);
    expect(
      logs
        .filter((entry) => entry.content.includes(providerWords))
        .map((entry) => ({ kind: entry.kind, content: entry.content })),
    ).toEqual([{ kind: "error", content: line }]);
    expect(logs.some((entry) => entry.metadata?.providerLogin)).toBe(false);
    expect(mgr.getAgent(info!.id)?.state).toBe("error");
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
            session.push({ kind: "auth_needed" });
          },
        },
      });
      const room = `room-fallback-${name.replaceAll(" ", "-")}`;
      const mgr = createAgentManager({
        resolveBackend: () => fake,
        officeState: new OfficeState({ rooms: rooms(room) }),
        initialRooms: [],
        listProviderAccounts,
        // The fallback target is the office account, whose commands only an
        // owner gets.
        findUser: () => ({ id: "user-a", role: "owner" }),
      });
      mgr.configureAgentTurnDeps();
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
          session.push({ kind: "auth_needed" });
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
    mgr.configureAgentTurnDeps();
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

  // Real subprocess credential scrub: run with bun run test:opencode.
  it.skipIf(!LIVE)(
    "keeps provider credentials out of auth guidance and agent logs, then recovers after a managed key change and /clear",
    async () => {
      const apiKey = `sk-${"S2_MANUAL_LOGIN_CANARY"}`;
      const newKey = `recovered-${apiKey}`;
      const userId = "opencode-recovery-test";
      const requestPaths: string[] = [];
      const requests: Array<{
        path: string;
        authorization: string | null;
        status: number;
      }> = [];
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
          const authorization = request.headers.get("authorization");
          const accepted = authorization === `Bearer ${newKey}`;
          requests.push({
            path: url.pathname,
            authorization,
            status: accepted ? 200 : 401,
          });
          if (!accepted) {
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
      const env = {
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
      };
      writeManagedUserEnv(userId, env);
      const environmentKey = environmentSourceKeyForUserId(userId);
      const profile = openCodeProfilePaths(environmentKey);
      // Route both reply and small-model/title work to the local provider.
      // This profile config is separate from the supervisor's managed config.
      const configDir = join(profile.configHome, "opencode");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "opencode.json"),
        JSON.stringify({
          model: "openai/gpt-4o",
          small_model: "openai/gpt-4o",
          enabled_providers: ["openai"],
        }),
      );
      const supervisor = openCodeSupervisorForEnvironment(
        environmentKey,
        buildEnvForUserId(userId),
        environmentSourceRevisionForUserId(userId),
      );
      const measure = async <T>(
        phase: string,
        action: () => Promise<T>,
      ): Promise<T> => {
        const started = performance.now();
        try {
          return await action();
        } finally {
          console.info(
            "OpenCode DI timing",
            JSON.stringify({
              phase,
              ms: Math.round(performance.now() - started),
              load: loadavg(),
            }),
          );
        }
      };
      let lease: Awaited<ReturnType<typeof supervisor.acquire>> | undefined;
      const startedPids = new Set<number>();
      const topicCalls: Promise<string>[] = [];
      let stopAgent: (() => Promise<unknown>) | undefined;
      reaper.track(supervisor);
      const teardown = reaper.add(async () => {
        await stopAgent?.();
        // A failed assertion can leave the real topic call starting a server.
        // Drain it before shutdown so it cannot start a server after cleanup.
        await Promise.allSettled(topicCalls);
        if (lease) startedPids.add(lease.pid);
        lease?.release();
        await measure("server teardown", () => supervisor.shutdown());
        await mock.stop(true);
        removeManagedUserEnv(userId);
        for (const pid of startedPids)
          expect(processIsRunning(pid), "fixture server stopped").toBe(false);
      });
      try {
        lease = await measure("server start", () => supervisor.acquire());
        // Keep the lease to read the server pid, but end the hold acquire()
        // takes: a held server waits out the replacement that the key change
        // below asks for, and an agent holds one only during a turn.
        lease.settle();
        startedPids.add(lease.pid);
        const firstPid = lease.pid;
        const productionBackend = createOpenCodeBackend({
          safeErrorSink: (error) => safeErrors.push({ ...error }),
        });
        const backend: Backend = {
          ...productionBackend,
          oneShotPrompt(...args) {
            const call = productionBackend.oneShotPrompt(...args);
            topicCalls.push(call);
            return call;
          },
        };
        const isGuidance = (entry: { kind: string; content: string }) =>
          entry.kind === "system" &&
          entry.content.includes("OPENCODE_API_KEY") &&
          entry.content.includes("/clear");
        const guidanceLogged = Promise.withResolvers<void>();
        let settled = Promise.withResolvers<void>();
        const expectedAgent = { id: "" };
        const mgr = createAgentManager({
          eventSink: (event) => {
            if (
              event.type === "log_entry" &&
              event.entry.agentId === expectedAgent.id &&
              isGuidance(event.entry)
            ) {
              guidanceLogged.resolve();
            }
            if (
              event.type === "agent_updated" &&
              event.agentId === expectedAgent.id &&
              (event.changes.state === "waiting_for_response" ||
                event.changes.state === "error")
            ) {
              settled.resolve();
            }
          },
          resolveBackend: () => backend,
          officeState: new OfficeState({
            rooms: rooms("room-opencode-recovery"),
          }),
          initialRooms: [],
        });
        mgr.configureAgentTurnDeps();
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
          "tester",
          "opencode",
          undefined,
          userId,
        );
        expectedAgent.id = info!.id;
        stopAgent = () => mgr.kill(info!.id);
        const replyStarted = performance.now();
        mgr.enqueueMessage(info!.id, {
          sender: { kind: "user", username: "tester" },
          text: "fail before login",
        });
        await settled.promise;
        // Login guidance is asynchronous and may follow the settled state.
        // This deadline detects a missing event; success ends on the event itself.
        let guidanceDeadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            guidanceLogged.promise,
            new Promise<never>((_resolve, reject) => {
              guidanceDeadline = setTimeout(
                () =>
                  reject(
                    new Error(
                      "Auth guidance never arrived after the auth-failed turn settled",
                    ),
                  ),
                5000,
              );
            }),
          ]);
        } finally {
          clearTimeout(guidanceDeadline);
        }
        console.info(
          "OpenCode DI timing",
          JSON.stringify({
            phase: "guidance reply",
            ms: Math.round(performance.now() - replyStarted),
            load: loadavg(),
          }),
        );
        const logs = mgr.getAgentLogs(info!.id);
        expect(
          logs.some(isGuidance),
          "system guidance names the key and /clear",
        ).toBe(true);
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
        await Promise.allSettled(topicCalls);
        expect(
          topicCalls.length,
          "the initial topic call also reached the local provider",
        ).toBeGreaterThan(0);
        expect(
          safeErrors,
          "one rejected-key error from the turn and one from topic generation",
        ).toHaveLength(2);
        expect(requestPaths).toContain("/v1/responses");
        expect(
          safeErrors.every((error) => error.statusCode === 401),
          "only rejected-key errors before recovery",
        ).toBe(true);
        const authErrorCount = safeErrors.length;
        const initialTopicCount = topicCalls.length;
        expect(requests.length).toBeGreaterThan(0);
        expect(
          requests.every(
            (request) =>
              request.authorization === `Bearer ${apiKey}` &&
              request.status === 401,
          ),
          "the original key was rejected before recovery",
        ).toBe(true);
        expect(mgr.getAgent(info!.id)?.state).toBe("waiting_for_response");
        expect(
          JSON.stringify(logs).includes(apiKey),
          "guidance logs exclude the provider key",
        ).toBe(false);

        writeManagedUserEnv(userId, { ...env, OPENAI_API_KEY: newKey });
        expect(environmentSourceKeyForUserId(userId)).toBe(environmentKey);
        const beforeRecovery = requests.length;
        await mgr.sendMessage(info!.id, "/clear", "tester");
        settled = Promise.withResolvers<void>();
        mgr.enqueueMessage(info!.id, {
          sender: { kind: "user", username: "tester" },
          text: "reply after the managed key change",
        });
        await measure("recovery reply", () => settled.promise);
        startedPids.add(lease.pid);
        // Distinguish a turn that never reached the mock from a stale key.
        const recoveryRequests = requests.slice(beforeRecovery);
        const recoveryCause = (
          mgr
            .getAgentLogs(info!.id)
            .filter(
              (entry) => entry.kind === "error" || entry.kind === "system",
            )
            .at(-1)?.content ?? "No recovery error or system entry"
        )
          .replaceAll(newKey, "[REDACTED]")
          .replaceAll(apiKey, "[REDACTED]");
        expect(
          recoveryRequests.length,
          `No provider request arrived after /clear. Last recovery error/system entry: ${recoveryCause}`,
        ).toBeGreaterThan(0);
        // An env-revision mutant sends another 401 and fails here.
        expect(
          recoveryRequests.some(
            (request) =>
              request.authorization === `Bearer ${newKey}` &&
              request.status === 200,
          ),
          "recovery provider request uses the new managed key",
        ).toBe(true);
        expect(
          mgr
            .getAgentLogs(info!.id)
            .some(
              (entry) =>
                entry.kind === "text" &&
                entry.content === "Recovered after login.",
            ),
          "a real provider reply arrives after /clear",
        ).toBe(true);
        expect(lease.pid).not.toBe(firstPid);
        expect(processIsRunning(firstPid)).toBe(false);
        expect(supervisor.profileDir).toBe(profile.profileDir);
        const recoveryTopics = await Promise.allSettled(
          topicCalls.slice(initialTopicCount),
        );
        expect(
          recoveryTopics.length,
          "recovery also exercises topic generation",
        ).toBeGreaterThan(0);
        expect(
          recoveryTopics.every((result) => result.status === "fulfilled"),
          "recovery topic calls succeed",
        ).toBe(true);
        expect(safeErrors).toHaveLength(authErrorCount);
        console.info(
          "OpenCode recovery mock requests",
          JSON.stringify(
            requestPaths.reduce<Record<string, number>>((counts, path) => {
              counts[path] = (counts[path] ?? 0) + 1;
              return counts;
            }, {}),
          ),
        );
        expect(
          requestPaths.every(
            (path) => path === "/v1/models" || path === "/v1/responses",
          ),
          "all provider requests use the local mock protocol",
        ).toBe(true);
        const serialized = JSON.stringify(mgr.getAgentLogs(info!.id));
        expect(
          serialized.includes(apiKey),
          "recovery logs exclude provider keys",
        ).toBe(false);
        let scannedFiles = 0;
        for await (const path of new Bun.Glob("**/*.jsonl").scan(STATE_ROOT)) {
          scannedFiles++;
          expect(
            (await Bun.file(join(STATE_ROOT, path)).text()).includes(apiKey),
            "persisted logs exclude provider keys",
          ).toBe(false);
        }
        expect(
          scannedFiles,
          "Credential sweep must read persisted logs",
        ).toBeGreaterThan(0);
        await mgr.kill(info!.id);
      } finally {
        await teardown();
      }
    },
    130_000,
  );

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
    // onSend completes the wake turn so it doesn't park; configureAgentTurnDeps
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
    mgr.configureAgentTurnDeps();
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
