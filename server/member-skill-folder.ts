import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SkillEngine } from "../shared/contract-shapes.ts";
import { STATE_ROOT } from "./config.ts";
import { ISOMUX_CODEX_HOME } from "./backends/codex/native-bin.ts";
import { entries, isBundledLink, linkTarget } from "./skill-folder-build.ts";

export {
  buildMemberSkillFolder,
  type MemberSkillFolderInput,
} from "./skill-folder-build.ts";

// One skill folder per member, engine and provider root: the skills of the
// member's Skill menu that the engine does not read by itself, so the engine's
// own skill tool lists what the menu lists. No member's skill reaches another
// member's agent, and isomux writes nothing into a provider home. Agents of
// one member on different provider roots (a personal home, the office
// sign-in) read different native folders, so each root has its own folder.
//
// Layout under memberSkillFolderPath(...):
//   claude:          .claude/skills/<name> and .claude/commands/<name>.md
//                    (links); the engine gets the folder itself.
//   codex, opencode: skills/<name> (links); a Claude command becomes
//                    generated/<name>/SKILL.md, linked from skills/<name>;
//                    the engine gets <folder>/skills.

type Env = { [key: string]: string | undefined };

const MEMBER_ID = /^[a-zA-Z0-9_-]+$/;

function membersDir(stateRoot: string): string {
  return join(stateRoot, "member-skills");
}

// <stateRoot>/member-skills/<userId or .office>/<engine>/<sha8 of the
// resolved provider root>. A dot is not valid in a user id, so .office never
// names a member.
export function memberSkillFolderPath(
  userId: string | null | undefined,
  engine: SkillEngine,
  providerRoot: string,
  stateRoot: string = STATE_ROOT,
): string {
  if (userId && !MEMBER_ID.test(userId))
    throw new Error("Invalid user id for a member skill folder");
  const key = createHash("sha256")
    .update(resolve(providerRoot))
    .digest("hex")
    .slice(0, 8);
  return join(membersDir(stateRoot), userId || ".office", engine, key);
}

// An isolated member's folder: in their agent space, built by their runner
// (member-skill-folder-host.ts), keyed the same way.
export function memberSpaceSkillFolderPath(
  agentRoot: string,
  engine: SkillEngine,
  providerRoot: string,
): string {
  const key = createHash("sha256")
    .update(resolve(providerRoot))
    .digest("hex")
    .slice(0, 8);
  return join(agentRoot, "skill-folders", engine, key);
}

function flagSet(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

// The skills and commands folders the engine reads by itself, in the env and
// home its process gets. A name in one of them stays out of the folder: the
// engine's own copy wins.
export function engineNativeSkillDirs(
  engine: SkillEngine,
  env: Env | undefined,
  home: string,
): string[] {
  if (engine === "claude") {
    const root = env?.CLAUDE_CONFIG_DIR || join(home, ".claude");
    return [join(root, "skills"), join(root, "commands")];
  }
  if (engine === "codex")
    return [
      join(env?.CODEX_HOME || ISOMUX_CODEX_HOME, "skills"),
      join(home, ".agents", "skills"),
    ];
  // OpenCode 2.1.4 and 2.2.5 (measured with a server and GET /api/skill,
  // 2026-11-03; measure again on an OpenCode upgrade): ~/.claude/skills unless one of its Claude Code
  // flags is set, ~/.agents/skills, and skill/ and skills/ of its config
  // folder, which OPENCODE_CONFIG_DIR replaces.
  const dirs: string[] = [];
  if (
    !flagSet(env?.OPENCODE_DISABLE_CLAUDE_CODE) &&
    !flagSet(env?.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS)
  )
    dirs.push(join(home, ".claude", "skills"));
  dirs.push(join(home, ".agents", "skills"));
  const configDir =
    env?.OPENCODE_CONFIG_DIR ||
    join(env?.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  dirs.push(join(configDir, "skill"), join(configDir, "skills"));
  return dirs;
}

// Removes every folder of the member (all engines and provider roots).
export function removeMemberSkillFolders(
  userId: string,
  stateRoot: string = STATE_ROOT,
): void {
  if (!MEMBER_ID.test(userId)) return;
  rmSync(join(membersDir(stateRoot), userId), {
    recursive: true,
    force: true,
  });
}

// Boot: removes the folders of members that are gone. Keeps .office.
export function sweepMemberSkillFolders(
  liveUserIds: Iterable<string>,
  stateRoot: string = STATE_ROOT,
): void {
  const live = new Set(liveUserIds);
  for (const name of entries(membersDir(stateRoot)))
    if (!live.has(name)) removeMemberSkillFolders(name, stateRoot);
}

export interface LegacySkillLinkCleanup {
  // The office's own Codex home (ISOMUX_CODEX_HOME).
  codexHome: string;
  // The box Claude root (~/.claude or the office CLAUDE_CONFIG_DIR).
  boxClaudeRoot: string;
  // Every personal provider home (provider-homes/<userId>/<provider>).
  personalHomes: { provider: "claude" | "codex"; root: string }[];
  // The box source roots the personal homes linked from.
  sourceRoots: { claude: string; codex: string };
  bundledDir: string;
  // Written after a cleanup; a cleanup with this file present does nothing.
  marker: string;
}

function unlinkWhere(dir: string, matches: (path: string) => boolean): void {
  for (const name of entries(dir)) {
    const path = join(dir, name);
    if (!matches(path)) continue;
    try {
      unlinkSync(path);
    } catch {}
  }
}

// One time: removes the links the old session-start passes wrote into
// provider homes (bundled-skill links, and personal-home links to the box
// root of the same name). Nothing else is touched. A member may have made a
// personal-home link of that same shape by hand: removing it loses nothing,
// because the box root is in that member's menu roots, so the skill reaches
// their agents through the member skill folder.
export function cleanupLegacySkillLinks(opts: LegacySkillLinkCleanup): void {
  if (existsSync(opts.marker)) return;
  const bundled = (path: string) => isBundledLink(path, opts.bundledDir);
  for (const dir of [
    join(opts.codexHome, "skills"),
    join(opts.boxClaudeRoot, "skills"),
    ...opts.personalHomes.map((home) => join(home.root, "skills")),
  ])
    unlinkWhere(dir, bundled);
  for (const home of opts.personalHomes) {
    const source = resolve(opts.sourceRoots[home.provider]);
    for (const sub of home.provider === "claude"
      ? ["skills", "commands"]
      : ["skills"])
      unlinkWhere(
        join(home.root, sub),
        (path) => linkTarget(path) === join(source, sub, basename(path)),
      );
  }
  try {
    mkdirSync(dirname(opts.marker), { recursive: true, mode: 0o700 });
    writeFileSync(opts.marker, "");
  } catch (err) {
    console.error(
      "[skills] could not record the legacy skill link cleanup:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
