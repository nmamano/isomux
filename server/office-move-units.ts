// The office user's own systemd user units at a move (task 78733adf; SRE
// items 4 and 5): the units an agent or a member made, which the office lock
// does not stop.
//
// - Unit files: list-unit-files, then show FragmentPath / UnitFileState /
//   ActiveState; kept when the FragmentPath is under the office user's home,
//   minus the units the office owns (isProtectedUnitEntry). At the lock,
//   "enabled" ones are disabled (their enable links go, so a reboot under
//   linger does not start them) and active ones are stopped.
// - Transient units (systemd-run --user, FragmentPath under
//   /run/user/<uid>/systemd/transient): stopped at the lock, with their
//   ExecStart, WorkingDirectory and Environment recorded, so the restore can
//   start them again with systemd-run.
//
// The record (MOVE_UNITS_FILE) is written BEFORE any change. The first
// normal boot restores from it: enable only for UnitFileState exactly
// "enabled", start what was active, systemd-run the transient ones.

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RunResult } from "./app-supervisor.ts";
import { isProtectedUnitEntry } from "./office-units.ts";
import type { AgentUnit, TransientExec } from "../shared/office-move.ts";

/** The record of the units the move lock changed, in the state root. */
export const MOVE_UNITS_FILE = "move-units.json";

/** Runs systemctl / systemd-run without a shell. Production: the app
 *  supervisor's host.run (it reaches the user manager from a system-service
 *  install too). */
export type UnitRunner = (argv: string[]) => RunResult;

export type { AgentUnit, TransientExec } from "../shared/office-move.ts";

export interface UnitContext {
  /** The office user's home. */
  home: string;
  /** The office's app unit prefix (unitPrefixFor). */
  appPrefix: string;
  /** The office's own user unit, or null (system unit, no unit). */
  officeUnit: string | null;
  /** The office user's uid (the transient unit dir is under /run/user/<uid>). */
  uid: number;
}

/** The unit types a move stops and restores. */
const MOVE_UNIT_TYPES = ["service", "timer", "socket", "path"] as const;

const SHOW_PROPS = ["Id", "FragmentPath", "UnitFileState", "ActiveState"];

const systemctlUser = (...args: string[]) => ["systemctl", "--user", ...args];

/** The agent-made units of the office user, unit files and transient. */
export function listAgentUnits(run: UnitRunner, ctx: UnitContext): AgentUnit[] {
  const types = `--type=${MOVE_UNIT_TYPES.join(",")}`;
  // The unit files, and the loaded units: a running instance of a template
  // and a transient unit are only in the second list.
  const lists = [
    systemctlUser("list-unit-files", "--no-legend", "--no-pager", types),
    systemctlUser(
      "list-units",
      "--all",
      "--no-legend",
      "--no-pager",
      "--plain",
      types,
    ),
  ];
  const seen = new Set<string>();
  for (const argv of lists) {
    const listed = run(argv);
    if (listed.code !== 0)
      throw new Error(
        `systemctl ${argv[2]} failed: ${listed.stderr.trim() || listed.code}`,
      );
    for (const line of listed.stdout.split("\n")) {
      const name = line.trim().split(/\s+/)[0];
      if (
        name &&
        MOVE_UNIT_TYPES.some((t) => name.endsWith(`.${t}`)) &&
        // A template (foo@.service) is no unit: show refuses its name.
        !/@\.[a-z]+$/.test(name) &&
        !isProtectedUnitEntry(name, {
          appPrefix: ctx.appPrefix,
          officeUnit: ctx.officeUnit,
        })
      )
        seen.add(name);
    }
  }
  const names = [...seen].sort();
  if (names.length === 0) return [];
  const shown = run(
    systemctlUser(
      "show",
      "--no-pager",
      `--property=${SHOW_PROPS.join(",")}`,
      ...names,
    ),
  );
  if (shown.code !== 0)
    throw new Error(
      `systemctl show failed: ${shown.stderr.trim() || shown.code}`,
    );
  const home = ctx.home.endsWith("/") ? ctx.home : `${ctx.home}/`;
  const transientDir = `/run/user/${ctx.uid}/systemd/transient/`;
  const units: AgentUnit[] = [];
  const blocks = shown.stdout.split(/\n\s*\n/);
  names.forEach((name, i) => {
    const props = parseProps(blocks[i] ?? "");
    const fragmentPath = props.get("FragmentPath") ?? "";
    const transient = fragmentPath.startsWith(transientDir);
    if (!transient && !fragmentPath.startsWith(home)) return;
    const activeState = props.get("ActiveState") ?? "";
    const unit: AgentUnit = {
      name,
      fragmentPath,
      unitFileState: props.get("UnitFileState") ?? "",
      activeState,
      transient,
    };
    if (transient && activeState === "active")
      unit.exec = transientExec(run, name);
    units.push(unit);
  });
  return units;
}

function parseProps(block: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of block.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return props;
}

// How to start a transient unit again, from its fragment (`systemctl cat`):
// systemd writes each word of ExecStart= and Environment= in double quotes,
// with \\ and \" escaped. `systemctl show` prints argv joined with spaces and
// no quotes, so `bash -c 'a; b'` would come back as `bash -c a;`. null when
// the fragment cannot be read exactly: a prefix (- @ : + !), a specifier, more
// than one command, or quoting it cannot parse. The restore then lists the
// unit as not restored.
function transientExec(run: UnitRunner, name: string): TransientExec | null {
  const r = run(systemctlUser("cat", "--no-pager", name));
  if (r.code !== 0) return null;
  let section = "";
  let exec: string[] = [];
  let environment: string[] = [];
  let workingDirectory: string | null = null;
  for (const raw of r.stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line.startsWith(";") || line === "") continue;
    if (/^\[.*\]$/.test(line)) {
      section = line;
      continue;
    }
    if (section !== "[Service]") continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "ExecStart") {
      // An empty assignment resets the list.
      if (value === "") exec = [];
      else exec.push(value);
    } else if (key === "Environment") {
      if (value === "") environment = [];
      else {
        const words = unitWords(value, { command: false });
        if (!words) return null;
        environment.push(...words);
      }
    } else if (key === "WorkingDirectory") {
      workingDirectory = value === "" ? null : value;
    }
  }
  if (exec.length !== 1) return null;
  if (/^"?[-@:+!]/.test(exec[0])) return null;
  const argv = unitWords(exec[0], { command: true });
  if (!argv || argv.length === 0 || argv.includes(";")) return null;
  if (workingDirectory && /^[-~!]|%/.test(workingDirectory)) return null;
  return { argv, workingDirectory, environment };
}

// The words of a unit file value: whitespace-separated, a word in double
// quotes may hold spaces, \\ and \" (and \n, \t) are escapes, %% is a %,
// and in a command $$ is a $. null for anything else (an open quote,
// another escape, a lone % or a lone $ in a command: systemd would expand
// it).
function unitWords(text: string, opts: { command: boolean }): string[] | null {
  const words: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    let word = "";
    if (text[i] === '"') {
      i++;
      let closed = false;
      while (i < text.length) {
        const c = text[i];
        if (c === "\\") {
          const n = text[i + 1];
          const esc: Record<string, string> = {
            "\\": "\\",
            '"': '"',
            n: "\n",
            t: "\t",
          };
          if (n === undefined || !(n in esc)) return null;
          word += esc[n];
          i += 2;
        } else if (c === '"') {
          closed = true;
          i++;
          break;
        } else {
          word += c;
          i++;
        }
      }
      if (!closed) return null;
      if (i < text.length && !/\s/.test(text[i])) return null;
    } else {
      while (i < text.length && !/\s/.test(text[i])) {
        if (text[i] === '"' || text[i] === "'" || text[i] === "\\") return null;
        word += text[i++];
      }
    }
    const plain = unescapeUnitWord(word, opts.command);
    if (plain === null) return null;
    words.push(plain);
  }
  return words;
}

// systemd writes a literal % as %% everywhere, and a literal $ as $$ in a
// command (ExecStart=), where $NAME is a variable. systemd 255 on this box
// writes Environment="A=x$HOME 5%% y" and ExecStart=... "echo \"$$HOME\"".
function unescapeUnitWord(word: string, command: boolean): string | null {
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === "%" || (command && c === "$")) {
      if (word[i + 1] !== c) return null;
      out += c;
      i++;
    } else out += c;
  }
  return out;
}

/** At the lock: writes MOVE_UNITS_FILE (the units as listed), then disables
 *  the "enabled" ones and stops the active ones (transient included). A
 *  failed systemctl is logged and the next unit still runs. Throws only when
 *  the record cannot be written, before any change. */
export function stopUnitsForMove(
  stateRoot: string,
  run: UnitRunner,
  units: AgentUnit[],
): void {
  writeUnitsRecord(stateRoot, units);
  stopRecordedUnits(run, units);
}

/** Disables the "enabled" units and stops the other active ones, from a
 *  record as the lock wrote it. The MOVE-locked boot runs it again as a
 *  safety net, without rewriting the record (a disabled unit reads
 *  "disabled" by then). A failure is logged and the next unit still runs. */
export function stopRecordedUnits(run: UnitRunner, units: AgentUnit[]): void {
  for (const unit of units) {
    // Only exactly "enabled": disable also removes a linked unit's link.
    const argv =
      unit.unitFileState === "enabled"
        ? systemctlUser("disable", "--now", unit.name)
        : unit.activeState === "active"
          ? systemctlUser("stop", unit.name)
          : null;
    if (!argv) continue;
    const r = run(argv);
    if (r.code !== 0)
      console.error(
        `[move] ${argv.slice(2).join(" ")} failed: ${r.stderr.trim() || r.code}`,
      );
  }
}

/** Writes MOVE_UNITS_FILE (0600: a transient unit's environment may hold a
 *  secret). The lock route writes it before the state turns to "move"; the
 *  stop step writes it again. */
export function writeUnitsRecord(stateRoot: string, units: AgentUnit[]): void {
  const path = join(stateRoot, MOVE_UNITS_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(units)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export interface UnitRestoreResult {
  restored: string[];
  /** Units that could not be started again exactly, with why. */
  failed: { name: string; reason: string }[];
}

/** At the first normal boot after a cancel or a lockdown-then-unlock:
 *  restores from MOVE_UNITS_FILE and deletes it. No record: nothing to do. */
export function restoreUnitsAfterMove(
  stateRoot: string,
  run: UnitRunner,
): UnitRestoreResult {
  const path = join(stateRoot, MOVE_UNITS_FILE);
  const result: UnitRestoreResult = { restored: [], failed: [] };
  if (!existsSync(path)) return result;
  let units: AgentUnit[] = [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(raw))
      units = raw.filter(
        (u): u is AgentUnit =>
          !!u &&
          typeof u === "object" &&
          typeof (u as AgentUnit).name === "string",
      );
  } catch (err) {
    console.error("[move] the units record is unreadable:", err);
  }
  for (const unit of units) {
    const reason = restoreOne(run, unit);
    if (reason) result.failed.push({ name: unit.name, reason });
    else result.restored.push(unit.name);
  }
  rmSync(path, { force: true });
  return result;
}

// null when the unit is back as it was, else why not.
function restoreOne(run: UnitRunner, unit: AgentUnit): string | null {
  const fail = (r: RunResult) => r.stderr.trim() || `exit ${r.code}`;
  if (unit.transient) {
    if (unit.activeState !== "active") return null;
    if (!unit.exec) return "its command could not be read at the lock";
    const argv = ["systemd-run", "--user", `--unit=${unit.name}`, "--collect"];
    if (unit.exec.workingDirectory)
      argv.push(`--working-directory=${unit.exec.workingDirectory}`);
    for (const entry of unit.exec.environment) argv.push("-E", entry);
    argv.push("--", ...unit.exec.argv);
    const r = run(argv);
    return r.code === 0 ? null : fail(r);
  }
  if (unit.unitFileState === "enabled") {
    const r = run(systemctlUser("enable", unit.name));
    if (r.code !== 0) return fail(r);
  }
  if (unit.activeState === "active") {
    const r = run(systemctlUser("start", unit.name));
    if (r.code !== 0) return fail(r);
  }
  return null;
}

/** The office's own unit and its Restart= value, from /proc/self/cgroup text
 *  (a user unit under user@<uid>.service, or a system unit). null when the
 *  office runs under no unit. */
export function officeRestartPolicy(
  cgroupText: string,
  run: UnitRunner,
): { unit: string; manager: "user" | "system"; restart: string } | null {
  const line = cgroupText.split("\n").find((l) => l.startsWith("0::"));
  if (line === undefined) return null;
  const parts = line.slice("0::".length).split("/");
  const leaf = parts[parts.length - 1];
  if (!leaf.endsWith(".service")) return null;
  const underUser = parts.some((p) => /^user@\d+\.service$/.test(p));
  if (/^user@\d+\.service$/.test(leaf)) return null;
  const manager = underUser ? "user" : "system";
  const argv = [
    "systemctl",
    ...(underUser ? ["--user"] : []),
    "show",
    "--property=Restart",
    "--value",
    leaf,
  ];
  const r = run(argv);
  if (r.code !== 0) return null;
  return { unit: leaf, manager, restart: r.stdout.trim() };
}
