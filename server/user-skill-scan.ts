// The user, plugin and synced skills of an isolated member's agent (part
// 2d-iii-a), as their runner finds them: the user-skills entry lists them
// (names and descriptions, no paths) and the user-skill entry reads one at
// its invocation. The runner reads as the member, so it reaches only what
// the member could read with their own shell, also when a root or a
// reported plugin path names an office folder. This module is in the runner
// bundle: only fs, path and the scans of skill-scan.ts.
import { basename, isAbsolute, join } from "path";
import type { EnginePlugin } from "./backends/types.ts";
import type { SkillEngine } from "../shared/contract-shapes.ts";
import {
  cutToBytes,
  PROJECT_SKILL_BODY_MAX,
  PROJECT_SKILL_LIST_MAX,
  PROJECT_SKILL_REPLY_MAX,
  PROJECT_SKILL_TEXT_MAX,
  readBounded,
  utf8Bytes,
  type ProjectSkillMeta,
} from "./project-skill-scan.ts";
import {
  locatePluginSkills,
  locateSyncedSkills,
  pluginDirs,
  scanCommandsDir,
  scanSkillsDir,
  type LocatedSkill,
} from "./skill-scan.ts";

// Bounds of the request (the server builds it; the runner checks it again).
export const USER_SKILL_ROOTS_MAX = 8;
export const USER_SKILL_PLUGINS_MAX = 200;
export const USER_SKILL_PATH_MAX = 4096;
// A name is at most this many UTF-8 bytes (a folder or file name).
const NAME_MAX = 255;

export interface UserSkillScanInput {
  engine: SkillEngine;
  cwd: string;
  // The member's own roots (userSkillRootsForInfo for a member): never a
  // box root and never STATE_ROOT/skills.
  roots: { root: string; includeCommands: boolean }[];
  claudeConfigDir: string;
  // The plugins the member's live Claude process reported, or null.
  plugins: { name: string; path: string; source?: string }[] | null;
  // Read the synced skills on disk (no live process rows), Claude only.
  synced: boolean;
}

export interface UserSkillLists {
  user: ProjectSkillMeta[];
  plugin: ProjectSkillMeta[];
  synced: ProjectSkillMeta[];
}

export type UserSkillBody =
  | { name: string; from: "user" | "plugin" | "synced"; body: string }
  | { name: string; missing: true };

// One name segment: a folder or file name, no "/", no ":", no control
// character, not "." or "..".
function isSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    utf8Bytes(value) <= NAME_MAX &&
    // eslint-disable-next-line no-control-regex
    !/[/:\u0000-\u001f\u007f]/.test(value)
  );
}

// A skill name the office takes from a runner: a user or synced name is one
// segment; a plugin name is <plugin>:<skill>, and only Claude has plugins.
export function isMemberSkillName(
  name: unknown,
  kind: "user" | "plugin",
): name is string {
  if (typeof name !== "string") return false;
  if (kind === "user") return isSegment(name);
  const parts = name.split(":");
  return parts.length === 2 && isSegment(parts[0]) && isSegment(parts[1]);
}

const ENGINES = new Set(["claude", "codex", "opencode"]);

function absolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    utf8Bytes(value) <= USER_SKILL_PATH_MAX &&
    !value.includes("\0")
  );
}

// The request of both entries, or a throw when it is out of shape.
export function userSkillScanInput(
  input: unknown,
  entry: string,
): UserSkillScanInput {
  const fail = (): never => {
    throw new Error(`${entry} input is out of shape`);
  };
  if (typeof input !== "object" || input === null) return fail();
  const req = input as Record<string, unknown>;
  const { engine, cwd, roots, claudeConfigDir, plugins, synced } = req;
  if (typeof engine !== "string" || !ENGINES.has(engine)) fail();
  if (!absolutePath(cwd) || !absolutePath(claudeConfigDir)) fail();
  if (typeof synced !== "boolean") fail();
  if (!Array.isArray(roots) || roots.length > USER_SKILL_ROOTS_MAX) fail();
  const rootList = (roots as unknown[]).map((root) => {
    const r = root as { root?: unknown; includeCommands?: unknown } | null;
    if (!absolutePath(r?.root) || typeof r.includeCommands !== "boolean")
      return fail();
    return { root: r.root, includeCommands: r.includeCommands };
  });
  let pluginList: UserSkillScanInput["plugins"] = null;
  if (plugins !== null) {
    if (!Array.isArray(plugins) || plugins.length > USER_SKILL_PLUGINS_MAX)
      fail();
    pluginList = (plugins as unknown[]).map((plugin) => {
      const p = plugin as {
        name?: unknown;
        path?: unknown;
        source?: unknown;
      } | null;
      if (
        typeof p?.name !== "string" ||
        !isSegment(p.name) ||
        !absolutePath(p.path) ||
        (p.source !== undefined &&
          (typeof p.source !== "string" ||
            utf8Bytes(p.source) > USER_SKILL_PATH_MAX))
      )
        return fail();
      return {
        name: p.name,
        path: p.path,
        ...(p.source !== undefined ? { source: p.source } : {}),
      };
    });
  }
  return {
    engine: engine as SkillEngine,
    cwd: cwd as string,
    roots: rootList,
    claudeConfigDir: claudeConfigDir as string,
    plugins: pluginList,
    synced: synced as boolean,
  };
}

function reported(input: UserSkillScanInput): EnginePlugin[] | null {
  return input.plugins;
}

function locateUser(input: UserSkillScanInput): LocatedSkill[] {
  const skills: LocatedSkill[] = [];
  for (const { root, includeCommands } of input.roots) {
    scanSkillsDir(join(root, "skills"), "user", skills);
    if (includeCommands)
      scanCommandsDir(join(root, "commands"), "user", skills);
  }
  return skills;
}

// The lists, first name wins in each, within the bounds: a name outside the
// rule is left out, a description is cut to the text bound, and a list stops
// at the entry bound or when the whole reply would pass its bound.
export function scanUserSkillLists(input: UserSkillScanInput): UserSkillLists {
  const claude = input.engine === "claude";
  const found = {
    user: locateUser(input),
    plugin: claude
      ? locatePluginSkills(input.claudeConfigDir, input.cwd, reported(input))
      : [],
    synced:
      claude && input.synced ? locateSyncedSkills(input.claudeConfigDir) : [],
  };
  const out: UserSkillLists = { user: [], plugin: [], synced: [] };
  let replyBytes = utf8Bytes(JSON.stringify(out));
  for (const list of ["user", "plugin", "synced"] as const) {
    const seen = new Set<string>();
    for (const skill of found[list]) {
      if (out[list].length >= PROJECT_SKILL_LIST_MAX) break;
      if (!isMemberSkillName(skill.name, list === "plugin" ? "plugin" : "user"))
        continue;
      if (seen.has(skill.name)) continue;
      const meta: ProjectSkillMeta = {
        name: skill.name,
        kind: basename(skill.path) === "SKILL.md" ? "skill" : "command",
      };
      if (skill.description !== undefined)
        meta.description = cutToBytes(
          skill.description,
          PROJECT_SKILL_TEXT_MAX,
        );
      const size = utf8Bytes(JSON.stringify(meta)) + 1;
      if (replyBytes + size > PROJECT_SKILL_REPLY_MAX) return out;
      seen.add(skill.name);
      out[list].push(meta);
      replyBytes += size;
    }
  }
  return out;
}

// The first file of `paths` that is there, as written, within the body
// bound (a link is followed: the runner reads as the member). Throws when it
// is over the bound.
function firstBody(paths: string[], name: string): string | null {
  for (const path of paths) {
    const read = readBounded(path, PROJECT_SKILL_BODY_MAX, true);
    if (!read) continue;
    if (read.over)
      throw new Error(`skill ${name} is over ${PROJECT_SKILL_BODY_MAX} bytes`);
    return read.text;
  }
  return null;
}

// Skill `name` as the office resolves it, minus what the office reads
// itself (bundled skills) and what the runner reads in another entry
// (project skills): a plugin name reads that plugin's file; another name
// the member's roots in order, then the synced skills on disk.
export function readUserSkillBody(
  input: UserSkillScanInput,
  name: string,
): UserSkillBody {
  const missing = { name, missing: true } as const;
  if (name.includes(":")) {
    if (input.engine !== "claude" || !isMemberSkillName(name, "plugin"))
      return missing;
    const [pluginName, skillName] = name.split(":");
    const plugin = pluginDirs(
      input.claudeConfigDir,
      input.cwd,
      reported(input),
    ).find((p) => p.name === pluginName);
    if (!plugin) return missing;
    const body = firstBody(
      [
        join(plugin.path, "skills", skillName, "SKILL.md"),
        join(plugin.path, "commands", `${skillName}.md`),
      ],
      name,
    );
    return body === null ? missing : { name, from: "plugin", body };
  }
  if (!isMemberSkillName(name, "user")) return missing;
  const user = firstBody(
    input.roots.flatMap(({ root, includeCommands }) => [
      join(root, "skills", name, "SKILL.md"),
      ...(includeCommands ? [join(root, "commands", `${name}.md`)] : []),
    ]),
    name,
  );
  if (user !== null) return { name, from: "user", body: user };
  if (input.engine === "claude" && input.synced) {
    const synced = locateSyncedSkills(input.claudeConfigDir).find(
      (skill) => skill.name === name,
    );
    const body = synced ? firstBody([synced.path], name) : null;
    if (body !== null) return { name, from: "synced", body };
  }
  return missing;
}
