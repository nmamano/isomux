import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  unlinkSync,
  symlinkSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ProviderAccountProvider } from "../shared/types.ts";
import type { UserSkillRoot } from "./skills.ts";
import { personalProviderHome } from "./provider-homes.ts";

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

export function exposePersonalProviderSkills(
  provider: ProviderAccountProvider,
  userId: string,
  effectiveRoot: string,
  sourceRoot = join(homedir(), provider === "claude" ? ".claude" : ".codex"),
  personalRoot = personalProviderHome(userId, provider),
): void {
  if (resolve(effectiveRoot) !== resolve(personalRoot)) return;
  if (resolve(sourceRoot) === resolve(personalRoot)) return;
  linkEntries(
    join(sourceRoot, "skills"),
    join(personalRoot, "skills"),
    (entry) => entry.isDirectory(),
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
  const claudeRoot = env?.CLAUDE_CONFIG_DIR || claudeSourceRoot;
  const claudeRoots = providerUserSkillRoots(
    "claude",
    userId,
    claudeRoot,
    claudeSourceRoot,
    personalClaudeRoot,
  );
  if (agentType !== "codex") return claudeRoots;

  const codexRoot = env?.CODEX_HOME || codexSourceRoot;
  const roots = [
    ...providerUserSkillRoots(
      "codex",
      userId,
      codexRoot,
      codexSourceRoot,
      personalCodexRoot,
    ),
    ...claudeRoots,
  ];
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
