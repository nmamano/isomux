import { isAbsolute, resolve } from "path";

// Backend login files are both protected from agent reads and omitted from
// office backups. Keep the two consumers on this shared list: adding a backend
// credential location must update both policies in the same change.
//
// The two consumers agree on the paths Isomux creates, not on every path. A
// read regex accepts any prefix and matches one component with [^/]+. A tar
// exclusion is rooted at the state root (anywhere() adds one level that
// matches any depth), and its "*" also matches "/". So a backup omits
// opencode/profiles/a/b/data/opencode/auth.json, which agents may read, and
// keeps x/opencode/profiles/p/opencode.json, which agents may not. Isomux
// creates neither path.

export interface BackendCredentialPath {
  id:
    | "claude-login"
    | "codex-login"
    | "opencode-login"
    | "opencode-mcp-login"
    | "opencode-isomux-config"
    | "browser-profile";
  pattern: RegExp;
  archivePatterns: (stateRootName: string) => string[];
}

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
  // The config Isomux writes for each OpenCode profile: it carries the
  // headers of the remote MCP servers Isomux registers (integrations A2).
  {
    id: "opencode-isomux-config",
    pattern: /(^|\/)opencode\/profiles\/[^/]+\/opencode\.json$/,
    archivePatterns: (root) => [`${root}/opencode/profiles/*/opencode.json`],
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
