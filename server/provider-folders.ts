// The provider folders the account, sign-in and usage code all name: the
// folder a launch's env points a provider at, and an isolated member's
// office account folder (office-login-sync.ts). A leaf: it imports none of
// provider-account-manager, office-login-sync, member-usage-cap or
// usage-account, so they can all use it.

import { resolve } from "node:path";
import type {
  AgentBackendType,
  ProviderAccountProvider,
} from "../shared/types.ts";
import {
  ISOMUX_CODEX_HOME,
  withIsomuxCodexHome,
} from "./backends/codex/native-bin.ts";
import { hostFor as memberHostFor, hostForEnv } from "./member-hosts.ts";
import { hasMemberOsUser, memberOsUserIds } from "./member-os-users.ts";

export type OfficeLoginProvider = "claude" | "codex";

export function effectiveProviderDirectory(
  provider: ProviderAccountProvider,
  env: Record<string, string | undefined>,
): string {
  return provider === "claude"
    ? resolve(
        env.CLAUDE_CONFIG_DIR?.trim() ||
          resolve(hostForEnv(env).home(), ".claude"),
      )
    : resolve(withIsomuxCodexHome(env).CODEX_HOME ?? ISOMUX_CODEX_HOME);
}

// The member office folder of an isolated member for `provider`, or null
// for a member without their own OS user (they use the office's folder).
export function memberOfficeFolder(
  userId: string | null | undefined,
  provider: AgentBackendType,
): string | null {
  if (!userId || !hasMemberOsUser(userId)) return null;
  const host = memberHostFor(userId);
  if (provider === "claude") return resolve(host.home(), ".claude");
  if (provider === "codex") return resolve(host.agentRoot(), "codex-home");
  return null;
}

// The isolated member and provider whose member office folder `dir` is, or
// null. Billing, the usage key and the sign-in label map such a folder to
// the office account. Members on one OS user share the folder (task
// 12c796b2): `userId` is the first of them, and the callers read only
// `provider`.
export function memberOfficeFolderOwner(
  dir: string,
): { userId: string; provider: OfficeLoginProvider } | null {
  const wanted = resolve(dir);
  for (const userId of memberOsUserIds())
    for (const provider of ["claude", "codex"] as const)
      if (memberOfficeFolder(userId, provider) === wanted)
        return { userId, provider };
  return null;
}
