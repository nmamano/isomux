// The account a subscription usage reading belongs to, so every agent on one
// provider account shows the latest reading any of them took (task 967a09d1).
// Server-internal: the key never goes on the wire or into a log.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { AgentBackendType } from "../shared/types.ts";
import { effectiveProviderDirectory } from "./provider-account-manager.ts";

// The keys and tokens that bypass the config directory's sign-in. Whoever set
// one pays for the agent's work (session-accounts.ts signInOf).
export const CREDENTIAL_VARIABLES = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ],
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY"],
} as const;

// The variables that select an account without the config directory: a
// credential, a cloud, or another endpoint. Anything else in the env (the
// agent token, PATH, a proxy) is the same account.
const AUTH_VARIABLES = {
  claude: [
    ...CREDENTIAL_VARIABLES.claude,
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BASE_URL",
  ],
  codex: [...CREDENTIAL_VARIABLES.codex, "OPENAI_BASE_URL"],
} as const;

// The key for a session that runs with `env` (the full env its process gets;
// the caller passes the host env when the session inherits it), or null for an
// engine whose readings are not shared. The directory part is the one the
// account manager reports for a sign-in, so usageKeyOnDirectory can match it.
export function usageAccountKey(
  agentType: AgentBackendType,
  env: Record<string, string | undefined>,
): string | null {
  if (agentType !== "claude" && agentType !== "codex") return null;
  const auth = AUTH_VARIABLES[agentType].map((name) => [
    name,
    env[name] ?? null,
  ]);
  const hash = createHash("sha256").update(JSON.stringify(auth)).digest("hex");
  return `${agentType}\0${effectiveProviderDirectory(agentType, env)}\0${hash}`;
}

// Whether `key` is an account in `dir` of `provider`, with any auth variables.
export function usageKeyOnDirectory(
  key: string,
  provider: AgentBackendType,
  dir: string,
): boolean {
  return key.startsWith(`${provider}\0${resolve(dir)}\0`);
}
