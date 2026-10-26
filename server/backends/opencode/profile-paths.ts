import { createHash } from "node:crypto";
import { join } from "node:path";
import { AGENT_ROOT } from "../../split/roots.ts";
import { OPENCODE_V2_DATABASE, openCodeProfileHome } from "./config-layers.ts";

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
    home: openCodeProfileHome(profileDir),
    configHome: join(profileDir, "config"),
    dataHome: join(profileDir, "data"),
    stateHome: join(profileDir, "state"),
    cacheHome: join(profileDir, "cache"),
  };
}

// OpenCode appends its log here (XDG_DATA_HOME/opencode/log; 1.18.35 and
// 2.1.4) and keeps it across server restarts; the server's stderr carries the
// same lines.
export function openCodeLogPath(profileDir: string): string {
  return join(profileDir, "data", "opencode", "log", "opencode.log");
}

// 2.1.4 runs on opencode-v2.db (OPENCODE_DB), a copy that start-server.ts
// makes of the version 1 database at a profile's first 2.1.4 start.
// opencode.db stays as OpenCode 1 left it, for a rollback.
export function openCodeDatabasePath(
  profileDir: string,
  version: "v1" | "v2",
): string {
  return join(
    profileDir,
    "data",
    "opencode",
    version === "v2" ? OPENCODE_V2_DATABASE : "opencode.db",
  );
}

export { openCodeSafetyPluginDir } from "./safety-plugin-tool.ts";
