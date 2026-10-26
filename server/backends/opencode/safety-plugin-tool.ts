import { join } from "node:path";

// The id of the Isomux safety plugin under the OpenCode 2 plugin API. Before
// every prompt, the transport requires that GET /api/plugin lists exactly one
// row with this id, loaded from openCodeSafetyPluginDir() and active.
export const OPENCODE_SAFETY_PLUGIN_ID = "isomux.safety";

// What a tool must never see: the server password opens every stored
// provider secret (GET /api/credential, gate E2), and the config names
// Isomux's file. The session's tool environment leaves these out
// (config-layers.ts), and the safety plugin drops them from every shell it
// sees. This module imports only node:path, so the plugin bundle and the
// start helper (start-server.ts) can take it.
export const OPENCODE_SERVER_ONLY_VARIABLES = [
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_PASSWORD",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
] as const;

// The variables a shell gets from the agents' OS user, not from the server:
// OpenCode's own process keeps its HOME, XDG folders and TMPDIR in the
// profile (credentials and data per member) and opens opencode-v2.db there.
// A shell gets the OS user's value, or none when the OS user has none, so
// git, gh, ssh and other tools read the user's config, as in a Claude
// agent's shell.
export const OPENCODE_SHELL_VARIABLES = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "OPENCODE_DB",
] as const;

export type OpenCodeShellVariable = (typeof OPENCODE_SHELL_VARIABLES)[number];

// The folder the Isomux safety plugin loads from under OpenCode 2, which
// skips a plugin entry that names a file. GET /api/plugin reports it as the
// row's source.path.
export function openCodeSafetyPluginDir(profileDir: string): string {
  return join(profileDir, "isomux-safety-plugin");
}
