import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderAccountProvider } from "../shared/types.ts";
import type { UserSkillRoot } from "./skills.ts";
import { personalProviderHome } from "./provider-homes.ts";
import { buildOfficeEnv } from "./env-loader.ts";
import { getAgentHost } from "./agent-host.ts";

// The office's Claude root: CLAUDE_CONFIG_DIR from the office env, else the
// box ~/.claude. Skill discovery reads it as the Claude source root, member
// skill folders link its skills, and the skills page creates new skills in it,
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
  // first, then ~/.agents/skills (Codex and OpenCode read it themselves),
  // then the other provider's. The own provider's effective root comes
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
  // The HOME the engine process gets: a member with no env file runs on the
  // host's base env (os.homedir() does not follow a HOME change).
  const home = (env ?? getAgentHost().baseEnv()).HOME || homedir();
  const agentsRoot = { root: join(home, ".agents"), includeCommands: false };
  const roots =
    agentType === "codex"
      ? [...codexRoots, agentsRoot, ...claudeRoots]
      : [...claudeRoots, agentsRoot, ...codexRoots];
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
