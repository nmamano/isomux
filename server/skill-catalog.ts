// The skills page's model: every skill an agent in the office can run, per
// engine, with the file it comes from. Built on the same located discovery the
// Sk menu and the slash-command resolver use (skills.ts), so the page lists
// what the code really resolves, in the same order.
//
// One engine's list is the union of its contexts. A context is one agent
// working folder (user roots, that folder's project skills, plugins, built-ins
// - the order discovery dedupes in); with no agents on the engine there is one
// context without project skills. An entry is shadowed when, in every context
// it belongs to, an earlier entry with the same name wins. Names follow the
// resolver's rules: a name with a colon only ever runs a plugin skill.
//
// Reads and writes go through file-editor.ts, so a save carries the same
// server-issued revision guard as the editor panel: a save based on an older
// revision fails with "stale" instead of overwriting the newer copy.

import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { rm } from "fs/promises";
import { SKILL_NAME } from "./project-skill-scan.ts";
import { dirname, isAbsolute, join, resolve } from "path";
import type {
  SkillCatalogEntry,
  SkillCatalogRes,
  SkillEngine,
} from "../shared/contract-shapes.ts";
import {
  BUNDLED_SKILLS_DIR,
  locateBundledSkills,
  locateUserSkills,
  pluginInstallPaths,
} from "./skills.ts";
import {
  engineCatalog,
  isInside,
  realKey,
  type CatalogSources,
  type SkillEngineContext,
} from "./skill-catalog-core.ts";
import {
  openOfficeFile,
  saveOfficeFile,
  markFileDeleted,
  type OpenFileResult,
  type SaveFileResult,
} from "./file-editor.ts";

export const SKILL_ENGINES: readonly SkillEngine[] = [
  "claude",
  "codex",
  "opencode",
];

export type { SkillEngineContext } from "./skill-catalog-core.ts";

// Same limit as the editor panel's open.
export const MAX_SKILL_BYTES = 1_000_000;
const MAX_DESCRIPTION = 1024;
// Claude Code's own skill-name rule (SKILL_NAME, project-skill-scan.ts):
// lowercase letters, digits and hyphens.
const MAX_NAME = 64;

const OFFICE_SOURCES: CatalogSources = {
  locateUser: (roots) => locateUserSkills(roots),
  get bundled() {
    return locateBundledSkills();
  },
  bundledDir: BUNDLED_SKILLS_DIR,
};

export function buildSkillCatalog(
  contexts: SkillEngineContext[],
  counts: Record<string, number>,
  newSkillDir: string,
  home: string,
): SkillCatalogRes {
  return {
    engines: contexts.map((context) => ({
      engine: context.engine,
      skills: engineCatalog(context, counts, OFFICE_SOURCES),
    })),
    newSkillDir,
    home,
  };
}

// The catalog entry for a path, if any engine lists it. Reads and writes are
// limited to these files: the routes are a skills surface, not a file surface.
// Unless `exact`, an absolute path that reaches a listed file through links
// (an agent's member skill folder) finds that entry; a listed path wins.
export function findCatalogEntry(
  catalog: SkillCatalogRes,
  path: string,
  opts: { exact?: boolean } = {},
): SkillCatalogEntry | null {
  for (const { skills } of catalog.engines)
    for (const entry of skills) if (entry.path === path) return entry;
  if (opts.exact || !isAbsolute(path)) return null;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  for (const { skills } of catalog.engines)
    for (const entry of skills) if (realKey(entry.path) === real) return entry;
  return null;
}

export function readSkillFile(path: string): OpenFileResult {
  return openOfficeFile(path);
}

export function saveSkillFile(
  path: string,
  content: string,
  expectedRev: number,
): SaveFileResult {
  // expectedMtime is unused when a revision is sent; force stays off, so a
  // deleted or changed file is reported, never overwritten.
  return saveOfficeFile(path, content, 0, expectedRev, false);
}

export type DeleteSkillResult =
  | { kind: "ok" }
  | { kind: "read_only" }
  | { kind: "deleted" }
  | { kind: "stale"; currentRev: number; currentMtime: number }
  | { kind: "io_error"; message: string };

// The catalog path is authoritative. Never realpath the removal target:
// unlink a linked entry, and let rm remove child links without following them.
export async function deleteSkillFile(
  entry: SkillCatalogEntry,
  expectedRev: number,
  contexts: SkillEngineContext[],
): Promise<DeleteSkillResult> {
  if (!entry.editable) return { kind: "read_only" };
  const target = entry.kind === "skill" ? dirname(entry.path) : entry.path;
  const protectedRoots = [
    realKey(BUNDLED_SKILLS_DIR),
    ...contexts.flatMap((context) =>
      pluginInstallPaths(context.pluginRoot).map(realKey),
    ),
  ];
  const realFile = realKey(entry.path);
  const realTarget = realKey(target);
  if (
    protectedRoots.some(
      (root) =>
        isInside(realFile, root) ||
        isInside(realTarget, root) ||
        (entry.kind === "skill" && isInside(root, realTarget)),
    )
  )
    return { kind: "read_only" };
  const current = readSkillFile(entry.path);
  if (current.kind === "not_found") return { kind: "deleted" };
  if (current.kind !== "ok")
    return {
      kind: "io_error",
      message:
        current.kind === "io_error"
          ? current.message
          : "Could not read the skill file before deleting it.",
    };
  if (current.rev !== expectedRev)
    return {
      kind: "stale",
      currentRev: current.rev,
      currentMtime: current.mtime,
    };
  try {
    if (entry.kind === "command" || lstatSync(target).isSymbolicLink())
      unlinkSync(target);
    else await rm(target, { recursive: true });
    markFileDeleted(entry.path);
    return { kind: "ok" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      markFileDeleted(entry.path);
      return { kind: "deleted" };
    }
    return {
      kind: "io_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export type CreateSkillResult =
  | { kind: "ok"; path: string }
  | { kind: "invalid"; field: "name" | "description" | "instructions" }
  | { kind: "exists"; path: string }
  | { kind: "io_error"; message: string };

// A description YAML would misread as plain text (a colon-space, a comment
// mark, a leading indicator) is written double-quoted. JSON string syntax is
// valid YAML double-quoted syntax.
function frontmatterScalar(value: string): string {
  const unsafe =
    /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) || /:\s|\s#|:$|\s$/.test(value);
  return unsafe ? JSON.stringify(value) : value;
}

export function skillFileContent(
  name: string,
  description: string,
  instructions: string,
): string {
  const body = instructions.trim();
  return `---\nname: ${name}\ndescription: ${frontmatterScalar(description)}\n---\n${body ? `\n${body}\n` : ""}`;
}

// The fields of a new skill, checked: the office's create and an isolated
// member's (member-skill-catalog.ts) take the same ones.
export function validateNewSkill(input: {
  name: unknown;
  description: unknown;
  instructions?: unknown;
}):
  | { kind: "ok"; name: string; description: string; instructions: string }
  | { kind: "invalid"; field: "name" | "description" | "instructions" } {
  const { name, description, instructions = "" } = input;
  if (
    typeof name !== "string" ||
    name.length > MAX_NAME ||
    !SKILL_NAME.test(name)
  )
    return { kind: "invalid", field: "name" };
  if (
    typeof description !== "string" ||
    !description.trim() ||
    description.length > MAX_DESCRIPTION ||
    /[\r\n]/.test(description)
  )
    return { kind: "invalid", field: "description" };
  if (typeof instructions !== "string")
    return { kind: "invalid", field: "instructions" };
  return { kind: "ok", name, description: description.trim(), instructions };
}

export function createSkill(
  newSkillDir: string,
  input: { name: unknown; description: unknown; instructions?: unknown },
): CreateSkillResult {
  const valid = validateNewSkill(input);
  if (valid.kind === "invalid") return valid;
  const { name } = valid;
  const content = skillFileContent(name, valid.description, valid.instructions);
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES)
    return { kind: "invalid", field: "instructions" };
  const folder = join(newSkillDir, name);
  const path = join(folder, "SKILL.md");
  try {
    // A session start links the bundled skills into this folder. A member's
    // own skill of a bundled name takes the name over from that link.
    if (
      resolve(newSkillDir, readlinkSync(folder)) ===
      join(resolve(BUNDLED_SKILLS_DIR), name)
    )
      unlinkSync(folder);
  } catch {
    // No link there.
  }
  try {
    mkdirSync(newSkillDir, { recursive: true });
    mkdirSync(folder);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST")
      return { kind: "exists", path };
    return { kind: "io_error", message: (err as Error).message };
  }
  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST")
      return { kind: "exists", path };
    return { kind: "io_error", message: (err as Error).message };
  }
  return { kind: "ok", path };
}
