// The engine catalog of the skills page (skill-catalog.ts says what it
// lists), over the sources it is given. The office builds its own; an
// isolated member's runner builds theirs as the member (the skill-catalog
// entry, part 2d-iii-b), so this module is in the runner bundle: only fs,
// path and the scans of skill-scan.ts.
import { lstatSync, readlinkSync, realpathSync } from "fs";
import { basename, dirname, resolve } from "path";
import type {
  SkillCatalogEntry,
  SkillEngine,
  SkillSource,
} from "../shared/contract-shapes.ts";
import {
  locatePluginSkills,
  locateProjectSkills,
  pluginInstallPaths,
  type LocatedSkill,
  type UserSkillRoot,
} from "./skill-scan.ts";

export interface SkillEngineContext {
  engine: SkillEngine;
  userRoots: UserSkillRoot[];
  pluginRoot: string;
  // Working folders of the caller-visible agents on this engine.
  cwds: string[];
}

export function realKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// The folder of a skill, or the file of a command: what a link points to.
function placeOf(skill: LocatedSkill): string {
  return basename(skill.path) === "SKILL.md" ? dirname(skill.path) : skill.path;
}

// Where a link points, one hop; null when `path` is not a link.
function linkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

function sourceOf(skill: LocatedSkill): SkillSource {
  return skill.origin === "claude" ? "isomux" : skill.origin;
}

// True when `path` is `root` or inside it.
export function isInside(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}

// The resolver sends a name with a colon straight to the plugins
// (resolveSkillPrompt), so only a plugin entry can run under such a name.
function canRunAs(skill: LocatedSkill): boolean {
  return skill.origin === "plugin" || !skill.name.includes(":");
}

// Where an engine catalog's user and bundled skills come from: the office
// reads its own (skills.ts); an isolated member's runner reads their roots
// and gets the bundled list from the office as data.
export interface CatalogSources {
  locateUser(roots: UserSkillRoot[]): LocatedSkill[];
  bundled: LocatedSkill[];
  bundledDir: string;
}

export function engineCatalog(
  context: SkillEngineContext,
  counts: Record<string, number>,
  sources: CatalogSources,
): SkillCatalogEntry[] {
  const user = sources.locateUser(context.userRoots).filter(canRunAs);
  // Only Claude loads plugin skills.
  const plugin =
    context.engine === "claude" ? locatePluginSkills(context.pluginRoot) : [];
  const bundled = sources.bundled;
  const cwds = [...new Set(context.cwds.map((cwd) => resolve(cwd)))].sort();
  const projects = cwds.map((cwd) => ({
    cwd,
    skills: locateProjectSkills(cwd, context.engine).filter(canRunAs),
  }));

  // Built-in and plugin files are read-only by where the file really is, so a
  // link to one from a user or project folder does not make it editable.
  const protectedRoots = [
    realKey(sources.bundledDir),
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

  // A built-in alias hides its canonical entry, as in the Skill menu.
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
  // that place belongs to. The first place found is the one shown, unless it
  // is a link to a later place of the same source: then the later one is, so
  // every engine shows the box home's path and the page lists the skill once
  // for all agents.
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
      if (
        sourceOf(skill) === sourceOf(group.first.skill) &&
        linkTarget(placeOf(group.first.skill)) === placeOf(skill)
      )
        group.first = item;
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
