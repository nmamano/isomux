import type { SkillInfo } from "../shared/types.ts";
import { join } from "path";
import { homedir } from "os";
import { STATE_ROOT } from "./config.ts";
import { existsSync, readdirSync, readFileSync } from "fs";

// Shape of ~/.claude/plugins/installed_plugins.json that we care about.
interface PluginManifest {
  plugins?: Record<string, { installPath?: string }[]>;
}

// Skills bundled with isomux itself (available to all users regardless of their config)
export const BUNDLED_SKILLS_DIR = join(import.meta.dir, "..", "skills");

// Extract description from SKILL.md / command .md YAML frontmatter
function extractSkillDescription(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return undefined;
    const descMatch = fmMatch[1].match(/description:\s*(.+)/);
    return descMatch ? descMatch[1].trim() : undefined;
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

// Scan disk for user-defined skills and commands that the SDK doesn't report.
// Backend-agnostic dirs (.isomux) come first so they win on name collisions
// against Claude-specific dirs (.claude); both are still scanned so existing
// user setups keep working unchanged.
function scanSkillsDir(
  dir: string,
  origin: SkillInfo["origin"],
  skills: SkillInfo[],
) {
  if (!existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const description = extractSkillDescription(
          join(dir, entry.name, "SKILL.md"),
        );
        skills.push({ name: entry.name, origin, description });
      }
    }
  } catch {}
}

function scanCommandsDir(
  dir: string,
  origin: SkillInfo["origin"],
  skills: SkillInfo[],
) {
  if (!existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const description = extractSkillDescription(join(dir, entry.name));
        skills.push({
          name: entry.name.replace(/\.md$/, ""),
          origin,
          description,
        });
      }
    }
  } catch {}
}

export function discoverUserSkills(
  claudeConfigDir = join(homedir(), ".claude"),
): SkillInfo[] {
  const skills: SkillInfo[] = [];
  scanSkillsDir(join(STATE_ROOT, "skills"), "user", skills);
  scanSkillsDir(join(claudeConfigDir, "skills"), "user", skills);
  scanCommandsDir(join(claudeConfigDir, "commands"), "user", skills);
  return skills;
}

// Scan skills bundled with isomux. If a SKILL.md declares `alias: <name>`
// in its frontmatter, the alias is surfaced as an additional entry pointing
// to the same prompt.
export function discoverBundledSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];
  if (existsSync(BUNDLED_SKILLS_DIR)) {
    try {
      for (const entry of readdirSync(BUNDLED_SKILLS_DIR, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory()) {
          const { description, alias } = extractBundledSkillFrontmatter(
            join(BUNDLED_SKILLS_DIR, entry.name, "SKILL.md"),
          );
          skills.push({ name: entry.name, origin: "isomux", description });
          if (alias && alias !== entry.name) {
            skills.push({
              name: alias,
              origin: "isomux",
              description,
              aliasFor: entry.name,
            });
          }
        }
      }
    } catch {}
  }
  return skills;
}

// Also scan project-level skills for a given cwd. Same priority rationale as
// discoverUserSkills: backend-agnostic dirs (.isomux, .agents) first, then
// Claude-specific (.claude). All are scanned so existing project setups
// continue to work.
export function discoverProjectSkills(cwd: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  scanSkillsDir(join(cwd, ".isomux", "skills"), "project", skills);
  scanSkillsDir(join(cwd, ".agents", "skills"), "project", skills);
  scanSkillsDir(join(cwd, ".claude", "skills"), "project", skills);
  scanCommandsDir(join(cwd, ".claude", "commands"), "project", skills);
  return skills;
}

// Scan skills from installed Claude Code plugins (~/.claude/plugins/)
export function discoverPluginSkills(
  claudeConfigDir = join(homedir(), ".claude"),
): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const manifestPath = join(
    claudeConfigDir,
    "plugins",
    "installed_plugins.json",
  );
  if (!existsSync(manifestPath)) return skills;

  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    ) as PluginManifest;
  } catch {
    return skills;
  }

  if (!manifest.plugins || typeof manifest.plugins !== "object") return skills;

  for (const [key, entries] of Object.entries(manifest.plugins)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const pluginName = key.split("@")[0];
    const installPath = entries[0].installPath;
    if (!installPath || !existsSync(installPath)) continue;

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
            const description = extractSkillDescription(join(cmdsDir, f.name));
            skills.push({
              name: `${pluginName}:${f.name.replace(/\.md$/, "")}`,
              origin: "plugin",
              description,
            });
          }
        }
      } catch {}
    }
  }
  return skills;
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

// Read a skill file, stripping YAML frontmatter
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
): string | null {
  const manifestPath = join(
    claudeConfigDir,
    "plugins",
    "installed_plugins.json",
  );
  if (!existsSync(manifestPath)) return null;
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    ) as PluginManifest;
  } catch {
    return null;
  }

  const plugins = manifest.plugins ?? {};
  const pluginKey = Object.keys(plugins).find(
    (k) => k.split("@")[0] === pluginName,
  );
  if (!pluginKey) return null;
  const entries = plugins[pluginKey];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const installPath = entries[0].installPath;
  if (!installPath) return null;

  return (
    readSkillFile(join(installPath, "skills", skillName, "SKILL.md")) ??
    readSkillFile(join(installPath, "commands", `${skillName}.md`))
  );
}

// Resolve a skill name to its prompt text, checking skill dirs in priority
// order. Mirrors the discovery order: backend-agnostic dirs (.isomux,
// .agents) first, then Claude-specific (.claude); user globals before
// project locals; plugins are namespaced separately.
//
// Priority:
//   1. ~/.isomux/skills/<name>/SKILL.md          (global user, isomux)
//   2. ~/.claude/skills/<name>/SKILL.md          (global user, claude)
//   3. ~/.claude/commands/<name>.md              (global user, claude commands)
//   4. <cwd>/.isomux/skills/<name>/SKILL.md      (project, isomux)
//   5. <cwd>/.agents/skills/<name>/SKILL.md      (project, .agents)
//   6. <cwd>/.claude/skills/<name>/SKILL.md      (project, claude)
//   7. <cwd>/.claude/commands/<name>.md          (project, claude commands)
//   8. Bundled isomux skills (server/skills/)
// Plugin-namespaced skills ("pluginName:skillName") short-circuit above the list.
export function resolveSkillPrompt(
  name: string,
  cwd: string,
  claudeConfigDir = join(homedir(), ".claude"),
): string | null {
  // Handle plugin-namespaced skills: "pluginName:skillName"
  if (name.includes(":")) {
    const [pluginName, skillName] = name.split(":", 2);
    return resolvePluginSkillPrompt(pluginName, skillName, claudeConfigDir);
  }

  const candidates = [
    join(STATE_ROOT, "skills", name, "SKILL.md"),
    join(claudeConfigDir, "skills", name, "SKILL.md"),
    join(claudeConfigDir, "commands", `${name}.md`),
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
  return null;
}
