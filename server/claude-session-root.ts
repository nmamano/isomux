import { join, resolve } from "node:path";
import {
  claudeProjectDir,
  claudeSessionFileExists,
  claudeSessionFileExistsOnHost,
} from "./cwd-utils.ts";
import { buildOfficeEnv } from "./env-loader.ts";
import { personalProviderHome } from "./provider-homes.ts";
import { msg } from "../shared/i18n/log-message.ts";
import { LocalizedError } from "./localized-error.ts";
import { hostForEnv } from "./member-hosts.ts";
import { hasMemberOsUser } from "./member-os-users.ts";
import { memberOfficeFolder } from "./provider-folders.ts";

type Env = Record<string, string | undefined>;
export function claudeConfigRoot(env: Env = process.env): string {
  return resolve(
    env?.CLAUDE_CONFIG_DIR || join(hostForEnv(env).home(), ".claude"),
  );
}

// Only exact owned ids are checked. No native project directory is enumerated.
// Existing pins win even if their file is missing; never change accounts to
// recover a pinned session. Legacy discovery checks the current root first.
//
// An isolated member (own OS user): this sync path never reads a file. A pin
// counts only when it is one of the member's roots
// (isolatedMemberClaudeRoots); else the root is the current env's, where a new
// session starts. The search through their host is
// resolveClaudeSessionRootOnHost, run before a turn (session-accounts.ts).
export function resolveClaudeSessionRoot(
  sessionId: string,
  cwd: string,
  currentEnv: Env | undefined,
  pinned: string | undefined,
  userId: string | null,
): string {
  if (hasMemberOsUser(userId)) {
    if (
      pinned &&
      isolatedMemberClaudeRoots(currentEnv, userId).includes(pinned)
    )
      return pinned;
    return claudeConfigRoot(currentEnv);
  }
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
  missing(sessionId, cwd, roots);
}

// True when resolveClaudeSessionRoot found the root, so a caller may pin it.
// For an isolated member it only falls back to the current env's root, which
// is right for this env only: only resolveClaudeSessionRootOnHost pins.
export function claudeSessionRootIsPinnable(userId: string | null): boolean {
  return !hasMemberOsUser(userId);
}

// The roots an isolated member's sessions can be in: the current env's,
// their personal provider home (in their agent space) and their member
// office folder (server/office-login-sync.ts). Never the office's.
export function isolatedMemberClaudeRoots(
  currentEnv: Env | undefined,
  userId: string | null,
): string[] {
  const office = memberOfficeFolder(userId, "claude");
  return [
    ...new Set([
      claudeConfigRoot(currentEnv),
      ...(userId ? [resolve(personalProviderHome(userId, "claude"))] : []),
      ...(office ? [office] : []),
    ]),
  ];
}

// Either user: an isolated member's roots are searched through their host
// (an env that keeps their tag), and a pin outside them is ignored. Others
// get resolveClaudeSessionRoot.
export async function resolveClaudeSessionRootOnHost(
  sessionId: string,
  cwd: string,
  currentEnv: Env | undefined,
  pinned: string | undefined,
  userId: string | null,
): Promise<string> {
  if (!hasMemberOsUser(userId))
    return resolveClaudeSessionRoot(sessionId, cwd, currentEnv, pinned, userId);
  const roots = isolatedMemberClaudeRoots(currentEnv, userId);
  if (pinned && roots.includes(pinned)) return pinned;
  for (const root of roots) {
    if (
      await claudeSessionFileExistsOnHost(cwd, sessionId, {
        ...currentEnv,
        CLAUDE_CONFIG_DIR: root,
      })
    )
      return root;
  }
  missing(sessionId, cwd, roots);
}

function missing(sessionId: string, cwd: string, roots: string[]): never {
  throw new LocalizedError(
    msg("systemEntries.claudeSession.missing", {
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
