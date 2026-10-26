import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentMcpServer } from "../../mcp-servers.ts";
import {
  OPENCODE_SERVER_ONLY_VARIABLES,
  type OpenCodeShellVariable,
} from "./safety-plugin-tool.ts";

// A member's user-level OpenCode plugins and config: their OPENCODE_CONFIG_DIR
// when it is an absolute path, else the directory a stock OpenCode install
// reads for the OS user. The server's own XDG directories stay per profile,
// so start-server.ts hands this one to OpenCode as OPENCODE_CONFIG_DIR.
export function openCodeUserConfigDir(
  env: Record<string, string | undefined>,
): string {
  const explicit = env.OPENCODE_CONFIG_DIR?.trim();
  if (explicit && isAbsolute(explicit)) return explicit;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  // The env's HOME, not this process's: the supervisor builds a session's
  // tool environment from the same env the helper gets (split mode).
  const home = env.HOME?.trim();
  return join(
    xdg && isAbsolute(xdg)
      ? xdg
      : join(home && isAbsolute(home) ? home : homedir(), ".config"),
    "opencode",
  );
}

// Isomux's config also goes in OPENCODE_CONFIG_CONTENT, the layer OpenCode
// loads after user and project config, so Isomux's permissions and agents win
// over theirs, and its plugin loads last. MCP servers are in neither layer:
// 2.1.4 takes each server whole from the last layer that names it
// (config/plugin/mcp.ts:46-50), and the environment, which holds this layer,
// is readable in /proc. The transport adds them at run time instead.
export function openCodeConfigOverride(
  config: Record<string, unknown>,
  safetyPlugin: string,
): Record<string, unknown> {
  return {
    ...config,
    plugins: [
      ...(Array.isArray(config.plugins) ? (config.plugins as unknown[]) : []),
      safetyPlugin,
    ],
  };
}

// An Isomux MCP server as the transport gives it to a folder at run time
// (PUT /api/experimental/mcp/:name). codemode false keeps its tools direct,
// with their own names in tool events and permission asks (core/src/tool.ts
// puts every other tool behind "execute").
export function openCodeMcpServerConfig(
  server: AgentMcpServer,
): Record<string, unknown> {
  return {
    type: "remote",
    url: server.url,
    headers: { ...server.headers },
    oauth: false,
    codemode: false,
  };
}

// The variables the server needs from Isomux, not from the member.
export interface OpenCodeServerVariables {
  profileDir: string;
  configPath: string;
  configContent: string;
  password: string;
}

// The database 2.1.4 opens, relative to XDG_DATA_HOME/opencode: a copy of
// the version 1 opencode.db (openCodeDatabasePath in profile-paths.ts). A
// shell tool that starts opencode gets it too, so no OpenCode 2 process
// migrates opencode.db in place.
export const OPENCODE_V2_DATABASE = "opencode-v2.db";

// The server's environment, built from the helper's environment (the agent
// user's own plus the member's variables). The server's shell tool starts
// from it, so openCodeToolEnvironment derives from this one builder: a
// variable added here reaches a session's shell commands too, except the
// shell variables (OPENCODE_SHELL_VARIABLES), which a shell takes from the
// agents' OS user.
export function openCodeServerEnvironment(
  env: Record<string, string | undefined>,
  server: OpenCodeServerVariables,
): Record<string, string> {
  // E1: in 2.1.4 OPENCODE_CONFIG_DIR replaces the global config folder, so
  // a missing member folder is left out.
  const userConfigDir = openCodeUserConfigDir(env);
  const variables: Record<string, string | undefined> = {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([name]) =>
          (name === "OPENCODE_API_KEY" || !name.startsWith("OPENCODE_")) &&
          name !== "ISOMUX_OPENCODE_DEBUG",
      ),
    ),
    PATH: env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    // HOME, the XDG folders, TMPDIR and OPENCODE_DB. TMPDIR: E5, 2.1.4's
    // persistent-terminal daemon ignores it (a fixed /tmp/opencode-pty-<uid>/),
    // and Isomux creates no persistent terminal.
    ...openCodeShellProfileValues(server.profileDir),
    OPENCODE_CONFIG: server.configPath,
    OPENCODE_CONFIG_CONTENT: server.configContent,
    OPENCODE_CONFIG_DIR: existsSync(userConfigDir) ? userConfigDir : undefined,
    // Read by the 2.1.4 updater; serve itself makes no update request (S10).
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_SERVER_PASSWORD: server.password,
  };
  return Object.fromEntries(
    Object.entries(variables).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

// The environment of a session's shell commands (PUT
// /api/session/:id/environment, which replaces the server's for them): the
// server's without its secrets, and with the agents' OS user's HOME, XDG
// folders and TMPDIR, as a Claude agent's shell has them.
export function openCodeToolEnvironment(
  env: Record<string, string | undefined>,
  profileDir: string,
): Record<string, string> {
  const variables = openCodeServerEnvironment(env, {
    profileDir,
    configPath: "",
    configContent: "",
    password: "",
  });
  for (const name of OPENCODE_SERVER_ONLY_VARIABLES) delete variables[name];
  for (const [name, value] of Object.entries(openCodeShellUserValues(env))) {
    if (value === null) delete variables[name];
    else variables[name] = value;
  }
  return variables;
}

export function openCodeProfileHome(profileDir: string): string {
  return join(profileDir, "home");
}

export function openCodeTmpDir(profileDir: string): string {
  return join(profileDir, "tmp");
}

// The value the server sets for each shell variable from the profile.
export function openCodeShellProfileValues(
  profileDir: string,
): Record<OpenCodeShellVariable, string> {
  return {
    HOME: openCodeProfileHome(profileDir),
    XDG_CONFIG_HOME: join(profileDir, "config"),
    XDG_DATA_HOME: join(profileDir, "data"),
    XDG_STATE_HOME: join(profileDir, "state"),
    XDG_CACHE_HOME: join(profileDir, "cache"),
    TMPDIR: openCodeTmpDir(profileDir),
    OPENCODE_DB: OPENCODE_V2_DATABASE,
  };
}

// The value each shell variable takes from the agents' OS user (the env the
// server starts from), or null when it has none. OPENCODE_DB is always null:
// a shell's opencode reads the user's data folder, not the profile's.
export function openCodeShellUserValues(
  env: Record<string, string | undefined>,
): Record<OpenCodeShellVariable, string | null> {
  const value = (name: string) => env[name]?.trim() || null;
  return {
    HOME: value("HOME"),
    XDG_CONFIG_HOME: value("XDG_CONFIG_HOME"),
    XDG_DATA_HOME: value("XDG_DATA_HOME"),
    XDG_STATE_HOME: value("XDG_STATE_HOME"),
    XDG_CACHE_HOME: value("XDG_CACHE_HOME"),
    TMPDIR: value("TMPDIR"),
    OPENCODE_DB: null,
  };
}
