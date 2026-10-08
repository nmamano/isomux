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

import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import type {
  SkillCatalogEntry,
  SkillCatalogRes,
  SkillEngine,
  SkillSource,
} from "../shared/contract-shapes.ts";
import {
  BUNDLED_SKILLS_DIR,
  locateBundledSkills,
  locatePluginSkills,
  locateProjectSkills,
  locateUserSkills,
  pluginInstallPaths,
  type LocatedSkill,
  type UserSkillRoot,
} from "./skills.ts";
import {
  openFile,
  saveFile,
  type OpenFileResult,
  type SaveFileResult,
} from "./file-editor.ts";

export const SKILL_ENGINES: readonly SkillEngine[] = [
  "claude",
  "codex",
  "opencode",
];

export interface SkillEngineContext {
  engine: SkillEngine;
  userRoots: UserSkillRoot[];
  pluginRoot: string;
  // Working folders of the caller-visible agents on this engine.
  cwds: string[];
}

// Same limit as the editor panel's open.
export const MAX_SKILL_BYTES = 1_000_000;
const MAX_DESCRIPTION = 1024;
// Claude Code's own skill-name rule: lowercase letters, digits and hyphens.
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;

function realKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sourceOf(skill: LocatedSkill): SkillSource {
  return skill.origin === "claude" ? "isomux" : skill.origin;
}

// True when `path` is `root` or inside it.
function isInside(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}

// The resolver sends a name with a colon straight to the plugins
// (resolveSkillPrompt), so only a plugin entry can run under such a name.
function canRunAs(skill: LocatedSkill): boolean {
  return skill.origin === "plugin" || !skill.name.includes(":");
}

function engineCatalog(
  context: SkillEngineContext,
  counts: Record<string, number>,
): SkillCatalogEntry[] {
  const user = locateUserSkills(context.userRoots).filter(canRunAs);
  const plugin = locatePluginSkills(context.pluginRoot);
  const bundled = locateBundledSkills();
  const cwds = [...new Set(context.cwds.map((cwd) => resolve(cwd)))].sort();
  const projects = cwds.map((cwd) => ({
    cwd,
    skills: locateProjectSkills(cwd).filter(canRunAs),
  }));

  // Built-in and plugin files are read-only by where the file really is, so a
  // link to one from a user or project folder does not make it editable.
  const protectedRoots = [
    realKey(BUNDLED_SKILLS_DIR),
    ...pluginInstallPaths(context.pluginRoot).map(realKey),
  ];

  // Winners per context, by name: the first entry in discovery order.
  const contexts: LocatedSkill[][] =
    projects.length === 0
      ? [[...user, ...plugin, ...bundled]]
      : projects.map((p) => [...user, ...p.skills, ...plugin, ...bundled]);
  const winners = contexts.map((list) => {
    const byName = new Map<string, LocatedSkill>();
    for (const s of list) if (!byName.has(s.name)) byName.set(s.name, s);
    return byName;
  });

  // A built-in alias hides its canonical entry, as in the Sk menu.
  const aliased = new Set(
    bundled.filter((s) => s.aliasFor).map((s) => s.aliasFor as string),
  );
  const own = (name: string): number => {
    const v = Object.prototype.hasOwnProperty.call(counts, name)
      ? counts[name]
      : 0;
    return typeof v === "number" ? v : 0;
  };

  const ordered: { skill: LocatedSkill; project?: string }[] = [
    ...user.map((skill) => ({ skill })),
    ...projects.flatMap((p) =>
      p.skills.map((skill) => ({ skill, project: p.cwd })),
    ),
    ...plugin.map((skill) => ({ skill })),
    ...bundled.map((skill) => ({ skill })),
  ];

  // One entry per name and real file: the same file reached twice (a personal
  // provider home links the box home's skills, or two projects link one
  // folder) is one skill. It runs when any of its places runs in any context
  // that place belongs to; the first place found is the one shown.
  const groups = new Map<
    string,
    {
      first: { skill: LocatedSkill; project?: string };
      runs: boolean;
      winner?: LocatedSkill;
    }
  >();
  for (const item of ordered) {
    const { skill, project } = item;
    if (skill.origin === "isomux" && aliased.has(skill.name)) continue;
    const memberOf =
      project === undefined
        ? winners
        : winners.filter((_, i) => projects[i].cwd === project);
    const runs = memberOf.some((w) => w.get(skill.name) === skill);
    const key = `${skill.name}\0${realKey(skill.path)}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        first: item,
        runs,
        winner: memberOf[0]?.get(skill.name),
      });
    } else {
      group.runs ||= runs;
    }
  }

  const out: SkillCatalogEntry[] = [];
  for (const { first, runs, winner } of groups.values()) {
    const { skill, project } = first;
    const source = sourceOf(skill);
    const real = realKey(skill.path);
    const entry: SkillCatalogEntry = {
      name: skill.name,
      source,
      kind: basename(skill.path) === "SKILL.md" ? "skill" : "command",
      path: skill.path,
      dir: skill.dir,
      editable:
        (source === "user" || source === "project") &&
        !protectedRoots.some((root) => isInside(real, root)),
      uses: own(skill.name) + (skill.aliasFor ? own(skill.aliasFor) : 0),
    };
    if (skill.description !== undefined) entry.description = skill.description;
    if (skill.aliasFor !== undefined) entry.aliasFor = skill.aliasFor;
    if (project !== undefined) entry.project = project;
    if (skill.plugin !== undefined) entry.plugin = skill.plugin;
    if (!runs && winner) entry.shadowedBy = winner.path;
    out.push(entry);
  }
  return out;
}

export function buildSkillCatalog(
  contexts: SkillEngineContext[],
  counts: Record<string, number>,
  newSkillDir: string,
  home: string,
): SkillCatalogRes {
  return {
    engines: contexts.map((context) => ({
      engine: context.engine,
      skills: engineCatalog(context, counts),
    })),
    newSkillDir,
    home,
  };
}

// The catalog entry for a path, if any engine lists it. Reads and writes are
// limited to these files: the routes are a skills surface, not a file surface.
export function findCatalogEntry(
  catalog: SkillCatalogRes,
  path: string,
): SkillCatalogEntry | null {
  for (const { skills } of catalog.engines)
    for (const entry of skills) if (entry.path === path) return entry;
  return null;
}

export function readSkillFile(path: string): OpenFileResult {
  return openFile(path);
}

export function saveSkillFile(
  path: string,
  content: string,
  expectedRev: number,
): SaveFileResult {
  // expectedMtime is unused when a revision is sent; force stays off, so a
  // deleted or changed file is reported, never overwritten.
  return saveFile(path, content, 0, expectedRev, false);
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

export function createSkill(
  newSkillDir: string,
  input: { name: unknown; description: unknown; instructions?: unknown },
): CreateSkillResult {
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
  const content = skillFileContent(name, description.trim(), instructions);
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES)
    return { kind: "invalid", field: "instructions" };
  const folder = join(newSkillDir, name);
  const path = join(folder, "SKILL.md");
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
