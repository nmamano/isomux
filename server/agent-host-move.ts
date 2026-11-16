// A manager change between hosts (internal-docs/member-os-user-design.md
// 2.4, task abdb452b): the agent and its files move from the OS user its
// old manager's agents run as to the new manager's. office->member,
// member->office and member->member (through the office). The steps reuse
// the file moves of enable and disable (member-move.ts, member-move-out.ts)
// for this one agent's sessions and the data of the apps it made.

import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentHost } from "./agent-host.ts";
import { agentCwdProblem, agentHome } from "./agent-folder.ts";
import {
  appsArrive,
  appsLeave,
  OFFICE_APP_DATA_ROOT,
  type LeftApp,
} from "./member-app-move.ts";
import type { CeilingClamp } from "./member-ceiling.ts";
import {
  hostFor,
  memberHostConnected,
  memberIsMoving,
  memberShareOf,
} from "./member-hosts.ts";
import {
  applyMemberMovePins,
  planAgentMoveIn,
  planAgentMoveInFromOut,
  stageMemberMove,
  type MemberMoveAgent,
  type MemberMovePlan,
  type PinChange,
  type StagedMove,
} from "./member-move.ts";
import {
  planAgentMoveOut,
  transferMemberFilesOut,
  type MemberMoveOutPlan,
  type MoveOutResult,
} from "./member-move-out.ts";
import { hasMemberOsUser, memberOsUserState } from "./member-os-users.ts";
import { removeMemberShareFiles } from "./member-share-files.ts";
import { claimMemberMoves, releaseMemberMoves } from "./member-user-admin.ts";
import { getUserById } from "./users.ts";
import type { CwdProblem } from "./cwd-utils.ts";
import {
  accessGrantOf,
  type AgentAccessGrant,
} from "../shared/agent-access.ts";
import type { AgentInfo, AppRecord } from "../shared/types.ts";

// What the setManager write of a host move does around the fields: pins
// before them (to the office) or after them (to a member), so a stop in
// between never gives an office-user agent a pin into a member's home. The
// beforeManagerChange guard lets exactly this agent, from and to, through
// for this one write.
export interface AgentHostChange {
  from: string | null;
  to: string;
  beforeFields: () => void;
  afterFields: () => void;
  // The folder the agent gets, when the move changed it (the notice names
  // the old one).
  cwd: { from: string; to: string } | null;
  // The apps that stay with the old manager (the folder rule), for the
  // notice.
  appsStayed: string[];
}

// What the agent manager and the office give the move (set at startup).
export interface AgentHostMoveWiring {
  getAgent: (agentId: string) => AgentInfo | undefined;
  // The ceiling clamp for the new manager (memberCeiling.clampFor); pure.
  clampFor: (agent: AgentInfo, toUserId: string) => CeilingClamp;
  setAccess: (agentId: string, grant: AgentAccessGrant) => Promise<unknown>;
  // The per-agent hold: the queue, the turn, its processes, background
  // work and terminal. Resolves once they have ended.
  holdAgent: (agentId: string) => Promise<void>;
  releaseAgent: (agentId: string) => void;
  setManager: (
    agentId: string,
    toUserId: string,
    manager: string,
    changedBy: string,
    hostChange: AgentHostChange,
  ) => Promise<AgentInfo | null>;
  // The apps the agent made that `fromUserId` owns (the ones a manager
  // change moves).
  agentApps: (agentId: string, fromUserId: string | null) => AppRecord[];
  // The office part of a manager change after the agent's own: the apps,
  // schedules and webhooks to the new manager (apps in `keepApps` stay).
  transferMade: (
    agentId: string,
    fromUserId: string | null,
    toUserId: string,
    keepApps: ReadonlySet<string>,
  ) => void;
  // The chat line of a failed move, with its reason (the request may have
  // been cut, so the chat tells it too).
  systemLine: (agentId: string, text: string) => void;
  // The agent's Sk menu and skill folder, for its new host.
  refreshSkills?: (agentId: string) => void;
}

// The file and host steps; real functions by default, stand-ins in tests.
export interface AgentHostMoveDeps {
  hasOsUser: (userId: string | null) => boolean;
  // The connected host of a member who has an OS user, or undefined.
  memberHost: (userId: string) => AgentHost | undefined;
  // The go-on/disable busy set (member-user-admin.ts): false when one of
  // them is busy, and then nothing is claimed.
  claimMembers: (userIds: string[]) => boolean;
  releaseMembers: (userIds: string[]) => void;
  planIn: (
    agent: MemberMoveAgent,
    fromUserId: string | null,
    toUserId: string,
    appTrees: { src: string; destParts: string[] }[],
  ) => MemberMovePlan;
  planInFromOut: (
    agent: MemberMoveAgent,
    out: MoveOutResult,
    toUserId: string,
  ) => MemberMovePlan;
  stageIn: (plan: MemberMovePlan, host: AgentHost) => Promise<StagedMove>;
  planOut: (
    agent: MemberMoveAgent,
    fromUserId: string,
    host: AgentHost,
    appNames: string[],
  ) => MemberMoveOutPlan;
  transferOut: (
    plan: MemberMoveOutPlan,
    host: AgentHost,
  ) => Promise<MoveOutResult>;
  applyPins: (pins: PinChange[]) => void;
  appsLeave: (userId: string | null, names: string[]) => Promise<LeftApp[]>;
  appsArrive: (userId: string | null, left: readonly LeftApp[]) => void;
  cwdProblem: (
    cwd: string,
    userId: string | null,
  ) => Promise<CwdProblem | null>;
  // The uids that own `path` and each of its ancestors (lstat).
  ownerUids: (path: string) => number[];
  // The uid of a member's own OS user (their record), or undefined.
  osUid: (userId: string) => number | undefined;
  agentHome: (userId: string | null) => string;
  removeShareFiles: (userId: string, agentId: string) => void;
  refreshSkills: (agentId: string) => void;
  log: (line: string) => void;
}

export type AgentHostMoveResult =
  | { ok: true; agent: AgentInfo }
  | {
      ok: false;
      status: 404 | 409 | 500;
      code:
        | "agent_not_found"
        | "unknown_member"
        | "cannot_move_down"
        | "member_os_user"
        | "move_in_progress"
        | "host_move_failed";
      reason: string;
    };

export type AgentHostMoveRefusal = Extract<AgentHostMoveResult, { ok: false }>;

// What a manager change answers (transferAgentManager): the agent, null for
// a killed or unknown agent, a refusal of the ceiling or of an unknown
// member, or a host move's refusal or failure.
export type ManagerTransferResult =
  | AgentInfo
  | null
  | "unknown_member"
  | "cannot_move_down"
  | AgentHostMoveRefusal;

export function isHostMoveRefusal(
  value: unknown,
): value is AgentHostMoveRefusal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  );
}

let wiring: AgentHostMoveWiring | null = null;

export function setAgentHostMoveWiring(next: AgentHostMoveWiring | null): void {
  wiring = next;
}

// The owners of `path` and of each folder above it; throws when one cannot
// be read (the folder rule then fails closed).
function lstatOwners(path: string): number[] {
  const uids: number[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    uids.push(lstatSync(at).uid);
    if (dirname(at) === at) return uids;
  }
}

// The connected runner host of a member whose record is ready (not
// moving, not unfinished, not malformed).
function readyMemberHost(userId: string): AgentHost | undefined {
  const state = memberOsUserState(userId);
  if (state.kind !== "isolated" || state.unfinished) return undefined;
  if (memberIsMoving(userId) || !memberHostConnected(userId)) return undefined;
  return hostFor(userId);
}

const DEFAULT_DEPS: AgentHostMoveDeps = {
  hasOsUser: hasMemberOsUser,
  memberHost: readyMemberHost,
  claimMembers: claimMemberMoves,
  releaseMembers: releaseMemberMoves,
  planIn: planAgentMoveIn,
  planInFromOut: planAgentMoveInFromOut,
  stageIn: stageMemberMove,
  planOut: planAgentMoveOut,
  transferOut: transferMemberFilesOut,
  applyPins: applyMemberMovePins,
  appsLeave: (userId, names) => appsLeave(userId, names),
  appsArrive,
  cwdProblem: agentCwdProblem,
  ownerUids: lstatOwners,
  osUid: (userId) => {
    const state = memberOsUserState(userId);
    return state.kind === "isolated" ? state.osUser.uid : undefined;
  },
  agentHome,
  removeShareFiles: (userId, agentId) => {
    const share = memberShareOf(userId);
    if (share) removeMemberShareFiles(share, agentId);
  },
  refreshSkills: (agentId) => wiring?.refreshSkills?.(agentId),
  log: (line) => console.log(line),
};
let deps = DEFAULT_DEPS;

// Tests: replace some dependencies; null restores the defaults.
export function setAgentHostMoveDeps(
  over: Partial<AgentHostMoveDeps> | null,
): void {
  deps = over ? { ...DEFAULT_DEPS, ...over } : DEFAULT_DEPS;
}

// The agents whose host move runs.
const moving = new Set<string>();

// True while a host move of the agent runs: its folder, engine, access and
// a kill are refused (409 move_in_progress).
export function agentHostMoving(agentId: string): boolean {
  return moving.has(agentId);
}

function refused(
  status: 404 | 409,
  code: Exclude<AgentHostMoveRefusal["code"], "host_move_failed">,
  reason: string,
): AgentHostMoveResult {
  return { ok: false, status, code, reason };
}

// Whether the agents of `toUserId` may use `cwd`, coming from `fromUserId`:
// their host can enter it, and on the office's host no part of the path is
// owned by the old member's OS user (its owner can rename what is in it,
// and their code would run as the office user, design 3.2). A move to a
// member needs only the enter: write sharing between members is fine.
async function folderFits(
  cwd: string,
  fromUserId: string | null,
  toUserId: string,
): Promise<boolean> {
  try {
    if (await deps.cwdProblem(cwd, toUserId)) return false;
    if (deps.hasOsUser(toUserId) || !fromUserId) return true;
    const uid = deps.osUid(fromUserId);
    if (uid === undefined) return true;
    return !deps.ownerUids(cwd).includes(uid);
  } catch {
    return false;
  }
}

// Move `agentId` to `toUserId`, whose agents run on another host.
export async function moveAgentHost(
  agentId: string,
  toUserId: string,
  changedBy: string,
): Promise<AgentHostMoveResult> {
  const w = wiring;
  if (!w) throw new Error("the agent host move is not wired");
  const agent = w.getAgent(agentId);
  if (!agent) return refused(404, "agent_not_found", "Agent not found");
  if (moving.has(agentId))
    return refused(
      409,
      "move_in_progress",
      `${agent.name} is moving to another OS user. Try again after that manager change.`,
    );
  const to = getUserById(toUserId);
  if (!to) return refused(404, "unknown_member", "No member has this id");
  const from = agent.userId ?? null;
  // Pure, before anything is held; applied after the files moved.
  const clamp = w.clampFor(agent, toUserId);
  if (clamp.kind === "cannot")
    return refused(
      409,
      "cannot_move_down",
      `${agent.name} cannot run at the highest agent level of this member's permission pack with its engine and model. Change its engine or model first.`,
    );
  const fromIsolated = !!from && deps.hasOsUser(from);
  const toIsolated = deps.hasOsUser(toUserId);
  const fromHost = from && fromIsolated ? deps.memberHost(from) : undefined;
  const toHost = toIsolated ? deps.memberHost(toUserId) : undefined;
  if ((fromIsolated && !fromHost) || (toIsolated && !toHost))
    return refused(
      409,
      "member_os_user",
      `${agent.name} cannot move: the OS user of ${fromIsolated && !fromHost ? (agent.manager ?? "its manager") : to.name} is not ready.`,
    );
  const claimed = [
    ...(from && fromIsolated ? [from] : []),
    ...(toIsolated ? [toUserId] : []),
  ];
  if (!deps.claimMembers(claimed))
    return refused(
      409,
      "move_in_progress",
      "The files of the old or the new manager are moving. Try again later.",
    );
  moving.add(agentId);
  try {
    return await move(w, {
      agent,
      from,
      to: { id: to.id, name: to.name },
      changedBy,
      clamp,
      fromHost,
      toHost,
    });
  } finally {
    moving.delete(agentId);
    deps.releaseMembers(claimed);
  }
}

interface MoveInput {
  agent: AgentInfo;
  from: string | null;
  to: { id: string; name: string };
  changedBy: string;
  clamp: CeilingClamp;
  fromHost: AgentHost | undefined;
  toHost: AgentHost | undefined;
}

async function move(
  w: AgentHostMoveWiring,
  input: MoveInput,
): Promise<AgentHostMoveResult> {
  const { agent, from, to, changedBy, clamp, fromHost, toHost } = input;
  const agentId = agent.id;
  const moveAgent = { id: agentId, agentType: agent.agentType, cwd: agent.cwd };
  // The folder and the apps, by the new host's rule.
  const cwdFits = await folderFits(agent.cwd, from, to.id);
  const cwd = cwdFits ? null : { from: agent.cwd, to: deps.agentHome(to.id) };
  const apps = w.agentApps(agentId, from);
  const movingApps: string[] = [];
  const stayed: string[] = [];
  for (const app of apps)
    ((await folderFits(app.cwd, from, to.id)) ? movingApps : stayed).push(
      app.name,
    );
  stayed.sort();

  let left: LeftApp[] = [];
  let staged: StagedMove | null = null;
  let out: MoveOutResult | null = null;
  let fieldsWritten = false;
  const undoFiles = async () => {
    if (staged)
      await staged
        .undo()
        .catch((error: unknown) =>
          deps.log(
            `[agent-move] ${agentId}: the undo on the new host failed: ${(error as Error).message}`,
          ),
        );
    if (out) {
      try {
        out.undo();
      } catch (error) {
        deps.log(
          `[agent-move] ${agentId}: the undo in the office failed: ${(error as Error).message}`,
        );
      }
    }
  };
  let held = false;
  // The grant before the clamp, given back when the move fails after it.
  const grantBefore = accessGrantOf(agent);
  let clamped = false;
  const fail = async (error: unknown): Promise<AgentHostMoveResult> => {
    const reason = (error as Error)?.message ?? String(error);
    await undoFiles();
    if (clamped && w.getAgent(agentId))
      await w
        .setAccess(agentId, grantBefore)
        .catch((accessError: unknown) =>
          deps.log(
            `[agent-move] ${agentId}: its access was not given back: ${(accessError as Error).message}`,
          ),
        );
    if (left.length > 0)
      try {
        deps.appsArrive(from, left);
      } catch (arriveError) {
        deps.log(
          `[agent-move] ${agentId}: the apps did not go back up: ${(arriveError as Error).message}`,
        );
      }
    deps.log(`[agent-move] ${agentId}: the move to ${to.id} failed: ${reason}`);
    try {
      w.systemLine(agentId, reason);
    } catch {}
    if (held) w.releaseAgent(agentId);
    return { ok: false, status: 500, code: "host_move_failed", reason };
  };

  try {
    // A hold that throws part way may have taken the queue: release it too.
    held = true;
    await w.holdAgent(agentId);
    if (movingApps.length > 0) left = await deps.appsLeave(from, movingApps);
    const appTrees = movingApps.map((name) => ({
      src: join(OFFICE_APP_DATA_ROOT, name),
      destParts: ["apps", "data", name],
    }));
    if (fromHost) {
      const plan = deps.planOut(moveAgent, from!, fromHost, movingApps);
      out = await deps.transferOut(plan, fromHost);
    }
    if (toHost) {
      const plan = out
        ? deps.planInFromOut(moveAgent, out, to.id)
        : deps.planIn(moveAgent, from, to.id, appTrees);
      staged = await deps.stageIn(plan, toHost);
    }
    if (!w.getAgent(agentId))
      throw new Error(`${agent.name} was removed during the move`);
    if (clamp.kind === "move") {
      clamped = true;
      await w.setAccess(agentId, clamp.grant);
    }
    const hostChange: AgentHostChange = {
      from,
      to: to.id,
      // To the office: the pins of what came back, before the fields.
      beforeFields: () => {
        if (!toHost && out) deps.applyPins(out.pins);
      },
      // To a member: their pins, after the fields.
      afterFields: () => {
        fieldsWritten = true;
        if (!staged) return;
        try {
          deps.applyPins(staged.pins);
        } catch (error) {
          // The member's host finds the sessions in their roots.
          deps.log(
            `[agent-move] ${agentId}: the pins on the new host were not written: ${(error as Error).message}`,
          );
        }
      },
      cwd,
      appsStayed: stayed,
    };
    const info = await w.setManager(
      agentId,
      to.id,
      to.name,
      changedBy,
      hostChange,
    );
    if (!info) throw new Error(`${agent.name} was removed during the move`);
  } catch (error) {
    if (!fieldsWritten) return await fail(error);
    // The fields are written: the move stands, whatever followed.
    deps.log(
      `[agent-move] ${agentId}: after the manager change: ${(error as Error).message}`,
    );
  }

  // The agent runs on the new host now.
  try {
    w.transferMade(agentId, from, to.id, new Set(stayed));
  } catch (error) {
    deps.log(
      `[agent-move] ${agentId}: what it made did not move: ${(error as Error).message}`,
    );
  }
  if (left.length > 0) deps.appsArrive(to.id, left);
  deps.refreshSkills(agentId);
  if (out) await out.removeMemberCopy();
  if (staged) {
    staged.deleteOfficeCopies();
    await staged
      .done()
      .catch((error: unknown) =>
        deps.log(
          `[agent-move] ${agentId}: cannot remove the staging folder: ${(error as Error).message}`,
        ),
      );
  }
  if (out) {
    try {
      out.done();
    } catch {}
  }
  if (fromHost && from) {
    try {
      deps.removeShareFiles(from, agentId);
    } catch (error) {
      deps.log(
        `[agent-move] ${agentId}: cannot remove its share files: ${(error as Error).message}`,
      );
    }
  }
  w.releaseAgent(agentId);
  const after = w.getAgent(agentId);
  return after
    ? { ok: true, agent: after }
    : {
        ok: false,
        status: 500,
        code: "host_move_failed",
        reason: `${agent.name} was removed during the move`,
      };
}
