// Claude Code as the agent user (internal-docs/os-user-split-design.md,
// section 2.1). In split mode every SDK query starts the CLI through the agent
// host, with the agent host's environment when the caller gave none (the SDK
// would copy the server's process.env). In single-user mode a query starts
// the CLI through the host only when it runs in its own PID namespace
// (server/process-isolation.ts); otherwise the SDK spawns the CLI itself.
import type {
  Options,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentHost } from "../../agent-host.ts";
import type { SessionFilesPrepare } from "../../engine-session-store.ts";
import { hostForEnv } from "../../member-hosts.ts";

export function spawnClaudeThroughHost(
  host: AgentHost,
  { command, args, cwd, env, signal }: SpawnOptions,
  isolate = false,
  // A resume through a runner host: the runner's step before the CLI starts
  // (server/engine-session-store.ts prepareResume).
  prepare?: SessionFilesPrepare,
): SpawnedProcess {
  // The SDK reads no stderr from a custom spawn.
  const child = host.spawnChild([command, ...args], {
    cwd,
    env,
    stderr: "ignore",
    ...(isolate ? { isolate: true } : {}),
    ...(prepare && host.kind === "runner" ? { prepare } : {}),
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

// isolate: the CLI runs in its own PID namespace (server/process-isolation.ts).
// Only the agent session call sites ask for it.
export function withAgentSpawn(
  options: Options,
  {
    isolate = false,
    prepare,
  }: { isolate?: boolean; prepare?: SessionFilesPrepare } = {},
): Options {
  // An isolated member's env names its member: the CLI starts on that
  // member's host, which refuses any env not built for them.
  const host = hostForEnv(options.env);
  if (host.kind !== "runner" && !isolate) return options;
  return {
    ...options,
    // The host's own CLI: a member host runs the member runtime's copy.
    pathToClaudeCodeExecutable: host.claudeBin(),
    env: options.env ?? host.baseEnv(),
    spawnClaudeCodeProcess: (spawn) =>
      spawnClaudeThroughHost(host, spawn, isolate, prepare),
  };
}
