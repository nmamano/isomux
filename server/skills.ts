import type { SkillInfo } from "../shared/types.ts";
import type { CommandRow, EnginePlugin } from "./backends/types.ts";
import { isAbsolute, join } from "path";
import { homedir } from "os";
import { STATE_ROOT } from "./config.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";

// Shape of ~/.claude/plugins/installed_plugins.json that we care about.
interface PluginManifest {
  plugins?: Record<string, { installPath?: string }[]>;
}

// Bundled skills are available to all users, independent of their config.
export const BUNDLED_SKILLS_DIR = join(import.meta.dir, "..", "skills");

export interface UserSkillRoot {
  root: string;
  includeCommands: boolean;
}

function normalizeUserSkillRoots(
  roots: UserSkillRoot[] | string,
  includeCommands = true,
): UserSkillRoot[] {
  return typeof roots === "string" ? [{ root: roots, includeCommands }] : roots;
}

// A frontmatter value as written, minus YAML quoting: the skills page writes a
// description that YAML would misread as a double-quoted string.
function unquoteScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {}
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function extractSkillDescription(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return undefined;
    const descMatch = fmMatch[1].match(/description:\s*(.+)/);
    return descMatch ? unquoteScalar(descMatch[1]) : undefined;
  } catch {
    return undefined;
  }
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

// A discovered skill plus the file it was read from. The skills page shows and
// edits that file; every other caller takes the plain SkillInfo projection.
export interface LocatedSkill extends SkillInfo {
  // SKILL.md for a skill folder, <name>.md for a command file.
  path: string;
  // The folder that was scanned (…/skills or …/commands).
  dir: string;
  // The plugin name, for a plugin skill.
  plugin?: string;
}

function toSkillInfo(skill: LocatedSkill): SkillInfo {
  const info: SkillInfo = {
    name: skill.name,
    origin: skill.origin,
    description: skill.description,
  };
  if (skill.aliasFor !== undefined) info.aliasFor = skill.aliasFor;
  return info;
}

// Scan disk for user-defined skills and commands that the SDK doesn't report.
// Backend-agnostic dirs (.isomux) come first so they win on name collisions
// against Claude-specific dirs (.claude); both are still scanned so existing
// user setups keep working unchanged.
function scanSkillsDir(
  dir: string,
  origin: SkillInfo["origin"],
  skills: LocatedSkill[],
) {
  if (!existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(join(dir, entry.name)).isDirectory();
        } catch {}
      }
      if (isDirectory) {
        const skillPath = join(dir, entry.name, "SKILL.md");
        if (!existsSync(skillPath)) continue;
        const description = extractSkillDescription(skillPath);
        skills.push({
          name: entry.name,
          origin,
          description,
          path: skillPath,
          dir,
        });
      }
    }
  } catch {}
}

function scanCommandsDir(
  dir: string,
  origin: SkillInfo["origin"],
  skills: LocatedSkill[],
) {
  if (!existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      let isFile = entry.isFile();
      if (!isFile && entry.isSymbolicLink()) {
        try {
          isFile = statSync(join(dir, entry.name)).isFile();
        } catch {}
      }
      if (isFile && entry.name.endsWith(".md")) {
        const path = join(dir, entry.name);
        skills.push({
          name: entry.name.replace(/\.md$/, ""),
          origin,
          description: extractSkillDescription(path),
          path,
          dir,
        });
      }
    }
  } catch {}
}

export function locateUserSkills(
  roots: UserSkillRoot[] | string = [
    { root: join(homedir(), ".claude"), includeCommands: true },
  ],
  includeCommands = true,
): LocatedSkill[] {
  const skills: LocatedSkill[] = [];
  scanSkillsDir(join(STATE_ROOT, "skills"), "user", skills);
  for (const source of normalizeUserSkillRoots(roots, includeCommands)) {
    scanSkillsDir(join(source.root, "skills"), "user", skills);
    if (source.includeCommands)
      scanCommandsDir(join(source.root, "commands"), "user", skills);
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

// Also scan project-level skills for a given cwd. Same priority rationale as
// discoverUserSkills: backend-agnostic dirs (.isomux, .agents) first, then
// Claude-specific (.claude). All are scanned so existing project setups
// continue to work.
export function locateProjectSkills(cwd: string): LocatedSkill[] {
  const skills: LocatedSkill[] = [];
  scanSkillsDir(join(cwd, ".isomux", "skills"), "project", skills);
  scanSkillsDir(join(cwd, ".agents", "skills"), "project", skills);
  scanSkillsDir(join(cwd, ".claude", "skills"), "project", skills);
  scanCommandsDir(join(cwd, ".claude", "commands"), "project", skills);
  return skills;
}

export function discoverProjectSkills(cwd: string): SkillInfo[] {
  return locateProjectSkills(cwd).map(toSkillInfo);
}

// Every installed plugin's install folder, whether or not it has a skill a
// member can run. The skills page keeps files under these read-only.
export function pluginInstallPaths(
  claudeConfigDir = join(homedir(), ".claude"),
): string[] {
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(
      readFileSync(
        join(claudeConfigDir, "plugins", "installed_plugins.json"),
        "utf-8",
      ),
    ) as PluginManifest;
  } catch {
    return [];
  }
  if (!manifest.plugins || typeof manifest.plugins !== "object") return [];
  return Object.values(manifest.plugins).flatMap((entries) =>
    Array.isArray(entries)
      ? entries.flatMap((e) =>
          typeof e?.installPath === "string" ? [e.installPath] : [],
        )
      : [],
  );
}

// A plugin folder whose skills the Sk menu lists and skill lookup reads.
export interface PluginDir {
  name: string;
  // name@marketplace
  key?: string;
  path: string;
}

// The enabledPlugins map of one settings file, or {} when it has none.
function readEnabledPlugins(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    const enabled =
      parsed && typeof parsed === "object"
        ? (parsed as { enabledPlugins?: unknown }).enabledPlugins
        : undefined;
    return enabled && typeof enabled === "object"
      ? (enabled as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// The plugins an agent runs. With `reported` (the live Claude process's
// list) that list is the answer: the CLI's enable rules are richer than a
// settings read. Without it, the plugins installed_plugins.json lists whose
// value in the winning settings file (user, then project, then local) is
// true; a missing key does not load in the CLI either (measured 2026-10-20).
export function pluginDirs(
  claudeConfigDir: string,
  cwd?: string,
  reported?: EnginePlugin[] | null,
): PluginDir[] {
  if (reported) {
    return reported.flatMap((p) =>
      isAbsolute(p.path) && existsSync(p.path)
        ? [{ name: p.name, key: p.source, path: p.path }]
        : [],
    );
  }
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(
      readFileSync(
        join(claudeConfigDir, "plugins", "installed_plugins.json"),
        "utf-8",
      ),
    ) as PluginManifest;
  } catch {
    return [];
  }
  if (!manifest.plugins || typeof manifest.plugins !== "object") return [];
  const enabled = Object.assign(
    {},
    readEnabledPlugins(join(claudeConfigDir, "settings.json")),
    ...(cwd
      ? [
          readEnabledPlugins(join(cwd, ".claude", "settings.json")),
          readEnabledPlugins(join(cwd, ".claude", "settings.local.json")),
        ]
      : []),
  ) as Record<string, unknown>;
  const dirs: PluginDir[] = [];
  for (const [key, entries] of Object.entries(manifest.plugins)) {
    if (enabled[key] !== true) continue;
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const installPath = entries[0].installPath;
    if (!installPath || !existsSync(installPath)) continue;
    dirs.push({ name: key.split("@")[0], key, path: installPath });
  }
  return dirs;
}

// Scan the skills of the plugins an agent runs (pluginDirs).
export function locatePluginSkills(
  claudeConfigDir = join(homedir(), ".claude"),
  cwd?: string,
  reported?: EnginePlugin[] | null,
): LocatedSkill[] {
  const skills: LocatedSkill[] = [];
  for (const { name: pluginName, path: installPath } of pluginDirs(
    claudeConfigDir,
    cwd,
    reported,
  )) {
    // skills/<name>/SKILL.md (check user-invocable frontmatter)
    const skillsDir = join(installPath, "skills");
    if (existsSync(skillsDir)) {
      try {
        for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const skillMd = join(skillsDir, d.name, "SKILL.md");
          if (!existsSync(skillMd)) continue;
          try {
            const content = readFileSync(skillMd, "utf-8");
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch && /user-invocable:\s*false/i.test(fmMatch[1]))
              continue;
          } catch {}
          const description = extractSkillDescription(skillMd);
          skills.push({
            name: `${pluginName}:${d.name}`,
            origin: "plugin",
            description,
            path: skillMd,
            dir: skillsDir,
            plugin: pluginName,
          });
        }
      } catch {}
    }

    // commands/<name>.md (legacy format, always user-invocable)
    const cmdsDir = join(installPath, "commands");
    if (existsSync(cmdsDir)) {
      try {
        for (const f of readdirSync(cmdsDir, { withFileTypes: true })) {
          if (f.isFile() && f.name.endsWith(".md")) {
            const path = join(cmdsDir, f.name);
            skills.push({
              name: `${pluginName}:${f.name.replace(/\.md$/, "")}`,
              origin: "plugin",
              description: extractSkillDescription(path),
              path,
              dir: cmdsDir,
              plugin: pluginName,
            });
          }
        }
      } catch {}
    }
  }
  return skills;
}

// Account-synced Claude Code skills on disk:
// <claudeConfigDir>/skills/synced/<bucket>/<name>/SKILL.md, by folder name.
// The first bucket wins a name.
export function locateSyncedSkills(claudeConfigDir: string): LocatedSkill[] {
  const syncedDir = join(claudeConfigDir, "skills", "synced");
  let buckets: string[];
  try {
    buckets = readdirSync(syncedDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const found: LocatedSkill[] = [];
  for (const bucket of buckets) {
    const skills: LocatedSkill[] = [];
    scanSkillsDir(join(syncedDir, bucket), "user", skills);
    for (const skill of skills)
      if (!found.some((s) => s.name === skill.name)) found.push(skill);
  }
  return found;
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

function readSkillFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
    return stripped.trim();
  } catch {
    return null;
  }
}

// Resolve a plugin-namespaced skill (e.g., "codex:rescue") to its prompt text
function resolvePluginSkillPrompt(
  pluginName: string,
  skillName: string,
  claudeConfigDir: string,
  cwd: string,
  reported?: EnginePlugin[] | null,
): string | null {
  const plugin = pluginDirs(claudeConfigDir, cwd, reported).find(
    (p) => p.name === pluginName,
  );
  if (!plugin) return null;
  return (
    readSkillFile(join(plugin.path, "skills", skillName, "SKILL.md")) ??
    readSkillFile(join(plugin.path, "commands", `${skillName}.md`))
  );
}

// Resolve a skill name to its prompt text. This uses the same ordered user
// roots as discovery, then project-local and bundled skills. The first match
// wins in both paths; plugin-namespaced skills are resolved separately.
// Plugin-namespaced skills ("pluginName:skillName") short-circuit above the list.
export function resolveSkillPrompt(
  name: string,
  cwd: string,
  roots: UserSkillRoot[] | string = [
    { root: join(homedir(), ".claude"), includeCommands: true },
  ],
  includeCommands = true,
  pluginRoot?: string,
  reported?: EnginePlugin[] | null,
  reportedSkills?: CommandRow[] | null,
): string | null {
  const normalizedRoots = normalizeUserSkillRoots(roots, includeCommands);
  const claudeConfigDir =
    pluginRoot ?? normalizedRoots[0]?.root ?? join(homedir(), ".claude");
  if (name.includes(":")) {
    const [pluginName, skillName] = name.split(":", 2);
    return resolvePluginSkillPrompt(
      pluginName,
      skillName,
      claudeConfigDir,
      cwd,
      reported,
    );
  }

  const candidates = [
    join(STATE_ROOT, "skills", name, "SKILL.md"),
    ...normalizedRoots.flatMap((source) => [
      join(source.root, "skills", name, "SKILL.md"),
      ...(source.includeCommands
        ? [join(source.root, "commands", `${name}.md`)]
        : []),
    ]),
    join(cwd, ".isomux", "skills", name, "SKILL.md"),
    join(cwd, ".agents", "skills", name, "SKILL.md"),
    join(cwd, ".claude", "skills", name, "SKILL.md"),
    join(cwd, ".claude", "commands", `${name}.md`),
    join(BUNDLED_SKILLS_DIR, name, "SKILL.md"),
  ];
  for (const path of candidates) {
    const prompt = readSkillFile(path);
    if (prompt !== null) return prompt;
  }

  // Bundled-skill alias fallback: scan SKILL.md frontmatter for `alias: <name>`.
  if (existsSync(BUNDLED_SKILLS_DIR)) {
    try {
      for (const entry of readdirSync(BUNDLED_SKILLS_DIR, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const skillMd = join(BUNDLED_SKILLS_DIR, entry.name, "SKILL.md");
        const { alias } = extractBundledSkillFrontmatter(skillMd);
        if (alias === name) return readSkillFile(skillMd);
      }
    } catch {}
  }

  // Account-synced skills, last as in the menu. A live process's rows replace
  // this read: its skills run in the process.
  if (!reportedSkills) {
    const synced = locateSyncedSkills(claudeConfigDir).find(
      (skill) => skill.name === name,
    );
    if (synced) return readSkillFile(synced.path);
  }
  return null;
}
