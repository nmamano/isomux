// The office's AppSupervisor when members can have their own OS user
// (internal-docs/member-os-user-design.md, slice 3b): each call goes to the
// supervisor of the host that runs the app's owner. An office app (or one
// whose owner has no OS user) goes to the office's supervisor; an isolated
// member's app goes to a supervisor whose host is that member's runner
// (member-app-host.ts), and never to the office's. The interface is the
// same, so no caller changes.
//
// A member whose runner is not ready: every call throws member_os_user
// (409), states() answers unknown, provablyNotRunning() is false. A member
// with no systemd user manager (the container shape): every call throws
// apps_not_supported (501), from their own check, except the delete, which
// asks again and, with no manager running, removes the app's files on their
// host through the runner.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AppSupervisorError,
  createAppSupervisor,
  UNKNOWN_RUNTIME,
  type AppRuntime,
  type AppSupervisor,
} from "./app-supervisor.ts";
import {
  createMemberAppHost,
  type MemberAppHost,
  type SyncCall,
} from "./member-app-host.ts";
import { appSecretsPath, type AppSecretsFile } from "./app-secrets.ts";
import type { AppRecord } from "../shared/types.ts";

// Where the app of an owner runs, now.
export type AppOwnerTarget =
  | { kind: "office" }
  | { kind: "not_ready" }
  | {
      kind: "member";
      // Changes whenever the member's runner connects again: a supervisor
      // made for another key never gets a call.
      key: object;
      uid: number;
      socketPath: string;
      home: string;
      agentRoot: string;
      // The member's runtime bin folder (memberRuntimeBinDir), for their
      // apps' PATH.
      runtimeBinDir: string;
    };

export interface AppSupervisorRouterDeps {
  office: AppSupervisor;
  // The uid that runs an office app (the port check, app-port-owner.ts).
  officeAppUid: () => number | null;
  // The owner of each named app that exists (one registry read).
  owners: (appNames: readonly string[]) => Map<string, string | null>;
  // False while no member has an OS user: every call goes to the office's
  // supervisor without a registry read.
  anyIsolated: () => boolean;
  target: (userId: string) => AppOwnerTarget;
  memberName: (userId: string) => string;
  // Tests: build the member's host and supervisor.
  memberSupervisor?: (
    userId: string,
    target: Extract<AppOwnerTarget, { kind: "member" }>,
  ) => { host: MemberAppHost; supervisor: AppSupervisor };
  // Tests: the transport of the member's host, with production's host and
  // supervisor around it.
  memberHostCall?: (
    userId: string,
    target: Extract<AppOwnerTarget, { kind: "member" }>,
  ) => SyncCall;
  log?: (line: string) => void;
}

export interface AppSupervisorRouter extends AppSupervisor {
  // The uid whose listening socket the relay accepts for the app, or null
  // when there is none to accept (the relay refuses).
  appUid(appName: string): number | null;
  // Drop the member's supervisor (enable, disable, a host change).
  forget(userId: string): void;
  // False when the apps of `userId` cannot be reached now: their own OS
  // user's runner is not ready.
  ownerReady(userId: string | null): boolean;
  // Can the host of `userId`'s apps run apps: true for the office, the
  // member's held user manager answer for a member. Throws member_os_user
  // when their host is not ready.
  canRun(userId: string | null): boolean;
  // Why `userId` cannot get a new app now (register asks it before any
  // write), or null.
  ownerAppsRefusal(userId: string | null): {
    code: "member_os_user" | "apps_not_supported";
    message: string;
  } | null;
  // The secrets file of a member's app, through their host; null for an
  // office app (app-secrets.ts writes it). Throws member_os_user when their
  // host is not ready.
  secretsFile(app: AppRecord): AppSecretsFile | null;
  // The data folder of a member's app (app-registry.ts MemberAppData), as
  // the member. Throw member_os_user when their host is not ready.
  makeDataDir(userId: string, path: string): void;
  // The app's data folder exists on the host that runs it (a move carries
  // only files, not an empty folder).
  ensureDataDir(app: AppRecord): void;
  retireDataDir(userId: string, root: string, name: string, at: number): void;
}

const RETIRE_TRIES = 100;

type Route =
  | { kind: "office"; supervisor: AppSupervisor }
  | {
      kind: "member";
      userId: string;
      host: MemberAppHost;
      supervisor: AppSupervisor;
    };

function defaultMemberSupervisor(
  userId: string,
  target: Extract<AppOwnerTarget, { kind: "member" }>,
  memberName: string,
  call: SyncCall | undefined,
): { host: MemberAppHost; supervisor: AppSupervisor } {
  const host = createMemberAppHost({
    userId,
    memberName,
    uid: target.uid,
    socketPath: target.socketPath,
    home: target.home,
    agentRoot: target.agentRoot,
    ...(call ? { call } : {}),
  });
  const supervisor = createAppSupervisor({
    host,
    secretsDir: host.secretsDir,
    runtimeBinDir: target.runtimeBinDir,
    noBlock: true,
    ownsSecretsFile: true,
  });
  return { host, supervisor };
}

export function createAppSupervisorRouter(
  deps: AppSupervisorRouterDeps,
): AppSupervisorRouter {
  const log = deps.log ?? ((line: string) => console.error(line));
  const members = new Map<
    string,
    { key: object; host: MemberAppHost; supervisor: AppSupervisor }
  >();

  const notReady = (userId: string) =>
    new AppSupervisorError(
      "member_os_user",
      `${deps.memberName(userId)}'s own OS user is not ready`,
    );
  const unsupported = (userId: string) =>
    new AppSupervisorError(
      "apps_not_supported",
      `${deps.memberName(userId)}'s own OS user has no systemd user manager, so their agents cannot run apps`,
    );

  function routeOwner(userId: string | null | undefined): Route {
    if (!userId) return { kind: "office", supervisor: deps.office };
    const target = deps.target(userId);
    if (target.kind === "office") {
      members.delete(userId);
      return { kind: "office", supervisor: deps.office };
    }
    if (target.kind === "not_ready") {
      members.delete(userId);
      throw notReady(userId);
    }
    let entry = members.get(userId);
    if (!entry || entry.key !== target.key) {
      const made = deps.memberSupervisor
        ? deps.memberSupervisor(userId, target)
        : defaultMemberSupervisor(
            userId,
            target,
            deps.memberName(userId),
            deps.memberHostCall?.(userId, target),
          );
      entry = { key: target.key, ...made };
      members.set(userId, entry);
    }
    return {
      kind: "member",
      userId,
      host: entry.host,
      supervisor: entry.supervisor,
    };
  }

  const routeName = (appName: string): Route =>
    deps.anyIsolated()
      ? routeOwner(deps.owners([appName]).get(appName))
      : { kind: "office", supervisor: deps.office };

  // The supervisor for a call that runs or changes the app: a member host
  // with no user manager refuses it (its held answer is enough here).
  function supervisorFor(route: Route): AppSupervisor {
    if (route.kind === "member" && !route.host.userManager(false))
      throw unsupported(route.userId);
    return route.supervisor;
  }
  const byName = (appName: string) => supervisorFor(routeName(appName));

  // An app the office's own supervisor runs: no owner, or an owner with no
  // OS user of their own.
  const officeApp = (appName: string): boolean => {
    if (!deps.anyIsolated()) return true;
    const owner = deps.owners([appName]).get(appName);
    return !owner || deps.target(owner).kind === "office";
  };
  // The lock's enabled bit (lockdown.ts disableAppsForLock), only where the
  // office's supervisor has it. An isolated member's units are never
  // disabled: every locked boot stops her apps through her runner
  // (locked-member-apps.ts), and a unit left disabled by an enable that
  // fails at the unlock would never start again. So her apps are never
  // listed as enabled, and enable and disable do nothing for them.
  const office = deps.office;
  const enabledBit =
    office.enabledApps && office.enable && office.disable
      ? {
          enabledApps: (appNames: readonly string[]) =>
            office.enabledApps!(appNames.filter(officeApp)),
          enable: (appName: string) => {
            if (officeApp(appName)) office.enable!(appName);
          },
          disable: (appName: string) => {
            if (officeApp(appName)) office.disable!(appName);
          },
        }
      : {};

  return {
    ...enabledBit,
    unitName: (appName) => deps.office.unitName(appName),
    install: (app: AppRecord) =>
      supervisorFor(routeOwner(app.userId)).install(app),
    provisionToken: (appName, raw) =>
      byName(appName).provisionToken(appName, raw),
    readToken: (appName) => byName(appName).readToken(appName),
    removeToken: (appName) => byName(appName).removeToken(appName),
    unitInjectsToken: (appName) => byName(appName).unitInjectsToken(appName),
    unitInjectsSecrets: (appName) =>
      byName(appName).unitInjectsSecrets(appName),
    unitPathHasRuntime: (appName) =>
      byName(appName).unitPathHasRuntime(appName),
    readUnitFile: (appName) => byName(appName).readUnitFile(appName),
    restoreUnitFile: (appName, contents) =>
      byName(appName).restoreUnitFile(appName, contents),
    reloadUnits: () => {
      deps.office.reloadUnits();
      for (const [userId, entry] of members) {
        try {
          if (entry.host.userManager(false)) entry.supervisor.reloadUnits();
        } catch {
          log(
            `[apps] the app units of ${deps.memberName(userId)} could not be reloaded`,
          );
        }
      }
    },
    regenerate: (app) => supervisorFor(routeOwner(app.userId)).regenerate(app),
    reinstall: (app) => supervisorFor(routeOwner(app.userId)).reinstall(app),
    // A member's app: what a failed move left on the office's host goes
    // first (each step is idempotent), then the member's host. A member
    // host with no user manager, asked now and proved by their runtime
    // folder, runs nothing: its files go through the runner, so an enabled
    // unit cannot start the app when a manager comes up later. A manager
    // whose bus fails is not that proof: refused, nothing removed.
    teardown: (appName) => {
      const route = routeName(appName);
      if (route.kind === "office") return deps.office.teardown(appName);
      deps.office.teardown(appName);
      if (route.host.userManager(true))
        return route.supervisor.teardown(appName);
      if (!route.host.managerFolderAbsent())
        throw new AppSupervisorError(
          "supervisor_failed",
          `${deps.memberName(route.userId)}'s systemd user manager did not answer; try again`,
        );
      if (!route.supervisor.removeFiles)
        throw new AppSupervisorError(
          "supervisor_failed",
          "the app's files could not be removed",
        );
      route.supervisor.removeFiles(appName);
    },
    start: (appName) => byName(appName).start(appName),
    stop: (appName) => byName(appName).stop(appName),
    restart: (appName) => byName(appName).restart(appName),
    states: (appNames) => {
      if (!deps.anyIsolated()) return deps.office.states(appNames);
      const owners = deps.owners(appNames);
      const groups = new Map<string, string[]>();
      const office: string[] = [];
      for (const name of appNames) {
        const owner = owners.get(name);
        if (!owner) {
          office.push(name);
          continue;
        }
        const list = groups.get(owner) ?? [];
        list.push(name);
        groups.set(owner, list);
      }
      const result = new Map<string, AppRuntime>();
      const put = (read: Map<string, AppRuntime>) => {
        for (const [name, runtime] of read) result.set(name, runtime);
      };
      for (const [owner, names] of groups) {
        let route: Route;
        try {
          route = routeOwner(owner);
        } catch {
          for (const name of names) result.set(name, UNKNOWN_RUNTIME);
          continue;
        }
        if (route.kind === "office") {
          office.push(...names);
          continue;
        }
        try {
          if (!route.host.userManager(false)) {
            const startError = unsupported(owner).message;
            for (const name of names)
              result.set(name, { ...UNKNOWN_RUNTIME, startError });
            continue;
          }
          put(route.supervisor.states(names));
        } catch {
          for (const name of names) result.set(name, UNKNOWN_RUNTIME);
        }
      }
      if (office.length > 0) put(deps.office.states(office));
      // The caller's order.
      return new Map(
        appNames.map((n) => [n, result.get(n) ?? UNKNOWN_RUNTIME]),
      );
    },
    provablyNotRunning: (appName) => {
      try {
        const route = routeName(appName);
        if (route.kind === "office")
          return deps.office.provablyNotRunning(appName);
        if (!deps.office.provablyNotRunning(appName)) return false;
        if (!route.host.userManager(true))
          return route.host.managerFolderAbsent();
        return route.supervisor.provablyNotRunning(appName);
      } catch {
        return false;
      }
    },
    logs: (appName, lines) => byName(appName).logs(appName, lines),
    appUid: (appName) => {
      try {
        const route = routeName(appName);
        return route.kind === "office" ? deps.officeAppUid() : route.host.uid;
      } catch {
        return null;
      }
    },
    forget: (userId) => {
      members.delete(userId);
    },
    canRun: (userId) => {
      const route = routeOwner(userId);
      return route.kind === "office" || route.host.userManager(false);
    },
    ownerAppsRefusal: (userId) => {
      if (!userId || !deps.anyIsolated()) return null;
      try {
        const route = routeOwner(userId);
        supervisorFor(route);
        return null;
      } catch (error) {
        if (
          error instanceof AppSupervisorError &&
          (error.code === "member_os_user" ||
            error.code === "apps_not_supported")
        )
          return { code: error.code, message: error.message };
        throw error;
      }
    },
    ownerReady: (userId) => {
      if (!userId || !deps.anyIsolated()) return true;
      return deps.target(userId).kind !== "not_ready";
    },
    ensureDataDir: (app) => {
      const route = routeOwner(app.userId);
      if (route.kind === "office") mkdirSync(app.dataDir, { recursive: true });
      else route.host.mkdir(app.dataDir);
    },
    makeDataDir: (userId, path) => {
      const route = routeOwner(userId);
      if (route.kind === "office")
        throw new AppSupervisorError(
          "supervisor_failed",
          "the app's owner has no OS user of their own",
        );
      route.host.mkdir(path);
    },
    // archiveDataDir's rule (app-registry.ts) through the member's host: a
    // folder that is not there has nothing to set aside, and the name walks
    // until the rename finds a free one.
    retireDataDir: (userId, root, name, at) => {
      const route = routeOwner(userId);
      if (route.kind === "office")
        throw new AppSupervisorError(
          "supervisor_failed",
          "the app's owner has no OS user of their own",
        );
      const retired = join(root, ".retired");
      route.host.mkdir(retired);
      for (let n = 1; n <= RETIRE_TRIES; n++) {
        const to = join(
          retired,
          n === 1 ? `${name}-${at}` : `${name}-${at}-${n}`,
        );
        try {
          route.host.rename(join(root, name), to);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return;
          if (code !== "EEXIST") throw error;
        }
      }
      throw new AppSupervisorError(
        "supervisor_failed",
        `no free name to set the data of ${name} aside`,
      );
    },
    secretsFile: (app) => {
      if (!deps.anyIsolated()) return null;
      const route = routeOwner(app.userId);
      if (route.kind === "office") return null;
      const path = appSecretsPath(route.host.secretsDir, app.name);
      return {
        read: () => route.host.readFile(path),
        write: (text) => route.host.writeFile(path, text, 0o600),
      };
    },
  };
}
