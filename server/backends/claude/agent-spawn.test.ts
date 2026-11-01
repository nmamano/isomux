// Task 8db21c8b: the Claude CLI of an agent session starts through the agent
// host with isolate, in single-user mode too; other SDK queries (usage,
// account) do not ask for it. A fake local host records each spawn and runs
// `true` in its place, so no CLI starts.
import { afterEach, describe, expect, it } from "bun:test";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import {
  localAgentHost,
  setAgentHost,
  type SpawnChildOptions,
} from "../../agent-host.ts";
import { realV1SdkClient } from "../claude.ts";
import { withAgentSpawn } from "./agent-spawn.ts";

afterEach(() => setAgentHost(localAgentHost));

function recordingHost() {
  const spawns: SpawnChildOptions[] = [];
  setAgentHost({
    ...localAgentHost,
    spawnChild: (_argv, options = {}) => {
      spawns.push(options);
      return localAgentHost.spawnChild(["true"], { env: process.env });
    },
  });
  return spawns;
}

function spawnOptions(): SpawnOptions {
  return {
    command: "claude",
    args: [],
    env: { PATH: process.env.PATH },
    signal: new AbortController().signal,
  };
}

describe("withAgentSpawn on the local host", () => {
  it("starts the CLI through the host with isolate only when asked", () => {
    const spawns = recordingHost();
    const isolated = withAgentSpawn({}, { isolate: true });
    expect(isolated.spawnClaudeCodeProcess).toBeDefined();
    isolated.spawnClaudeCodeProcess!(spawnOptions());
    const plain = withAgentSpawn({});
    plain.spawnClaudeCodeProcess?.(spawnOptions());
    expect(spawns.map((options) => options.isolate === true)).toEqual(
      plain.spawnClaudeCodeProcess ? [true, false] : [true],
    );
  });

  it("wraps the CLI of an isolated one-shot query", async () => {
    const spawns = recordingHost();
    await realV1SdkClient
      .oneShotPrompt({
        prompt: "Topic",
        model: "claude-haiku-4-5",
        pathToClaudeCodeExecutable: "/bin/true",
        isolate: true,
      })
      .catch(() => {});
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns.every((options) => options.isolate === true)).toBe(true);
  });
});
