// The backup's exclusion list (moved out of server/backup.ts so the office
// move can share it without loading the backup scheduler; task 78733adf).
// Each entry is a credential or secret store the daily backup leaves out, as
// tar globs rooted at the state root's name. The office move leaves out the
// same entries (server/office-move-scope.ts).

import {
  BACKEND_CREDENTIAL_PATHS,
  type BackendCredentialPath,
} from "./backend-credential-paths.ts";

export interface BackupExclusion {
  id: string;
  archivePatterns: (stateRootName: string) => string[];
}

function rootedDirectory(root: string, path: string): string[] {
  return [`${root}/${path}`, `${root}/${path}/*`];
}

function backendExclusions(entry: BackendCredentialPath): BackupExclusion[] {
  if (entry.backup === "keep") return [];
  return [{ id: entry.id, archivePatterns: entry.archivePatterns }];
}

// One list drives the tar exclusions. Locations are rooted because GNU
// tar exclusion wildcards otherwise match the same directory name inside an
// app's customer-owned data. Backend credential names use the shared matcher
// from backend-credential-paths.ts and can occur in a configured home at any
// depth. Transcripts and logs stay: they can incidentally contain user text,
// but they are not credential stores and removing them would destroy history
// without making an archive secret-free.
export const BACKUP_EXCLUSIONS: readonly BackupExclusion[] = [
  {
    id: "app-runtime-credentials",
    archivePatterns: (root) => rootedDirectory(root, "apps/units"),
  },
  // The container app supervisor keeps each app's raw token beside its runtime
  // state (deploy/container/supervisor.py); the .tmp is the token mid-write.
  {
    id: "container-app-tokens",
    archivePatterns: (root) => [
      `${root}/container-runtime/*.token.json`,
      `${root}/container-runtime/*.token.tmp`,
    ],
  },
  {
    id: "personal-environment",
    archivePatterns: (root) => rootedDirectory(root, "user-env"),
  },
  // The whole directory, so a temp file mid-write stays out too.
  {
    id: "office-environment",
    archivePatterns: (root) => rootedDirectory(root, "office-env"),
  },
  // Secret values (internal-docs/secrets-design.md), office and members.
  {
    id: "secret-store",
    archivePatterns: (root) => rootedDirectory(root, "secrets"),
  },
  // A removed member's kept variables and connection shapes (task 321e7b8e).
  {
    id: "removed-members",
    archivePatterns: (root) => rootedDirectory(root, "removed-members"),
  },
  // Remote MCP server registrations (integrations A2): the URL path of some
  // hosted servers carries a token. After a restore, members add them again.
  {
    id: "mcp-server-registrations",
    archivePatterns: (root) => rootedDirectory(root, "mcp-servers"),
  },
  {
    id: "codex-shell-snapshots",
    archivePatterns: (root) => [
      ...rootedDirectory(root, "codex-home/shell_snapshots"),
      `${root}/*/.codex/shell_snapshots`,
      `${root}/*/.codex/shell_snapshots/*`,
      `${root}/*/codex-home/shell_snapshots`,
      `${root}/*/codex-home/shell_snapshots/*`,
      `${root}/provider-homes/*/codex/shell_snapshots`,
      `${root}/provider-homes/*/codex/shell_snapshots/*`,
    ],
  },
  // An office move in progress (task 78733adf): the move code's key, the
  // hashes of its token and of the new office's session, and the units the
  // move stopped (a transient unit's environment can hold a secret). The
  // temp files are each file in the middle of a write.
  {
    id: "office-move",
    archivePatterns: (root) => [
      `${root}/office-move.json`,
      `${root}/office-move.json.tmp`,
      `${root}/move-units.json`,
      `${root}/move-units.json.tmp`,
    ],
  },
  // Webhook signing secrets (D5). After a restore, the owner rotates once per
  // hook. The temp file is the secrets file in the middle of a write.
  {
    id: "webhook-secrets",
    archivePatterns: (root) => [
      `${root}/webhooks/secrets.json`,
      `${root}/webhooks/secrets.json.tmp`,
    ],
  },
  // Members' WhatsApp sessions (full access to each member's WhatsApp) and
  // the downloaded bridge package (task d03a61d8). After a restore, members
  // link again; the package downloads again at the first link.
  {
    id: "whatsapp-sessions",
    archivePatterns: (root) => rootedDirectory(root, "whatsapp"),
  },
  // Members' Discord bot tokens, routes and cursors (task 7fd44c30). After a
  // restore, members connect their bots again.
  {
    id: "discord-bots",
    archivePatterns: (root) => rootedDirectory(root, "discord"),
  },
  // The pager's Discord webhook URLs. After a restore, each member enters
  // theirs again.
  {
    id: "pager-discord-webhooks",
    archivePatterns: (root) => [
      `${root}/pager-settings.json`,
      `${root}/pager-settings.json.tmp`,
      `${root}/pager-settings.json.corrupt-*`,
    ],
  },
  // The Web Push VAPID private key and the device endpoints. After a
  // restore, the server makes new keys and members turn notifications on
  // again.
  {
    id: "web-push",
    archivePatterns: (root) => [
      `${root}/web-push.json`,
      `${root}/web-push.json.tmp`,
      `${root}/web-push.json.corrupt-*`,
    ],
  },
  {
    id: "legacy-tls-key",
    archivePatterns: (root) => [`${root}/tls/cert.key`],
  },
  ...BACKEND_CREDENTIAL_PATHS.flatMap(backendExclusions),
];
