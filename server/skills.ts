import type { SkillInfo } from "../shared/types.ts";
import { join } from "path";
import { homedir } from "os";
import { existsSync, readdirSync, readFileSync } from "fs";

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

// Scan disk for user-defined skills and commands that the SDK doesn't report
export function discoverUserSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];
  // Global user skills: ~/.claude/skills/<name>/SKILL.md
  const globalSkillsDir = join(homedir(), ".claude", "skills");
  if (existsSync(globalSkillsDir)) {
    try {
      for (const entry of readdirSync(globalSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const description = extractSkillDescription(join(globalSkillsDir, entry.name, "SKILL.md"));
          skills.push({ name: entry.name, origin: "user", description });
        }
      }
    } catch {}
  }
  // Global user commands: ~/.claude/commands/<name>.md
  const globalCmdsDir = join(homedir(), ".claude", "commands");
  if (existsSync(globalCmdsDir)) {
    try {
      for (const entry of readdirSync(globalCmdsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const description = extractSkillDescription(join(globalCmdsDir, entry.name));
          skills.push({ name: entry.name.replace(/\.md$/, ""), origin: "user", description });
        }
      }
    } catch {}
  }
  return skills;
}

// Scan skills bundled with isomux
export function discoverBundledSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];
  if (existsSync(BUNDLED_SKILLS_DIR)) {
    try {
      for (const entry of readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const description = extractSkillDescription(join(BUNDLED_SKILLS_DIR, entry.name, "SKILL.md"));
          skills.push({ name: entry.name, origin: "isomux", description });
        }
      }
    } catch {}
  }
  return skills;
}

// Also scan project-level skills for a given cwd
export function discoverProjectSkills(cwd: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  // Project commands: <cwd>/.claude/commands/<name>.md
  const projCmdsDir = join(cwd, ".claude", "commands");
  if (existsSync(projCmdsDir)) {
    try {
      for (const entry of readdirSync(projCmdsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const description = extractSkillDescription(join(projCmdsDir, entry.name));
          skills.push({ name: entry.name.replace(/\.md$/, ""), origin: "project", description });
        }
      }
    } catch {}
  }
  return skills;
}

// Scan skills from installed Claude Code plugins (~/.claude/plugins/)
export function discoverPluginSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const manifestPath = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(manifestPath)) return skills;

  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return skills;
  }

  if (!manifest.plugins || typeof manifest.plugins !== "object") return skills;

  for (const [key, entries] of Object.entries(manifest.plugins)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const pluginName = key.split("@")[0];
    const installPath = (entries as any[])[0].installPath;
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
            if (fmMatch && /user-invocable:\s*false/i.test(fmMatch[1])) continue;
          } catch {}
          const description = extractSkillDescription(skillMd);
          skills.push({ name: `${pluginName}:${d.name}`, origin: "plugin", description });
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
            skills.push({ name: `${pluginName}:${f.name.replace(/\.md$/, "")}`, origin: "plugin", description });
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
function resolvePluginSkillPrompt(pluginName: string, skillName: string): string | null {
  const manifestPath = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(manifestPath)) return null;
  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch { return null; }

  const pluginKey = Object.keys(manifest.plugins ?? {}).find(k => k.split("@")[0] === pluginName);
  if (!pluginKey) return null;
  const entries = manifest.plugins[pluginKey];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const installPath = entries[0].installPath;
  if (!installPath) return null;

  return readSkillFile(join(installPath, "skills", skillName, "SKILL.md"))
    ?? readSkillFile(join(installPath, "commands", `${skillName}.md`));
}

// Resolve a skill name to its prompt text, checking skill dirs in priority order:
// 1. User skills (~/.claude/) — highest skill tier
// 2. Project skills (<cwd>/.claude/)
// 3. Plugin skills (~/.claude/plugins/) — namespaced with "plugin:skill"
// 4. Isomux bundled skills (isomux/skills/)
export function resolveSkillPrompt(name: string, cwd: string): string | null {
  // Handle plugin-namespaced skills: "pluginName:skillName"
  if (name.includes(":")) {
    const [pluginName, skillName] = name.split(":", 2);
    return resolvePluginSkillPrompt(pluginName, skillName);
  }

  const candidates = [
    join(homedir(), ".claude", "skills", name, "SKILL.md"),
    join(homedir(), ".claude", "commands", `${name}.md`),
    join(cwd, ".claude", "skills", name, "SKILL.md"),
    join(cwd, ".claude", "commands", `${name}.md`),
    join(BUNDLED_SKILLS_DIR, name, "SKILL.md"),
  ];
  for (const path of candidates) {
    const prompt = readSkillFile(path);
    if (prompt !== null) return prompt;
  }
  return null;
}
