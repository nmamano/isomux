// An isolated member's skill folder, built by their runner as the member
// (the skill-folder entry, part 2d-iii-a). The office sends strings and the
// bytes of the bundled skills (our code), never a path into its own files:
// the runner writes the bundled skills to a copy in the member's agent
// space and links only to that copy and to the member's own folders. This
// module is in the runner bundle: only fs, path, crypto and
// skill-folder-build.ts.
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { SkillEngine } from "../shared/contract-shapes.ts";
import { buildMemberSkillFolder } from "./skill-folder-build.ts";

// Bounds of the bundle (agreed for part 2d-iii-a). The whole input is one
// runner frame (1 MiB), so the bytes, base64 included, stay well below it.
export const SKILL_BUNDLE_FILES_MAX = 200;
export const SKILL_BUNDLE_FILE_MAX = 256 * 1024;
export const SKILL_BUNDLE_TOTAL_MAX = 512 * 1024;
const SKILL_BUNDLE_DEPTH_MAX = 8;
const PATH_MAX = 4096;
const LIST_MAX = 64;

export interface SkillBundleFile {
  // Relative, "/"-separated.
  path: string;
  base64: string;
}

export interface SkillFolderRequest {
  engine: SkillEngine;
  // The member's agent space; the folder and the bundled copy are below
  // <agentRoot>/skill-folders.
  agentRoot: string;
  // <agentRoot>/skill-folders/<engine>/<key>
  folder: string;
  // The menu's user folders in priority order (strings: the member's own).
  userFolders: { skills: string; commands?: string }[];
  // The folders the engine reads by itself.
  nativeDirs: string[];
  // OpenCode: its config folder replaces the default one only when it is
  // there, which only the member can see.
  openCodeConfig?: { dir: string; ifThere: string[]; otherwise: string[] };
  bundle: SkillBundleFile[];
}

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

// A bundle path: relative, at most 8 segments, each of letters, digits,
// ".", "_" and "-", none starting with a dot (so no "." or "..").
export function isBundlePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 512)
    return false;
  const parts = path.split("/");
  return (
    parts.length <= SKILL_BUNDLE_DEPTH_MAX &&
    parts.every((part) => SEGMENT.test(part))
  );
}

// The bundle's problem, or null when it is in bounds: the same check on
// the office side before the call and in the runner before it writes.
export function skillBundleProblem(bundle: unknown): string | null {
  if (!Array.isArray(bundle)) return "the bundle is not a list";
  if (bundle.length > SKILL_BUNDLE_FILES_MAX)
    return `the bundle has more than ${SKILL_BUNDLE_FILES_MAX} files`;
  let total = 0;
  const seen = new Set<string>();
  for (const file of bundle as unknown[]) {
    const f = file as { path?: unknown; base64?: unknown } | null;
    if (!f || Object.keys(f).sort().join(",") !== "base64,path")
      return "a bundle file is out of shape";
    if (!isBundlePath(f.path)) return "a bundle path is not allowed";
    if (seen.has(f.path)) return "a bundle path is there twice";
    for (const other of seen)
      if (other.startsWith(`${f.path}/`) || f.path.startsWith(`${other}/`))
        return "a bundle path is a folder of another";
    seen.add(f.path);
    if (typeof f.base64 !== "string") return "a bundle file has no bytes";
    const size = Buffer.from(f.base64, "base64").length;
    if (size > SKILL_BUNDLE_FILE_MAX)
      return `a bundle file is larger than ${SKILL_BUNDLE_FILE_MAX} bytes`;
    total += size;
    if (total > SKILL_BUNDLE_TOTAL_MAX)
      return `the bundle is larger than ${SKILL_BUNDLE_TOTAL_MAX} bytes`;
  }
  return null;
}

// The bundle's hash: its paths and bytes in path order.
export function skillBundleHash(bundle: SkillBundleFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...bundle].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(Buffer.from(file.base64, "base64"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function absolute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    value.length <= PATH_MAX &&
    !value.includes("\0")
  );
}

function absoluteList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= LIST_MAX &&
    value.every((item) => absolute(item))
  );
}

const ENGINES = new Set(["claude", "codex", "opencode"]);
const KEY = /^[0-9a-f]{8}$/;

// The request, or a throw when it is out of shape.
export function skillFolderRequest(input: unknown): SkillFolderRequest {
  const fail = (why: string): never => {
    throw new Error(`skill-folder: ${why}`);
  };
  if (typeof input !== "object" || input === null) fail("no input");
  const req = input as Record<string, unknown>;
  const { engine, agentRoot, folder, userFolders, nativeDirs } = req;
  if (typeof engine !== "string" || !ENGINES.has(engine)) fail("engine");
  if (!absolute(agentRoot) || !absolute(folder)) fail("paths");
  const base = join(agentRoot as string, "skill-folders", engine as string);
  if (
    dirname(folder as string) !== base ||
    !KEY.test((folder as string).slice(base.length + 1))
  )
    fail("the folder is not one of the agent space's skill folders");
  if (!Array.isArray(userFolders) || userFolders.length > LIST_MAX)
    fail("user folders");
  for (const f of userFolders as unknown[]) {
    const entry = f as { skills?: unknown; commands?: unknown } | null;
    if (
      !entry ||
      !absolute(entry.skills) ||
      (entry.commands !== undefined && !absolute(entry.commands))
    )
      fail("user folders");
  }
  if (!absoluteList(nativeDirs)) fail("native folders");
  if (req.openCodeConfig !== undefined) {
    const c = req.openCodeConfig as Record<string, unknown> | null;
    if (
      !c ||
      !absolute(c.dir) ||
      !absoluteList(c.ifThere) ||
      !absoluteList(c.otherwise)
    )
      fail("the OpenCode config folder");
  }
  const problem = skillBundleProblem(req.bundle);
  if (problem) fail(problem);
  return req as unknown as SkillFolderRequest;
}

// The bundled skills' copy, <agentRoot>/skill-folders/bundled/<hash>,
// written once per hash: under a temp name, then renamed. Folders 0700,
// files 0600.
function placeBundle(root: string, bundle: SkillBundleFile[]): string {
  const hash = skillBundleHash(bundle);
  const dir = join(root, hash);
  if (existsSync(dir)) return dir;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = join(
    root,
    `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    mkdirSync(temp, { mode: 0o700 });
    for (const file of bundle) {
      const path = join(temp, ...file.path.split("/"));
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, Buffer.from(file.base64, "base64"), {
        mode: 0o600,
        flag: "wx",
      });
    }
    try {
      renameSync(temp, dir);
    } catch (err) {
      // Another build of the same hash came first.
      if (!existsSync(dir)) throw err;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return dir;
}

// A temp copy older than this is from a build that stopped (a crash);
// a build in progress writes its copy in well under it.
const STALE_TEMP_MS = 10 * 60 * 1000;

// Old copies: the current one and the newest other one stay (another
// engine's folder may still link to it until its next build); the rest go,
// and so do the temp copies of builds that stopped.
function pruneBundles(root: string, current: string): void {
  let all: string[];
  try {
    all = readdirSync(root);
  } catch {
    return;
  }
  for (const name of all) {
    if (!name.startsWith(".tmp-")) continue;
    try {
      if (Date.now() - statSync(join(root, name)).mtimeMs > STALE_TEMP_MS)
        rmSync(join(root, name), { recursive: true, force: true });
    } catch {}
  }
  const names = all.filter(
    (name) => !name.startsWith(".") && join(root, name) !== current,
  );
  const byAge = names
    .map((name) => {
      try {
        return { name, mtime: statSync(join(root, name)).mtimeMs };
      } catch {
        return { name, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { name } of byAge.slice(1))
    rmSync(join(root, name), { recursive: true, force: true });
}

// Builds the folder; returns the path the engine is given, as
// buildMemberSkillFolder does. Throws on a failure.
export function buildSkillFolderAsMember(req: SkillFolderRequest): string {
  const root = join(req.agentRoot, "skill-folders", "bundled");
  const bundledDir = placeBundle(root, req.bundle);
  const nativeDirs = [...req.nativeDirs];
  if (req.openCodeConfig)
    nativeDirs.push(
      ...(existsSync(req.openCodeConfig.dir)
        ? req.openCodeConfig.ifThere
        : req.openCodeConfig.otherwise),
    );
  const given = buildMemberSkillFolder({
    engine: req.engine,
    folder: req.folder,
    userFolders: req.userFolders,
    bundledDir,
    nativeDirs,
  });
  if (given === null) throw new Error("the skill folder build failed");
  pruneBundles(root, bundledDir);
  return given;
}
