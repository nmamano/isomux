// The limits on a schedule an ordinary agent made (task c4233bfd): the job may
// not reach more than the agent itself, in permission mode or in folder. The
// cron handlers check it on the agent's writes and triggers, and the cronjob
// manager at every run start of such a job. The room is visibility only, so
// the handlers check it apart, and only where a request sets it.

import { realpathSync } from "fs";
import { sep } from "path";
import {
  CODEX_DEFAULT_SANDBOX,
  type AgentInfo,
  runsInFolder,
  type CodexSandboxMode,
  type Cronjob,
} from "../shared/types.ts";
import { resolveCwd } from "./cwd-utils.ts";
import { memberFolderHost, resolveAgentCwd } from "./agent-folder.ts";
import { sameAgentHost } from "./member-os-users.ts";
import { belowStandard } from "../shared/agent-access.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";

export type ScheduleLimitJob = Pick<
  Cronjob,
  "agentType" | "codexSandbox" | "cwd" | "target"
> &
  Partial<Pick<Cronjob, "command">>;

export type ScheduleLimitAgent = Pick<
  AgentInfo,
  "agentType" | "permissionMode" | "codexSandbox" | "cwd" | "access"
>;

// The API error code of a refusal.
export const SCHEDULE_EXCEEDS_AGENT = "schedule_exceeds_agent";

export const SCHEDULE_ROOM_REFUSAL =
  "A schedule you make must be in your own room or in no room.";

// How much a run reaches without asking: 3 full access, 2 writes in its
// folder, 1 reads only, 0 asks or is gated, so it cannot run unattended.
type Reach = 0 | 1 | 2 | 3;

// A missing sandbox runs as CODEX_DEFAULT_SANDBOX.
function sandboxReach(sandbox: CodexSandboxMode | undefined): Reach {
  const mode = sandbox ?? CODEX_DEFAULT_SANDBOX;
  if (mode === "danger-full-access") return 3;
  if (mode === "read-only") return 1;
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
// (validateCronjobPermissionMode); a Codex one runs in its sandbox. A command
// job runs a shell with nobody present, whatever session fields it carries.
function jobReach(job: ScheduleLimitJob): Reach {
  if (job.command !== undefined) return 3;
  return job.agentType === "codex" ? sandboxReach(job.codexSandbox) : 3;
}

// Whether the agent may make any schedule: a privileged agent always, an
// ordinary one when its mode runs without approvals. Decides the schedule
// line of the system prompt.
// An agent below Standard makes none: it has no tool for it.
export function agentMakesSchedules(
  agent: AgentMode & Pick<AgentInfo, "privileged" | "access">,
): boolean {
  if (agent.access && belowStandard(agent.access)) return false;
  return agent.privileged === true || agentReach(agent) > 0;
}

export type ScheduleLimitBreach = "access" | "mode" | "folder";

// The breach found before the folder, or "check folder" when only the folder
// is left to compare.
function breachBeforeFolder(
  job: ScheduleLimitJob,
  agent: ScheduleLimitAgent,
): ScheduleLimitBreach | null | "check folder" {
  // A job runs as its own run, with a shell: an agent below Standard reaches
  // less than any job.
  if (agent.access && belowStandard(agent.access)) return "access";
  // A job that only messages an agent runs nothing: its mode and folder are
  // never used.
  if (!runsInFolder(job)) return null;
  if (jobReach(job) > agentReach(agent)) return "mode";
  return "check folder";
}

// Where the job reaches more than the agent, else null. For an agent that
// runs as the office user: scheduleLimitBreachFor picks the host.
export function scheduleLimitBreach(
  job: ScheduleLimitJob,
  agent: ScheduleLimitAgent,
  realpath: (path: string) => string = realpathSync,
): ScheduleLimitBreach | null {
  const before = breachBeforeFolder(job, agent);
  if (before !== "check folder") return before;
  return folderInside(job.cwd, agent.cwd, realpath) ? null : "folder";
}

// scheduleLimitBreach on the host of the agent's manager (`agentUserId`):
// an isolated member's folders resolve as the member, through their runner.
// A job owned on another host than the agent's is refused ("folder"): the
// two cannot share a folder (member-os-user-design.md 2.4).
export async function scheduleLimitBreachFor(
  job: ScheduleLimitJob,
  agent: ScheduleLimitAgent,
  jobUserId: string | null,
  agentUserId: string | null,
): Promise<ScheduleLimitBreach | null> {
  const before = breachBeforeFolder(job, agent);
  if (before !== "check folder") return before;
  if (!sameAgentHost(jobUserId, agentUserId)) {
    console.error(
      `[schedule-limits] a job of ${jobUserId ?? "no member"} and an agent of ${agentUserId ?? "no member"} run as different OS users; refused`,
    );
    return "folder";
  }
  return (await folderInsideFor(job.cwd, agent.cwd, agentUserId))
    ? null
    : "folder";
}

// Whether `dir` is `agentDir` or inside it; both already resolved.
export function insideResolved(dir: string, agentDir: string): boolean {
  return (
    dir === agentDir ||
    dir.startsWith(agentDir.endsWith(sep) ? agentDir : agentDir + sep)
  );
}

// Whether `cwd` is the agent's folder or a folder inside it. `realpath`
// resolves both, so a symlink that points out is outside; a folder that does
// not exist is outside too. Also the spawn limit (server/spawn-agent-limits.ts).
export function folderInside(
  cwd: string,
  agentCwd: string,
  realpath: (path: string) => string = realpathSync,
): boolean {
  let dir: string;
  let agentDir: string;
  try {
    dir = realpath(resolveCwd(cwd));
    agentDir = realpath(resolveCwd(agentCwd));
  } catch {
    return false;
  }
  return insideResolved(dir, agentDir);
}

// folderInside on the host of `userId`: for an isolated member, `~` is their
// home and both paths resolve through their runner, as the member. A host
// that is not ready or a runner error is outside, never the office's
// realpath.
export async function folderInsideFor(
  cwd: string,
  agentCwd: string,
  userId: string | null,
): Promise<boolean> {
  const host = memberFolderHost(userId);
  if (!host) return folderInside(cwd, agentCwd);
  try {
    const dir = await host.fs.realpath(resolveAgentCwd(cwd, userId));
    const agentDir = await host.fs.realpath(resolveAgentCwd(agentCwd, userId));
    return insideResolved(dir, agentDir);
  } catch {
    return false;
  }
}

// The refusal reason for the agent that asks, else null.
export function scheduleExceedsAgent(
  job: ScheduleLimitJob,
  agent: ScheduleLimitAgent,
  realpath: (path: string) => string = realpathSync,
): string | null {
  return scheduleExceedsText(scheduleLimitBreach(job, agent, realpath), job);
}

// scheduleExceedsAgent on the host of the agent's manager
// (scheduleLimitBreachFor).
export async function scheduleExceedsAgentFor(
  job: ScheduleLimitJob,
  agent: ScheduleLimitAgent,
  jobUserId: string | null,
  agentUserId: string | null,
): Promise<string | null> {
  return scheduleExceedsText(
    await scheduleLimitBreachFor(job, agent, jobUserId, agentUserId),
    job,
  );
}

function scheduleExceedsText(
  breach: ScheduleLimitBreach | null,
  job: ScheduleLimitJob,
): string | null {
  if (breach === "access")
    return "An agent below Standard cannot make or run a schedule.";
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
  breach: "access" | "mode" | "folder",
  maker: Pick<AgentInfo, "name" | "agentType">,
  job: ScheduleLimitJob,
): LogMessage {
  const agent = maker.name;
  if (breach === "access")
    return msg("systemEntries.scheduleRun.limit.access", { agent });
  if (breach === "folder")
    return msg("systemEntries.scheduleRun.limit.folder", { agent });
  // One key per remedy, so no translated mode name goes into a sentence.
  if (maker.agentType !== "codex")
    return msg("systemEntries.scheduleRun.limit.modeBypass", { agent });
  return job.agentType === "codex"
    ? msg("systemEntries.scheduleRun.limit.modeCodexSandbox", { agent })
    : msg("systemEntries.scheduleRun.limit.modeCodexFull", { agent });
}
