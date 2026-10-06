// Split-mode start (internal-docs/os-user-split-design.md, sections 2.4 and
// 8). When ISOMUX_AGENT_RUNNER names the runner's socket, the server makes the
// trusted checks, connects to the runner, logs the runner diagnostic and
// installs a RunnerAgentHost. Any failure stops the start: the server never
// falls back to single-user mode. Until the last slice of task 01f5038c, split
// mode also needs ISOMUX_SPLIT_RIG=1 (the test rig only).

import { spawnSync } from "child_process";
import { readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { RunnerAgentHost } from "../agent-runner/client.ts";
import {
  runTrustedChecks,
  type AgentIdentity,
  type CheckFailure,
} from "./trusted-checks.ts";

// STATE_ROOT/split.json, written by the migration (design section 3.1).
export interface SplitConfig {
  agentUser: string;
  agentUid: number;
  agentRoot: string;
  agentRootWasDefault: boolean;
  shareRoot: string;
}

export const CODE_ROOT = resolve(import.meta.dir, "..", "..");
// Depth of the code walk at start; `bun server/split/check.ts` walks it all.
export const START_CODE_DEPTH = 2;

export function readSplitConfig(stateRoot: string): SplitConfig {
  const raw = JSON.parse(
    readFileSync(join(stateRoot, "split.json"), "utf8"),
  ) as Partial<SplitConfig>;
  if (
    typeof raw.agentUser !== "string" ||
    !raw.agentUser ||
    typeof raw.agentUid !== "number" ||
    !Number.isSafeInteger(raw.agentUid) ||
    typeof raw.agentRoot !== "string" ||
    typeof raw.agentRootWasDefault !== "boolean" ||
    typeof raw.shareRoot !== "string" ||
    !raw.shareRoot.startsWith("/")
  )
    throw new Error("split.json is incomplete");
  return raw as SplitConfig;
}

// The agent user's uid, primary group and groups, from the system's user
// database (`id`), never from the runner.
export function readAgentIdentity(user: string): AgentIdentity {
  const id = (flag: string): number[] => {
    const result = spawnSync("id", [flag, "--", user], { encoding: "utf8" });
    const text = result.status === 0 ? result.stdout.trim() : "";
    if (!/^\d+( \d+)*$/.test(text))
      throw new Error(`cannot look up the user ${user}`);
    return text.split(" ").map(Number);
  };
  return { uid: id("-u")[0], gid: id("-g")[0], groups: id("-G") };
}

export interface SplitCheckSetup {
  config: SplitConfig;
  agent: AgentIdentity;
}

// The trusted checks for this server process. codeDepth is START_CODE_DEPTH
// at start and Infinity for the full check.
export function checkSplit(
  stateRoot: string,
  codeDepth: number,
): { setup: SplitCheckSetup | null; failures: CheckFailure[] } {
  let config: SplitConfig;
  let agent: AgentIdentity;
  try {
    config = readSplitConfig(stateRoot);
    agent = readAgentIdentity(config.agentUser);
  } catch (error) {
    return {
      setup: null,
      failures: [{ check: "agent-user", detail: (error as Error).message }],
    };
  }
  if (agent.uid !== config.agentUid)
    return {
      setup: null,
      failures: [
        {
          check: "agent-user",
          detail: `split.json names uid ${config.agentUid}, but ${config.agentUser} is uid ${agent.uid}`,
        },
      ],
    };
  const failures = runTrustedChecks({
    serverUid: process.getuid!(),
    serverGid: process.getgid!(),
    agent,
    stateRoot,
    shareRoot: config.shareRoot,
    codeRoot: realpathSync(CODE_ROOT),
    codeDepth,
  });
  return { setup: { config, agent }, failures };
}

export function describeFailure(failure: CheckFailure): string {
  return `${failure.check}${failure.path ? ` at ${failure.path}` : ""}: ${failure.detail}`;
}

const DIAGNOSTIC_TRIES = [
  "readState",
  "writeCode",
  "renameCode",
  "createInShare",
] as const;

// The runner diagnostic: log only. It never turns a failed check into a pass
// and never stops a start that the checks allowed.
export async function logRunnerDiagnostic(
  host: RunnerAgentHost,
  stateRoot: string,
  shareRoot: string,
): Promise<void> {
  let result: Record<string, unknown> = {};
  try {
    result = ((await host.runEntry("diagnose", {
      stateFile: join(stateRoot, "users.json"),
      codeFile: join(CODE_ROOT, "package.json"),
      shareRoot,
    })) ?? {}) as Record<string, unknown>;
  } catch (error) {
    console.error(
      `[split] runner diagnostic not proven: ${(error as Error).message}`,
    );
    return;
  }
  for (const name of DIAGNOSTIC_TRIES) {
    const answer = result[name];
    const code = typeof answer === "string" ? answer : "no answer";
    const proven = code === "EACCES" || code === "EPERM";
    const line = `[split] runner diagnostic ${name}: ${proven ? "proven" : "not proven"} (${code})`;
    if (proven) console.log(line);
    else console.error(line);
  }
}

export type SplitStart =
  | { mode: "single" }
  | { mode: "split"; host: RunnerAgentHost }
  | { mode: "refused"; reasons: string[] };

export async function startSplitMode(
  env: NodeJS.ProcessEnv,
  stateRoot: string,
): Promise<SplitStart> {
  const socketPath = env.ISOMUX_AGENT_RUNNER?.trim();
  if (!socketPath) return { mode: "single" };
  if (env.ISOMUX_SPLIT_RIG !== "1")
    return {
      mode: "refused",
      reasons: [
        "ISOMUX_AGENT_RUNNER is set, but this version has no split mode",
      ],
    };
  const { setup, failures } = checkSplit(stateRoot, START_CODE_DEPTH);
  if (!setup || failures.length > 0)
    return { mode: "refused", reasons: failures.map(describeFailure) };
  let host: RunnerAgentHost;
  try {
    host = await RunnerAgentHost.connect(socketPath);
  } catch (error) {
    return {
      mode: "refused",
      reasons: [`cannot reach the agent runner: ${(error as Error).message}`],
    };
  }
  if (host.uid !== setup.agent.uid)
    return {
      mode: "refused",
      reasons: [
        `the agent runner runs as uid ${host.uid}, not the agent user's uid ${setup.agent.uid}`,
      ],
    };
  await logRunnerDiagnostic(host, stateRoot, setup.config.shareRoot);
  return { mode: "split", host };
}
