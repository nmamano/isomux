// The folder of an agent whose manager has their own OS user
// (internal-docs/member-os-user-design.md, section 3.3). Such a folder is the
// member's: `~` and a relative path resolve against the member's home, and
// the folder is checked through the member's host, never with a stat of the
// office's file system. Every other agent's folder is resolved and checked
// with the office's resolveCwd and cwdProblem, unchanged.
//
// The owner is always the agent's manager (the new agent's manager at a
// spawn), never the caller. memberFolderHost is the one test of "an isolated
// member": every site below uses it, never a test of its own.
//
// Sites that resolve or check an agent's folder, after a grep of resolveCwd(,
// cwdProblem(, validateCwd( and homedir() under server/ (part 2b-ii); every
// hit is in one row.
//   A: uses this module, or skips the office stat for a member:
//   - office-agents-routes.ts spawn (validate; the state-folder, home and
//     overlap compares) and edit (folder rules compare, validate).
//   - agent-manager.ts spawn (the stored cwd, the lazy check), editAgent
//     (the stored cwd), revive (the home fallback and both checks).
//   - routes/handlers/agents.ts pack spawn and pack edit compares.
//   - routes/handlers/rooms.ts room folder: the office check, then each
//     isolated manager of an agent in the room through their host
//     (isomux-office.ts memberCwdProblem).
//   - routes/handlers/validate.ts validate.cwd (the caller's host), and
//     isomux-office.ts listBackendModels, which office-onboarding.ts
//     resolveCodexDefaultModel uses.
//   - office-persistence.ts killedAgentCeilingRecord: the home fallback.
//   - skip, relying on the folder check after a failed turn
//     (member-folder-hint.ts, agent-manager.ts checkMemberFolder):
//     agent-manager.ts createSession and applySessionCwdForResume, and
//     cwd-utils.ts diagnoseProcessExit.
//   B: office scope by design:
//   - office-access-policy.ts folder rules (home, roomCwd,
//     roomCwdChangeRefusal) and agent-folder-rules.ts's home: they compare
//     stored paths, and a member's agent folder is absolute from its spawn
//     on. A room folder `~` is the office's home there, a different folder
//     from a member's home.
//   - isomux-diff.ts resolveDiffCwd: it runs on the agent's host (the diff
//     runner entry for a member), so its homedir() is the member's home.
//   - homedir() for the office's own files: cwd-utils.ts, config.ts,
//     skills.ts and provider-skill-links.ts defaults,
//     provider-account-manager.ts, claude-install-check.ts, agent-host.ts
//     (the office host), member-hosts.ts (the trusted checks), agent-skills.ts
//     memberSkillFolderFor (null for a member host), isomux-office.ts office
//     move, and agent-runner/runner.ts (the runner's own home, the member's
//     for a member runner).
//   C: later slices:
//   - slice 3 (schedules): routes/handlers/cron.ts validateCwd (create,
//     edit), cronjob-manager.ts resolveCwd (create, edit) and cwdProblem
//     (fire, run start, run resume), cron-agent-fire.ts cwdProblem,
//     cron-agent-limits.ts realpath(resolveCwd), office-managers.ts
//     stateFolderRefusal(resolveCwd(job.cwd)), isomux-office.ts cron
//     validateCwd dep and folderRefusal.
//   - slice 3 (apps and units): routes/handlers/apps.ts validateCwd
//     (register, edit), app-registry.ts cwd check, isomux-office.ts app
//     stateFolderRefusal, the apps validateCwd dep and the agent units' home,
//     app-supervisor.ts.
//   - 2d (skills, the share and the hooks): skill-catalog.ts project folders
//     and isomux-office.ts skill catalog home, discoverPluginSkills and
//     discoverUserSkills at a member's spawn and restore, resolveSkillPrompt's
//     user roots, safety-policy.ts's homedir() fallbacks, and the OpenCode
//     safety roots (backends/opencode/supervisor.ts, config-layers.ts).
//   - 2c (reach): isomux-office.ts sudo home and sudo-runner.ts.
import { homedir } from "os";
import { isAbsolute, resolve } from "path";
import type { AgentFileStat, AgentHost } from "./agent-host.ts";
import {
  cwdProblem,
  resolveCwd,
  validateCwd,
  type CwdProblem,
} from "./cwd-utils.ts";
import { errCode, errMessage } from "../shared/errors.ts";
import { hostFor, NOT_READY_PATH } from "./member-hosts.ts";

// The host of `userId` when they have their own OS user (ready, moving or
// not ready), else null: the office's host, local or split.
export function memberFolderHost(
  userId: string | null | undefined,
): AgentHost | null {
  const host = hostFor(userId);
  return host.member !== undefined ? host : null;
}

// `cwd` as an absolute path for an agent managed by `userId`. A member's `~`
// and relative paths resolve against their home. Throws when such a path
// needs the home of a member whose host is not ready: it has none.
export function resolveAgentCwd(
  cwd: string,
  userId: string | null | undefined,
): string {
  const host = memberFolderHost(userId);
  if (!host) return resolveCwd(cwd);
  if (isAbsolute(cwd)) return resolve(cwd);
  const home = host.home();
  if (home === NOT_READY_PATH)
    throw new Error(
      `${cwd} cannot be used until the member's OS user is ready`,
    );
  if (cwd === "~") return home;
  if (cwd.startsWith("~/")) return resolve(home, cwd.slice(2));
  return resolve(home, cwd);
}

// The home an agent managed by `userId` falls back to. Throws as
// resolveAgentCwd does.
export function agentHome(userId: string | null | undefined): string {
  return memberFolderHost(userId) ? resolveAgentCwd("~", userId) : homedir();
}

// Why the folder cannot be used, or null. A member's folder is checked
// through their host; a host that is not ready gives "inaccessible".
export async function agentCwdProblem(
  cwd: string,
  userId: string | null | undefined,
): Promise<CwdProblem | null> {
  const host = memberFolderHost(userId);
  if (!host) return cwdProblem(cwd);
  let path: string;
  try {
    path = resolveAgentCwd(cwd, userId);
  } catch (err) {
    return { kind: "inaccessible", path: cwd, message: errMessage(err) };
  }
  try {
    const stat = await statMemberFolder(host, path);
    return stat.type === "dir" ? null : { kind: "not_directory", path };
  } catch (err) {
    if (errCode(err) === "ENOENT") return { kind: "missing", path };
    if (errCode(err) === "ENOTDIR") return { kind: "not_directory", path };
    return { kind: "inaccessible", path, message: errMessage(err) };
  }
}

// A member's folder through the member's host: the stat, then for a folder
// the enter. A stat needs search access to the parent only, so a folder of
// another user with mode 700 stats fine. Rejects with the errno of the first
// that fails.
export async function statMemberFolder(
  host: AgentHost,
  path: string,
): Promise<AgentFileStat> {
  const stat = await host.fs.stat(path);
  if (stat.type === "dir") await host.fs.enter(path);
  return stat;
}

// The folder `cwd` of `userId`'s agent or job with its links resolved, for
// the folder rules (agent-folder-rules.ts), which compare paths. The office:
// resolveCwd, and the rules resolve links themselves. An isolated member:
// resolved through their runner, as the member, since the office cannot
// resolve a link inside their home; when the runner cannot, the path as
// written (resolveAgentCwd), never the office's realpath.
export async function folderForRules(
  cwd: string,
  userId: string | null | undefined,
): Promise<string> {
  const host = memberFolderHost(userId);
  if (!host) return resolveCwd(cwd);
  const path = resolveAgentCwd(cwd, userId);
  try {
    return await host.fs.realpath(path);
  } catch {
    return path;
  }
}

// validateCwd for an agent managed by `userId`: the resolved folder, or a
// throw with the same English as validateCwd.
export async function validateAgentCwd(
  cwd: string,
  userId: string | null | undefined,
): Promise<string> {
  if (!memberFolderHost(userId)) return validateCwd(cwd);
  const problem = await agentCwdProblem(cwd, userId);
  if (!problem) return resolveAgentCwd(cwd, userId);
  throw new Error(cwdProblemSentence(problem));
}

// The English of validateCwd for a problem.
export function cwdProblemSentence(problem: CwdProblem): string {
  switch (problem.kind) {
    case "missing":
      return `Directory does not exist: ${problem.path}`;
    case "inaccessible":
      return `Cannot access ${problem.path}: ${problem.message}`;
    case "not_directory":
      return `Not a directory: ${problem.path}`;
  }
}

// The commands that give `osUser` read access to `dir` (section 3.2): an
// access and a default ACL on the folder, and x on each ancestor from / down
// to its parent, / excluded. Paths are shell-quoted when they need it.
export function readShareCommands(osUser: string, dir: string): string[] {
  const ancestors: string[] = [];
  for (let at = resolve(dir, ".."); at !== "/"; at = resolve(at, ".."))
    ancestors.unshift(at);
  const commands = [
    `setfacl -R -m u:${osUser}:rX,d:u:${osUser}:rX ${shellWord(dir)}`,
  ];
  if (ancestors.length > 0)
    commands.push(
      `setfacl -m u:${osUser}:x ${ancestors.map(shellWord).join(" ")}`,
    );
  return commands;
}

function shellWord(path: string): string {
  return /^[A-Za-z0-9_./+:@%-]+$/.test(path)
    ? path
    : `'${path.replace(/'/g, `'\\''`)}'`;
}
