// The project skills of a working folder, as the engine finds them there
// (server/skills.ts locateProjectSkills reads the same folders). A member
// runner runs the two entries below as the member (project-skills,
// project-skill), so this module is in the runner bundle: only fs and path.
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  type Dirent,
} from "fs";
import { isAbsolute, join } from "path";
import type { SkillEngine } from "../shared/contract-shapes.ts";

// The names the skills page can write and a member runner's list carries.
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Bounds of the runner's replies (agreed for part 2b-ii). Text and body
// bounds count UTF-8 bytes.
export const PROJECT_SKILL_LIST_MAX = 200;
export const PROJECT_SKILL_TEXT_MAX = 1024;
export const PROJECT_SKILL_REPLY_MAX = 512 * 1024;
export const PROJECT_SKILL_BODY_MAX = 256 * 1024;
// The head of a skill file the list reads for its description.
const DESCRIPTION_READ_MAX = 64 * 1024;

export interface ProjectSkillMeta {
  name: string;
  kind: "skill" | "command";
  description?: string;
  aliasFor?: string;
}

// The project folders an engine reads by itself in its working folder, in
// menu priority order (Codex also reads .agents/skills up to the repository
// root; the menu reads the working folder only). The Sk menu lists only
// these, so a project skill in another engine's folder is not offered to an
// agent whose tool cannot load it.
export function projectSkillFolders(
  cwd: string,
  engine: SkillEngine,
): { dir: string; commands?: true }[] {
  const at = (...parts: string[]) => join(cwd, ...parts);
  switch (engine) {
    case "claude":
      return [
        { dir: at(".claude", "skills") },
        { dir: at(".claude", "commands"), commands: true },
      ];
    case "codex":
      return [{ dir: at(".agents", "skills") }];
    case "opencode":
      return [
        { dir: at(".opencode", "skills") },
        { dir: at(".opencode", "skill") },
        { dir: at(".agents", "skills") },
        { dir: at(".claude", "skills") },
      ];
  }
}

// The file a skill or command name reads from in one folder.
function skillFile(folder: { dir: string; commands?: true }, name: string) {
  return folder.commands
    ? join(folder.dir, `${name}.md`)
    : join(folder.dir, name, "SKILL.md");
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// `text` cut to at most `max` UTF-8 bytes, on a character boundary.
function cutToBytes(text: string, max: number): string {
  if (utf8Bytes(text) <= max) return text;
  let out = "";
  let size = 0;
  for (const ch of text) {
    const next = utf8Bytes(ch);
    if (size + next > max) break;
    out += ch;
    size += next;
  }
  return out;
}

// At most `max` bytes of a regular file, opened without following a final
// link; null when the file is absent or not a regular file. `over` is true
// when the file has more.
function readBounded(
  path: string,
  max: number,
): { text: string; over: boolean } | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buf.length) {
      const n = readSync(fd, buf, size, buf.length - size, null);
      if (n === 0) break;
      size += n;
    }
    return {
      text: buf.subarray(0, Math.min(size, max)).toString("utf8"),
      over: size > max,
    };
  } finally {
    closeSync(fd);
  }
}

// The description in a skill file's frontmatter, as skills.ts reads it.
function description(text: string): string | undefined {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const raw = fm?.[1].match(/description:\s*(.+)/)?.[1];
  if (raw === undefined) return undefined;
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

function isDirectoryEntry(dir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function isFileEntry(dir: string, entry: Dirent): boolean {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isFile();
  } catch {
    return false;
  }
}

// The project skills of `cwd` for `engine`, first name wins, within the
// list bounds: a name outside SKILL_NAME is left out, a description is cut
// to the text bound, and the list stops at the entry or reply bound.
export function scanProjectSkillList(
  cwd: string,
  engine: SkillEngine,
): ProjectSkillMeta[] {
  const out: ProjectSkillMeta[] = [];
  const seen = new Set<string>();
  let replyBytes = 2;
  for (const folder of projectSkillFolders(cwd, engine)) {
    let entries: Dirent[];
    try {
      entries = readdirSync(folder.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      let name: string;
      if (folder.commands) {
        if (!entry.name.endsWith(".md") || !isFileEntry(folder.dir, entry))
          continue;
        name = entry.name.slice(0, -3);
      } else {
        if (!isDirectoryEntry(folder.dir, entry)) continue;
        name = entry.name;
      }
      if (!SKILL_NAME.test(name) || seen.has(name)) continue;
      const read = readBounded(skillFile(folder, name), DESCRIPTION_READ_MAX);
      if (!read) continue;
      const meta: ProjectSkillMeta = {
        name,
        kind: folder.commands ? "command" : "skill",
      };
      const said = description(read.text);
      if (said !== undefined)
        meta.description = cutToBytes(said, PROJECT_SKILL_TEXT_MAX);
      const size = utf8Bytes(JSON.stringify(meta)) + 1;
      if (
        out.length >= PROJECT_SKILL_LIST_MAX ||
        replyBytes + size > PROJECT_SKILL_REPLY_MAX
      )
        return out;
      seen.add(name);
      out.push(meta);
      replyBytes += size;
    }
  }
  return out;
}

// The file of skill `name` in `cwd` for `engine`, as written (frontmatter
// included), from the first folder that has it; {name, missing: true} when
// no folder has it. Throws when it is over the body bound.
export function readProjectSkillBody(
  cwd: string,
  engine: SkillEngine,
  name: string,
): { name: string; body: string } | { name: string; missing: true } {
  if (!SKILL_NAME.test(name)) return { name, missing: true };
  for (const folder of projectSkillFolders(cwd, engine)) {
    const read = readBounded(skillFile(folder, name), PROJECT_SKILL_BODY_MAX);
    if (!read) continue;
    if (read.over)
      throw new Error(
        `project skill ${name} is over ${PROJECT_SKILL_BODY_MAX} bytes`,
      );
    return { name, body: read.text };
  }
  return { name, missing: true };
}

const ENGINES = new Set(["claude", "codex", "opencode"]);

// The {cwd, engine} input of the two runner entries.
export function skillEngineInput(
  input: unknown,
  entry: string,
): { cwd: string; engine: SkillEngine } {
  const req = input as { cwd?: unknown; engine?: unknown } | null;
  if (
    typeof req?.cwd !== "string" ||
    !isAbsolute(req.cwd) ||
    typeof req.engine !== "string" ||
    !ENGINES.has(req.engine)
  )
    throw new Error(`${entry} needs an absolute cwd and an engine`);
  return { cwd: req.cwd, engine: req.engine as SkillEngine };
}
