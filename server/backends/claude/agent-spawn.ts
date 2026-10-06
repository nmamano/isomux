// Claude Code as the agent user (internal-docs/os-user-split-design.md,
// section 2.1). In split mode every SDK query starts the CLI through the agent
// host, with the agent host's environment when the caller gave none (the SDK
// would copy the server's process.env). In single-user mode nothing is added:
// the SDK spawns the CLI itself, as before.
import type {
  Options,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { getAgentHost, type AgentHost } from "../../agent-host.ts";

export function spawnClaudeThroughHost(
  host: AgentHost,
  { command, args, cwd, env, signal }: SpawnOptions,
): SpawnedProcess {
  // The SDK reads no stderr from a custom spawn.
  const child = host.spawnChild([command, ...args], {
    cwd,
    env,
    stderr: "ignore",
  });
  if (signal.aborted) child.kill("SIGTERM");
  else {
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => signal.removeEventListener("abort", onAbort);
    child.once("exit", done);
    child.once("error", done);
  }
  return child;
}

export function withAgentSpawn(options: Options): Options {
  const host = getAgentHost();
  if (host.kind !== "runner") return options;
  return {
    ...options,
    env: options.env ?? host.baseEnv(),
    spawnClaudeCodeProcess: (spawn) => spawnClaudeThroughHost(host, spawn),
  };
}
