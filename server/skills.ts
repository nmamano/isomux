import type { SkillInfo } from "../shared/types.ts";
import type { SkillEngine } from "../shared/contract-shapes.ts";
import type { CommandRow, EnginePlugin } from "./backends/types.ts";
import { join } from "path";
import { homedir } from "os";
import { STATE_ROOT } from "./config.ts";
import { projectSkillFolders } from "./project-skill-scan.ts";
import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import {
  locatePluginSkills,
  locateProjectSkills,
  locateSyncedSkills as locateSyncedSkillsIn,
  readSkillPrompt,
  resolvePluginSkillPrompt,
  scanCommandsDir,
  scanSkillsDir as scanSkillsDirIn,
  toSkillInfo,
  type LocatedSkill,
  type UserSkillRoot,
} from "./skill-scan.ts";

export {
  extractSkillDescription,
  locatePluginSkills,
  locateProjectSkills,
  pluginDirs,
  pluginInstallPaths,
  type LocatedSkill,
  type PluginDir,
  type UserSkillRoot,
} from "./skill-scan.ts";

// Bundled skills are available to all users, independent of their config.
export const BUNDLED_SKILLS_DIR = join(import.meta.dir, "..", "skills");

function normalizeUserSkillRoots(
  roots: UserSkillRoot[] | string,
  includeCommands = true,
): UserSkillRoot[] {
  return typeof roots === "string" ? [{ root: roots, includeCommands }] : roots;
}

// Extract description + optional alias from SKILL.md frontmatter. Only
// bundled skills honor `alias:`; user/project/plugin skills don't.
function extractBundledSkillFrontmatter(filePath: string): {
  description?: string;
  alias?: string;
} {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};
    const descMatch = fmMatch[1].match(/description:\s*(.+)/);
    const aliasMatch = fmMatch[1].match(/alias:\s*(.+)/);
    return {
      description: descMatch ? descMatch[1].trim() : undefined,
      alias: aliasMatch ? aliasMatch[1].trim() : undefined,
    };
  } catch {
    return {};
  }
}

// A link an older session start made: the bundled skill folder of the same
// name.
function isBundledSkillLink(dir: string, name: string): boolean {
  try {
    return (
      realpathSync(join(dir, name)) ===
      realpathSync(join(BUNDLED_SKILLS_DIR, name))
    );
  } catch {
    return false;
  }
}

function scanSkillsDir(
  dir: string,
  origin: SkillInfo["origin"],
  skills: LocatedSkill[],
) {
  scanSkillsDirIn(dir, origin, skills, isBundledSkillLink);
}

// Account-synced Claude Code skills on disk (skill-scan.ts).
export function locateSyncedSkills(claudeConfigDir: string): LocatedSkill[] {
  return locateSyncedSkillsIn(claudeConfigDir, isBundledSkillLink);
}

// The folders the user skills come from, in priority order. The member skill
// folder reads the same list (member-skill-folder.ts), so the engine's own
// tool gets what the menu lists.
export function userSkillFolders(
  roots: UserSkillRoot[] | string,
  includeCommands = true,
): { skills: string; commands?: string }[] {
  return [
    { skills: join(STATE_ROOT, "skills") },
    ...rootSkillFolders(normalizeUserSkillRoots(roots, includeCommands)),
  ];
}

// The skill and command folders of the roots alone, without the office's
// STATE_ROOT/skills: an isolated member's agent gets only these.
export function rootSkillFolders(
  roots: UserSkillRoot[],
): { skills: string; commands?: string }[] {
  return roots.map((source) => ({
    skills: join(source.root, "skills"),
    ...(source.includeCommands
      ? { commands: join(source.root, "commands") }
      : {}),
  }));
}

export function locateUserSkills(
  roots: UserSkillRoot[] | string = [
    { root: join(homedir(), ".claude"), includeCommands: true },
  ],
  includeCommands = true,
): LocatedSkill[] {
  const skills: LocatedSkill[] = [];
  for (const folder of userSkillFolders(roots, includeCommands)) {
    scanSkillsDir(folder.skills, "user", skills);
    if (folder.commands) scanCommandsDir(folder.commands, "user", skills);
  }
  return skills;
}

export function discoverUserSkills(
  roots: UserSkillRoot[] | string = [
    { root: join(homedir(), ".claude"), includeCommands: true },
  ],
  includeCommands = true,
): SkillInfo[] {
  return locateUserSkills(roots, includeCommands).map(toSkillInfo);
}

// Scan skills bundled with isomux. If a SKILL.md declares `alias: <name>`
// in its frontmatter, the alias is surfaced as an additional entry pointing
// to the same prompt.
export function locateBundledSkills(): LocatedSkill[] {
  const skills: LocatedSkill[] = [];
  if (existsSync(BUNDLED_SKILLS_DIR)) {
    try {
      for (const entry of readdirSync(BUNDLED_SKILLS_DIR, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory()) {
          const path = join(BUNDLED_SKILLS_DIR, entry.name, "SKILL.md");
          const { description, alias } = extractBundledSkillFrontmatter(path);
          const dir = BUNDLED_SKILLS_DIR;
          skills.push({
            name: entry.name,
            origin: "isomux",
            description,
            path,
            dir,
          });
          if (alias && alias !== entry.name) {
            skills.push({
              name: alias,
              origin: "isomux",
              description,
              aliasFor: entry.name,
              path,
              dir,
            });
          }
        }
      }
    } catch {}
  }
  return skills;
}

export function discoverBundledSkills(): SkillInfo[] {
  return locateBundledSkills().map(toSkillInfo);
}

export function discoverProjectSkills(
  cwd: string,
  engine: SkillEngine,
): SkillInfo[] {
  return locateProjectSkills(cwd, engine).map(toSkillInfo);
}

// The account's skills that the rest of the menu does not list. With `rows`
// (the live Claude process's commands) the answer is its non-builtin,
// non-mcp__ rows whose name and aliases are not in `listed`; without it, the
// synced skills on disk.
export function discoverSyncedSkills(
  claudeConfigDir: string,
  rows: CommandRow[] | null | undefined,
  listed: ReadonlySet<string>,
): SkillInfo[] {
  if (!rows) return locateSyncedSkills(claudeConfigDir).map(toSkillInfo);
  return rows
    .filter(
      (row) =>
        !row.builtin &&
        !row.name.startsWith("mcp__") &&
        ![row.name, ...(row.aliases ?? [])].some((name) => listed.has(name)),
    )
    .map((row) => ({
      name: row.name,
      origin: "user" as const,
      ...(row.description ? { description: row.description } : {}),
    }));
}

export function discoverPluginSkills(
  claudeConfigDir = join(homedir(), ".claude"),
  cwd?: string,
  reported?: EnginePlugin[] | null,
): SkillInfo[] {
  return locatePluginSkills(claudeConfigDir, cwd, reported).map(toSkillInfo);
}

// Deduplicate skills by name, keeping the first (highest-priority) occurrence
export function deduplicateSkills(skills: SkillInfo[]): SkillInfo[] {
  const seen = new Set<string>();
  const result: SkillInfo[] = [];
  for (const s of skills) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      result.push(s);
    }
  }
  return result;
}

// The prompts an isolated member's runner read now for one name
// (member-user-skills.ts, member-project-skills.ts): the office reads none
// of the member's files, so these stand in for every read but the bundled
// skills. Null where the runner found nothing.
export interface MemberSkillPrompts {
  // A user skill, or the plugin skill for a plugin name.
  user: string | null;
  project: string | null;
  // A synced skill on disk (only when no live rows replace it).
  synced: string | null;
}

// A bundled skill's prompt by its name or its alias.
function bundledSkillPrompt(name: string): string | null {
  const prompt = readSkillPrompt(join(BUNDLED_SKILLS_DIR, name, "SKILL.md"));
  if (prompt !== null) return prompt;
  // Bundled-skill alias fallback: scan SKILL.md frontmatter for `alias: <name>`.
  if (existsSync(BUNDLED_SKILLS_DIR)) {
    try {
      for (const entry of readdirSync(BUNDLED_SKILLS_DIR, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const skillMd = join(BUNDLED_SKILLS_DIR, entry.name, "SKILL.md");
        const { alias } = extractBundledSkillFrontmatter(skillMd);
        if (alias === name) return readSkillPrompt(skillMd);
      }
    } catch {}
  }
  return null;
}

// Resolve a skill name to its prompt text. This uses the same ordered user
// roots as discovery, then the engine's project folders and bundled skills. The first match
// wins in both paths; plugin-namespaced skills are resolved separately.
// Plugin-namespaced skills ("pluginName:skillName") short-circuit above the list.
// An isolated member's agent passes `member` and gets the same order with no
// office read of their files: user, project, bundled, synced; a plugin name
// only the runner's plugin read.
export function resolveSkillPrompt(
  name: string,
  cwd: string,
  engine: SkillEngine,
  roots: UserSkillRoot[] | string = [
    { root: join(homedir(), ".claude"), includeCommands: true },
  ],
  includeCommands = true,
  pluginRoot?: string,
  reported?: EnginePlugin[] | null,
  reportedSkills?: CommandRow[] | null,
  member?: MemberSkillPrompts,
): string | null {
  if (member) {
    if (name.includes(":")) return engine === "claude" ? member.user : null;
    return (
      member.user ?? member.project ?? bundledSkillPrompt(name) ?? member.synced
    );
  }
  const normalizedRoots = normalizeUserSkillRoots(roots, includeCommands);
  const claudeConfigDir =
    pluginRoot ?? normalizedRoots[0]?.root ?? join(homedir(), ".claude");
  if (name.includes(":")) {
    // Only Claude loads plugin skills, so only a Claude agent lists them.
    if (engine !== "claude") return null;
    const [pluginName, skillName] = name.split(":", 2);
    return resolvePluginSkillPrompt(
      pluginName,
      skillName,
      claudeConfigDir,
      cwd,
      reported,
    );
  }

  const userCandidates = [
    join(STATE_ROOT, "skills", name, "SKILL.md"),
    ...normalizedRoots.flatMap((source) => [
      join(source.root, "skills", name, "SKILL.md"),
      ...(source.includeCommands
        ? [join(source.root, "commands", `${name}.md`)]
        : []),
    ]),
  ];
  const projectCandidates = projectSkillFolders(cwd, engine).map((folder) =>
    folder.commands
      ? join(folder.dir, `${name}.md`)
      : join(folder.dir, name, "SKILL.md"),
  );
  for (const path of [...userCandidates, ...projectCandidates]) {
    const prompt = readSkillPrompt(path);
    if (prompt !== null) return prompt;
  }
  const bundled = bundledSkillPrompt(name);
  if (bundled !== null) return bundled;

  // Account-synced skills, last as in the menu, and Claude's only. A live
  // process's rows replace this read: its skills run in the process.
  if (!reportedSkills && engine === "claude") {
    const synced = locateSyncedSkills(claudeConfigDir).find(
      (skill) => skill.name === name,
    );
    if (synced) return readSkillPrompt(synced.path);
  }
  return null;
}
