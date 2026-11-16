// The swap of an office move-in (task 78733adf, slice 2c-1; design:
// internal-docs/office-move-design.md "The swap"). After the old office
// answered `done`, the new office stores the swap's inputs in
// `<home>/.isomux-move-in/swap.json` and restarts. The next boot, before any
// state module loads, puts the stage in place of the fresh office's home:
//
// - keep: every path of the home that the new box's move scope leaves out
//   (out or bound: its code folder, caches, the files bound to its origin,
//   its SSH login keys, the move's own files, the move-in folder), the office id, and the
//   new office's own user unit. The kept paths stay where they are.
// - ops: renames one level at a time ("a swap with holes"). A folder with a
//   kept path inside is entered; any other entry moves whole. The first swap
//   boot computes the ops from the home as it is then and writes them to
//   swap.json before the first rename; a resumed boot uses the stored ops.
// - then the merges (users.json, office-config.json), the fresh office's
//   backups deleted, move-units.json, the state `moved` with the report, and
//   swap.json deleted last. Every step can run again with the same result.
//
// A failed op or step leaves swap.json: the process boots the swap-failed
// server (server/move-swap-failed-office.ts), which loads no state.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { dirname, join } from "node:path";
import { errMessage } from "../shared/errors.ts";
import { isBackupEntryName } from "./backup.ts";
import {
  MOVE_IN_DIR,
  MOVE_IN_STATE_FILE,
  type MoveBoxInfo,
  type MoveOfficeUnit,
} from "./office-move.ts";
import {
  createMoveScope,
  moveScope,
  type MoveEntryKind,
} from "./office-move-scope.ts";
import { MOVE_IN_STAGE } from "./office-move-stage.ts";
import { writeUnitsRecord, type AgentUnit } from "./office-move-units.ts";
import { OFFICE_CONFIG_BOX_KEYS } from "./persistence.ts";
import type { MoveInReport, MoveInReportInput } from "../shared/office-move.ts";

/** The swap file, in the move-in folder (MOVE_IN_DIR). */
export const MOVE_IN_SWAP_FILE = "swap.json";
/** The fresh office's entries that the swap replaced, in the move-in folder. */
export const MOVE_IN_ASIDE = "aside";
/** In the aside folder: stage entries the swap did not put in place (a kept
 *  path, the old office's own unit). */
export const MOVE_IN_FROM_STAGE = ".from-stage";

/** The most entries the walk of the fresh home reads before it refuses (a
 *  fresh home is small). */
export const MOVE_IN_SWAP_WALK_MAX = 200_000;

/** One rename. Paths are relative to the home, with "/". */
export type MoveInSwapOp =
  /** home/path -> aside/path, only when home/path exists and aside/path
   *  does not. */
  | { op: "aside"; path: string }
  /** stage/path -> home/path, only when stage/path exists and home/path does
   *  not. Both present is a conflict: an error, never a skip. */
  | { op: "in"; path: string }
  /** stage/path -> aside/.from-stage/path (a kept path, the old office's own
   *  unit). */
  | { op: "drop"; path: string };

export type { MoveInReport, MoveInReportInput } from "../shared/office-move.ts";

/** What finish stores; the swap boot computes the rest from the disk. */
export interface MoveInSwapInputs {
  version: 1;
  home: string;
  stateRoot: string;
  /** The running server's code folder and the backup folder (the new box's
   *  move scope leaves them out). */
  codeDir: string | null;
  backupDir: string | null;
  /** The new office's own user unit, kept. null: a system unit or none. */
  newOfficeUnit: MoveOfficeUnit | null;
  /** The old office's own user unit, as its redeem answered: its file, its
   *  drop-in folder and its links go to aside/.from-stage. */
  oldOfficeUnit: MoveOfficeUnit | null;
  /** The fresh office's one owner, kept in users.json with this id. */
  ownerId: string;
  /** The old office's units record (the manifest's), written as
   *  move-units.json. */
  units: AgentUnit[];
  report: MoveInReportInput;
  /** The most entries the walk of the fresh home reads (default
   *  MOVE_IN_SWAP_WALK_MAX). */
  walkMax?: number;
  /** Whether this office listened on loopback only when the owner finished.
   *  A failed swap's page binds by it, never by the state root, which may
   *  hold the old office's settings by then. Absent: loopback. */
  loopbackOnly?: boolean;
}

export interface MoveInSwapFile {
  inputs: MoveInSwapInputs;
  /** null until the first swap boot computes them. */
  ops: MoveInSwapOp[] | null;
}

/** Why finish refuses before it sends `done` (the dry run). */
export type MoveInSwapRefusal =
  | { code: "home_too_big"; entries: number }
  | { code: "home_has_mounts"; paths: string[] }
  | { code: "account_clash"; id: string }
  | { code: "swap_unreadable"; message: string };

/** The walk of the fresh home passed its cap. */
export class MoveInSwapTooBig extends Error {
  constructor(readonly entries: number) {
    super(`The home has more than ${entries} entries to read.`);
    this.name = "MoveInSwapTooBig";
  }
}

// ---- paths ----

/** The folders of a user's own unit files, relative to the home. */
const UNIT_DIRS = [".config/systemd/user", ".local/share/systemd/user"];
/** The folders of a unit's enable links. */
const LINK_DIR_RE = /\.(?:wants|requires|upholds)$/;

const moveInDirOf = (home: string) => join(home, MOVE_IN_DIR);
const stageOf = (home: string) => join(moveInDirOf(home), MOVE_IN_STAGE);
const asideOf = (home: string) => join(moveInDirOf(home), MOVE_IN_ASIDE);
const swapFileOf = (home: string) => join(moveInDirOf(home), MOVE_IN_SWAP_FILE);

/** A path relative to the home with "/", or null outside it. */
function relInHome(home: string, abs: string | null): string | null {
  if (!abs) return null;
  const prefix = home.endsWith("/") ? home : `${home}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
}

function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

const exists = (p: string) => lstatOrNull(p) !== null;
const isRealDir = (p: string) => lstatOrNull(p)?.isDirectory() === true;

function listDir(p: string): Dirent[] {
  return isRealDir(p) ? readdirSync(p, { withFileTypes: true }) : [];
}

const kindOf = (d: Dirent): MoveEntryKind =>
  d.isSymbolicLink()
    ? "symlink"
    : d.isDirectory()
      ? "dir"
      : d.isFile()
        ? "file"
        : "other";

/** The paths of an office's own unit under `root` (a home or the stage),
 *  relative: its file, its drop-in folder and its enable links. Only those
 *  that exist. */
function unitPaths(
  home: string,
  root: string,
  unit: MoveOfficeUnit | null,
): string[] {
  if (!unit) return [];
  const out = new Set<string>();
  const frag = relInHome(home, unit.fragmentPath);
  if (frag) {
    out.add(frag);
    out.add(`${frag}.d`);
  }
  for (const dir of UNIT_DIRS) {
    out.add(`${dir}/${unit.name}`);
    out.add(`${dir}/${unit.name}.d`);
    for (const d of listDir(join(root, dir)))
      if (d.isDirectory() && LINK_DIR_RE.test(d.name))
        out.add(`${dir}/${d.name}/${unit.name}`);
  }
  return [...out].filter((p) => exists(join(root, p))).sort();
}

// ---- the keep rule ----

/** The keep walk as a generator: it yields about every 10 ms, so finish's
 *  dry run can give the event loop a turn; the boot drives it to the end. */
function* keepWalk(inputs: MoveInSwapInputs): Generator<void, string[]> {
  const { home } = inputs;
  const scope = createMoveScope({
    home,
    stateRoot: inputs.stateRoot,
    codeDir: inputs.codeDir,
    backupDir: inputs.backupDir,
  });
  const max = inputs.walkMax ?? MOVE_IN_SWAP_WALK_MAX;
  const keep = new Set<string>();
  let entries = 0;
  let last = performance.now();
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    for (const d of listDir(rel ? join(home, rel) : home)) {
      if (++entries > max) throw new MoveInSwapTooBig(max);
      const r = rel ? `${rel}/${d.name}` : d.name;
      const kind = kindOf(d);
      // The side-file rule of the walk is not applied: a fresh -wal goes
      // aside with the fresh database, never next to the old one.
      if (!moveScope(scope, r, kind).in) keep.add(r);
      else if (kind === "dir") stack.push(r);
      if (performance.now() - last > 10) {
        yield;
        last = performance.now();
      }
    }
  }
  if (scope.stateRootRel !== null) {
    const id = `${scope.stateRootRel}/office-id`;
    if (exists(join(home, id))) keep.add(id);
  }
  for (const p of unitPaths(home, home, inputs.newOfficeUnit)) keep.add(p);
  return [...keep].sort();
}

function runToEnd<T>(gen: Generator<void, T>): T {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

async function runYielding<T>(gen: Generator<void, T>): Promise<T> {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** The paths of the home that the swap keeps, from the disk as it is now.
 *  Sorted. Throws MoveInSwapTooBig past the walk's cap. */
export function moveInKeepPaths(inputs: MoveInSwapInputs): string[] {
  return runToEnd(keepWalk(inputs));
}

// ---- the plan ----

function planWithKeep(
  inputs: MoveInSwapInputs,
  keepList: string[],
): MoveInSwapOp[] {
  const { home } = inputs;
  const stage = stageOf(home);
  const keep = new Set(keepList);
  const ops: MoveInSwapOp[] = [];
  // B2: the old office's own unit leaves the stage first, so the rest of
  // its folder moves as usual.
  const dropped = new Set(unitPaths(home, stage, inputs.oldOfficeUnit));
  for (const p of dropped) ops.push({ op: "drop", path: p });
  const keepUnder = (p: string) => {
    const prefix = `${p}/`;
    for (const k of keep) if (k.startsWith(prefix)) return true;
    return false;
  };
  const visit = (rel: string) => {
    const at = (root: string) => (rel ? join(root, rel) : root);
    const inHome = new Set(listDir(at(home)).map((d) => d.name));
    const inStage = new Map<string, Dirent>();
    for (const d of listDir(at(stage))) {
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (!dropped.has(p)) inStage.set(d.name, d);
    }
    const names = [...new Set([...inHome, ...inStage.keys()])].sort();
    for (const name of names) {
      const p = rel ? `${rel}/${name}` : name;
      const fromStage = inStage.get(name);
      if (keep.has(p)) {
        if (fromStage) ops.push({ op: "drop", path: p });
        continue;
      }
      if (keepUnder(p)) {
        // A hole folder: it stays, and its entries go one by one.
        if (fromStage && !fromStage.isDirectory()) {
          ops.push({ op: "drop", path: p });
          dropped.add(p);
        }
        visit(p);
        continue;
      }
      if (inHome.has(name)) ops.push({ op: "aside", path: p });
      if (fromStage) ops.push({ op: "in", path: p });
    }
  };
  visit("");
  return ops;
}

/** The ops, from the home and the stage as they are now. */
export function planMoveInSwap(inputs: MoveInSwapInputs): MoveInSwapOp[] {
  return planWithKeep(inputs, moveInKeepPaths(inputs));
}

// ---- finish's dry run ----

function readJsonObject(p: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  const v: unknown = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error(`${p} is not a JSON object.`);
  return v as Record<string, unknown>;
}

const stateRel = (inputs: MoveInSwapInputs) =>
  relInHome(inputs.home, inputs.stateRoot);

/** finish's dry run, before `done`: the walk and its cap, the devices, the
 *  account id. Changes nothing. Yields to the event loop about every 10 ms. */
export async function checkMoveInSwap(
  inputs: MoveInSwapInputs,
): Promise<MoveInSwapRefusal[]> {
  const out: MoveInSwapRefusal[] = [];
  try {
    const rel = stateRel(inputs);
    if (rel === null)
      return [
        {
          code: "swap_unreadable",
          message: "The office's data folder is not inside the home.",
        },
      ];
    let keep: string[];
    try {
      keep = await runYielding(keepWalk(inputs));
    } catch (err) {
      if (err instanceof MoveInSwapTooBig)
        return [{ code: "home_too_big", entries: err.entries }];
      throw err;
    }
    // D6: the fresh owner, and an old user with the same id.
    const fresh = readJsonObject(join(inputs.home, rel, "users.json"));
    if (!fresh || !fresh[inputs.ownerId])
      out.push({
        code: "swap_unreadable",
        message: "This office's owner is not in its users.json.",
      });
    const old = readJsonObject(join(stageOf(inputs.home), rel, "users.json"));
    if (old && Object.hasOwn(old, inputs.ownerId))
      out.push({ code: "account_clash", id: inputs.ownerId });
    // D4: every rename stays on the home's device.
    const dev = statSync(inputs.home).dev;
    const mounts = new Set<string>();
    const check = (abs: string, shown: string) => {
      const st = lstatOrNull(abs);
      if (st && st.dev !== dev) mounts.add(shown);
    };
    check(moveInDirOf(inputs.home), MOVE_IN_DIR);
    check(stageOf(inputs.home), `${MOVE_IN_DIR}/${MOVE_IN_STAGE}`);
    check(asideOf(inputs.home), `${MOVE_IN_DIR}/${MOVE_IN_ASIDE}`);
    for (const op of planWithKeep(inputs, keep)) {
      if (op.op === "aside") check(join(inputs.home, op.path), op.path);
      else {
        check(join(stageOf(inputs.home), op.path), op.path);
        if (op.op === "in") {
          const parent = dirname(op.path);
          check(join(inputs.home, parent === "." ? "" : parent), op.path);
        }
      }
    }
    if (mounts.size > 0)
      out.push({ code: "home_has_mounts", paths: [...mounts].sort() });
  } catch (err) {
    out.push({ code: "swap_unreadable", message: errMessage(err) });
  }
  return out;
}

// ---- swap.json ----

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Writes swap.json (atomic, 0600). */
export function writeMoveInSwapFile(home: string, file: MoveInSwapFile): void {
  mkdirSync(moveInDirOf(home), { recursive: true, mode: 0o700 });
  writeAtomic(swapFileOf(home), `${JSON.stringify(file)}\n`);
}

function readMoveInSwapFile(home: string): MoveInSwapFile | null {
  let text: string;
  try {
    text = readFileSync(swapFileOf(home), "utf8");
  } catch {
    return null;
  }
  const v = JSON.parse(text) as MoveInSwapFile;
  if (!v || typeof v !== "object" || !v.inputs || v.inputs.version !== 1)
    throw new Error("swap.json does not parse.");
  return v;
}

// ---- the swap ----

export type MoveInSwapBoot =
  | { kind: "none" }
  | { kind: "swapped"; report: MoveInReport }
  | {
      kind: "failed";
      /** The op or step that failed. */
      step: string;
      message: string;
      /** Where the swap-failed page listens (swap.json's; loopback when it
       *  did not read). */
      loopbackOnly: boolean;
    };

class StepFailed extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = "StepFailed";
  }
}

function runOp(home: string, op: MoveInSwapOp): void {
  const stage = stageOf(home);
  const aside = asideOf(home);
  const move = (src: string, dst: string) => {
    mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    renameSync(src, dst);
  };
  switch (op.op) {
    case "aside": {
      const src = join(home, op.path);
      const dst = join(aside, op.path);
      // Done already (and maybe its `in` too), or nothing to set aside.
      if (exists(dst) || !exists(src)) return;
      move(src, dst);
      return;
    }
    case "in": {
      const src = join(stage, op.path);
      const dst = join(home, op.path);
      if (!exists(src)) return;
      if (exists(dst))
        throw new Error(
          `${op.path} is in the copy and also on this machine. Move one of them away, then try again.`,
        );
      // The parent is a hole folder of the home: it exists.
      renameSync(src, dst);
      return;
    }
    case "drop": {
      const src = join(stage, op.path);
      const dst = join(aside, MOVE_IN_FROM_STAGE, op.path);
      if (!exists(src)) return;
      if (exists(dst))
        throw new Error(`${op.path} was set aside from the copy already.`);
      move(src, dst);
      return;
    }
  }
}

/** The first `in` whose home path is taken by an entry no earlier op sets
 *  aside, or null. */
function inConflict(home: string, ops: MoveInSwapOp[]): string | null {
  const asideOps = new Set(
    ops.filter((o) => o.op === "aside").map((o) => o.path),
  );
  for (const op of ops) {
    if (op.op !== "in") continue;
    if (!exists(join(stageOf(home), op.path))) continue; // in place already
    if (!exists(join(home, op.path))) continue;
    // home/p goes aside first, unless it went aside already (then what is
    // there now came later).
    if (asideOps.has(op.path) && !exists(join(asideOf(home), op.path)))
      continue;
    return op.path;
  }
  return null;
}

/** The files and links left in the stage (empty folders may stay). */
function stageLeft(home: string): string[] {
  const left: string[] = [];
  const stack = [""];
  const stage = stageOf(home);
  while (stack.length > 0 && left.length < 10) {
    const rel = stack.pop()!;
    for (const d of listDir(rel ? join(stage, rel) : stage)) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) stack.push(r);
      else left.push(r);
    }
  }
  return left.sort();
}

type UserRec = Record<string, unknown> & { name?: unknown };

/** The name the fresh owner gets: its own, or a free "<name> new box". */
function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " new box" : ` new box ${n}`;
    const candidate = `${name.slice(0, 64 - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function mergeUsers(inputs: MoveInSwapInputs, rel: string): void {
  const path = join(inputs.home, rel, "users.json");
  const users = readJsonObject(path) ?? {};
  if (Object.hasOwn(users, inputs.ownerId)) return; // merged already
  const fresh = readJsonObject(join(asideOf(inputs.home), rel, "users.json"));
  const rec = fresh?.[inputs.ownerId] as UserRec | undefined;
  if (!rec || typeof rec.name !== "string")
    throw new Error("The fresh office's owner is not in its users.json.");
  const taken = new Set(
    Object.values(users)
      .map((u) => (u as UserRec)?.name)
      .filter((n): n is string => typeof n === "string")
      .map((n) => n.toLowerCase()),
  );
  users[inputs.ownerId] = { ...rec, name: freeName(rec.name, taken) };
  writeAtomic(path, JSON.stringify(users, null, 2));
}

function ownerRenamedTo(inputs: MoveInSwapInputs, rel: string): string | null {
  const users = readJsonObject(join(inputs.home, rel, "users.json")) ?? {};
  const fresh =
    readJsonObject(join(asideOf(inputs.home), rel, "users.json")) ?? {};
  const now = (users[inputs.ownerId] as UserRec | undefined)?.name;
  const was = (fresh[inputs.ownerId] as UserRec | undefined)?.name;
  return typeof now === "string" && now !== was ? now : null;
}

function mergeConfig(inputs: MoveInSwapInputs, rel: string): void {
  const path = join(inputs.home, rel, "office-config.json");
  const old = readJsonObject(path);
  const fresh =
    readJsonObject(join(asideOf(inputs.home), rel, "office-config.json")) ?? {};
  if (!old && !OFFICE_CONFIG_BOX_KEYS.some((k) => Object.hasOwn(fresh, k)))
    return;
  const merged: Record<string, unknown> = { ...(old ?? {}) };
  for (const k of OFFICE_CONFIG_BOX_KEYS) {
    if (Object.hasOwn(fresh, k)) merged[k] = fresh[k];
    else delete merged[k];
  }
  writeAtomic(path, JSON.stringify(merged, null, 2));
}

function deleteBackups(dir: string | null): void {
  if (!dir) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // No backup folder: nothing to delete.
  }
  for (const name of names)
    if (isBackupEntryName(name))
      rmSync(join(dir, name), { recursive: true, force: true });
}

function treeBytes(root: string): number {
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const p = stack.pop()!;
    const st = lstatOrNull(p);
    if (!st) continue;
    if (st.isDirectory())
      for (const n of readdirSync(p)) stack.push(join(p, n));
    else if (st.isFile()) bytes += st.size;
  }
  return bytes;
}

function buildReport(
  file: MoveInSwapFile,
  ops: MoveInSwapOp[],
  rel: string,
  now: Date,
): MoveInReport {
  const { inputs } = file;
  const old = inputs.oldOfficeUnit;
  const unitDropped =
    old !== null &&
    ops.some((o) => {
      if (o.op !== "drop") return false;
      const base = o.path.slice(o.path.lastIndexOf("/") + 1);
      return (
        (base === old.name || base === `${old.name}.d`) &&
        (UNIT_DIRS.some((d) => o.path.startsWith(`${d}/`)) ||
          o.path === relInHome(inputs.home, old.fragmentPath))
      );
    });
  const aside = asideOf(inputs.home);
  return {
    ...inputs.report,
    swappedAt: now.getTime(),
    ownerRenamedTo: ownerRenamedTo(inputs, rel),
    oldOfficeUnitSetAside: unitDropped ? old.name : null,
    aside: {
      entries: isRealDir(aside) ? readdirSync(aside).sort() : [],
      bytes: treeBytes(aside),
    },
    units: null,
    audited: false,
  };
}

/** At boot, before moveBootMode and before any state module reads the disk.
 *  No swap.json: nothing. */
export function runMoveInSwapAtBoot(input: {
  home: string;
  now(): Date;
  /** Test seam: called with a name before each op and each step (the plan's
   *  write included). A throw from it stands for a crash at that point: it
   *  leaves the function as it is, never caught or turned into `failed`. */
  onStep?: (step: string) => void;
}): MoveInSwapBoot {
  const { home } = input;
  const at = (step: string) => input.onStep?.(step);
  const run = (step: string, fn: () => void) => {
    at(step);
    try {
      fn();
    } catch (err) {
      throw new StepFailed(step, errMessage(err));
    }
  };
  let loopbackOnly = true;
  try {
    let file: MoveInSwapFile | null;
    try {
      file = readMoveInSwapFile(home);
    } catch (err) {
      throw new StepFailed("read swap.json", errMessage(err));
    }
    if (!file) return { kind: "none" };
    const { inputs } = file;
    loopbackOnly = inputs.loopbackOnly !== false;
    const rel = stateRel(inputs);
    if (inputs.home !== home || rel === null)
      throw new StepFailed(
        "read swap.json",
        "swap.json names another home or a data folder outside it.",
      );
    // B1: the ops come from the home as it is at this boot, and are on disk
    // before the first rename.
    if (file.ops === null) {
      const f = file;
      run("plan", () => {
        f.ops = planMoveInSwap(inputs);
        writeMoveInSwapFile(home, f);
      });
    }
    const ops = file.ops!;
    // An `in` that would find home/p in its way fails here, before any
    // rename: the swap never stops halfway on a conflict it could see.
    at("check the ops");
    const conflict = inConflict(home, ops);
    if (conflict)
      throw new StepFailed(
        `in ${conflict}`,
        `${conflict} is in the copy and also on this machine. Move one of them away, then try again.`,
      );
    for (const op of ops) run(`${op.op} ${op.path}`, () => runOp(home, op));
    run("check the copy is in place", () => {
      const left = stageLeft(home);
      if (left.length > 0)
        throw new Error(
          `The copy still holds entries the move did not place: ${left.join(", ")}`,
        );
    });
    run("users.json", () => mergeUsers(inputs, rel));
    run("office-config.json", () => mergeConfig(inputs, rel));
    run("backups", () => deleteBackups(inputs.backupDir));
    run("move-units.json", () =>
      writeUnitsRecord(inputs.stateRoot, inputs.units),
    );
    let report: MoveInReport | null = null;
    run("state", () => {
      report = buildReport(file, ops, rel, input.now());
      writeAtomic(
        join(inputs.stateRoot, MOVE_IN_STATE_FILE),
        `${JSON.stringify({
          phase: "moved",
          oldOrigin: inputs.report.oldOrigin,
          office: inputs.report.office,
          report,
        })}\n`,
      );
    });
    run("delete swap.json", () => rmSync(swapFileOf(home), { force: true }));
    return { kind: "swapped", report: report! };
  } catch (err) {
    if (err instanceof StepFailed)
      return {
        kind: "failed",
        step: err.step,
        message: err.message,
        loopbackOnly,
      };
    throw err;
  }
}

// ---- after the swap ----

/** The state `moved` as the swap wrote it, or null in any other state. */
export function readMovedIn(
  stateRoot: string,
): { oldOrigin: string; office: MoveBoxInfo; report: MoveInReport } | null {
  try {
    const v = readJsonObject(join(stateRoot, MOVE_IN_STATE_FILE));
    if (!v || v.phase !== "moved" || !v.report || typeof v.report !== "object")
      return null;
    return v as unknown as {
      oldOrigin: string;
      office: MoveBoxInfo;
      report: MoveInReport;
    };
  } catch {
    return null;
  }
}

/** The first normal boot after a move-in: the units put back, the audit
 *  row written. The report is written again with what it learned. */
export function writeMovedInReport(
  stateRoot: string,
  report: MoveInReport,
): void {
  const current = readMovedIn(stateRoot);
  if (!current) return;
  writeAtomic(
    join(stateRoot, MOVE_IN_STATE_FILE),
    `${JSON.stringify({ ...current, phase: "moved", report })}\n`,
  );
}
