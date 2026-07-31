// Pure grouping/ranking transform for the Sk popover (task f1769b1a). Kept
// free of React so the ranking policy is unit-testable:
//
//   - A single cross-group "Most used" region surfaces at the very top: the
//     TOP_N entries with the highest use counts, count desc (name breaks
//     ties), spanning commands AND skills - "the most used are always the
//     most accessible regardless of skill/command" (Nil).
//   - The region is CAPPED (MOST_USED_CAP): counts are monotonic, so an
//     unbounded region would eventually drain every origin group into one
//     flat list. Used entries beyond the cap stay in their origin group
//     (keeping their ×N badge); an entry never appears twice.
//   - Never-used entries keep the original grouped layout: built-in commands
//     first (mirrors /help), then skills as bundled / user / project /
//     plugin, alphabetical. With no counts at all the menu is identical to
//     the pre-counts layout.
//   - An entry with `aliasFor` is a friendlier alias of a canonical name;
//     the canonical is hidden and the alias absorbs BOTH names' counts.
//   - Count reads are own-property + number guarded: names come from the
//     filesystem, so "constructor"/"toString" must never read
//     Object.prototype members off the parsed JSON counts map.
//
// "isomux" is the origin of skills bundled with isomux, hence "Bundled". The
// "claude" origin exists in the SkillOrigin union but no discovery path
// currently emits it; fold it into Bundled rather than surfacing an extra
// group that was never part of the agreed grouping.

import type { SkillInfo, SkillOrigin } from "../../shared/types.ts";

// Built-in slash commands ride the same slash_commands wire message as
// skills but with a simpler shape (no origin).
export interface CommandEntry {
  name: string;
  description?: string;
  aliasFor?: string;
  // No-arg commands EXECUTE on click instead of being copied into the draft.
  autoRun?: boolean;
}

export type GroupKey =
  | "most-used"
  | "commands"
  | "bundled"
  | "user"
  | "project"
  | "plugin";

const GROUP_ORDER: GroupKey[] = [
  "most-used",
  "commands",
  "bundled",
  "user",
  "project",
  "plugin",
];

const GROUP_LABELS: Record<GroupKey, string> = {
  "most-used": "Most used",
  commands: "Commands",
  bundled: "Bundled",
  user: "User",
  project: "Project",
  plugin: "Plugin",
};

export const MOST_USED_CAP = 8;

export interface SkillsMenuEntry {
  name: string;
  description?: string;
  autoRun?: boolean;
  count: number;
}

export interface SkillsMenuGroup {
  key: GroupKey;
  label: string;
  skills: SkillsMenuEntry[];
}

function groupForOrigin(origin: SkillOrigin): GroupKey {
  if (origin === "isomux" || origin === "claude") return "bundled";
  return origin;
}

export function buildSkillsMenuGroups(input: {
  skills: SkillInfo[];
  commands: CommandEntry[];
  counts: Record<string, number>;
  filter: string;
}): SkillsMenuGroup[] {
  const { skills, commands, counts, filter } = input;
  const aliasTargets = new Set(
    [...skills, ...commands]
      .filter((s) => s.aliasFor)
      .map((s) => s.aliasFor as string),
  );
  const q = filter.trim().toLowerCase();
  const matches = (name: string, description?: string) =>
    !q ||
    name.toLowerCase().includes(q) ||
    (description ?? "").toLowerCase().includes(q);
  const own = (k: string): number => {
    const v = Object.prototype.hasOwnProperty.call(counts, k) ? counts[k] : 0;
    return typeof v === "number" ? v : 0;
  };
  const countFor = (name: string, aliasFor?: string): number =>
    own(name) + (aliasFor ? own(aliasFor) : 0);

  // Collect every visible entry with its home group and count.
  const entries: { entry: SkillsMenuEntry; home: GroupKey }[] = [];
  const add = (
    home: GroupKey,
    name: string,
    description?: string,
    autoRun?: boolean,
    aliasFor?: string,
  ) => {
    if (aliasTargets.has(name) || !matches(name, description)) return;
    entries.push({
      entry: { name, description, autoRun, count: countFor(name, aliasFor) },
      home,
    });
  };
  // Only commands can be auto-run; skills always take a free-form prompt and
  // are copied into the draft.
  for (const c of commands)
    add("commands", c.name, c.description, c.autoRun, c.aliasFor);
  for (const s of skills)
    add(groupForOrigin(s.origin), s.name, s.description, undefined, s.aliasFor);

  // Top-N used entries across ALL groups form the "Most used" region; every
  // other entry (never-used, or used but beyond the cap) stays home.
  const mostUsed = entries
    .filter((e) => e.entry.count > 0)
    .sort(
      (a, b) =>
        b.entry.count - a.entry.count ||
        a.entry.name.localeCompare(b.entry.name),
    )
    .slice(0, MOST_USED_CAP);
  const promoted = new Set(mostUsed.map((e) => e.entry));

  const byGroup = new Map<GroupKey, SkillsMenuEntry[]>();
  if (mostUsed.length > 0)
    byGroup.set(
      "most-used",
      mostUsed.map((e) => e.entry),
    );
  for (const e of entries) {
    if (promoted.has(e.entry)) continue;
    const list = byGroup.get(e.home) ?? [];
    list.push(e.entry);
    byGroup.set(e.home, list);
  }
  for (const [key, list] of byGroup) {
    if (key === "most-used") continue; // already count-ordered
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({
    key: g,
    label: GROUP_LABELS[g],
    skills: byGroup.get(g)!,
  }));
}
