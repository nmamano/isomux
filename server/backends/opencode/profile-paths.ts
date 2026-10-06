import { createHash } from "node:crypto";
import { join } from "node:path";
import { AGENT_ROOT } from "../../split/roots.ts";

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
  // Agent space; in split mode the old state root (design section 3.1.2).
  const profileDir = join(AGENT_ROOT, "opencode", "profiles", key);
  return {
    profileDir,
    configPath: join(profileDir, "opencode.json"),
    home: join(profileDir, "home"),
    configHome: join(profileDir, "config"),
    dataHome: join(profileDir, "data"),
    stateHome: join(profileDir, "state"),
    cacheHome: join(profileDir, "cache"),
  };
}
