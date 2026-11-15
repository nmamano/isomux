// The backup's exclusion list (moved out of server/backup.ts so the office
// move can share it without loading the backup scheduler; task 78733adf).
// Each entry is a credential or secret store the daily backup leaves out, as
// tar globs rooted at the state root's name. The office move leaves out the
// same entries (server/office-move-scope.ts).

import { readdirSync } from "fs";
import { join } from "path";
import { errMessage } from "../shared/errors.ts";
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

// What Isomux or a backend makes again, so the daily backup leaves it out
// (task 1426371a): package and plugin caches, temp folders and the built
// Codex safety hook. Paths are relative to the state root and literal: they
// are read from the disk at each run, because a tar glob's "*" also matches
// "/" and would drop a folder of the same name deep in an agent's home. Kept
// apart from BACKUP_EXCLUSIONS, which the office move reports as sign-ins.
// The move still copies these paths.
const OPENCODE_PROFILE_REMADE = [
  "cache", // XDG_CACHE_HOME (backends/opencode/profile-paths.ts)
  "tmp", // openCodeCliTmpDir (backends/opencode/config-layers.ts)
  "home/.npm",
  // OpenCode installs its plugin package from package.json at start.
  "config/opencode/node_modules",
];
const CODEX_HOME_REMADE = ["cache", ".tmp", "tmp"];

export function regenerableBackupPaths(stateRoot: string): string[] {
  const paths = [
    // safety-hook-install.ts builds the golden copy again when it is missing
    // and installs the hook from it.
    "bin/isomux-codex-safety-hook",
    "bin/.isomux-codex-safety-hook.golden",
    ...CODEX_HOME_REMADE.map((name) => `codex-home/${name}`),
  ];
  for (const profile of subfolders(stateRoot, "opencode/profiles"))
    for (const name of OPENCODE_PROFILE_REMADE)
      paths.push(`opencode/profiles/${profile}/${name}`);
  for (const home of subfolders(stateRoot, "provider-homes"))
    for (const name of CODEX_HOME_REMADE)
      paths.push(`provider-homes/${home}/codex/${name}`);
  return paths;
}

// The names in a folder of the state root. A folder that is missing gives
// none; one that cannot be read is logged and gives none, so the archive is
// only bigger.
function subfolders(stateRoot: string, rel: string): string[] {
  try {
    return readdirSync(join(stateRoot, rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(
        `[backup] cannot list ${rel}, its caches stay in the archive: ${errMessage(err)}`,
      );
    return [];
  }
}
