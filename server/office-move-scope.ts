// What an office move copies (task 78733adf, slice 2a; design:
// internal-docs/office-move-design.md "Scope"). One predicate decides for the
// manifest walk and for each path of a batch, over paths relative to the
// office user's home. It never touches the disk: the SQLite side-file rule
// needs the disk, so the walk and the batch apply it (office-move-pull.ts).

import { isAbsolute, relative, sep } from "node:path";
import { BACKUP_EXCLUSIONS, tarGlobSource } from "./backup-exclusions.ts";
import { BACKEND_CREDENTIAL_PATHS } from "./backend-credential-paths.ts";
import {
  MOVE_CANCELLED_FILE,
  MOVE_IN_DIR,
  MOVE_IN_STATE_FILE,
  MOVE_LOCK_MARKER,
  MOVE_SCRATCH_DIR,
  MOVE_STATE_FILE,
} from "./office-move.ts";
import { MOVE_UNITS_FILE } from "./office-move-units.ts";

/** The kind of a home entry, from lstat (a symlink is never followed). */
export type MoveEntryKind = "file" | "dir" | "symlink" | "other";

export { MOVE_SCRATCH_DIR };

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
  /** Bound to the old box or its origin: left out, counted for the
   *  after-move report, and kept from the new box by the swap. */
  | { in: false; why: "bound"; unit: string };

interface UnitRule {
  unit: string;
  test: RegExp;
}

interface MoveScopeRules {
  /** Folders (or files) left out with all they hold. */
  out: string[];
  /** One regex over every bound rule, to skip the per-unit loop. */
  anyBound: RegExp | null;
  bound: UnitRule[];
  /** Slice 4: what a later pass fetches again whatever the manifests say. */
  alwaysFetch: RegExp;
}

/** The home's caches and build caches, rooted at the home. */
const HOME_CACHES = [
  // A move-in on this box (its stage holds another office's home).
  MOVE_IN_DIR,
  ".cache",
  ".bun",
  ".npm/_cacache",
  "go/pkg/mod",
  ".cargo/registry",
];

/** The move's own files in the state root: left out, not counted. */
const MOVE_OWN_FILES = [
  MOVE_IN_STATE_FILE,
  `${MOVE_IN_STATE_FILE}.tmp`,
  MOVE_STATE_FILE,
  `${MOVE_STATE_FILE}.tmp`,
  MOVE_UNITS_FILE,
  `${MOVE_UNITS_FILE}.tmp`,
  MOVE_CANCELLED_FILE,
  MOVE_LOCK_MARKER,
  MOVE_SCRATCH_DIR,
];

/** Units bound to the old box or its origin (slice 3): left out, counted for
 *  the after-move report, and kept from the new box by the swap. */
export const MOVE_BOUND_UNITS = [
  "browser-sessions",
  "app-sessions",
  "invites",
  "extension-pairings",
  "web-push",
  "ssh-authorized-keys",
] as const;

/** Sign-in and secret units that move with the office (slice 3). Every id
 *  of BACKUP_EXCLUSIONS and BACKEND_CREDENTIAL_PATHS is in exactly one of
 *  the two lists ("office-move" in neither: the move's own files are out). */
export const MOVE_CARRIED_UNITS = [
  "app-runtime-credentials",
  "container-app-tokens",
  "personal-environment",
  "office-environment",
  "secret-store",
  "removed-members",
  "mcp-server-registrations",
  "codex-shell-snapshots",
  "webhook-secrets",
  "whatsapp-sessions",
  "discord-bots",
  "pager-discord-webhooks",
  "legacy-tls-key",
  "browser-profile",
  "claude-login",
  "codex-login",
  "opencode-login",
  "opencode-mcp-login",
  "opencode-database",
  "opencode-isomux-config",
  "opencode-server-record",
] as const;

/** Files bound to the old office's origin, in the state root. Each covers
 *  its temp file and its quarantined copies (`.tmp`, `.corrupt-*`). */
const ORIGIN_BOUND: {
  unit: (typeof MOVE_BOUND_UNITS)[number];
  name: string;
}[] = [
  { unit: "browser-sessions", name: "sessions.json" },
  { unit: "app-sessions", name: "app-sessions.json" },
  { unit: "invites", name: "invites.json" },
  { unit: "extension-pairings", name: "browser-connections.json" },
  { unit: "web-push", name: "web-push.json" },
];

/** The keys that may log in to the old box over SSH: the new box keeps its
 *  own (the Hosted control plane writes its line there). A project's copy
 *  elsewhere in the home moves. */
const SSH_LOGIN_KEYS = /^\.ssh\/authorized_keys2?$/;

function relInHome(home: string, path: string | null): string | null {
  if (!path) return null;
  const rel = relative(home, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return null;
  return rel.split(sep).join("/");
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const rooted = (source: string) => `^(?:${source})(?:/.*)?$`;

function buildRules(
  stateRootRel: string | null,
  out: string[],
): MoveScopeRules {
  // The bound rules come first: the first rule that matches names the unit.
  const bound: UnitRule[] = [];
  const carried = new Set<string>(MOVE_CARRIED_UNITS);
  if (stateRootRel !== null)
    for (const { unit, name } of ORIGIN_BOUND)
      bound.push({
        unit,
        test: new RegExp(
          rooted(
            `${escapeRegex(`${stateRootRel}/${name}`)}(?:\\.tmp|\\.corrupt-.*)?`,
          ),
        ),
      });
  bound.push({ unit: "ssh-authorized-keys", test: SSH_LOGIN_KEYS });
  // A backup exclusion or backend login that is not in the carried list stays
  // on the old box under its own id: a new credential store moves only once
  // its author puts it in MOVE_CARRIED_UNITS.
  if (stateRootRel !== null) {
    // The state root's name as a glob literal, as backup.ts escapes it.
    const root = stateRootRel.replace(/[\\*?[\]]/g, "\\$&");
    for (const entry of BACKUP_EXCLUSIONS) {
      // The move's own files are "out" (above).
      if (entry.id === "office-move" || carried.has(entry.id)) continue;
      const sources = entry.archivePatterns(root).map(tarGlobSource);
      if (sources.length > 0)
        bound.push({
          unit: entry.id,
          test: new RegExp(rooted(sources.join("|"))),
        });
    }
  }
  for (const entry of BACKEND_CREDENTIAL_PATHS)
    if (!carried.has(entry.id))
      bound.push({ unit: entry.id, test: entry.pattern });
  return {
    out,
    alwaysFetch: alwaysFetchRule(stateRootRel),
    anyBound:
      bound.length > 0
        ? new RegExp(bound.map((r) => `(?:${r.test.source})`).join("|"))
        : null,
    bound,
  };
}

/** The sign-ins and secrets that move (slice 3), and the SQLite side-file
 *  names: one regex over paths relative to the home (slice 4). */
function alwaysFetchRule(stateRootRel: string | null): RegExp {
  const carried = new Set<string>(MOVE_CARRIED_UNITS);
  const sources: string[] = [
    rooted(escapeRegex(".ssh")),
    rooted(escapeRegex(".config/gh")),
    "-(?:wal|shm|journal)$",
  ];
  for (const entry of BACKEND_CREDENTIAL_PATHS)
    if (carried.has(entry.id)) sources.push(entry.pattern.source);
  if (stateRootRel !== null) {
    sources.push(
      `^${escapeRegex(`${stateRootRel}/api-tokens.json`)}(?:\\.tmp)?$`,
    );
    const root = stateRootRel.replace(/[\\*?[\]]/g, "\\$&");
    for (const entry of BACKUP_EXCLUSIONS) {
      if (!carried.has(entry.id)) continue;
      const globs = entry.archivePatterns(root).map(tarGlobSource);
      if (globs.length > 0) sources.push(rooted(globs.join("|")));
    }
  }
  return new RegExp(sources.map((x) => `(?:${x})`).join("|"));
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
  const { anyBound, bound } = scope.rules;
  if (anyBound && anyBound.test(relPath))
    for (const rule of bound)
      if (rule.test.test(relPath))
        return { in: false, why: "bound", unit: rule.unit };
  return IN;
}

/** Slice 4: whether a later pass fetches the file again even when the
 *  manifests agree. True for a sign-in or secret file that moves (the
 *  carried units of BACKUP_EXCLUSIONS and BACKEND_CREDENTIAL_PATHS, `.ssh`,
 *  `.config/gh`, `api-tokens.json`): a token refresh must not be kept
 *  stale; and for a name that ends in `-wal`, `-shm` or `-journal`. A
 *  SQLite file (q) is the caller's rule. */
export function moveAlwaysFetch(scope: MoveScope, relPath: string): boolean {
  return scope.rules.alwaysFetch.test(relPath);
}
