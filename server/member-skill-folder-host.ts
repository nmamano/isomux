// The office's side of an isolated member's skill folder (part 2d-iii-a):
// the folder is in the member's agent space and their runner builds it
// (skill-folder entry, server/skill-folder-runner.ts). The office sends the
// member's own folders as strings and the bundled skills as bytes; it never
// stats, reads or links a member path itself.
//
// A session gets the folder only after a build for the same input
// answered: a session that starts first runs without it, and gets it at its
// next start. One build per input runs at a time; a second ask waits for
// the first.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentHost } from "./agent-host.ts";
import { BUNDLED_SKILLS_DIR } from "./skills.ts";
import {
  skillBundleHash,
  skillBundleProblem,
  type SkillBundleFile,
  type SkillFolderRequest,
} from "./skill-folder-runner.ts";

export const SKILL_FOLDER_TIMEOUT_MS = 30_000;

// The bundled skills as the bundle: every regular file below the folder,
// in path order. Read once per process: the folder is our code.
let bundleCache: { dir: string; files: SkillBundleFile[] } | null = null;

export function readSkillBundle(
  dir: string = BUNDLED_SKILLS_DIR,
): SkillBundleFile[] {
  if (bundleCache?.dir === dir) return bundleCache.files;
  const files: SkillBundleFile[] = [];
  const walk = (rel: string) => {
    const abs = rel ? join(dir, rel) : dir;
    for (const name of readdirSync(abs).sort()) {
      if (name.startsWith(".")) continue;
      const path = rel ? `${rel}/${name}` : name;
      const stat = statSync(join(dir, path));
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile())
        files.push({
          path,
          base64: readFileSync(join(dir, path)).toString("base64"),
        });
    }
  };
  walk("");
  bundleCache = { dir, files };
  return files;
}

export type MemberSkillFolderInput = Omit<SkillFolderRequest, "bundle">;

// Per input: the path the last build that answered gave, and the build
// that runs now.
interface Build {
  path: string | null;
  running: Promise<string | null> | null;
}

// The path the engine is given for a folder: claude the folder itself, the
// others its skills/.
export function engineSkillPath(input: MemberSkillFolderInput): string {
  return input.engine === "claude"
    ? input.folder
    : join(input.folder, "skills");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createMemberSkillFolders(
  opts: {
    bundle?: () => SkillBundleFile[];
    timeoutMs?: number;
  } = {},
) {
  const builds = new Map<string, Build>();
  const bundleOf = opts.bundle ?? (() => readSkillBundle());

  function keyOf(
    userId: string,
    input: MemberSkillFolderInput,
    bundle: SkillBundleFile[],
  ): string {
    return JSON.stringify([userId, input, skillBundleHash(bundle)]);
  }

  async function run(
    host: AgentHost,
    userId: string,
    input: MemberSkillFolderInput,
    bundle: SkillBundleFile[],
  ): Promise<string | null> {
    const problem = skillBundleProblem(bundle);
    if (problem) {
      console.error(
        `[skills] ${userId}: no skill folder for ${input.engine}: ${problem}`,
      );
      return null;
    }
    const expected = engineSkillPath(input);
    try {
      const reply = await host.runEntry(
        "skill-folder",
        { ...input, bundle },
        opts.timeoutMs ?? SKILL_FOLDER_TIMEOUT_MS,
      );
      if (
        isRecord(reply) &&
        Object.keys(reply).length === 1 &&
        reply.path === expected
      )
        return expected;
      console.error(
        `[skills] ${userId}: the member runner gave a skill folder reply out of shape for ${input.engine}`,
      );
    } catch (err) {
      console.error(
        `[skills] ${userId}: the member runner built no skill folder for ${input.engine}: ${(err as Error).message}`,
      );
    }
    return null;
  }

  // Starts a build for the input, or joins the one that runs. Resolves to
  // the path the engine is given, or null after a failure (logged; a failed
  // build keeps the path an earlier one gave).
  function build(
    host: AgentHost,
    userId: string,
    input: MemberSkillFolderInput,
  ): Promise<string | null> {
    let bundle: SkillBundleFile[];
    try {
      bundle = bundleOf();
    } catch (err) {
      console.error(
        `[skills] cannot read the bundled skills: ${(err as Error).message}`,
      );
      return Promise.resolve(null);
    }
    const key = keyOf(userId, input, bundle);
    let entry = builds.get(key);
    if (entry?.running) return entry.running;
    if (!entry) {
      entry = { path: null, running: null };
      builds.set(key, entry);
    }
    const own = entry;
    own.running = run(host, userId, input, bundle).then((path) => {
      own.running = null;
      if (path !== null) own.path = path;
      return path;
    });
    return own.running;
  }

  // The path for a session start: only when a build for this input
  // answered. A build starts when none answered yet, and with `rebuild`
  // also after one did, so a skill added since reaches the folder; the
  // path of the last answer stays in use meanwhile.
  function pathFor(
    host: AgentHost,
    userId: string,
    input: MemberSkillFolderInput,
    rebuild = false,
  ): string | null {
    let bundle: SkillBundleFile[];
    try {
      bundle = bundleOf();
    } catch {
      return null;
    }
    const path = builds.get(keyOf(userId, input, bundle))?.path ?? null;
    if (path === null || rebuild) void build(host, userId, input);
    return path;
  }

  return { build, pathFor };
}
