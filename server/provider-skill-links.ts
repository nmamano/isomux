import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  symlinkSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ProviderAccountProvider } from "../shared/types.ts";
import { BUNDLED_SKILLS_DIR, type UserSkillRoot } from "./skills.ts";
import { personalProviderHome } from "./provider-homes.ts";
import { buildOfficeEnv } from "./env-loader.ts";

// The office's Claude root: CLAUDE_CONFIG_DIR from the office env, else the
// box ~/.claude. Skill discovery reads it as the Claude source root, personal
// Claude homes link its skills, and the skills page creates new skills in it,
// so a skill there reaches every engine with or without a personal account.
// Read on each call, so an office env edit takes effect without a restart.
export function officeClaudeSourceRoot(): string {
  let root: string | undefined;
  try {
    root = buildOfficeEnv().CLAUDE_CONFIG_DIR || undefined;
  } catch {
    root = undefined;
  }
  return root ?? join(homedir(), ".claude");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function linkEntries(
  sourceDir: string,
  targetDir: string,
  accepts: (entry: Dirent) => boolean,
): void {
  let sourceEntries: Dirent[];
  try {
    sourceEntries = existsSync(sourceDir)
      ? readdirSync(sourceDir, { withFileTypes: true }).filter(accepts)
      : [];
  } catch {
    return;
  }
  try {
    if (existsSync(targetDir)) {
      for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) continue;
        const target = join(targetDir, entry.name);
        const linkTarget = resolve(dirname(target), readlinkSync(target));
        const fromSource = relative(sourceDir, linkTarget);
        const pointsInsideSource =
          fromSource !== "" &&
          fromSource !== ".." &&
          !fromSource.startsWith(`..${sep}`);
        const matchingSource = sourceEntries.some(
          (source) => source.name === entry.name,
        );
        if (
          (pointsInsideSource && !matchingSource) ||
          (matchingSource && !existsSync(target))
        ) {
          unlinkSync(target);
        }
      }
    }
  } catch {
    // A concurrent cleanup must not prevent a valid source from being linked.
  }
  if (sourceEntries.length === 0) return;
  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    for (const entry of sourceEntries) {
      const target = join(targetDir, entry.name);
      if (pathExists(target)) continue;
      symlinkSync(
        join(sourceDir, entry.name),
        target,
        entry.isDirectory() ? "dir" : "file",
      );
    }
  } catch {
    // Skill exposure is best-effort. A read-only or concurrently changed source
    // must not prevent an agent session from starting.
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

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// A link isomux made: <skillsDir>/<name> pointing at <bundledDir>/<name>. A
// member's link to a bundled skill under another name is the member's.
function isBundledLink(path: string, bundledDir: string): boolean {
  return linkTarget(path) === join(resolve(bundledDir), basename(path));
}

// A member's skill folder: an entry that resolves to a folder other than the
// bundled skill of its name, so a box-home link isomux made is no member skill.
function isMemberSkillFolder(path: string, bundledDir: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
  } catch {
    return false;
  }
  return realPath(path) !== realPath(join(bundledDir, basename(path)));
}

function folderNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

// Links each bundled skill folder into an agent's skills folder (the one the
// engine's own skill tool reads), so Claude and Codex agents can load them
// without a member typing them. A member's skill of the same name wins: an
// entry already in skillsDir, or a skill folder in one of memberSourceDirs,
// which the member pass links next. Only isomux's own links are removed, plus
// a dead link with a bundled name (an isomux checkout that moved).
export function exposeBundledSkills(
  skillsDir: string,
  memberSourceDirs: string[],
  bundledDir: string,
): void {
  const bundled = new Set(
    folderNames(bundledDir).filter((name) => {
      try {
        return statSync(join(bundledDir, name)).isDirectory();
      } catch {
        return false;
      }
    }),
  );
  const memberHas = (name: string) =>
    memberSourceDirs.some((dir) =>
      isMemberSkillFolder(join(dir, name), bundledDir),
    );
  for (const name of folderNames(skillsDir)) {
    const path = join(skillsDir, name);
    const ours = isBundledLink(path, bundledDir);
    const dead = linkTarget(path) !== null && !existsSync(path);
    if (
      (ours && (dead || !bundled.has(name) || memberHas(name))) ||
      (dead && bundled.has(name))
    ) {
      try {
        unlinkSync(path);
      } catch {
        // Another agent's start removed it first.
      }
    }
  }
  if (bundled.size === 0) return;
  try {
    mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
  for (const name of bundled) {
    const path = join(skillsDir, name);
    if (pathExists(path) || memberHas(name)) continue;
    try {
      symlinkSync(join(resolve(bundledDir), name), path, "dir");
    } catch {
      // EEXIST: another agent of this home linked it first. Any other error
      // skips this skill only: skill exposure never blocks a session start.
    }
  }
}

export function exposePersonalProviderSkills(
  provider: ProviderAccountProvider,
  userId: string,
  effectiveRoot: string,
  sourceRoot = join(homedir(), provider === "claude" ? ".claude" : ".codex"),
  personalRoot = personalProviderHome(userId, provider),
  bundledDir = BUNDLED_SKILLS_DIR,
): void {
  if (resolve(effectiveRoot) !== resolve(personalRoot)) return;
  if (resolve(sourceRoot) === resolve(personalRoot)) return;
  const sourceSkills = join(sourceRoot, "skills");
  linkEntries(sourceSkills, join(personalRoot, "skills"), (entry) =>
    isMemberSkillFolder(join(sourceSkills, entry.name), bundledDir),
  );
  if (provider === "claude") {
    linkEntries(
      join(sourceRoot, "commands"),
      join(personalRoot, "commands"),
      (entry) => entry.isFile() && entry.name.endsWith(".md"),
    );
  }
}

export function providerUserSkillRoots(
  provider: ProviderAccountProvider,
  userId: string | null | undefined,
  effectiveRoot: string,
  sourceRoot = join(homedir(), provider === "claude" ? ".claude" : ".codex"),
  personalRoot = userId ? personalProviderHome(userId, provider) : null,
): UserSkillRoot[] {
  const includeCommands = provider === "claude";
  const roots = [{ root: effectiveRoot, includeCommands }];
  if (
    userId &&
    personalRoot &&
    resolve(effectiveRoot) === resolve(personalRoot) &&
    resolve(sourceRoot) !== resolve(personalRoot)
  ) {
    roots.push({ root: sourceRoot, includeCommands });
  }
  return roots;
}

export function agentUserSkillRoots(
  agentType: "claude" | "codex" | "opencode",
  userId: string | null | undefined,
  env: { [key: string]: string | undefined } | undefined,
  claudeSourceRoot = join(homedir(), ".claude"),
  codexSourceRoot = join(homedir(), ".codex"),
  personalClaudeRoot = userId ? personalProviderHome(userId, "claude") : null,
  personalCodexRoot = userId ? personalProviderHome(userId, "codex") : null,
): UserSkillRoot[] {
  // Every backend sees the same user skills from every source (Nil's
  // backend-independence rule, 2026-09-13): the agent's own provider roots
  // first, then the other provider's. The own provider's effective root comes
  // from the launch env; the other provider's defaults to the member's
  // personal home when there is one, so its box root joins too.
  const claudeRoot =
    env?.CLAUDE_CONFIG_DIR ||
    (agentType !== "codex"
      ? claudeSourceRoot
      : (personalClaudeRoot ?? claudeSourceRoot));
  const claudeRoots = providerUserSkillRoots(
    "claude",
    userId,
    claudeRoot,
    claudeSourceRoot,
    personalClaudeRoot,
  );
  const codexRoot =
    env?.CODEX_HOME ||
    (agentType === "codex"
      ? codexSourceRoot
      : (personalCodexRoot ?? codexSourceRoot));
  const codexRoots = providerUserSkillRoots(
    "codex",
    userId,
    codexRoot,
    codexSourceRoot,
    personalCodexRoot,
  );
  const roots =
    agentType === "codex"
      ? [...codexRoots, ...claudeRoots]
      : [...claudeRoots, ...codexRoots];
  const unique: UserSkillRoot[] = [];
  for (const source of roots) {
    const existing = unique.find(
      (candidate) => resolve(candidate.root) === resolve(source.root),
    );
    if (!existing) unique.push(source);
    else existing.includeCommands ||= source.includeCommands;
  }
  return unique;
}
