// Backend login files are both protected from agent reads and omitted from
// office backups. Keep the two consumers on this shared list: adding a backend
// credential location must update both policies in the same change.

export interface BackendCredentialPath {
  id: "claude-login" | "codex-login" | "opencode-login" | "opencode-mcp-login";
  pattern: RegExp;
  archivePatterns: (stateRootName: string) => string[];
}

function anywhere(stateRootName: string, suffix: string): string[] {
  return [`${stateRootName}/${suffix}`, `${stateRootName}/*/${suffix}`];
}

export const BACKEND_CREDENTIAL_PATHS: readonly BackendCredentialPath[] = [
  {
    id: "claude-login",
    pattern: /(^|\/)\.credentials\.json$/,
    archivePatterns: (root) => anywhere(root, ".credentials.json"),
  },
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
];

export function isBackendCredentialPath(path: string): boolean {
  return BACKEND_CREDENTIAL_PATHS.some((entry) => entry.pattern.test(path));
}
