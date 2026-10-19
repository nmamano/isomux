// /reload-plugins (task a93c05af): a member's reload of the OpenCode plugins
// and config. The command reaches the agent's engine only on OpenCode, with
// the environment key of the agent's member, the key the agent's sessions
// use. Claude keeps its pointer to the Claude CLI and Codex refuses it.
// Driven through AgentManager.sendMessage, so the registry entry, the handler
// and the manager's wiring to the backend are all in the path. What the
// reload does to the OpenCode server is in supervisor.test.ts.

import { describe, it, expect } from "bun:test";
import { FakeBackend } from "./fake-backend.ts";
import { OfficeState } from "../../shared/office-state.ts";
import { ENGINE_NAMES, type AgentBackendType } from "../../shared/types.ts";
import { translatorFor } from "../../shared/i18n/translate.ts";
import { autocompleteCommands } from "../../shared/commands.ts";
import { createAgentManager } from "../agent-manager.ts";
import { environmentSourceKeyForUserId } from "../env-loader.ts";
import { STATE_ROOT } from "../config.ts";
import { writeManagedUserEnv, removeManagedUserEnv } from "../user-env.ts";

type Outcome = "reloaded" | "pending" | Error;

class ReloadBackend extends FakeBackend {
  readonly reloads: { environmentKey: string }[] = [];
  outcome: Outcome = "reloaded";
  async reloadPlugins(opts: {
    environmentKey: string;
  }): Promise<"reloaded" | "pending"> {
    this.reloads.push({ ...opts });
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

async function agentOn(engine: AgentBackendType, userId: string) {
  const backend = new ReloadBackend();
  const roomId = `room-reload-${engine}`;
  const mgr = createAgentManager({
    resolveBackend: () => backend,
    officeState: new OfficeState({
      rooms: [{ id: roomId, name: roomId, prompt: null }],
    }),
    initialRooms: [],
  });
  const info = await mgr.spawn(
    `Reload ${engine}`,
    STATE_ROOT,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    undefined,
    engine,
    undefined,
    userId,
  );
  if (!info) throw new Error("spawn failed");
  // The lines one /reload-plugins adds to the agent's chat.
  const run = async () => {
    const before = mgr.getAgentLogs(info.id).length;
    await mgr.sendMessage(info.id, "/reload-plugins", "tester");
    return mgr.getAgentLogs(info.id).slice(before);
  };
  return { backend, run };
}

const { t } = translatorFor("en");

describe("/reload-plugins", () => {
  it("asks an OpenCode agent's engine to reload for the agent's member, and shows a distinct line per outcome", async () => {
    const userId = "user-reload-opencode";
    // A member with variables of their own has an environment key of their
    // own, so the key the engine gets names this member.
    writeManagedUserEnv(userId, { RELOAD_KEY_CANARY: "1" });
    const environmentKey = environmentSourceKeyForUserId(userId);
    expect(environmentKey).not.toBe(environmentSourceKeyForUserId(null));
    const { backend, run } = await agentOn("opencode", userId);
    const replies: string[] = [];
    for (const outcome of [
      "reloaded",
      "pending",
      new Error("reload-failure-canary"),
    ] as Outcome[]) {
      backend.outcome = outcome;
      const lines = await run();
      // The member sees what they typed, then the outcome.
      expect(lines[0]).toMatchObject({
        kind: "user_message",
        content: "/reload-plugins",
      });
      const outcomeLines = lines.slice(1);
      expect(outcomeLines.length, `one line for ${String(outcome)}`).toBe(1);
      replies.push(outcomeLines[0].content);
    }
    removeManagedUserEnv(userId);
    expect(backend.reloads).toEqual([
      { environmentKey },
      { environmentKey },
      { environmentKey },
    ]);
    expect(new Set(replies).size).toBe(3);
    // The failure line carries the engine's error, so it is not a refusal.
    expect(replies[2]).toContain("reload-failure-canary");
    for (const reply of replies)
      expect(reply).not.toBe(t("commands.reloadPlugins.message"));
  });

  it("keeps the Claude CLI pointer for a Claude agent and reloads nothing", async () => {
    const { backend, run } = await agentOn("claude", "user-reload-claude");
    const lines = await run();
    expect(lines.map((line) => line.kind)).toEqual(["user_message", "system"]);
    expect(lines[1].content).toBe(t("commands.reloadPlugins.message"));
    expect(backend.reloads).toEqual([]);
  });

  it("refuses it on a Codex agent as an OpenCode-only command and reloads nothing", async () => {
    const { backend, run } = await agentOn("codex", "user-reload-codex");
    const lines = await run();
    expect(lines.map((line) => line.kind)).toEqual(["user_message", "system"]);
    expect(lines[1].content).toBe(
      t("commands.unsupported.engine", {
        name: "reload-plugins",
        engines: ENGINE_NAMES.opencode,
      }),
    );
    expect(backend.reloads).toEqual([]);
  });

  it("is offered in autocomplete to OpenCode agents only", () => {
    const offered = (engine: AgentBackendType) =>
      autocompleteCommands(engine).some(
        (command) => command.name === "reload-plugins",
      );
    expect(offered("opencode")).toBe(true);
    expect(offered("claude")).toBe(false);
    expect(offered("codex")).toBe(false);
  });
});
