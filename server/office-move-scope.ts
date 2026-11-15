// What an office move copies (task 78733adf, slice 2a; design:
// internal-docs/office-move-design.md "Scope"). One predicate decides for the
// manifest walk and for each path of a batch, over paths relative to the
// office user's home. It never touches the disk: the SQLite side-file rule
// needs the disk, so the walk and the batch apply it (office-move-pull.ts).

import { isAbsolute, relative, sep } from "node:path";
import { BACKUP_EXCLUSIONS } from "./backup-exclusions.ts";
import { BACKEND_CREDENTIAL_PATHS } from "./backend-credential-paths.ts";
import {
  MOVE_CANCELLED_FILE,
  MOVE_LOCK_MARKER,
  MOVE_STATE_FILE,
} from "./office-move.ts";
import { MOVE_UNITS_FILE } from "./office-move-units.ts";

/** The kind of a home entry, from lstat (a symlink is never followed). */
export type MoveEntryKind = "file" | "dir" | "symlink" | "other";

/** The move's scratch folder in the state root (manifests, snapshots). */
export const MOVE_SCRATCH_DIR = "move-pull";

export interface MoveScope {
  /** The office user's home, absolute. */
  home: string;
  /** The state root relative to the home, or null when it is outside. */
  stateRootRel: string | null;
  /** The code folder relative to the home, or null when it is outside. */
  codeDirRel: string | null;
  /** The backup folder relative to the home, or null when it is outside. */
  backupDirRel: string | null;
  /** Built by createMoveScope. */
  readonly rules: MoveScopeRules;
}

export type MoveScopeVerdict =
  | { in: true }
  /** Left out and not counted (caches, the code folder, specials...). */
  | { in: false; why: "out" }
  /** A sign-in unit: left out and counted for the after-move report. */
  | { in: false; why: "signin"; unit: string };

interface UnitRule {
  unit: string;
  test: RegExp;
}

interface MoveScopeRules {
  /** Folders (or files) left out with all they hold. */
  out: string[];
  /** One regex over every sign-in rule, to skip the per-unit loop. */
  anySignin: RegExp | null;
  signins: UnitRule[];
}

/** The home's caches and build caches, rooted at the home. */
const HOME_CACHES = [
  ".cache",
  ".bun",
  ".npm/_cacache",
  "go/pkg/mod",
  ".cargo/registry",
];

/** The move's own files in the state root: left out, not counted. */
const MOVE_OWN_FILES = [
  MOVE_STATE_FILE,
  `${MOVE_STATE_FILE}.tmp`,
  MOVE_UNITS_FILE,
  `${MOVE_UNITS_FILE}.tmp`,
  MOVE_CANCELLED_FILE,
  MOVE_LOCK_MARKER,
  MOVE_SCRATCH_DIR,
];

/** Sign-in units rooted at the home. */
const HOME_SIGNINS: { unit: string; path: string }[] = [
  { unit: "ssh", path: ".ssh" },
  { unit: "gh", path: ".config/gh" },
];

/** Files bound to the old office's origin, in the state root. */
const ORIGIN_BOUND: { unit: string; name: string }[] = [
  { unit: "browser-sessions", name: "sessions.json" },
  { unit: "invites", name: "invites.json" },
  { unit: "api-tokens", name: "api-tokens.json" },
  { unit: "extension-pairings", name: "browser-connections.json" },
  { unit: "app-sessions", name: "app-sessions.json" },
  { unit: "web-push", name: "web-push.json" },
];

function relInHome(home: string, path: string | null): string | null {
  if (!path) return null;
  const rel = relative(home, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return null;
  return rel.split(sep).join("/");
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A glob as tar reads an exclusion (GNU tar --anchored --wildcards): "*"
// matches any run of characters, "/" too; "?" one character; "\x" a literal
// x. As tar does not enter an excluded folder, the pattern also covers all
// it holds.
function tarGlobSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) out += escapeRegex(glob[++i]);
    else if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else out += escapeRegex(c);
  }
  return out;
}

const rooted = (source: string) => `^(?:${source})(?:/.*)?$`;

function buildRules(
  stateRootRel: string | null,
  out: string[],
): MoveScopeRules {
  const signins: UnitRule[] = [];
  if (stateRootRel !== null) {
    // The state root's name as a glob literal, as backup.ts escapes it.
    const root = stateRootRel.replace(/[\\*?[\]]/g, "\\$&");
    for (const entry of BACKUP_EXCLUSIONS) {
      // The move's own files are "out" (above).
      if (entry.id === "office-move") continue;
      const sources = entry.archivePatterns(root).map(tarGlobSource);
      if (sources.length > 0)
        signins.push({
          unit: entry.id,
          test: new RegExp(rooted(sources.join("|"))),
        });
    }
    for (const { unit, name } of ORIGIN_BOUND)
      signins.push({
        unit,
        test: new RegExp(rooted(escapeRegex(`${stateRootRel}/${name}`))),
      });
  }
  // Backend sign-in files at any depth of the home. An entry the backup
  // keeps holds more than a sign-in, so it moves.
  for (const entry of BACKEND_CREDENTIAL_PATHS)
    if (entry.backup !== "keep")
      signins.push({ unit: entry.id, test: entry.pattern });
  for (const { unit, path } of HOME_SIGNINS)
    signins.push({ unit, test: new RegExp(rooted(escapeRegex(path))) });
  return {
    out,
    anySignin:
      signins.length > 0
        ? new RegExp(signins.map((r) => `(?:${r.test.source})`).join("|"))
        : null,
    signins,
  };
}

/** The scope of this office: the folders as absolute paths, each made
 *  relative to the home (null when outside it). The rules are built here,
 *  from the backup's exclusion list as it is now. */
export function createMoveScope(input: {
  home: string;
  stateRoot: string;
  codeDir: string | null;
  backupDir: string | null;
}): MoveScope {
  const stateRootRel = relInHome(input.home, input.stateRoot);
  const codeDirRel = relInHome(input.home, input.codeDir);
  const backupDirRel = relInHome(input.home, input.backupDir);
  const out = [...HOME_CACHES];
  if (codeDirRel) out.push(codeDirRel);
  if (backupDirRel) out.push(backupDirRel);
  if (stateRootRel !== null)
    for (const name of MOVE_OWN_FILES) out.push(`${stateRootRel}/${name}`);
  return {
    home: input.home,
    stateRootRel,
    codeDirRel,
    backupDirRel,
    rules: buildRules(stateRootRel, out),
  };
}

const OUT: MoveScopeVerdict = { in: false, why: "out" };
const IN: MoveScopeVerdict = { in: true };

/** Whether a home entry moves. `relPath` uses "/" and has no leading "/". */
export function moveScope(
  scope: MoveScope,
  relPath: string,
  kind: MoveEntryKind,
): MoveScopeVerdict {
  if (kind === "other") return OUT;
  for (const prefix of scope.rules.out)
    if (relPath === prefix || relPath.startsWith(`${prefix}/`)) return OUT;
  const { anySignin, signins } = scope.rules;
  if (anySignin && anySignin.test(relPath))
    for (const rule of signins)
      if (rule.test.test(relPath))
        return { in: false, why: "signin", unit: rule.unit };
  return IN;
}
