// Where the office starts agent-side work (internal-docs/os-user-split-design.md,
// sections 1 and 2.3). LocalAgentHost is the single-user code path: it spawns
// in this process, as this process's user. In split mode the server installs a
// RunnerAgentHost (server/agent-runner/client.ts), which asks the agent runner
// to do the same work as the agent user.

import { homedir, userInfo } from "os";
import {
  runIsomuxDiff,
  type IsomuxDiffRequest,
  type IsomuxDiffRunResult,
} from "./isomux-diff.ts";
import { resolveRealNode } from "./real-node.ts";

// The part of a child process that callers use. A Bun Subprocess satisfies it.
export interface AgentProcess {
  readonly pid: number | undefined;
  readonly stdin: {
    write(data: string | Uint8Array): unknown;
    end(): unknown;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export interface AgentHost {
  readonly kind: "local" | "runner";
  // The environment that agent processes start from: the agent user's own.
  baseEnv(): Record<string, string | undefined>;
  home(): string;
  username(): string;
  // A real Node.js binary that the agent user can run, or null.
  realNodePath(): string | null;
  // Start argv with piped stdin and stdout; stderr goes to the office log.
  spawnPipe(argv: string[]): AgentProcess;
  isomuxDiff(req: IsomuxDiffRequest): Promise<IsomuxDiffRunResult>;
}

export const localAgentHost: AgentHost = {
  kind: "local",
  baseEnv: () => process.env,
  home: () => homedir(),
  username: () => userInfo().username,
  realNodePath: () => resolveRealNode(),
  spawnPipe: (argv) =>
    Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit" }),
  isomuxDiff: async (req) => {
    try {
      return runIsomuxDiff(req);
    } catch (error) {
      return {
        kind: "git_error",
        cwd: req.dir ?? req.agentCwd,
        message: (error as Error).message,
      };
    }
  },
};

let current: AgentHost = localAgentHost;

export function getAgentHost(): AgentHost {
  return current;
}

// Called once at boot by the split-mode start (server/split/start.ts), and by
// tests that restore the default afterwards.
export function setAgentHost(host: AgentHost): void {
  current = host;
}
