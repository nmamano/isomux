import { createHash } from "node:crypto";
import { join } from "node:path";
import { AGENT_ROOT } from "../../split/roots.ts";
import { hostFor } from "../../member-hosts.ts";
import { officeAgentHost, type AgentHost } from "../../agent-host.ts";
import { memberOsUserIds } from "../../member-os-users.ts";
import { profileKeyForOwner } from "../../opencode-profile-keys.ts";
import { openCodeProfileHome } from "./config-layers.ts";

// In config-layers.ts, which start-server.ts can import.
export { openCodeStartupOutputDir } from "./config-layers.ts";

export interface OpenCodeProfilePaths {
  profileDir: string;
  configPath: string;
  home: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  cacheHome: string;
}

export function openCodeProfilePaths(
  environmentKey: string,
): OpenCodeProfilePaths {
  if (!environmentKey)
    throw new Error("OpenCode session environment identity is required.");
  const key = createHash("sha256")
    .update(environmentKey)
    .digest("hex")
    .slice(0, 16);
  // Agent space; in split mode the old state root (design section 3.1.2);
  // an isolated member's own.
  const profileDir = join(
    openCodeProfileRoot(environmentKey),
    "opencode",
    "profiles",
    key,
  );
  return {
    profileDir,
    configPath: openCodeConfigFilePath(profileDir),
    home: openCodeProfileHome(profileDir),
    configHome: join(profileDir, "config"),
    dataHome: join(profileDir, "data"),
    stateHome: join(profileDir, "state"),
    cacheHome: join(profileDir, "cache"),
  };
}

// The agent space of the owner of a profile key (with or without the
// limited suffix): an isolated member's, else AGENT_ROOT.
export function openCodeProfileOwner(
  environmentKey: string,
): string | undefined {
  const ids = memberOsUserIds();
  if (ids.length === 0) return undefined;
  return ids.find((id) => {
    const key = profileKeyForOwner(id);
    // openCodeProfileKey (access.ts) appends "\0below-standard".
    return environmentKey === key || environmentKey.startsWith(`${key}\0`);
  });
}

// The host whose agent space holds `profileDir`: an isolated member's, else
// the office's.
export function openCodeProfileHost(profileDir: string): AgentHost {
  for (const id of memberOsUserIds()) {
    const host = hostFor(id);
    if (
      host.member !== undefined &&
      profileDir.startsWith(`${host.agentRoot()}/`)
    )
      return host;
  }
  return officeAgentHost();
}

function openCodeProfileRoot(environmentKey: string): string {
  const owner = openCodeProfileOwner(environmentKey);
  return owner === undefined ? AGENT_ROOT : hostFor(owner).agentRoot();
}

// The config file the supervisor writes in a profile and passes as
// OPENCODE_CONFIG. Its server lists it as a config layer with this path.
export function openCodeConfigFilePath(profileDir: string): string {
  return join(profileDir, "opencode.json");
}

// OpenCode appends its log here (XDG_DATA_HOME/opencode/log; 1.18.35 and
// 2.1.4) and keeps it across server restarts.
export function openCodeLogPath(profileDir: string): string {
  return join(profileDir, "data", "opencode", "log", "opencode.log");
}

// In config-layers.ts, which storage.ts (and so the runner's entry) imports
// without this file's owner lookup.
export { openCodeDatabasePath } from "./config-layers.ts";

export { openCodeSafetyPluginDir } from "./safety-plugin-tool.ts";
