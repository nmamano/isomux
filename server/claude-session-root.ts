import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { claudeProjectDir, claudeSessionFileExists } from "./cwd-utils.ts";
import { buildOfficeEnv } from "./env-loader.ts";
import { personalProviderHome } from "./provider-homes.ts";
import { translatorFor, type Translator } from "../shared/i18n/translate.ts";

type Env = Record<string, string | undefined>;
export function claudeConfigRoot(env: Env = process.env): string {
  return resolve(env?.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
}

// Only exact owned ids are checked. No native project directory is enumerated.
// Existing pins win even if their file is missing; never change accounts to
// recover a pinned session. Legacy discovery checks the current root first.
export function resolveClaudeSessionRoot(
  sessionId: string,
  cwd: string,
  currentEnv: Env | undefined,
  pinned: string | undefined,
  userId: string | null,
  t: Translator["t"] = translatorFor("en").t,
): string {
  if (pinned) return pinned;
  const roots = [
    ...new Set([
      claudeConfigRoot(currentEnv),
      claudeConfigRoot(buildOfficeEnv()),
      ...(userId ? [personalProviderHome(userId, "claude")] : []),
    ]),
  ];
  for (const root of roots) {
    if (claudeSessionFileExists(cwd, sessionId, { CLAUDE_CONFIG_DIR: root }))
      return root;
  }
  throw new Error(
    t("systemEntries.claudeSession.missing", {
      session: sessionId.slice(0, 8),
      paths: roots
        .map((root) =>
          join(
            claudeProjectDir(cwd, { CLAUDE_CONFIG_DIR: root }),
            `${sessionId}.jsonl`,
          ),
        )
        .join(", "),
    }),
  );
}
