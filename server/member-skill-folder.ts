import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SkillEngine } from "../shared/contract-shapes.ts";
import { STATE_ROOT } from "./config.ts";
import { ISOMUX_CODEX_HOME } from "./backends/codex/native-bin.ts";
import { extractSkillDescription } from "./skills.ts";

// One skill folder per member, engine and provider root: the skills of the
// member's Sk menu that the engine does not read by itself, so the engine's
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
// The skill names Codex accepts; a command under another name stays
// menu-only on Codex and OpenCode.
const WRAPPER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
  // OpenCode 2.1.4 (measured with a server and GET /api/skill; measure again
  // on an OpenCode upgrade): ~/.claude/skills unless one of its Claude Code
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

export interface MemberSkillFolderInput {
  engine: SkillEngine;
  // memberSkillFolderPath(...)
  folder: string;
  // The menu's user folders in priority order (userSkillFolders).
  userFolders: { skills: string; commands?: string }[];
  bundledDir: string;
  // engineNativeSkillDirs(...)
  nativeDirs: string[];
}

type Planned =
  | { kind: "link"; target: string }
  | { kind: "wrapper"; content: string };

function entries(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// Where a link points, read one level. Null for an entry that is no link.
function linkTarget(path: string): string | null {
  try {
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

// A link isomux made: <dir>/<name> pointing at <bundledDir>/<name>.
function isBundledLink(path: string, bundledDir: string): boolean {
  return linkTarget(path) === join(resolve(bundledDir), basename(path));
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

// A skill or command that opts out of model use stays menu-only on the
// engines that do not read the flag themselves.
function optsOut(text: string): boolean {
  const frontmatter = text.match(FRONTMATTER)?.[1] ?? "";
  return /^disable-model-invocation:\s*["']?true["']?\s*$/m.test(frontmatter);
}

// A Claude command as a skill: its description (else its name) and its body.
// The description is a JSON string, which YAML reads back unchanged.
// $ARGUMENTS stays as written: nothing fills it when the model loads the
// skill by itself.
function wrapperFor(name: string, path: string, text: string): string {
  const description = extractSkillDescription(path) || name;
  const body = text.replace(FRONTMATTER, "");
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`;
}

// The names the engine reads by itself: a skill folder with a SKILL.md, and
// a command file as its name. A dead link or a folder without SKILL.md is
// nothing the engine loads, so it takes no name.
function nativeNames(dirs: string[]): Set<string> {
  const names = new Set<string>();
  for (const dir of dirs)
    for (const name of entries(dir)) {
      if (isFile(join(dir, name, "SKILL.md"))) names.add(name);
      else if (name.endsWith(".md") && isFile(join(dir, name)))
        names.add(name.slice(0, -3));
    }
  return names;
}

function plan(input: MemberSkillFolderInput): {
  skills: Map<string, Planned>;
  commands: Map<string, Planned>;
} {
  const claude = input.engine === "claude";
  const taken = nativeNames(input.nativeDirs);
  const skills = new Map<string, Planned>();
  const commands = new Map<string, Planned>();
  // The menu's order: each user folder's skills, then its commands, then the
  // bundled skills; the first of a name wins, also when it stays menu-only.
  for (const folder of input.userFolders) {
    for (const name of entries(folder.skills)) {
      const path = join(folder.skills, name);
      if (!isFile(join(path, "SKILL.md"))) continue;
      // An old isomux link to the bundled skill is the bundled skill.
      if (isBundledLink(path, input.bundledDir)) continue;
      if (taken.has(name)) continue;
      taken.add(name);
      if (!claude && optsOut(readText(join(path, "SKILL.md")))) continue;
      skills.set(name, { kind: "link", target: path });
    }
    if (!folder.commands) continue;
    for (const file of entries(folder.commands)) {
      if (!file.endsWith(".md")) continue;
      const path = join(folder.commands, file);
      if (!isFile(path)) continue;
      const name = file.slice(0, -3);
      if (taken.has(name)) continue;
      taken.add(name);
      if (claude) {
        commands.set(name, { kind: "link", target: path });
        continue;
      }
      const text = readText(path);
      if (optsOut(text) || name.length > 64 || !WRAPPER_NAME.test(name))
        continue;
      skills.set(name, {
        kind: "wrapper",
        content: wrapperFor(name, path, text),
      });
    }
  }
  for (const name of entries(input.bundledDir)) {
    const path = join(resolve(input.bundledDir), name);
    if (!isDir(path) || taken.has(name)) continue;
    taken.add(name);
    if (!claude && optsOut(readText(join(path, "SKILL.md")))) continue;
    skills.set(name, { kind: "link", target: path });
  }
  return { skills, commands };
}

function tempName(base: string): string {
  return `.${base}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
}

// Points dir/<entry> at target. A new link goes in under a temp name and is
// renamed over the old entry, so a reader never finds the entry missing.
function placeLink(dir: string, entry: string, target: string): void {
  const path = join(dir, entry);
  try {
    if (readlinkSync(path) === target) return;
  } catch {}
  const temp = join(dir, tempName(entry));
  symlinkSync(target, temp);
  try {
    renameSync(temp, path);
  } catch (err) {
    // A real folder in the way (not one of ours): replace it.
    if (!lstatSync(path).isSymbolicLink() && lstatSync(path).isDirectory()) {
      rmSync(path, { recursive: true, force: true });
      renameSync(temp, path);
      return;
    }
    rmSync(temp, { force: true });
    throw err;
  }
}

// The same for a generated SKILL.md: written under a temp name and renamed.
function placeFile(path: string, content: string): void {
  if (readText(path) === content && existsSync(path)) return;
  const temp = join(dirname(path), tempName(basename(path)));
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

// Removes what is not planned. Dot names are temp entries of a build in
// progress (or Codex's own), never removed here.
function removeExtras(dir: string, keep: Set<string>): void {
  for (const name of entries(dir)) {
    if (keep.has(name)) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

// Builds or updates the folder. Returns the path the engine is given (claude:
// the folder; codex, opencode: <folder>/skills), or null after a failure,
// which it logs. Never throws: a skill folder never blocks a session start.
export function buildMemberSkillFolder(
  input: MemberSkillFolderInput,
): string | null {
  try {
    const { folder } = input;
    const claude = input.engine === "claude";
    const { skills, commands } = plan(input);
    const skillsDir = claude
      ? join(folder, ".claude", "skills")
      : join(folder, "skills");
    mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
    if (claude) {
      const commandsDir = join(folder, ".claude", "commands");
      mkdirSync(commandsDir, { recursive: true, mode: 0o700 });
      for (const [name, entry] of commands)
        if (entry.kind === "link")
          placeLink(commandsDir, `${name}.md`, entry.target);
      removeExtras(
        commandsDir,
        new Set([...commands.keys()].map((name) => `${name}.md`)),
      );
    }
    const generated = join(folder, "generated");
    const wrappers = new Set<string>();
    for (const [name, entry] of skills) {
      if (entry.kind === "link") {
        placeLink(skillsDir, name, entry.target);
        continue;
      }
      const dir = join(generated, name);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      placeFile(join(dir, "SKILL.md"), entry.content);
      placeLink(skillsDir, name, dir);
      wrappers.add(name);
    }
    removeExtras(skillsDir, new Set(skills.keys()));
    // A generated skill goes once its name is no wrapper any more; the link
    // to it went above.
    if (!claude) removeExtras(generated, wrappers);
    return claude ? folder : skillsDir;
  } catch (err) {
    console.error(
      `[skills] could not build the skill folder ${input.folder}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
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
