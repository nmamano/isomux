// The office's process isolation state (server/process-isolation.ts): the
// probe result, the owner's switch, and the one decision per session start
// that both its spawn and its system prompt line follow. Boot runs the probe
// before it resumes agents; a wrapped spawn whose bwrap setup fails runs it
// again.

import { belowStandard, type AgentAccess } from "../shared/agent-access.ts";
import {
  CODEX_DEFAULT_SANDBOX,
  type AgentBackendType,
} from "../shared/types.ts";
import { getAgentHost } from "./agent-host.ts";
import {
  probeProcessIsolation,
  processIsolationStatus,
  type IsolationForm,
  type ProcessIsolationProbe,
  type ProcessIsolationProbeDeps,
  type ProcessIsolationStatus,
} from "./process-isolation.ts";

let probe: ProcessIsolationProbe | null = null;
let readSwitch: () => boolean = () => true;
let probeDeps: () => ProcessIsolationProbeDeps = () => {
  const host = getAgentHost();
  return {
    platform: process.platform,
    env: host.baseEnv(),
    run: (argv, options) => host.run(argv, options),
  };
};
let reprobe: Promise<ProcessIsolationStatus> | null = null;

// Tests set the result; they never run the probe through this module.
export function setProcessIsolationProbe(
  result: ProcessIsolationProbe | null,
): void {
  probe = result;
}

// The owner's switch (office settings), read at each decision.
export function setProcessIsolationSwitch(read: () => boolean): void {
  readSwitch = read;
}

// How the probe reaches the agent host. Default: the current agent host.
export function setProcessIsolationProbeDeps(
  deps: () => ProcessIsolationProbeDeps,
): void {
  probeDeps = deps;
}

export function processIsolationNow(): ProcessIsolationStatus {
  return processIsolationStatus(probe, readSwitch());
}

// Runs the probe and stores its result. Boot awaits it before it resumes
// agents. Never rejects: a probe that cannot run leaves isolation off.
export async function runProcessIsolationProbe(): Promise<ProcessIsolationStatus> {
  let result: ProcessIsolationProbe;
  try {
    result = await probeProcessIsolation(probeDeps());
  } catch (error) {
    result = { available: false, reason: "denied", detail: String(error) };
  }
  if (!result.available)
    console.warn(
      `[process-isolation] off (${result.reason}): ${result.detail}`,
    );
  setProcessIsolationProbe(result);
  return processIsolationNow();
}

// A wrapped spawn failed its bwrap setup (ISOLATION_SETUP_FAILED): probe
// again, once for every failure in flight. The next spawn follows the new
// result.
export function reportIsolationSetupFailure(): Promise<ProcessIsolationStatus> {
  reprobe ??= runProcessIsolationProbe().finally(() => {
    reprobe = null;
  });
  return reprobe;
}

// The form a session starting now runs in, or null when it is not wrapped:
// Claude "session"; Codex "session" only at danger-full-access (its own
// sandbox already gives each command a PID namespace); OpenCode
// "shared_server". Null whenever the status is off. Codex's container
// fallback to full access (sandbox-probe.ts) is not read here: it happens
// only where bwrap is denied, and there the status is off.
export function sessionIsolationForm(input: {
  agentType: AgentBackendType;
  // Codex: the agent's stored sandbox mode.
  codexSandbox?: string;
  access?: AgentAccess;
}): IsolationForm | null {
  if (processIsolationNow().state !== "on") return null;
  if (input.agentType === "opencode") return "shared_server";
  if (input.agentType === "claude") return "session";
  // Below standard a Codex thread is read-only whatever its stored mode.
  if (input.access !== undefined && belowStandard(input.access)) return null;
  return (input.codexSandbox ?? CODEX_DEFAULT_SANDBOX) === "danger-full-access"
    ? "session"
    : null;
}
