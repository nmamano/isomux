// The limits on a schedule an ordinary agent made (task c4233bfd): the job may
// not reach more than the agent itself, in permission mode or in folder. The
// cron handlers check it on the agent's writes and triggers, and the cronjob
// manager at every run start of such a job. The room is visibility only, so
// the handlers check it apart, and only where a request sets it.

import { realpathSync } from "fs";
import { sep } from "path";
import type { AgentInfo, CodexSandboxMode, Cronjob } from "../shared/types.ts";
import { resolveCwd } from "./cwd-utils.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";

export type ScheduleLimitJob = Pick<
  Cronjob,
  "agentType" | "codexSandbox" | "cwd"
>;

export type ScheduleLimitAgent = Pick<
  AgentInfo,
  "agentType" | "permissionMode" | "codexSandbox" | "cwd"
>;

// The API error code of a refusal.
export const SCHEDULE_EXCEEDS_AGENT = "schedule_exceeds_agent";

export const SCHEDULE_ROOM_REFUSAL =
  "A schedule you make must be in your own room or in no room.";

// How much a run reaches without asking: 3 full access, 2 writes in its
// folder, 1 reads only, 0 asks or is gated, so it cannot run unattended.
type Reach = 0 | 1 | 2 | 3;

// A missing sandbox is the Codex adapter's workspace-write default.
function sandboxReach(sandbox: CodexSandboxMode | undefined): Reach {
  if (sandbox === "danger-full-access") return 3;
  if (sandbox === "read-only") return 1;
  return 2;
}

type AgentMode = Pick<
  AgentInfo,
  "agentType" | "permissionMode" | "codexSandbox"
>;

function agentReach(agent: AgentMode): Reach {
  if (agent.agentType === "codex")
    return agent.permissionMode === "never"
      ? sandboxReach(agent.codexSandbox)
      : 0;
  // Claude "auto" still has a classifier that stops risky actions, and a
  // Claude schedule always runs with bypassPermissions.
  return agent.permissionMode === "bypassPermissions" ? 3 : 0;
}

// A Claude or OpenCode schedule always runs with bypassPermissions
// (validateCronjobPermissionMode); a Codex one runs in its sandbox.
function jobReach(job: ScheduleLimitJob): Reach {
  return job.agentType === "codex" ? sandboxReach(job.codexSandbox) : 3;
}

// Whether the agent may make any schedule: a privileged agent always, an
// ordinary one when its mode runs without approvals. Decides the schedule
// line of the system prompt.
export function agentMakesSchedules(
  agent: AgentMode & { privileged?: boolean },
): boolean {
  return agent.privileged === true || agentReach(agent) > 0;
}

// Where the job reaches more than the agent, else null. `realpath` resolves
// both folders, so a symlink that points out is refused; a folder that does
// not exist is refused too.
export function scheduleLimitBreach(
  job: ScheduleLimitJob,
  agent: ScheduleLimitAgent,
  realpath: (path: string) => string = realpathSync,
): "mode" | "folder" | null {
  if (jobReach(job) > agentReach(agent)) return "mode";
  let jobDir: string;
  let agentDir: string;
  try {
    jobDir = realpath(resolveCwd(job.cwd));
    agentDir = realpath(resolveCwd(agent.cwd));
  } catch {
    return "folder";
  }
  const inside =
    jobDir === agentDir ||
    jobDir.startsWith(agentDir.endsWith(sep) ? agentDir : agentDir + sep);
  return inside ? null : "folder";
}

// The refusal reason for the agent that asks, else null.
export function scheduleExceedsAgent(
  job: ScheduleLimitJob,
  agent: ScheduleLimitAgent,
  realpath: (path: string) => string = realpathSync,
): string | null {
  const breach = scheduleLimitBreach(job, agent, realpath);
  if (breach === "mode")
    return job.agentType === "codex"
      ? "A schedule runs with nobody present, so a Codex schedule has no approvals in its sandbox. Only an agent with that access can make one or run one it made: Codex in never with the same sandbox or a wider one, or bypassPermissions. Ask the member to create it on the Schedules tab of the Automations page, or to give you that mode."
      : "A schedule runs with nobody present, so a Claude or OpenCode schedule has full permissions. Only an agent with full permissions can make one or run one it made: bypassPermissions, or Codex in never with danger-full-access. Ask the member to create it on the Schedules tab of the Automations page, or to give you that mode.";
  if (breach === "folder")
    return "A schedule you make must run in your working folder or a folder inside it.";
  return null;
}

// The reason a run start was refused, for the member who reads the run.
export function scheduleRunRefusal(
  breach: "mode" | "folder",
  maker: Pick<AgentInfo, "name" | "agentType">,
  job: ScheduleLimitJob,
): LogMessage {
  const agent = maker.name;
  if (breach === "folder")
    return msg("systemEntries.scheduleRun.limit.folder", { agent });
  // One key per remedy, so no translated mode name goes into a sentence.
  if (maker.agentType !== "codex")
    return msg("systemEntries.scheduleRun.limit.modeBypass", { agent });
  return job.agentType === "codex"
    ? msg("systemEntries.scheduleRun.limit.modeCodexSandbox", { agent })
    : msg("systemEntries.scheduleRun.limit.modeCodexFull", { agent });
}
