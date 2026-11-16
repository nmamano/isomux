// A member's apps when their OS user changes
// (internal-docs/member-os-user-design.md, slice 3b): enable (go-on) and
// disable move each app the member owns from the host that ran it to the
// host that runs it now. The old host's teardown comes before the files
// move, so no app writes its data during the copy; the install on the new
// host comes after, with a new token (the old one is never read back from
// the member's home) and the secrets written again from the store. An app
// starts on the new host only when it ran before. Its data moves with the
// member's other files (member-move.ts trees, member-move-out.ts sources).

import { join } from "node:path";
import { STATE_ROOT } from "./config.ts";
import { APP_STILL_STOPPING, AppSupervisorError } from "./app-supervisor.ts";
import type { AppSupervisorRouter } from "./app-supervisor-router.ts";
import type { AppRecord } from "../shared/types.ts";

// The data folder of the office's apps (the production registry's,
// app-registry.ts).
export const OFFICE_APP_DATA_ROOT = join(STATE_ROOT, "apps", "data");

// How long a teardown on a member's host may wait for a slow stop, in
// steps (TEARDOWN_STOP_WAIT_MS each, then a pause).
const LEAVE_WAIT_MS = 15_000;
const LEAVE_PAUSE_MS = 1_000;

export interface LeftApp {
  name: string;
  // Ran (or was starting) before its teardown.
  running: boolean;
}

export interface MemberAppMoveDeps {
  apps: () => AppRecord[];
  supervisor: Pick<
    AppSupervisorRouter,
    | "states"
    | "teardown"
    | "install"
    | "regenerate"
    | "forget"
    | "canRun"
    | "ensureDataDir"
  >;
  // Mint and deliver a new token (the old hash is replaced); never throws.
  provisionToken: (record: AppRecord) => boolean;
  revokeToken: (appName: string) => void;
  syncSecrets: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

let moveDeps: MemberAppMoveDeps | null = null;

// Boot (isomux-office.ts); null: a member has no apps to move (tests).
export function setMemberAppMoveDeps(next: MemberAppMoveDeps | null): void {
  moveDeps = next;
}

function theirApps(
  deps: MemberAppMoveDeps,
  userId: string | null,
): AppRecord[] {
  return deps.apps().filter((app) => app.userId === userId);
}

// The go-on trees of the member's app data (member-move.ts): the office's
// folders, whatever host the member has now.
export function memberAppDataTrees(
  userId: string,
): { src: string; destParts: string[] }[] {
  if (!moveDeps) return [];
  return theirApps(moveDeps, userId).map((app) => ({
    src: join(OFFICE_APP_DATA_ROOT, app.name),
    destParts: ["apps", "data", app.name],
  }));
}

// The move-back sources of the member's app data (member-move-out.ts).
export function memberAppDataSources(
  userId: string,
  agentRoot: string,
): { path: string; destRoot: string }[] {
  if (!moveDeps) return [];
  return theirApps(moveDeps, userId).map((app) => ({
    path: join(agentRoot, "apps", "data", app.name),
    destRoot: join(OFFICE_APP_DATA_ROOT, app.name),
  }));
}

// Tear down every app of `userId` on the host that runs it now. A slow
// stop on a member's host is tried again for up to LEAVE_WAIT_MS. When one
// cannot be torn down, the apps already down go back up and this throws:
// the move does not start while an app may still run.
// `names`: only those apps of `userId` (an agent's host move).
export async function appsLeave(
  userId: string | null,
  names?: readonly string[],
): Promise<LeftApp[]> {
  const deps = moveDeps;
  if (!deps) return [];
  const apps = theirApps(deps, userId).filter(
    (app) => !names || names.includes(app.name),
  );
  if (apps.length === 0) return [];
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  let states: Map<string, { state: string }>;
  try {
    states = deps.supervisor.states(apps.map((app) => app.name));
  } catch {
    states = new Map();
  }
  const left: LeftApp[] = [];
  for (const app of apps) {
    const state = states.get(app.name)?.state;
    const end = now() + LEAVE_WAIT_MS;
    try {
      for (;;) {
        try {
          deps.supervisor.teardown(app.name);
          break;
        } catch (error) {
          const slow =
            error instanceof AppSupervisorError &&
            error.message === APP_STILL_STOPPING;
          if (!slow || now() >= end) throw error;
          await sleep(LEAVE_PAUSE_MS);
        }
      }
    } catch (error) {
      appsArrive(userId, left);
      throw new Error(
        `cannot stop the app ${app.name}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    left.push({
      name: app.name,
      running: state === "running" || state === "starting",
    });
  }
  return left;
}

// Install the apps that left on the host that runs `userId`'s apps now.
// Never throws: an app that cannot be installed stays stopped, with a log
// line; its next start provisions a token (ensureAppToken).
// `userId` null: the apps of an agent with no manager (a legacy agent's
// host move), which run on the office's host.
export function appsArrive(
  userId: string | null,
  left: readonly LeftApp[],
): void {
  const deps = moveDeps;
  if (!deps || left.length === 0) return;
  const log = deps.log ?? ((line: string) => console.error(line));
  if (userId !== null) deps.supervisor.forget(userId);
  const byName = new Map(theirApps(deps, userId).map((a) => [a.name, a]));
  const records = left
    .map((entry) => ({ entry, record: byName.get(entry.name) }))
    .filter(
      (item): item is { entry: LeftApp; record: AppRecord } => !!item.record,
    );
  let canRun: boolean;
  try {
    canRun = deps.supervisor.canRun(userId);
  } catch (error) {
    for (const { record } of records)
      log(`[apps] "${record.name}" stays stopped: ${(error as Error).message}`);
    return;
  }
  if (!canRun) {
    // The container shape: the member's OS user has no systemd user manager.
    for (const { record } of records) {
      try {
        deps.revokeToken(record.name);
      } catch {}
      log(
        `[apps] "${record.name}" stopped: its owner's own OS user cannot run apps (no systemd user manager)`,
      );
    }
    return;
  }
  for (const { record } of records) deps.provisionToken(record);
  // The secrets files before the first start.
  deps.syncSecrets();
  for (const { entry, record } of records) {
    try {
      deps.supervisor.ensureDataDir(record);
      if (entry.running) deps.supervisor.install(record);
      else deps.supervisor.regenerate(record);
    } catch (error) {
      log(
        `[apps] "${record.name}" could not be installed on its owner's new host: ${(error as Error).message}`,
      );
    }
  }
}
