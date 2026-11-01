// The folder rules of the folder and web stops (task e77304b1). An agent at
// those stops keeps its files in its own folder, and its file tools reach
// nothing outside it. The folder must therefore hold no office state, no
// provider home and no other agent's, schedule's or app's folder, and no
// other agent, schedule or app may work inside it.

import { realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";
import { stopHasFolder, type AgentAccess } from "../shared/agent-access.ts";

export interface FolderRuleAgent {
  id: string;
  name: string;
  cwd: string;
  access?: AgentAccess;
}

// A schedule or an app: it runs in its folder with a shell.
export interface FolderRuleWorkload {
  name: string;
  cwd: string;
}

export interface FolderRuleState {
  stateRoot: string;
  home: string;
  // The Claude, Codex and OpenCode homes of the server user.
  providerHomes: string[];
  agents: FolderRuleAgent[];
  schedules: FolderRuleWorkload[];
  apps: FolderRuleWorkload[];
}

// The provider homes of an environment: the Claude config dir, the Codex
// home and the OpenCode config and data dirs.
export function providerHomesOf(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string[] {
  return [
    env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    env.CODEX_HOME || join(home, ".codex"),
    join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode"),
    join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode"),
  ];
}

// The real path, so a symlink is judged by where it points. A path that does
// not exist yet is judged as written.
function real(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function inside(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  );
}

function overlaps(a: string, b: string): boolean {
  return inside(a, b) || inside(b, a);
}

// The refusal for agent `agent` to keep `folder` at the folder or web stop,
// else null.
export function confinedFolderRefusal(
  agent: Pick<FolderRuleAgent, "id" | "name">,
  folder: string,
  state: FolderRuleState,
): string | null {
  const dir = real(folder);
  if (overlaps(dir, real(state.stateRoot)))
    return `The folder of ${agent.name} may not hold the office state or sit inside it.`;
  if (dir === real(state.home))
    return `The folder of ${agent.name} may not be the home folder.`;
  if (state.providerHomes.some((home) => overlaps(dir, real(home))))
    return `The folder of ${agent.name} may not hold a Claude, Codex or OpenCode home or sit inside one.`;
  const other = state.agents.find(
    (a) => a.id !== agent.id && overlaps(dir, real(a.cwd)),
  );
  if (other)
    return `The folder of ${agent.name} may not overlap the folder of ${other.name}.`;
  const schedule = state.schedules.find((s) => overlaps(dir, real(s.cwd)));
  if (schedule)
    return `The folder of ${agent.name} may not overlap the folder of the schedule ${schedule.name}.`;
  const app = state.apps.find((a) => overlaps(dir, real(a.cwd)));
  if (app)
    return `The folder of ${agent.name} may not overlap the folder of the app ${app.name}.`;
  return null;
}

// The refusal for an agent (`selfId`), a schedule or an app (null) to work in `cwd`
// when it overlaps the folder of an agent at the folder or web stop, else
// null.
export function folderOverlapRefusal(
  cwd: string,
  selfId: string | null,
  state: Pick<FolderRuleState, "agents">,
): string | null {
  const dir = real(cwd);
  const owner = state.agents.find(
    (a) =>
      a.id !== selfId &&
      a.access !== undefined &&
      stopHasFolder(a.access) &&
      overlaps(dir, real(a.cwd)),
  );
  return owner
    ? `This folder overlaps the folder of ${owner.name}, an agent below Standard that keeps its files there.`
    : null;
}
