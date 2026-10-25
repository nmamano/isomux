import { isAbsolute, resolve } from "path";

// Backend login files are both protected from agent reads and omitted from
// office backups. Keep the two consumers on this shared list: adding a backend
// credential location must update both policies in the same change. An entry
// with backup "keep" is only protected from agent reads: the backup keeps the
// file, because it holds more than a login.
//
// The two consumers agree on the paths Isomux creates, not on every path. A
// read regex accepts any prefix and matches one component with [^/]+. A tar
// exclusion is rooted at the state root (anywhere() adds one level that
// matches any depth), and its "*" also matches "/". So a backup omits
// opencode/profiles/a/b/data/opencode/auth.json, which agents may read, and
// keeps x/opencode/profiles/p/opencode.json, which agents may not. Isomux
// creates neither path.

export type BackendCredentialPath = {
  id:
    | "claude-login"
    | "codex-login"
    | "opencode-login"
    | "opencode-mcp-login"
    | "opencode-database"
    | "opencode-isomux-config"
    | "opencode-server-record"
    | "browser-profile";
  pattern: RegExp;
} & (
  | { backup?: undefined; archivePatterns: (stateRootName: string) => string[] }
  | { backup: "keep" }
);

function anywhere(stateRootName: string, suffix: string): string[] {
  return [`${stateRootName}/${suffix}`, `${stateRootName}/*/${suffix}`];
}

export const BACKEND_CREDENTIAL_PATHS: readonly BackendCredentialPath[] = [
  {
    id: "browser-profile",
    pattern:
      /(^|\/)browser-profiles\/[^/]+\/storage-state\.json(?:\.corrupt-\d+)?$/,
    archivePatterns: (root) => [
      `${root}/browser-profiles/*/storage-state.json`,
      `${root}/browser-profiles/*/storage-state.json.corrupt-*`,
    ],
  },
  {
    id: "claude-login",
    pattern: /(^|\/)\.credentials\.json$/,
    archivePatterns: (root) => anywhere(root, ".credentials.json"),
  },
  // auth.json is a generic name (locale files, fixtures), so unlike the
  // Claude entry this one matches only the directory shapes Isomux uses. A
  // member who sets CODEX_HOME elsewhere is covered by codexLoginFile in the
  // safety policy; the backup archive excludes only the shapes below.
  {
    id: "codex-login",
    pattern:
      /(^|\/)(?:\.codex|codex-home|provider-homes\/[^/]+\/codex)\/auth\.json$/,
    archivePatterns: (root) => [
      ...anywhere(root, ".codex/auth.json"),
      ...anywhere(root, "codex-home/auth.json"),
      `${root}/provider-homes/*/codex/auth.json`,
    ],
  },
  {
    id: "opencode-login",
    pattern:
      /(^|\/)(?:\.local\/share\/opencode|opencode\/profiles\/[^/]+\/data\/opencode)\/auth\.json$/,
    archivePatterns: (root) => [
      ...anywhere(root, ".local/share/opencode/auth.json"),
      `${root}/opencode/profiles/*/data/opencode/auth.json`,
    ],
  },
  {
    id: "opencode-mcp-login",
    pattern:
      /(^|\/)(?:\.local\/share\/opencode|opencode\/profiles\/[^/]+\/data\/opencode)\/mcp-auth\.json$/,
    archivePatterns: (root) => [
      ...anywhere(root, ".local/share/opencode/mcp-auth.json"),
      `${root}/opencode/profiles/*/data/opencode/mcp-auth.json`,
    ],
  },
  // OpenCode 2 keeps every provider credential in its database
  // (opencode-v2.db; opencode.db is the version 1 file a profile keeps for a
  // rollback). The database also holds every OpenCode session, so a backup
  // keeps it.
  {
    id: "opencode-database",
    pattern:
      /(^|\/)(?:\.local\/share\/opencode|opencode\/profiles\/[^/]+\/data\/opencode)\/opencode[^/]*\.db(?:-wal|-shm)?$/,
    backup: "keep",
  },
  // The config Isomux writes for each OpenCode profile. Under OpenCode 1 it
  // carried the headers of the remote MCP servers Isomux registers
  // (integrations A2); a profile keeps that file until its first OpenCode 2
  // start rewrites it without them.
  {
    id: "opencode-isomux-config",
    pattern: /(^|\/)opencode\/profiles\/[^/]+\/opencode\.json$/,
    archivePatterns: (root) => [`${root}/opencode/profiles/*/opencode.json`],
  },
  // The server record of each OpenCode profile holds the server password,
  // which opens every stored provider secret (gate E2). A restored record
  // is of no use: its pid and start time never match a process again.
  {
    id: "opencode-server-record",
    pattern: /(^|\/)opencode\/profiles\/[^/]+\/server\.lock$/,
    archivePatterns: (root) => [`${root}/opencode/profiles/*/server.lock`],
  },
];

export function isBackendCredentialPath(path: string): boolean {
  return BACKEND_CREDENTIAL_PATHS.some((entry) => entry.pattern.test(path));
}

// The Codex login inside a CODEX_HOME the agent runs with, or null when the
// value is unset or not an absolute path.
export function codexLoginFile(
  codexHome: string | null | undefined,
): string | null {
  const home = codexHome?.trim();
  return home && isAbsolute(home) ? resolve(home, "auth.json") : null;
}
