// The folder rules of the folder and web stops (task e77304b1). An agent at
// those stops keeps its files in its own folder, and its file tools reach
// nothing outside it. The folder must therefore hold no office state, no
// provider home and no other agent's, schedule's or app's folder, and no
// other agent, schedule or app may work inside it. The one exception: agents
// below Standard of one room share that room's folder (task 329974fe). Under
// a member's permission pack, a folder agent's folder is its room's folder.
// No agent, schedule or app at any stop works inside the office state.

import { realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";
import {
  belowStandard,
  stopHasFolder,
  type AgentAccess,
} from "../shared/agent-access.ts";

export interface FolderRuleAgent {
  id: string;
  name: string;
  cwd: string;
  roomId: string;
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
  // The resolved folder of room `roomId`, or null when it has none.
  roomCwd: (roomId: string) => string | null;
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

// Whether two agents below Standard of room `roomId` may share `dir`: it is
// that room's folder, and `other` works there in the same room. A session
// below Standard loads nothing from its folder (no settings, instructions,
// skills or MCP servers on any engine), so what one plants there does not
// reach the other.
function sharesRoomFolder(
  dir: string,
  roomId: string,
  other: FolderRuleAgent,
  state: Pick<FolderRuleState, "roomCwd">,
): boolean {
  if (other.roomId !== roomId || !belowStandard(other.access ?? "standard"))
    return false;
  const room = state.roomCwd(roomId);
  return room !== null && dir === real(room) && real(other.cwd) === dir;
}

// The agents below Standard of room `roomId` that work at its folder: the
// ones that share it.
export function roomFolderSharers<A extends FolderRuleAgent>(
  roomId: string,
  state: { agents: A[]; roomCwd: FolderRuleState["roomCwd"] },
): A[] {
  const room = state.roomCwd(roomId);
  if (room === null) return [];
  const dir = real(room);
  return state.agents.filter(
    (a) =>
      a.roomId === roomId &&
      belowStandard(a.access ?? "standard") &&
      real(a.cwd) === dir,
  );
}

// The refusal for agent `agent` to keep `folder` at the folder or web stop,
// else null. With `roomFolderOnly` (its manager is a member with a
// permission pack), the folder is its room's folder itself, by the path as
// written and by where it points.
export function confinedFolderRefusal(
  agent: Pick<FolderRuleAgent, "id" | "name" | "roomId">,
  folder: string,
  state: FolderRuleState,
  opts: { roomFolderOnly: boolean } = { roomFolderOnly: false },
): string | null {
  const dir = real(folder);
  // The home folder first: it usually holds the office state too, and the
  // home folder is what the member picked.
  if (dir === real(state.home))
    return `The folder of ${agent.name} may not be the home folder.`;
  if (overlaps(dir, real(state.stateRoot)))
    return `The folder of ${agent.name} may not hold the office state or sit inside it.`;
  if (state.providerHomes.some((home) => overlaps(dir, real(home))))
    return `The folder of ${agent.name} may not hold a Claude, Codex or OpenCode home or sit inside one.`;
  if (opts.roomFolderOnly) {
    const room = state.roomCwd(agent.roomId);
    if (room === null)
      return `The room of ${agent.name} has no folder, so it cannot work at Folder or Web.`;
    if (resolve(folder) !== resolve(room) || dir !== real(room))
      return `The folder of ${agent.name} must be the folder of its room.`;
  }
  const other = state.agents.find(
    (a) =>
      a.id !== agent.id &&
      overlaps(dir, real(a.cwd)) &&
      !sharesRoomFolder(dir, agent.roomId, a, state),
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

// The refusal for an agent (`self`, at its stop), a schedule or an app (null)
// to work in `cwd` when it overlaps the folder of an agent at the folder or
// web stop, else null. An agent below Standard may share its room's folder
// with such an agent of its room.
export function folderOverlapRefusal(
  cwd: string,
  self:
    (Pick<FolderRuleAgent, "id" | "roomId"> & { access: AgentAccess }) | null,
  state: Pick<FolderRuleState, "agents" | "roomCwd">,
): string | null {
  const dir = real(cwd);
  const owner = state.agents.find(
    (a) =>
      a.id !== self?.id &&
      a.access !== undefined &&
      stopHasFolder(a.access) &&
      overlaps(dir, real(a.cwd)) &&
      !(
        self &&
        belowStandard(self.access) &&
        sharesRoomFolder(dir, self.roomId, a, state)
      ),
  );
  return owner
    ? `This folder overlaps the folder of ${owner.name}, an agent below Standard that keeps its files there.`
    : null;
}

// The refusal for an agent, a schedule or an app to work in `cwd` when it
// sits inside the office state, else null. Holding the state (home) is
// allowed.
export function stateFolderRefusal(
  cwd: string,
  stateRoot: string,
): string | null {
  return inside(real(cwd), real(stateRoot))
    ? "This folder is inside the office state, where no agent, schedule or app may work."
    : null;
}
