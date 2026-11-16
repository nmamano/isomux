// The move preflight (task 78733adf; SRE items 4, 9, 10, 11): what the owner
// sees on the new box before they agree to the lock. One job at a time, run
// in the office process with async child processes; each step has its own
// time limit and reports timedOut instead of failing the job.

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AgentUnit } from "./office-move-units.ts";

/** One step's time limit for du on one top-level entry. */
export const PREFLIGHT_DU_TIMEOUT_MS = 30_000;
/** One app folder's grep time limit. */
export const PREFLIGHT_GREP_TIMEOUT_MS = 20_000;
/** Paths listed per app folder. */
export const PREFLIGHT_MAX_HOST_PATHS = 20;

export interface TurnInFlight {
  agentId: string;
  name: string;
  roomName: string | null;
}

export interface MovePreflightResult {
  /** Epoch ms the job finished. The lock counts freshness from here. */
  finishedAt: number;
  turnsInFlight: TurnInFlight[];
  units: AgentUnit[] | { timedOut: true } | { error: string };
  /** The office unit's Restart= value; the lock refuses unless "always". */
  restart: { unit: string; manager: "user" | "system"; restart: string } | null;
  /** App folders whose files name the old host (OAuth redirect URIs too). */
  hostRefs: {
    app: string;
    paths: string[];
    truncated: boolean;
    timedOut: boolean;
  }[];
  sizes: {
    entries: { name: string; bytes: number | null; timedOut: boolean }[];
    /** The sum of the entries that finished. */
    total: number;
  };
  /** Packages installed system-wide with sudo by the office user (apt
   *  history); unknown when the log cannot be read. */
  sudoPackages: { packages: string[] } | { unknown: true };
  /** Members with their own OS user (slice 3): the lock refuses while any
   *  member has one, or while their record cannot be read. */
  memberOsUsers: { names: string[] } | { broken: true };
}

export type MovePreflightStatus =
  | { state: "running"; startedAt: number }
  | { state: "ready"; startedAt: number; result: MovePreflightResult }
  | { state: "failed"; startedAt: number; error: string };

/** A child process run with a time limit. */
export type PreflightExec = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; timedOut: boolean }>;

export interface MovePreflightDeps {
  /** The office user's home. */
  home: string;
  /** The host names the old office answers on (publicOrigin host, the
   *  request host). */
  hosts(): string[];
  apps(): { name: string; folder: string }[];
  turnsInFlight(): TurnInFlight[];
  listUnits(): AgentUnit[];
  restartPolicy(): MovePreflightResult["restart"];
  memberOsUsers(): MovePreflightResult["memberOsUsers"];
  exec: PreflightExec;
  /** The office OS user's name (the apt Requested-By match). */
  osUser: string;
  /** Production: /var/log/apt/history.log. */
  aptHistoryPath: string;
  now(): number;
}

export type StartPreflightResult =
  { ok: true; id: string } | { ok: false; status: 409; message: string };

export interface MovePreflightJobs {
  /** Starts a job for the pairing `pairing` (the session hash). */
  start(pairing: string): StartPreflightResult;
  /** null for an unknown id or another pairing's job. */
  status(id: string, pairing: string): MovePreflightStatus | null;
  /** Drops every job (a cancel, an expiry). */
  clear(): void;
}

/** The largest file the host search lists: bigger ones are data, not
 *  code or config. */
const HOST_REF_MAX_FILE_BYTES = 1024 * 1024;

export function createMovePreflightJobs(
  deps: MovePreflightDeps,
): MovePreflightJobs {
  interface Job {
    pairing: string;
    status: MovePreflightStatus;
  }
  let jobs = new Map<string, Job>();
  let running: string | null = null;

  const start = (pairing: string): StartPreflightResult => {
    if (running !== null)
      return {
        ok: false,
        status: 409,
        message: "A preflight is already running.",
      };
    const id = randomUUID();
    const startedAt = deps.now();
    const job: Job = { pairing, status: { state: "running", startedAt } };
    jobs.set(id, job);
    running = id;
    const mine = jobs;
    void runPreflight(deps)
      .then(
        (result): MovePreflightStatus => ({
          state: "ready",
          startedAt,
          result,
        }),
        (err: unknown): MovePreflightStatus => ({
          state: "failed",
          startedAt,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .then((status) => {
        // A clear in the meantime dropped this job.
        if (mine === jobs && jobs.has(id)) job.status = status;
        if (running === id) running = null;
      })
      .catch((err: unknown) => {
        console.error("[move] the preflight job failed:", err);
        if (running === id) running = null;
      });
    return { ok: true, id };
  };

  return {
    start,
    status: (id, pairing) => {
      const job = jobs.get(id);
      return job && job.pairing === pairing ? job.status : null;
    },
    clear: () => {
      jobs = new Map();
      running = null;
    },
  };
}

async function runPreflight(
  deps: MovePreflightDeps,
): Promise<MovePreflightResult> {
  const turnsInFlight = deps.turnsInFlight();
  let units: MovePreflightResult["units"];
  try {
    units = deps.listUnits();
  } catch (err) {
    units = { error: err instanceof Error ? err.message : String(err) };
  }
  const restart = deps.restartPolicy();
  const hostRefs: MovePreflightResult["hostRefs"] = [];
  for (const app of deps.apps())
    hostRefs.push(await hostRefsIn(deps, app.name, app.folder));
  const sizes = await homeSizes(deps);
  let sudoPackages: MovePreflightResult["sudoPackages"];
  try {
    sudoPackages = {
      packages: sudoPackagesFromAptHistory(
        readFileSync(deps.aptHistoryPath, "utf8"),
        deps.osUser,
      ),
    };
  } catch {
    sudoPackages = { unknown: true };
  }
  return {
    finishedAt: deps.now(),
    turnsInFlight,
    units,
    restart,
    hostRefs,
    sizes,
    sudoPackages,
    memberOsUsers: deps.memberOsUsers(),
  };
}

async function hostRefsIn(
  deps: MovePreflightDeps,
  app: string,
  folder: string,
): Promise<MovePreflightResult["hostRefs"][number]> {
  const hosts = deps.hosts().filter((h) => h.length > 0);
  if (hosts.length === 0)
    return { app, paths: [], truncated: false, timedOut: false };
  // find skips the big files before grep reads them: one large dump would
  // otherwise use up the app's time limit.
  const argv = [
    "find",
    folder,
    "(",
    "-name",
    "node_modules",
    "-o",
    "-name",
    ".git",
    ")",
    "-prune",
    "-o",
    "-type",
    "f",
    "-size",
    `-${HOST_REF_MAX_FILE_BYTES + 1}c`,
    "-exec",
    "grep",
    "-lIF",
    ...hosts.flatMap((h) => ["-e", h]),
    "--",
    "{}",
    "+",
  ];
  const r = await deps.exec(argv, PREFLIGHT_GREP_TIMEOUT_MS);
  if (r.timedOut) return { app, paths: [], truncated: false, timedOut: true };
  const found = r.stdout
    .split("\n")
    .filter((p) => p.length > 0)
    .map((p) => (isAbsolute(p) ? p : join(folder, p)))
    .sort();
  return {
    app,
    paths: found.slice(0, PREFLIGHT_MAX_HOST_PATHS),
    truncated: found.length > PREFLIGHT_MAX_HOST_PATHS,
    timedOut: false,
  };
}

async function homeSizes(
  deps: MovePreflightDeps,
): Promise<MovePreflightResult["sizes"]> {
  const entries: MovePreflightResult["sizes"]["entries"] = [];
  let names: string[] = [];
  try {
    names = readdirSync(deps.home).sort();
  } catch (err) {
    console.error("[move] could not list the home:", err);
  }
  let total = 0;
  for (const name of names) {
    const r = await deps.exec(
      ["du", "-sxb", "--", join(deps.home, name)],
      PREFLIGHT_DU_TIMEOUT_MS,
    );
    const bytes = r.timedOut
      ? null
      : parseInt(r.stdout.trim().split(/\s+/)[0], 10);
    const known = bytes !== null && Number.isFinite(bytes) ? bytes : null;
    if (known !== null) total += known;
    entries.push({ name, bytes: known, timedOut: r.timedOut });
  }
  return { entries, total };
}

/** The production exec: a child process without a shell, killed at the time
 *  limit. */
export const spawnPreflightExec: PreflightExec = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, timeoutMs);
  try {
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { code, stdout: timedOut ? "" : stdout, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

/** The "Requested-By: <user> (" blocks of an apt history log -> the package
 *  names they installed (no arch, no automatic dependencies), sorted. */
export function sudoPackagesFromAptHistory(
  text: string,
  osUser: string,
): string[] {
  const packages = new Set<string>();
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const by = lines.find((l) => l.startsWith("Requested-By: "));
    if (!by || by.slice("Requested-By: ".length).split(" (")[0] !== osUser)
      continue;
    const install = lines.find((l) => l.startsWith("Install: "));
    if (!install) continue;
    // name:arch (version[, automatic]), ...
    for (const m of install
      .slice("Install: ".length)
      .matchAll(/([^\s,][^\s]*?) \(([^)]*)\)/g)) {
      if (/,\s*automatic\s*$/.test(m[2])) continue;
      packages.add(m[1].split(":")[0]);
    }
  }
  return [...packages].sort();
}
