// Pure helpers for the Skills page, kept free of React so the grouping and
// filtering rules are unit-testable.

import type {
  SkillCatalogEntry,
  SkillCatalogRes,
  SkillSource,
} from "../../shared/contract-shapes.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";

// The member's own skills first, built-ins last: the order of what a member
// is most likely to open.
export const SOURCE_ORDER: readonly SkillSource[] = [
  "user",
  "project",
  "plugin",
  "isomux",
];

export const SOURCE_GROUP_KEYS: Record<SkillSource, PlainMessageKey> = {
  user: "skills.group.user",
  project: "skills.group.project",
  plugin: "skills.group.plugin",
  isomux: "skills.group.isomux",
};

export const SOURCE_BADGE_KEYS: Record<SkillSource, PlainMessageKey> = {
  user: "skills.source.user",
  project: "skills.source.project",
  plugin: "skills.source.plugin",
  isomux: "skills.source.isomux",
};

// One entry's identity on the page. A built-in alias shares its file with no
// other listed entry, but two names can share a path in principle.
export function entryKey(entry: Pick<SkillCatalogEntry, "name" | "path">) {
  return `${entry.name}\0${entry.path}`;
}

export function matchesQuery(entry: SkillCatalogEntry, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.name.toLowerCase().includes(q) ||
    (entry.description ?? "").toLowerCase().includes(q) ||
    entry.path.toLowerCase().includes(q)
  );
}

export interface SkillGroup {
  source: SkillSource;
  skills: SkillCatalogEntry[];
}

// Group by source in SOURCE_ORDER. Inside a group, skills that run come
// before shadowed ones, then by name.
export function groupSkills(
  skills: SkillCatalogEntry[],
  query: string,
): SkillGroup[] {
  const groups: SkillGroup[] = [];
  for (const source of SOURCE_ORDER) {
    const list = skills
      .filter((s) => s.source === source && matchesQuery(s, query))
      .sort(
        (a, b) =>
          Number(!!a.shadowedBy) - Number(!!b.shadowedBy) ||
          a.name.localeCompare(b.name),
      );
    if (list.length > 0) groups.push({ source, skills: list });
  }
  return groups;
}

// A path under the home folder shows as ~/...
export function tildePath(path: string, home: string): string {
  if (!home || home === "/") return path;
  const base = home.replace(/\/+$/, "");
  if (path === base) return "~";
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

// The SKILL.md body without its frontmatter, for the rendered preview.
export function skillBody(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---[^\n]*(?:\r?\n|$)/, "");
}

// Mirrors the server's name rule, so the form can say what is wrong before
// a round trip.
export function validSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

// Shared means the exact name and path run in all three existing catalogs.
// Each catalog retains its current "runs in any agent context" meaning.
// Different paths (including symlinks) remain in the engine-specific lists.
export function partitionSkills(engines: SkillCatalogRes["engines"]) {
  const lists = ["claude", "codex", "opencode"].map(
    (engine) => engines.find((e) => e.engine === engine)?.skills ?? [],
  );
  const runnable = lists.map(
    (skills) => new Set(skills.filter((s) => !s.shadowedBy).map(entryKey)),
  );
  const shared = lists[0].filter((s) =>
    runnable.every((keys) => keys.has(entryKey(s))),
  );
  const sharedKeys = new Set(shared.map(entryKey));
  return {
    shared,
    engines: engines.map((e) => ({
      ...e,
      skills: e.skills.filter((s) => !sharedKeys.has(entryKey(s))),
    })),
  };
}
