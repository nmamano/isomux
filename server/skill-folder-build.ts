// The build of one member skill folder from the folders it is given
// (member-skill-folder.ts says what goes in). The office builds the
// folders of its own agents; an isolated member's runner builds theirs as
// the member (the skill-folder entry, part 2d-iii-a), so this module is in
// the runner bundle: only fs, path, crypto and skill-scan.ts.
import { randomBytes } from "node:crypto";
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
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SkillEngine } from "../shared/contract-shapes.ts";
import { extractSkillDescription } from "./skill-scan.ts";

// The skill names Codex accepts; a command under another name stays
// menu-only on Codex and OpenCode.
const WRAPPER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
  { kind: "link"; target: string } | { kind: "wrapper"; content: string };

export function entries(dir: string): string[] {
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
export function linkTarget(path: string): string | null {
  try {
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

// A link isomux made: <dir>/<name> pointing at <bundledDir>/<name>.
export function isBundledLink(path: string, bundledDir: string): boolean {
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
