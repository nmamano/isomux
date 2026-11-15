// The skill scans that read only the folders they are given: no config, no
// office path. skills.ts uses them for the office's agents, and a member
// runner (server/member-user-skills.ts entries) runs them as the member, so
// this module is in the runner bundle: only fs, path and os.
import type { SkillInfo } from "../shared/types.ts";
import type { EnginePlugin } from "./backends/types.ts";
import { isAbsolute, join } from "path";
import { homedir } from "os";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import type { SkillEngine } from "../shared/contract-shapes.ts";
import { projectSkillFolders } from "./project-skill-scan.ts";

export interface UserSkillRoot {
  root: string;
  includeCommands: boolean;
}

// Shape of ~/.claude/plugins/installed_plugins.json that we care about.
interface PluginManifest {
  plugins?: Record<string, { installPath?: string }[]>;
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

export function extractSkillDescription(filePath: string): string | undefined {
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

export function toSkillInfo(skill: LocatedSkill): SkillInfo {
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
export function scanSkillsDir(
  dir: string,
  origin: SkillInfo["origin"],
  skills: LocatedSkill[],
  // A user entry this returns true for is left out (the office's old links
  // to its bundled skills).
  skip?: (dir: string, name: string) => boolean,
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
        // Older session starts linked the bundled skills into the provider homes;
        // such a link is the bundled skill, listed once with its own origin.
        if (origin === "user" && skip?.(dir, entry.name)) continue;
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

export function scanCommandsDir(
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
export function locateSyncedSkills(
  claudeConfigDir: string,
  skip?: (dir: string, name: string) => boolean,
): LocatedSkill[] {
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
    scanSkillsDir(join(syncedDir, bucket), "user", skills, skip);
    for (const skill of skills)
      if (!found.some((s) => s.name === skill.name)) found.push(skill);
  }
  return found;
}

export function readSkillPrompt(path: string): string | null {
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
export function resolvePluginSkillPrompt(
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
    readSkillPrompt(join(plugin.path, "skills", skillName, "SKILL.md")) ??
    readSkillPrompt(join(plugin.path, "commands", `${skillName}.md`))
  );
}

export function locateProjectSkills(
  cwd: string,
  engine: SkillEngine,
): LocatedSkill[] {
  const skills: LocatedSkill[] = [];
  for (const folder of projectSkillFolders(cwd, engine))
    if (folder.commands) scanCommandsDir(folder.dir, "project", skills);
    else scanSkillsDir(folder.dir, "project", skills);
  return skills;
}
