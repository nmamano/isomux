// The apps of isolated members while the office is locked
// (internal-docs/member-os-user-design.md, slice 3b). A locked office loads
// no member host, and no runner connects to it, but each member's app runs
// under their own systemd user manager and a lock must stop it, as it stops
// an office app. The locked office calls the member's runner directly: a
// synchronous runner call needs no office connect (the runner accepts the
// office uid, and agent-runner/sync_call.py checks the listener's uid
// first).
//
// lockedAppSupervisor: the router of a locked office. Its member target
// comes from member-os-users.json and the member's passwd entry (getent),
// never from the runner: any process of her uid can answer on its socket.
// The runner's "info" answer must name the recorded uid and user. A runner
// that does not answer costs one call bound, then INFO_RETRY_MS of
// not_ready with no call.
//
// keepStoppingMemberApps: a runner that does not answer at the locked boot
// (it starts after the office at a box boot) is asked again every
// RETRY_MS until each member app is stopped. These stops never go into the
// lock's apps record: the app may have been started by the box boot, not
// by its owner.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  createAppSupervisorRouter,
  type AppOwnerTarget,
  type AppSupervisorRouter,
} from "./app-supervisor-router.ts";
import type { AppSupervisor } from "./app-supervisor.ts";
import { MEMBER_AGENT_DIR } from "./agent-host.ts";
import {
  CALL_BOUND_MS,
  runnerSyncCall,
  type SyncCall,
} from "./member-app-host.ts";
import type { LockdownApps } from "./lockdown.ts";
import type { MemberOsUserState } from "./member-os-users.ts";

export const RETRY_MS = 60_000;
// Under RETRY_MS, so each retry pass asks a silent runner once.
export const INFO_RETRY_MS = 30_000;

// The home of `name` in passwd (NSS), when its uid is `uid`; else null.
export function passwdHome(name: string, uid: number): string | null {
  const result = spawnSync("getent", ["passwd", "--", name], {
    encoding: "utf8",
    timeout: CALL_BOUND_MS,
  });
  if (result.status !== 0) return null;
  const fields = result.stdout.trim().split(":");
  if (fields.length < 7 || fields[0] !== name || Number(fields[2]) !== uid)
    return null;
  const home = fields[5] ?? "";
  return home.startsWith("/") ? home : null;
}

export interface LockedAppSupervisorDeps {
  office: AppSupervisor;
  // The owner of each named app (the app registry).
  owners: (appNames: readonly string[]) => Map<string, string | null>;
  anyIsolated: () => boolean;
  memberState: (userId: string) => MemberOsUserState;
  socketPath: (osUserName: string) => string;
  // The member's home (default passwdHome).
  home?: (osUserName: string, uid: number) => string | null;
  // Tests: the transport to a member's runner, and the clock.
  call?: (socketPath: string, uid: number) => SyncCall;
  now?: () => number;
  log?: (line: string) => void;
}

export function lockedAppSupervisor(
  deps: LockedAppSupervisorDeps,
): AppSupervisorRouter {
  const call = deps.call ?? runnerSyncCall;
  const homeOf = deps.home ?? passwdHome;
  const now = deps.now ?? (() => Date.now());
  const held = new Map<string, Extract<AppOwnerTarget, { kind: "member" }>>();
  const failedAt = new Map<string, number>();
  const names = new Map<string, string>();

  function target(userId: string): AppOwnerTarget {
    const state = deps.memberState(userId);
    if (state.kind === "none") return { kind: "office" };
    if (state.kind !== "isolated") return { kind: "not_ready" };
    const { name, uid } = state.osUser;
    names.set(userId, name);
    const socketPath = deps.socketPath(name);
    const known = held.get(userId);
    if (known && known.uid === uid && known.socketPath === socketPath)
      return known;
    held.delete(userId);
    const failed = failedAt.get(userId);
    if (failed !== undefined && now() - failed < INFO_RETRY_MS)
      return { kind: "not_ready" };
    const home = homeOf(name, uid);
    const reply = home
      ? call(socketPath, uid)({ op: "info" }, undefined, CALL_BOUND_MS)
      : null;
    const info = reply?.control;
    if (
      !home ||
      info?.type !== "info" ||
      info.uid !== uid ||
      info.user !== name
    ) {
      failedAt.set(userId, now());
      return { kind: "not_ready" };
    }
    failedAt.delete(userId);
    const made = {
      kind: "member" as const,
      key: {},
      uid,
      socketPath,
      home,
      agentRoot: join(home, MEMBER_AGENT_DIR),
    };
    held.set(userId, made);
    return made;
  }

  const router = createAppSupervisorRouter({
    office: deps.office,
    // The locked office relays nothing.
    officeAppUid: () => null,
    owners: deps.owners,
    anyIsolated: deps.anyIsolated,
    target: (userId) => {
      const result = target(userId);
      // A runner that stopped answering is asked for its home again.
      if (result.kind !== "member") held.delete(userId);
      return result;
    },
    memberName: (userId) => names.get(userId) ?? userId,
    memberHostCall: (_userId, member) => call(member.socketPath, member.uid),
    ...(deps.log ? { log: deps.log } : {}),
  });
  // A stop that throws (a runner gone, its breaker open) drops the owner's
  // held target and counts as a failed ask: the rest of the pass makes no
  // call for them, and the next pass asks the runner again, through a new
  // host with a new breaker.
  return {
    ...router,
    stop: (appName) => {
      try {
        router.stop(appName);
      } catch (error) {
        const owner = deps.owners([appName]).get(appName);
        if (owner && held.delete(owner)) failedAt.set(owner, now());
        throw error;
      }
    },
  };
}

export interface KeepStoppingDeps {
  apps: LockdownApps;
  // The member apps (owner has an OS user).
  isMemberApp: (name: string) => boolean;
  everyMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (line: string) => void;
}

// Runs one pass now, then one every `everyMs` while a member app is not
// known to be stopped. Returns the function that ends the passes.
export function keepStoppingMemberApps(deps: KeepStoppingDeps): () => void {
  const log = deps.log ?? ((line: string) => console.log(line));
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clear =
    deps.clearInterval ??
    ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const waitLogged = new Set<string>();
  let handle: unknown = null;
  // One pass: true when every member app is known to be stopped.
  const pass = (): boolean => {
    let left = 0;
    for (const name of deps.apps.list()) {
      if (!deps.isMemberApp(name)) continue;
      let active: boolean;
      try {
        active = deps.apps.isActive(name);
      } catch {
        active = true;
      }
      if (!active) continue;
      try {
        deps.apps.stop(name);
        if (waitLogged.delete(name))
          log(`[lockdown] stopped the app ${name} through its owner's runner`);
      } catch {
        left++;
        if (!waitLogged.has(name)) {
          waitLogged.add(name);
          log(
            `[lockdown] the app ${name} could not be stopped yet: its owner's runner did not answer; trying again every ${(deps.everyMs ?? RETRY_MS) / 1000} s`,
          );
        }
      }
    }
    return left === 0;
  };
  if (pass()) return () => {};
  handle = every(() => {
    if (pass() && handle !== null) {
      clear(handle);
      handle = null;
    }
  }, deps.everyMs ?? RETRY_MS);
  return () => {
    if (handle !== null) clear(handle);
    handle = null;
  };
}
