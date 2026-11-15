// An isolated member's skills page catalog, built by their runner as the
// member (the skill-catalog entry, part 2d-iii-b): their roots, their
// plugins and their own agents' folders, read with their own files. The
// office sends the bundled skills as data (names and paths of our code), so
// the page shows them in the same places. This module is in the runner
// bundle: only fs, path and the scans.
import { isAbsolute, join } from "path";
import type {
  SkillCatalogEntry,
  SkillEngine,
} from "../shared/contract-shapes.ts";
import {
  engineCatalog,
  type SkillEngineContext,
} from "./skill-catalog-core.ts";
import {
  scanCommandsDir,
  scanSkillsDir,
  type LocatedSkill,
  type UserSkillRoot,
} from "./skill-scan.ts";

const PATH_MAX = 4096;
const TEXT_MAX = 1024;
const ROOTS_MAX = 8;
const CWDS_MAX = 500;
const BUNDLED_MAX = 200;

export interface SkillCatalogRequest {
  engines: {
    engine: SkillEngine;
    userRoots: UserSkillRoot[];
    pluginRoot: string;
    cwds: string[];
  }[];
  // The office's bundled skills (locateBundledSkills), as data.
  bundled: LocatedSkill[];
  bundledDir: string;
}

export interface SkillCatalogReply {
  engines: { engine: SkillEngine; skills: SkillCatalogEntry[] }[];
}

const ENGINES = new Set(["claude", "codex", "opencode"]);

function absolute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    Buffer.byteLength(value, "utf8") <= PATH_MAX &&
    !value.includes("\0")
  );
}

function text(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && Buffer.byteLength(value, "utf8") <= TEXT_MAX)
  );
}

// The request, or a throw when it is out of shape.
export function skillCatalogRequest(input: unknown): SkillCatalogRequest {
  const fail = (why: string): never => {
    throw new Error(`skill-catalog: ${why}`);
  };
  const req = input as Record<string, unknown> | null;
  if (typeof req !== "object" || req === null) return fail("no input");
  if (!Array.isArray(req.engines) || req.engines.length > ENGINES.size)
    fail("engines");
  for (const e of req.engines as Record<string, unknown>[]) {
    if (
      typeof e !== "object" ||
      e === null ||
      typeof e.engine !== "string" ||
      !ENGINES.has(e.engine) ||
      !absolute(e.pluginRoot) ||
      !Array.isArray(e.userRoots) ||
      e.userRoots.length > ROOTS_MAX ||
      !Array.isArray(e.cwds) ||
      e.cwds.length > CWDS_MAX ||
      !(e.cwds as unknown[]).every(absolute)
    )
      fail("an engine");
    for (const r of e.userRoots as Record<string, unknown>[])
      if (!absolute(r?.root) || typeof r.includeCommands !== "boolean")
        fail("a user root");
  }
  if (!absolute(req.bundledDir)) fail("the bundled folder");
  if (!Array.isArray(req.bundled) || req.bundled.length > BUNDLED_MAX)
    fail("the bundled skills");
  for (const b of req.bundled as Record<string, unknown>[])
    if (
      typeof b?.name !== "string" ||
      b.origin !== "isomux" ||
      !absolute(b.path) ||
      !absolute(b.dir) ||
      !text(b.description) ||
      !text(b.aliasFor)
    )
      fail("a bundled skill");
  return req as unknown as SkillCatalogRequest;
}

// The member's user skills: their roots alone (no office folder).
function locateUser(roots: UserSkillRoot[]): LocatedSkill[] {
  const skills: LocatedSkill[] = [];
  for (const { root, includeCommands } of roots) {
    scanSkillsDir(join(root, "skills"), "user", skills);
    if (includeCommands)
      scanCommandsDir(join(root, "commands"), "user", skills);
  }
  return skills;
}

export function buildMemberSkillCatalog(
  req: SkillCatalogRequest,
): SkillCatalogReply {
  return {
    engines: req.engines.map((context: SkillEngineContext) => ({
      engine: context.engine,
      skills: engineCatalog(
        context,
        {},
        { locateUser, bundled: req.bundled, bundledDir: req.bundledDir },
      ),
    })),
  };
}
