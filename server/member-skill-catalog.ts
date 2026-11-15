// The skills page of an isolated member (part 2d-iii-b): their catalog comes
// from their runner (skill-catalog entry), and every read and write of a
// listed file goes through their host, as the member: the office never
// reads or writes a member's skill file with its own files. The only file
// the office reads for them is a bundled skill (our code). Every reply is
// member data: one entry out of shape refuses the whole reply.
import { dirname, isAbsolute, join } from "path";
import type {
  SkillCatalogEntry,
  SkillCatalogRes,
  SkillEngine,
} from "../shared/contract-shapes.ts";
import type { AgentHost } from "./agent-host.ts";
import {
  markFileDeleted,
  openFile,
  openOfficeFile,
  saveFile,
  type OpenFileResult,
  type SaveFileResult,
} from "./file-editor.ts";
import {
  MAX_SKILL_BYTES,
  skillFileContent,
  validateNewSkill,
  type CreateSkillResult,
  type DeleteSkillResult,
} from "./skill-catalog.ts";
import type { SkillCatalogRequest } from "./skill-catalog-runner.ts";
import type { LocatedSkill } from "./skill-scan.ts";
import { MEMBER_HOST_NOT_READY } from "./member-hosts.ts";

// A runner call for the catalog gets this long; a runner that does not
// answer is a failed call.
export const SKILL_CATALOG_TIMEOUT_MS = 30_000;
const ENTRIES_MAX = 1000;
const REPLY_MAX = 4 * 1024 * 1024;
const PATH_MAX = 4096;
const TEXT_MAX = 1024;
const NAME_MAX = 255;

// The member's host is not ready (their runner is not connected): the
// routes answer 409 member_os_user.
export class MemberSkillsNotReady extends Error {}

function isNotReady(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === MEMBER_HOST_NOT_READY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absolute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    Buffer.byteLength(value, "utf8") <= PATH_MAX &&
    !value.includes("\0")
  );
}

function optionalText(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && Buffer.byteLength(value, "utf8") <= TEXT_MAX)
  );
}

// A name as a skill can have one: no "/", no control character.
function isName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= NAME_MAX &&
    // eslint-disable-next-line no-control-regex
    !/[/\u0000-\u001f\u007f]/.test(value)
  );
}

const ENTRY_KEYS = new Set([
  "name",
  "aliasFor",
  "description",
  "source",
  "kind",
  "path",
  "dir",
  "project",
  "plugin",
  "editable",
  "shadowedBy",
  "uses",
]);
const SOURCES = new Set(["user", "project", "plugin", "isomux"]);

function parseEntry(
  value: unknown,
  engine: SkillEngine,
  bundledPaths: Set<string>,
): SkillCatalogEntry | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !ENTRY_KEYS.has(key))) return null;
  const e = value;
  if (!isName(e.name) || typeof e.source !== "string" || !SOURCES.has(e.source))
    return null;
  // A name with ":" runs only a plugin skill, and only Claude has plugins.
  if (
    e.name.includes(":") !== (e.source === "plugin") ||
    (e.source === "plugin" && engine !== "claude")
  )
    return null;
  if (e.kind !== "skill" && e.kind !== "command") return null;
  if (!absolute(e.path) || !absolute(e.dir)) return null;
  if (typeof e.editable !== "boolean" || typeof e.uses !== "number")
    return null;
  if (!optionalText(e.description) || !optionalText(e.aliasFor)) return null;
  if (e.project !== undefined && !absolute(e.project)) return null;
  if (e.shadowedBy !== undefined && !absolute(e.shadowedBy)) return null;
  if (e.plugin !== undefined && !isName(e.plugin)) return null;
  // Only user and project skills are the member's to change, and a built-in
  // is one the office sent.
  if (e.editable && e.source !== "user" && e.source !== "project") return null;
  if (e.source === "isomux" && !bundledPaths.has(e.path)) return null;
  return e as unknown as SkillCatalogEntry;
}

// The runner's catalog, or null when any part is out of shape or bounds.
export function parseMemberSkillCatalog(
  reply: unknown,
  engines: SkillEngine[],
  bundledPaths: Set<string>,
): SkillCatalogRes["engines"] | null {
  if (!isRecord(reply) || Object.keys(reply).join() !== "engines") return null;
  if (!Array.isArray(reply.engines) || reply.engines.length !== engines.length)
    return null;
  if (Buffer.byteLength(JSON.stringify(reply), "utf8") > REPLY_MAX) return null;
  const out: SkillCatalogRes["engines"] = [];
  for (const [i, item] of (reply.engines as unknown[]).entries()) {
    if (!isRecord(item) || item.engine !== engines[i]) return null;
    if (!Array.isArray(item.skills) || item.skills.length > ENTRIES_MAX)
      return null;
    const skills: SkillCatalogEntry[] = [];
    for (const raw of item.skills as unknown[]) {
      const entry = parseEntry(raw, engines[i], bundledPaths);
      if (!entry) return null;
      skills.push(entry);
    }
    out.push({ engine: engines[i], skills });
  }
  return out;
}

// The caller's own counts on the entries, as the office catalog has them.
function withUses(
  engines: SkillCatalogRes["engines"],
  counts: Record<string, number>,
): SkillCatalogRes["engines"] {
  const own = (name: string): number => {
    const v = Object.prototype.hasOwnProperty.call(counts, name)
      ? counts[name]
      : 0;
    return typeof v === "number" ? v : 0;
  };
  return engines.map(({ engine, skills }) => ({
    engine,
    skills: skills.map((skill) => ({
      ...skill,
      uses: own(skill.name) + (skill.aliasFor ? own(skill.aliasFor) : 0),
    })),
  }));
}

// The catalog of an isolated member. Throws MemberSkillsNotReady when their
// runner is not connected; a failed call, a runner that does not answer in
// time or a reply out of shape throws an Error, which the route shows.
export async function fetchMemberSkillCatalog(
  host: AgentHost,
  request: Omit<SkillCatalogRequest, "bundled" | "bundledDir">,
  bundled: { skills: LocatedSkill[]; dir: string },
  counts: Record<string, number>,
  page: { newSkillDir: string; home: string },
): Promise<SkillCatalogRes> {
  let reply: unknown;
  try {
    reply = await host.runEntry(
      "skill-catalog",
      { ...request, bundled: bundled.skills, bundledDir: bundled.dir },
      SKILL_CATALOG_TIMEOUT_MS,
    );
  } catch (err) {
    if (isNotReady(err)) throw new MemberSkillsNotReady();
    throw new Error(
      `Your agent runner gave no skill list: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const engines = parseMemberSkillCatalog(
    reply,
    request.engines.map((e) => e.engine),
    new Set(bundled.skills.map((s) => s.path)),
  );
  if (!engines)
    throw new Error("Your agent runner gave a skill list out of shape.");
  return { engines: withUses(engines, counts), ...page };
}

// A listed file of an isolated member: a built-in through the office (our
// code), anything else through their host.
export function readMemberSkillFile(
  host: AgentHost,
  entry: SkillCatalogEntry,
): Promise<OpenFileResult> {
  if (entry.source === "isomux")
    return Promise.resolve(openOfficeFile(entry.path));
  return guard(openFile(entry.path, host));
}

export function saveMemberSkillFile(
  host: AgentHost,
  entry: SkillCatalogEntry,
  content: string,
  expectedRev: number,
): Promise<SaveFileResult> {
  return guard(saveFile(entry.path, content, 0, expectedRev, false, host));
}

// The member's own file or folder goes through their host; the runner's
// catalog said it is editable (not a built-in or plugin file by its real
// path). rm does not follow a link: a linked entry loses only the link.
export async function deleteMemberSkillFile(
  host: AgentHost,
  entry: SkillCatalogEntry,
  expectedRev: number,
): Promise<DeleteSkillResult> {
  if (!entry.editable) return { kind: "read_only" };
  const current = await guard(openFile(entry.path, host));
  if (current.kind === "not_found") return { kind: "deleted" };
  if (current.kind !== "ok")
    return {
      kind: "io_error",
      message:
        current.kind === "io_error"
          ? current.message
          : "Could not read the skill file before deleting it.",
    };
  if (current.rev !== expectedRev)
    return {
      kind: "stale",
      currentRev: current.rev,
      currentMtime: current.mtime,
    };
  const target = entry.kind === "skill" ? dirname(entry.path) : entry.path;
  try {
    // A skill folder goes with its files; a command is one file. A linked
    // entry loses only its link.
    await host.fs.rm(target, { recursive: entry.kind === "skill" });
    markFileDeleted(entry.path, host);
    return { kind: "ok" };
  } catch (err) {
    if (isNotReady(err)) throw new MemberSkillsNotReady();
    return { kind: "io_error", message: (err as Error).message };
  }
}

// A new skill in the member's own folder, written as the member.
export async function createMemberSkill(
  host: AgentHost,
  newSkillDir: string,
  input: { name: unknown; description: unknown; instructions?: unknown },
): Promise<CreateSkillResult> {
  const valid = validateNewSkill(input);
  if (valid.kind === "invalid") return valid;
  const content = skillFileContent(
    valid.name,
    valid.description,
    valid.instructions,
  );
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES)
    return { kind: "invalid", field: "instructions" };
  const folder = join(newSkillDir, valid.name);
  const path = join(folder, "SKILL.md");
  try {
    if (await host.fs.exists(folder)) return { kind: "exists", path };
    await host.fs.mkdir(folder, 0o755);
    await host.fs.writeText(path, content, { mode: 0o644, exclusive: true });
  } catch (err) {
    if (isNotReady(err)) throw new MemberSkillsNotReady();
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST")
      return { kind: "exists", path };
    return { kind: "io_error", message: (err as Error).message };
  }
  return { kind: "ok", path };
}

async function guard<T>(result: Promise<T>): Promise<T> {
  try {
    return await result;
  } catch (err) {
    if (isNotReady(err)) throw new MemberSkillsNotReady();
    throw err;
  }
}
