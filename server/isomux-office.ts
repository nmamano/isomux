import { readWidgetMetadata } from "./app-widget-metadata.ts";
import { appWidgetHandlers } from "./routes/handlers/app-widget.ts";
import {
  appFilesRevision,
  appServing,
  bumpAppRestartSeq,
  requestAppReload,
} from "./app-revision.ts";

// Every office verb that runs a new process for an app moves the widget's
// revision and asks its open widgets to reload (task d7ac4f73).
function appProcessStarted(name: string): void {
  bumpAppRestartSeq(name);
  requestAppReload(name);
}
import { auditHandlers } from "./routes/handlers/audit.ts";
import { terminalRecordingHandlers } from "./routes/handlers/terminal-recordings.ts";
import { auditActor } from "./audit-actor.ts";
import { secureStateRoot } from "./state-root-mode.ts";
import type { AuditActor } from "../shared/audit.ts";
import {
  agentAccessOf,
  belowStandard,
  INLINE_IMAGE_TYPES,
  stopHasFolder,
} from "../shared/agent-access.ts";
import {
  confinedFolderRefusal,
  folderOverlapRefusal,
} from "./agent-folder-rules.ts";
import { createMemberCeiling } from "./member-ceiling.ts";
import { AppSupervisorError } from "./app-supervisor.ts";
import { type GithubSync } from "./github-sync.ts";
import { githubSyncHandlers } from "./routes/handlers/github-sync.ts";
import { formatIssueData } from "../shared/github-issue.ts";
import { officeAuditStore, recordAudit } from "./audit-store.ts";
import { notePromptContent } from "./audit-context.ts";
import { type ExtensionWsData } from "./browser-extension-service";
import { browserExtensionHandlers } from "./routes/handlers/browser-extension";
import { english } from "./i18n.ts";
import {
  msg,
  renderLogText,
  type LogMessage,
} from "../shared/i18n/log-message.ts";
import {
  INSTALL_KIND,
  isHostedAccess,
  hostedAccessRule,
  type InstallKind,
} from "./install-kind.ts";
import type { Server, ServerWebSocket } from "bun";
import type {
  ServerMessage,
  ClientCommand,
  BackendModelWire,
  AgentBackendType,
  AgentInfo,
  PresenceInfo,
  UserRecord,
  ProcessIsolationReason,
} from "../shared/types.ts";
import {
  listAllPresence,
  moveLobbyPresence,
  presencePageFromWire,
  setPresence,
  _testClearPresence,
} from "./presence.ts";
import type { EnqueueResult } from "./internal-types.ts";
import { runPreUseridBackupIfNeeded } from "./migrations.ts";
import { setProcessName } from "./process-name.ts";
import { armStopReap } from "./stop-reap.ts";
import { runAtServerStop } from "./server-stop.ts";
import { normalizeBunRunPath } from "./bun-run-path.ts";
import { startAgentOomStamping } from "./oom-stamp.ts";
import { prepareCodexSafetyHookArtifact } from "./backends/codex/safety-hook-install.ts";
import { engineRunsAccessHere } from "./backends/access-here.ts";
import { type AgentManager } from "./agent-manager.ts";
import { getBackend } from "./backends/index.ts";
import { registerProductionCronjobManagerForModuleReads } from "./cronjob-manager.ts";
import type { CronjobManager } from "./cronjob-manager.ts";
import { askAudienceFor, askMemberIds, type AskAudienceDeps } from "./asks.ts";
import {
  saveRecentCwd,
  getFilePath,
  saveFile,
  loadServerConfig,
  saveServerConfig,
  loadRecordTerminals,
  saveRecordTerminals,
  loadClaudeIsomuxLabel,
  saveClaudeIsomuxLabel,
  loadProcessIsolation,
  saveProcessIsolation,
} from "./persistence.ts";
import { normalizePublicOrigin } from "../shared/public-origin.ts";
import type { InviteWire, SessionWire } from "../shared/types.ts";
import {
  startUpdateChecker,
  getUpdateStatus,
  onUpdateChange,
} from "./update-checker.ts";
import {
  startBackupScheduler,
  currentBackupDir,
  getBackupStatus,
  saveBackupSettings,
  type BackupStatus,
} from "./backup.ts";
import { getVersionInfo } from "./version.ts";
import { setTrustedProxy } from "./proxy-trust.ts";
import {
  CLAUDE_NATIVE_BIN,
  pathWithBundledClaude,
  resolveCwd,
  validateCwd,
} from "./cwd-utils.ts";
import { modelFamilyMismatchError } from "./agent-validators.ts";
import type { Cronjob, CronjobTarget } from "../shared/types.ts";
import { LOBBY_ROOM_ID, cronjobRunStreamId } from "../shared/types.ts";
import { errMessage } from "../shared/errors.ts";
import type { FreeModelProbeTiming } from "./welcome-opencode-model.ts";
import { checkOpenCodeModels } from "./opencode-model-check.ts";
import {
  buildProductionGuardDeps,
  type GuardDepsLiveReaders,
} from "./identity/guard-deps.ts";
import { identityFitsAgent } from "./identity/agent-fit.ts";
import { withMemberPack } from "./identity/member-pack.ts";
import {
  cronjobOwnerOrOfficeOwner,
  hasOfficeOwnerReach,
  sharesRoomWithMember,
  logSearchAccess,
  queueCancelAny,
  type GuardDeps,
} from "./identity/guards.ts";
import {
  hasOwner,
  listUsers,
  getUser,
  getUserById,
  getUserByName,
  pruneStaleRoomRefs,
  updateUserById,
  wouldDeleteLeaveNoOwner,
  setOnUserAccessChanged,
} from "./users.ts";
import { homedir, hostname as osHostname, userInfo } from "os";
import type { FileWatcher } from "./file-editor.ts";
import { isCredentialStorePath } from "./credential-store-paths.ts";
import { httpContentTypeForFilename } from "./mime-types.ts";
import { join } from "path";
import {
  checkOrigin,
  untrustedFileHeaders,
  setOnOwnerCreated,
  setInviteSeatGate,
} from "./auth-middleware.ts";
import { activeSetupKey, setupKeyAtBoot, setupKeyFile } from "./setup-key.ts";
import {
  buildPublicOrigin,
  freezeBootState,
  loadOfficeId,
  isOutsideReachabilityBlocked,
  isProcessPreClaim,
  loadAuthState,
  SELF_INVITE_TTL_MS,
  listActiveSessions,
  listActiveSessionsForUserId,
  listInvites,
  listInvitesForUser,
  mintInvite,
  noteSessionDeviceByHash,
  sessionContextFor,
  setOnInviteConsumed,
  setOnSessionsChanged,
  takeOwnerClaimedInThisProcess,
  setPublicOriginFallback,
  setLoopbackOriginPort,
  setRoomsSnapshotProvider,
  type SessionLookup,
} from "./auth.ts";
import {
  pushAllowedForPack,
  type WsFrame,
  type WsPushKind,
} from "./ws-push-area.ts";
import { lowercaseKey } from "../shared/identity.ts";
import { BROWSER_SHARE_DEVICE } from "../shared/browser-share.ts";
import { startAdminSocket } from "./admin-socket.ts";
import { startSplitMode } from "./split/start.ts";
import {
  setAgentHost,
  setIsolationSetupFailureListener,
} from "./agent-host.ts";
import {
  processIsolationNow,
  reportIsolationSetupFailure,
  runProcessIsolationProbe,
} from "./process-isolation-state.ts";
import { type McpEndpointDeps } from "./mcp-endpoint.ts";
import { type FolderMcpDeps } from "./folder-mcp-endpoint.ts";
import { runFolderFiles } from "./folder-files-host.ts";
import { API_ROUTES, type RoutePrecondition } from "./routes/table.ts";
import {
  authorizeRoute,
  fail,
  type ExecutorDeps,
  type RouteHandler,
  type PreconditionFn,
  type HandlerErrorStatus,
} from "./routes/executor.ts";
import { tasksHandlers } from "./routes/handlers/tasks.ts";
import { pagerHandlers } from "./routes/handlers/pager.ts";
import {
  pagerEntryFromAsk,
  raisePage,
  type PagerCompatDeps,
} from "./pager-compat.ts";
import { migratePagerAtBoot } from "./pager-migration.ts";
import { askHandlers } from "./routes/handlers/asks.ts";
import { officeAskHistory } from "./ask-history.ts";
import { pagerSettingsHandlers } from "./routes/handlers/pager-settings.ts";
import { integrationChangesHandlers } from "./routes/handlers/integration-changes.ts";
import { voiceHandlers } from "./routes/handlers/voice.ts";
import { whatsappHandlers } from "./routes/handlers/whatsapp.ts";
import { discordHandlers } from "./routes/handlers/discord.ts";
import { messagingHandlers } from "./routes/handlers/messaging.ts";
import { voiceKeyForUserId } from "./voice-key.ts";
import { pushDevicesHandlers } from "./routes/handlers/push-devices.ts";
import { agentReferenceHandlers } from "./routes/handlers/agent-reference.ts";
import { appsHandlers } from "./routes/handlers/apps.ts";
import { appRegistry, appRegistrationGeneration } from "./app-registry.ts";
import { appShortUrl } from "./app-short-url.ts";
import { webhookRegistry } from "./webhooks/registry.ts";
import {
  createWebhookIngress,
  type WebhookIngress,
} from "./webhooks/ingress.ts";
import {
  webhooksHandlers,
  webhookTargetPrecondition,
} from "./routes/handlers/webhooks.ts";
import { appThumbnailStore, readCappedFile } from "./app-thumbnails.ts";
import {
  appHostDomain,
  appPublicUrl,
  freezeAppHostDomain,
} from "./app-domain.ts";
import {
  handleAppMintRequest,
  appSessionExpiresAt,
  invalidateAppRegistration,
} from "./app-auth.ts";
import { retireAppRegistration } from "./app-lifecycle.ts";
import { previewAppGrant } from "./app-preview-grant.ts";
import { recheckOpenAppSockets, type AppRelayWsData } from "./app-ws-relay.ts";
import { type AppSupervisor } from "./app-supervisor.ts";
import { appTokens, setAppOwnerAgentResolver } from "./app-tokens.ts";
import { appMessageLimiter } from "./app-message-limits.ts";
import { reconcileAppTokens } from "./app-token-reconcile.ts";
import { reconcileAppUrls } from "./app-url-reconcile.ts";
import { memoryHandlers } from "./routes/handlers/memory.ts";
import { memoryStore, isSafeScopeId, versionOf } from "./memory-store.ts";
import { cronHandlers } from "./routes/handlers/cron.ts";
import { agentAffordanceHandlers } from "./routes/handlers/agent-affordances.ts";
import { logsHandlers } from "./routes/handlers/logs.ts";
import { terminalReadHandlers } from "./routes/handlers/terminal.ts";
import { buildSessionIndex, retrieveSession } from "./log-search.ts";
import { fileLogSource } from "./log-source.ts";
import { runSearchInChild } from "./log-search-runner.ts";
import { uploadsHandlers } from "./routes/handlers/uploads.ts";
import { agentDirectoryHandlers } from "./routes/handlers/agent-directory.ts";
import { agentAvatarHandlers } from "./routes/handlers/agent-avatar.ts";
import { appSignInHandlers } from "./routes/handlers/app-sign-in.ts";
import { skillUsageHandlers } from "./routes/handlers/skill-usage.ts";
import { skillsHandlers } from "./routes/handlers/skills.ts";
import {
  buildSkillCatalog,
  createSkill,
  readSkillFile,
  saveSkillFile,
  deleteSkillFile,
} from "./skill-catalog.ts";
import { getSkillUseCounts } from "./skill-usage.ts";
import { accessHandlers } from "./routes/handlers/access.ts";
import {
  membersChatHandlers,
  type MembersChatAuthor,
} from "./routes/handlers/members-chat.ts";
import { floorsHandlers } from "./routes/handlers/floors.ts";
import { probeOffice, type OfficeProbeOptions } from "./office-card.ts";
import { createOfficeNameCache } from "./office-name-cache.ts";
import { userEnvHandlers } from "./routes/handlers/user-env.ts";
import { secretsHandlers } from "./routes/handlers/secrets.ts";
import { secretRequestHandlers } from "./routes/handlers/secret-requests.ts";
import { createSecretRequests } from "./secret-requests.ts";
import { sudoRequestHandlers } from "./routes/handlers/sudo-requests.ts";
import { createSudoRequests, type SudoRequests } from "./sudo-requests.ts";
import { probeSudo, startSudo } from "./sudo-runner.ts";
import { askRunLine, askRunLostNotice } from "./ask-command-runner.ts";
import { createSudoRunStore } from "./sudo-run-store.ts";
import { createConnectionWrites } from "./connection-writes.ts";
import { createStepAsks, type StepAsks } from "./step-asks.ts";
import { createInProcessDispatch, officeStepRuns } from "./office-step-runs.ts";
import { mcpServersHandlers } from "./routes/handlers/mcp-servers.ts";
import { createMcpOAuth, type McpOAuth } from "./mcp-oauth.ts";
import { createMcpServerStore } from "./mcp-server-store.ts";
import {
  createMcpServerSources,
  mcpServerRows,
  setMcpPlaceholderProvider,
} from "./mcp-servers.ts";
import {
  createSecretStore,
  SecretStoreUnreadableError,
  type AppGrant,
  type SecretScope,
} from "./secret-store.ts";
import { scrubPatterns } from "./secret-proxy/scrub.ts";
import { appSecretsDir, createAppSecrets } from "./app-secrets.ts";
import {
  appProxySecretsOf,
  productionAppProxySecret,
} from "./app-proxy-secret.ts";
import { OAUTH_SECRET_NAME } from "../shared/mcp-servers.ts";
import { createSecretsRuntime } from "./secret-proxy/runtime.ts";
import { setSecretValuesForRedaction } from "./log-redaction.ts";
import { SHARE_ROOT } from "./split/roots.ts";
import {
  createConnectionTester,
  type ConnectionTestFetch,
} from "./connection-tests.ts";
import { connectionTestsHandlers } from "./routes/handlers/connection-tests.ts";
import {
  claudeFamilyModelsForUserId,
  envSourceForUserId,
  limitedClaudeFamiliesForUserId,
  readOfficeEnvFile,
  setOfficeEnvFileProvider,
  setSecretEnvironmentProvider,
} from "./env-loader.ts";
import {
  OFFICE_NAME_MAX,
  officeSettingsHandlers,
} from "./routes/handlers/office-settings.ts";
import { validateHandlers } from "./routes/handlers/validate.ts";
import {
  createEnterpriseSeats,
  type EnterpriseSeats,
} from "./enterprise-seats.ts";
import { enterpriseSeatsHandlers } from "./enterprise-seats-routes.ts";
import { rescueHandlers } from "./routes/handlers/rescue.ts";
import {
  createOfficeExportJobs,
  spawnExportChildProcess,
  type OfficeExportJobs,
  type OfficeExportJobsDeps,
} from "./office-export-jobs.ts";
import { requestStopForLock } from "./office-lockdown-route.ts";
import { closeOfficeSockets, resetOfficeLockGate } from "./office-lock-gate.ts";
import { backendsHandlers } from "./routes/handlers/backends.ts";
import { providerAccountsHandlers } from "./routes/handlers/provider-accounts.ts";
import { openCodeHandlers } from "./routes/handlers/opencode.ts";
import { buildConnectionsList } from "./connections-list.ts";
import { buildAgentConnections } from "./agent-connections.ts";
import { connectionsHandlers } from "./routes/handlers/connections.ts";
import {
  claudeConnectorsFor,
  claudeConnectorStatusesFor,
  claudeEngineServersFor,
} from "./claude-connectors.ts";
import {
  type CreateClaudeAccountClient,
  type CreateCodexAccountClient,
} from "./provider-account-manager.ts";
import { systemHandlers } from "./routes/handlers/system.ts";
import { usageHandlers } from "./routes/handlers/usage.ts";
import { STATE_ROOT } from "./config.ts";
import {
  cleanupLegacySkillLinks,
  sweepMemberSkillFolders,
} from "./member-skill-folder.ts";
import {
  officeClaudeSourceRoot,
  officeCodexSourceRoot,
} from "./provider-skill-links.ts";
import {
  personalProviderHome,
  removePersonalProviderHomes,
  sweepPersonalProviderHomes,
} from "./provider-homes.ts";
import { BUNDLED_SKILLS_DIR } from "./skills.ts";
import { ISOMUX_CODEX_HOME } from "./backends/codex/native-bin.ts";
import {
  managedEnvValuesDiffer,
  managedOfficeEnvExists,
  managedUserEnvExists,
  managedUserEnvPath,
  nextManagedEnvNotes,
  readManagedOfficeEnv,
  readManagedOfficeEnvNotes,
  readManagedUserEnv,
  readManagedUserEnvNotes,
  removeManagedUserEnv,
  writeManagedOfficeEnv,
  writeManagedOfficeEnvNotes,
  writeManagedUserEnv,
  writeManagedUserEnvNotes,
} from "./user-env.ts";
import {
  legacyEnvFileExists,
  migrateManagedEnvAtBoot,
} from "./managed-env-migration.ts";
import { readEnvFile } from "./persistence.ts";
import {
  memberUsageCap,
  resetMemberUsageCap,
  usageCapText,
} from "./member-usage-cap.ts";
import {
  providerFallback,
  resetProviderFallback,
} from "./provider-fallback.ts";
import { type StorageRoots } from "./storage-usage.ts";
import { updateHandlers } from "./routes/handlers/update.ts";
import { triggerUpdate } from "./update-trigger.ts";
import { readUpdateConf } from "./update-conf.ts";
import { viewHandlers } from "./routes/handlers/view.ts";
import { preferencesHandlers } from "./routes/handlers/preferences.ts";
import { apiTokenHandlers } from "./routes/handlers/api-tokens.ts";
import {
  setApiTokenStreamSinks,
  drainApiTokenInbox,
  sendApiTokenMessage,
  apiTokenHeardFrom,
  enqueueApiTokenInboxMessage,
  apiTokenRoomsById,
  isLiveApiTokenOwnedBy,
  listApiTokens,
  mintApiToken,
  revokeApiToken,
} from "./api-tokens.ts";
import {
  dropRemovedMember,
  listRemovedMembers,
  purgeExpiredRemovedMembers,
  reconcileRemovedMembers,
  removedMemberWire,
} from "./removed-members.ts";
import { roomsHandlers } from "./routes/handlers/rooms.ts";
import { conversationHandlers } from "./routes/handlers/conversation.ts";
import type {
  AccessSettings,
  BackupStatusWire,
  UserPublicWire,
  OfficeSettingsRes,
} from "../shared/contract-shapes.ts";
import { createIdempotencyCache } from "./transport/idempotency.ts";
import { emit, type EmitContext, type EmitDeps } from "./events/emit.ts";
import type { EventId, EventPayloads } from "./events/registry.ts";
import { createFrontDoor, PORT, UI_DIST } from "./office-front-door.ts";
import {
  readLockState,
  restartAppsAfterLock,
  type LockdownApps,
} from "./lockdown.ts";
import { applyLockEffects, startLockedOffice } from "./locked-office.ts";
import { defaultAppSupervisor } from "./app-supervisor-default.ts";
import { createAccessPolicy } from "./office-access-policy.ts";
import { createEventFanout } from "./office-event-fanout.ts";
import { createSessionProjection } from "./office-session-projection.ts";
import {
  createStorageOps,
  createStorageRoutes,
} from "./office-storage-routes.ts";
import { createEditorRoutes } from "./office-editor-routes.ts";
import { createAgentsRoutes } from "./office-agents-routes.ts";
import { createUsersRoutes } from "./office-users-routes.ts";
import {
  createInvitesRoutes,
  createSessionsRoutes,
} from "./office-invites-sessions-routes.ts";
import {
  agentManager,
  cronjobManager,
  scheduledMessageManager,
  askStore,
  membersChat,
  floors,
  pagerSettings,
  pagerDelivery,
  webPushStore,
  webPushDelivery,
  whatsappSupervisor,
  whatsappRoutes,
  discordSupervisor,
  discordRoutes,
  messagingReplies,
  githubLinks,
  githubSync,
  uiBuildTracker,
  providerAccountManager,
  appSupervisor,
  extensionService,
  extensionSessions,
  appHostingUnsupported,
  createManagers,
} from "./office-managers.ts";
import {
  createOfficeOnboarding,
  type WelcomeModelTiming,
} from "./office-onboarding.ts";
import { appDeltaFor, type AppChange } from "./events/app-delta.ts";
import { webhookVisibleTo } from "./webhook-visibility.ts";
import { cronjobVisibleTo } from "./cronjob-visibility.ts";
import { planOwnerAccessMigration } from "./access-migration.ts";
import { OfficeOutbox } from "./office-ws-outbox.ts";
import {
  checkTerminalCommand,
  probeEditFile,
  probeReadFile,
} from "./affordance-checks.ts";
import {
  limitToTokenRooms,
  tokenRooms,
  withinTokenRooms,
  cronOwnOnly,
  type Identity,
} from "./identity/index.ts";
import { hidesManagerData } from "./system-prompt.ts";
import { scheduleExceedsAgent } from "./cron-agent-limits.ts";
import { appVisibleTo } from "./app-visibility.ts";

// Boot is extracted into startServer() at the end of this file. The CLI
// fast-path (`bun run server/isomux-office.ts owner-login`) and the production
// auto-start both live in runOfficeMain() there, which only the process entry
// point calls, so importing this module (the in-process test harness) has no
// boot side effects.

// bootPrelude: pre-userid backup migration, access-settings resolution, and
// boot-state freeze. Extracted from module top-level so startServer() controls
// timing (production via import.meta.main; tests via the in-process harness).
// Body left at its prior indentation; prettier normalizes post-review.
function bootPrelude(): void {
  // Pre-userid backup is the migration safety snapshot (NOT the daily backup
  // scheduler), so it runs UNCONDITIONALLY - skipBackups controls only the daily
  // scheduler in runBackgroundBoot. It must run before any user/session/agent/
  // cronjob state touches disk; the state modules above lazy-load (no top-level
  // disk reads), so this top-of-body call is in time - but it is fragile to
  // future eager-load refactors. Audit if any imported module starts loading
  // eagerly. On a fresh harness boot it is a no-op (no pre-userid state).
  runPreUseridBackupIfNeeded();

  // Load auth state now: legacy sign-in links bind to member ids before any
  // member edit (a rename) can run.
  loadAuthState();

  // Resolve access settings from office-config.json, write any backfill back
  // to disk, then lock the boot-time state. Cookie/origin policy and listener
  // binding are frozen independently so a claim cannot change either
  // mid-process.
  {
    const cfg = loadServerConfig();

    // External-access backfill. When the field is absent from JSON
    // (pre-redesign install), default to true if a publicOrigin exists so the
    // office stays reachable at its old address after the upgrade. Write the
    // resolved value back so subsequent boots don't re-run this inference.
    let externalAccess = cfg.externalAccess;
    if (externalAccess === null) {
      externalAccess = cfg.publicOrigin !== null;
      try {
        saveServerConfig({
          publicOrigin: cfg.publicOrigin,
          externalAccess,
        });
      } catch (err) {
        console.error(
          `[auth] failed to backfill office-config.json (${(err as Error).message}); will re-attempt next boot`,
        );
      }
    }

    setPublicOriginFallback(cfg.publicOrigin);
    freezeBootState({ externalAccess, networkBind: cfg.networkBind });
    setTrustedProxy(cfg.trustedProxy);
    if (cfg.networkBind === "loopback") {
      console.log(
        '[network] networkBind="loopback": office listener uses 127.0.0.1. Set networkBind to "all" for direct-port access.',
      );
    }
  }

  // App hostnames ride the same freeze, and must come after it: they are
  // derived from buildPublicOrigin, which only answers for this boot once the
  // boot state is locked.
  freezeAppHostDomain();

  // The setup key that claims an unclaimed office (server/setup-key.ts).
  setupKeyAtBoot(isProcessPreClaim());

  // The office id names this office's session cookies (server/office-id.ts).
  // A file that cannot be read or written stops the boot here.
  loadOfficeId();
} // end bootPrelude

// Secrets (internal-docs/secrets-design.md): the store, and the runtime that
// runs the proxy and gives agents placeholders. The runtime acts only after
// enable(), which runOfficeMain calls; the in-process test harness never
// starts a proxy child.
const secretStore = createSecretStore();
// Read only for the secrets OAuth registrations own (integrations A2b).
const oauthRegistrations = createMcpServerStore(() => null);
// Secrets an OAuth registration owns (its refresh token and client secret)
// are the registration's, not a connection agents get: the connections list
// and the agents' own list leave them out, as the secrets runtime does.
function withoutOAuthOwned<T extends { name: string }>(
  scope: SecretScope,
  secrets: T[],
): T[] {
  let owned: ((name: string) => boolean) | null = null;
  try {
    const names = new Set(oauthRegistrations.oauthOwnedSecrets(scope));
    owned = (name) => names.has(name);
  } catch {
    owned = (name) => OAUTH_SECRET_NAME.test(name);
  }
  return secrets.filter((secret) => !owned(secret.name));
}
const secretsRuntime = createSecretsRuntime({
  store: secretStore,
  stateRoot: STATE_ROOT,
  shareRoot: SHARE_ROOT,
  serverEnv: process.env,
  onUse: (use) =>
    recordAudit({
      actor: {
        kind: "secret_proxy",
        id: "secret-proxy",
        name: "secret-proxy",
        ...(use.ownerId ? { ownerId: use.ownerId } : {}),
      },
      operation: "secrets.use",
      targets: [use.name],
      fields: [],
      secretUse: { host: use.host, method: use.method, path: use.path },
    }),
  onSetChanged: (change) => agentManager?.envChanged(change),
  onValues: setSecretValuesForRedaction,
  log: (code) => console.log(`[secret-proxy] ${code}`),
  oauthOwned: (scope) => {
    try {
      return oauthRegistrations.oauthOwnedSecrets(scope);
    } catch {
      return null;
    }
  },
});
setSecretEnvironmentProvider((userId) => secretsRuntime.environmentFor(userId));
// Vault secrets that apps read as raw values (task c7007f8b): the files in
// STATE_ROOT/secrets/apps, synced after every secret change, app delete and
// boot. The supervisor is read at call time: startServer assigns it.
const appSecrets = createAppSecrets({
  store: secretStore,
  apps: () => appRegistry.list(),
  supervisor: {
    unitInjectsSecrets: (name) => appSupervisor.unitInjectsSecrets(name),
    regenerate: (record) => appSupervisor.regenerate(record),
    states: (names) => appSupervisor.states(names),
    restart: (name) => {
      appSupervisor.restart(name);
      appProcessStarted(name);
    },
  },
  dir: appSecretsDir(STATE_ROOT),
  proxySecret: productionAppProxySecret,
  oauthOwned: (scope) => {
    try {
      return oauthRegistrations.oauthOwnedSecrets(scope);
    } catch {
      return null;
    }
  },
  log: (line) => console.error(line),
});
// After a committed secret change: the proxy and agents, then the apps. The
// apps sync even when the proxy did not take the change.
async function secretsChanged(): Promise<void> {
  try {
    await secretsRuntime.changed();
  } finally {
    await appSecrets.sync();
  }
}
// Every vault value, for the app logs scrub. An unreadable file has none to
// give.
function vaultValues(): string[] {
  return secretStore.scopes().flatMap((scope) => {
    try {
      return secretStore.readForProxy(scope).map((secret) => secret.value);
    } catch (error) {
      if (error instanceof SecretStoreUnreadableError) return [];
      throw error;
    }
  });
}
// A grant names a live app by name and creation time.
const isLiveAppGrant = (grant: AppGrant): boolean =>
  appRegistry.get(grant.name)?.createdAt === grant.createdAt;
setMcpPlaceholderProvider((scope, name) =>
  secretsRuntime.placeholderOf(scope, name),
);
// Step asks (task c71cb60f): made with the routes. Every hook that may have
// done a step calls stepsChanged.
let stepAsks: StepAsks | undefined;
function stepsChanged(): void {
  void stepAsks?.reconcile();
}
// The office settings as office.getSettings answers them.
function officeSettingsNow(): OfficeSettingsRes {
  return {
    name: agentManager.getOfficeSettings().name,
    version: officeSettingsVersion(),
    memberUsageCap: memberUsageCap().isEnabled(),
    memberUsageShare: memberUsageCap().share(),
    recordTerminals: loadRecordTerminals(),
    providerFallback: providerFallback().isEnabled(),
    processIsolation: loadProcessIsolation(),
    processIsolationStatus: processIsolationStatusLine(),
    claudeIsomuxLabel: loadClaudeIsomuxLabel(),
  };
}
// Who sees and answers an ask (askVisibleTo), read live: GET /api/asks,
// pushAskChange, the member answer routes and the secret request routes.
const askAudience: AskAudienceDeps = {
  isOfficeOwner: (userId) => buildLiveGuardDeps().isOfficeOwnerUserId(userId),
  agentRoomId: (agentId) => agentManager.getAgent(agentId)?.roomId ?? null,
  canSeeRoom: (userId, roomId) => {
    const user = getUserById(userId);
    return !!user && accessibleRoomIdsFor(user).has(roomId);
  },
  roomHidden: (userId, roomId) =>
    getUserById(userId)?.hidden.includes(roomId) ?? false,
  roomMemberIds: (roomId) =>
    listUsers()
      .filter((user) => accessibleRoomIdsFor(user).has(roomId))
      .map((user) => user.id),
};
export function mayUseExtension(member: string, agentId: string): boolean {
  return (
    agentManager.getAgent(agentId)?.userId === member &&
    mayReachExtension(member, agentId)
  );
}

// A member reaches an agent in a room they can access, whoever manages it.
// The terminal frames of a browser socket: the agent's room is visible to the
// member, and the member has no permission pack, read live (a pack gives no
// shell).
function terminalAllowed(session: SessionLookup, agentId: string): boolean {
  if (getUserById(session.userId)?.pack) return false;
  return agentVisibleForSession(session, agentId);
}

export function mayReachExtension(member: string, agentId: string): boolean {
  const user = getUserById(member);
  const agent = agentManager.getAgent(agentId);
  if (!user || !agent) return false;
  const deps = buildLiveGuardDeps();
  const identity = withMemberPack(
    { scope: "user", userId: member, role: user.role, capabilities: [] },
    getUserById,
  );
  // A tab offer is a write to the agent: a member with a pack offers tabs
  // only to agents that fit it.
  return (
    deps.hasRoomAccess(identity, agent.roomId) &&
    identityFitsAgent(identity, agentId, deps)
  );
}

// A page the member shared from the browser extension (task 68da3968): the
// member's own message, which never answers a pending prompt.
async function shareWithAgent(
  member: string,
  agentId: string,
  text: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const result = await sendMemberMessage(
    agentId,
    text,
    getUserById(member)?.name,
    BROWSER_SHARE_DEVICE,
    undefined,
    { refusePromptAnswer: true },
  );
  return result.ok ? { ok: true } : { ok: false, code: result.code };
}

let seedWelcomeAgentsForFirstOwner:
  | ((username: string) => Promise<void>)
  | null = null;

const {
  resolveCodexDefaultModel,
  replaceRefusedFreeModel,
  stopFallbackRepick,
  backfillOfficeFreeModelMarks,
  ensureReceptionistAtBoot,
  seedWelcomeAgentsForFirstOwner: seedFirstOwner,
  configureWelcomeModelTiming,
} = createOfficeOnboarding({
  listBackendModels,
  recordOpenCodeFreeLimit: () => agentManager.openCodeFreeLimit.record(),
});

// registerBootHooks: install the auth.ts callbacks (room-snapshot provider,
// invite/session change fanout, first-owner welcome-agent seed) against the
// active manager instance. Extracted so startServer() controls when they run.
// The welcome-agent seed is also consumed by the ordered background boot path
// when Render claimed its first owner before the hooks existed.
// Body left at prior indentation; prettier normalizes post-review.
function registerBootHooks(): void {
  agentManager.setRefusedFreeModelReplacer(replaceRefusedFreeModel);
  // Inject the room snapshot provider auth.ts uses when seeding a new
  // owner's allowedRooms at invite-acceptance time. The provider closes
  // over agentManager.getRooms() rather than auth.ts importing
  // agent-manager directly - keeps the dependency graph one-way.
  setRoomsSnapshotProvider(() =>
    agentManager.getOrdinaryRooms().map((r) => r.id),
  );

  // When an invite is consumed (typically via HTTP POST /auth/accept,
  // which never touches the WS dispatch loop), fan out an updated
  // invites_list to every owner WS so their Access pane re-renders in
  // real time. Without this hook, a browser that minted an invite while a
  // *separate* browser opened the /i/ URL would have to reconnect to see
  // the consumed invite drop off the Outstanding list.
  //
  // users list too: acceptance is the ONE path that can create a user
  // record outside the users.* handlers (acceptInvite's claimUser upsert),
  // so without this an already-open owner tab shows the new session in the
  // sessions table while the user roster stays stale until reload - the
  // "session exists but user doesn't" ghost. emitUsersList() is the same
  // sanctioned fanout every other user mutation uses (public roster to
  // all, admin roster to owners).
  setOnInviteConsumed(() => {
    emitInvitesList();
    emitSessionsList();
    emitUsersList();
  });

  // Owner AccessPane sessions table stays fresh on any server-initiated
  // session invalidation: revoke, logout, delete-user fanout, and the
  // hot-path expiry / orphan branches in validateByHash. Without this,
  // e.g. deleting a member silently leaves their row in the table until
  // the owner reloads. Per-WS pushers also keep the member's
  // "My devices" sessions table consistent on the same events.
  setOnSessionsChanged(() => {
    emitSessionsList();
    recheckOpenAppSockets();
    extensionService?.revalidate();
    stepsChanged();
  });

  // The one owner of "a change to a user's room access re-projects their live
  // sockets": users.ts fires this after every persisted write that changes a
  // user's role or allowedRooms set, whichever route or flow made it
  // (users.setAccess, users.update, the rooms.create creator grant, the
  // rooms.close strip, bootstrap promotion and its rollback). The other source
  // of access change is the live room set itself, which owners reach by rule;
  // rooms.close re-projects that for everyone. A member's room access or
  // role may also be the change a step ask waits for.
  setOnUserAccessChanged((userId, changed) => {
    try {
      onUserAccessChanged(userId, changed);
    } finally {
      stepsChanged();
    }
  });
  seedWelcomeAgentsForFirstOwner = seedFirstOwner;
  // An app's owner agent, live: killed agents are gone from the manager.
  setAppOwnerAgentResolver((agentId) => {
    const agent = agentManager.getAgent(agentId);
    return agent
      ? { agentId, userId: agent.userId, privileged: agent.privileged === true }
      : null;
  });
  setInviteSeatGate(() => enterpriseSeats);
  setOnOwnerCreated(async ({ username }) => {
    takeOwnerClaimedInThisProcess();
    await seedWelcomeAgentsForFirstOwner!(username);
  });
} // end registerBootHooks

// Each WS carries the session it was authenticated with at upgrade time. The
// session reference is used per-message (so revoke kicks in on the next msg)
// and to attribute writes to the right user without trusting client-supplied
// `username` fields. The `connectionId` is a per-WS identifier (NOT per
// auth session) - multiple tabs of the same user share `session.sessionIdHash`
// but get distinct `connectionId`s, so live-avatars presence keyed by
// connectionId gives one ghost per tab (the design contract).
export interface OfficeWsData {
  kind: "office";
  session: SessionLookup;
  connectionId: string;
}

// One `Bun.serve` serves the office AND every app hostname, and a Bun server has
// exactly one set of websocket callbacks - so those callbacks receive both kinds
// of socket and have to tell them apart. `kind` is that discriminant, and it is
// a field rather than a guess about which properties exist: an app-relay socket
// carries no office session at all, and there must be no shape in which one
// could be mistaken for the other.
export interface ApiTokenWsData {
  kind: "api";
  tokenId: string;
  userId: string;
}
export type WsData =
  | OfficeWsData
  | ApiTokenWsData
  | AppRelayWsData
  | ExtensionWsData;
type EventSocket =
  | ServerWebSocket<OfficeWsData>
  | ServerWebSocket<ApiTokenWsData>;
const apiTokenSockets = new Set<ServerWebSocket<ApiTokenWsData>>();

function liveTokenSocket(ws: ServerWebSocket<ApiTokenWsData>): boolean {
  if (
    getUserById(ws.data.userId) &&
    isLiveApiTokenOwnedBy(ws.data.tokenId, ws.data.userId)
  )
    return true;
  ws.close(1008, "API token unavailable");
  apiTokenSockets.delete(ws);
  return false;
}

let connectionIdCounter = 0;
function nextConnectionId(): string {
  connectionIdCounter++;
  // Timestamp-prefixed counter: unique within a process lifetime even if
  // the same WS hash reconnects rapidly; the counter ticks per upgrade.
  // Not security-sensitive (the auth boundary is the cookie); just needs
  // to be unique across concurrent connections.
  return `c${Date.now().toString(36)}-${connectionIdCounter.toString(36)}`;
}

const browsers = new Set<ServerWebSocket<OfficeWsData>>();
// Every frame to an office browser socket goes through its outbox
// (server/office-ws-outbox.ts), so nothing is dropped past Bun's backpressure
// limit and no live frame overtakes a replay still in the queue.
const outboxes = new WeakMap<ServerWebSocket<OfficeWsData>, OfficeOutbox>();

function outboxFor(ws: ServerWebSocket<OfficeWsData>): OfficeOutbox {
  let outbox = outboxes.get(ws);
  if (!outbox) {
    outbox = new OfficeOutbox(ws, {
      onFail: (reason) =>
        console.warn(`[ws] closed an office socket: outbox ${reason}`),
    });
    outboxes.set(ws, outbox);
  }
  return outbox;
}

// Every frame to a browser socket, with its push kind (server/ws-push-area.ts).
function officeSend(
  ws: ServerWebSocket<OfficeWsData>,
  kind: WsPushKind,
  data: string,
): void {
  if (!wsPushAllowed(ws.data.session, kind)) return;
  outboxFor(ws).send(data);
}

// A lazy run of frames (the connect replay) through the same filter.
function officeSendLazy(
  ws: ServerWebSocket<OfficeWsData>,
  frames: Iterator<WsFrame>,
): void {
  const session = ws.data.session;
  outboxFor(ws).sendLazy(
    (function* () {
      try {
        for (let r = frames.next(); !r.done; r = frames.next())
          if (wsPushAllowed(session, r.value.kind)) yield r.value.data;
      } finally {
        frames.return?.();
      }
    })(),
  );
}

// Whether the member of `session` gets a push of `kind`, by their pack read
// live.
function wsPushAllowed(session: SessionLookup, kind: WsPushKind): boolean {
  const user = getUserById(session.userId);
  return pushAllowedForPack(
    user?.role === "member" ? user.pack : undefined,
    kind,
  );
}

// The identity and visibility policy (server/office-access-policy.ts). Created
// here, right after the last const it reads.
const {
  ENGINE_BELOW_STANDARD_MESSAGE,
  accessChangeRefusal,
  accessibleRoomIdsForIdentity,
  agentMayOpenApp,
  announceAppAudienceChanges,
  announceCronjobHookAudience,
  announceWebhookAudienceChanges,
  appActorName,
  appViewerFacts,
  appVisibilityFacts,
  attributionFor,
  boardRoomIdsForIdentity,
  canUserAccessApp,
  cronjobFacts,
  cronjobFactsById,
  cronjobViewerFor,
  cronjobViewerForSession,
  cronjobsFor,
  cwdFolderRefusal,
  defaultCreateRoomIdForIdentity,
  emitUsersList,
  folderRuleState,
  ordinaryScheduleMaker,
  ownScheduleLimitsFor,
  projectCronjobFor,
  snapshotAppVisibility,
  snapshotWebhookAudience,
  spawnAccessRefusal,
  spawnRefusal,
  taskViewerForIdentity,
  taskViewerForUser,
  viewerAppWire,
  webhookFacts,
  webhookTargetRoomId,
  webhookTargetsAgent,
  webhookViewerFor,
  webhookViewerForSession,
  webhookWire,
} = createAccessPolicy({
  accessibleRoomIdsFor,
  browsers,
  buildLiveGuardDeps,
  canAccess,
  currentWebhookIngress,
  liveEmit,
  officeSend,
  pushAppDeltaToEachWs,
  toPublicWire,
});

// Names and rooms as they are now, for the PagerEntry the compat pager
// routes build from a paged ask (server/pager-compat.ts).
const pagerCompat: PagerCompatDeps = {
  agent: (agentId) => {
    const agent = agentManager.getAgent(agentId);
    return agent ? { name: agent.name, roomId: agent.roomId } : null;
  },
  // The app's room is its creator agent's live room, the rule that decides
  // who sees the app (appVisibilityFacts); null without one.
  app: (name, createdAt) => {
    const app = appRegistry.get(name);
    if (!app || app.createdAt !== createdAt) return null;
    return {
      registrationGen: appRegistrationGeneration(app),
      roomId: appVisibilityFacts(app).creatorRoomId ?? null,
    };
  },
  memberName: (userId) => getUserById(userId)?.name ?? null,
};

// The agent ceiling of member permission packs (server/member-ceiling.ts).
const memberCeiling = createMemberCeiling({
  getUserById,
  getAllAgents: () => agentManager.getAllAgents(),
  engineRuns: (agent, access) =>
    engineRunsAccessHere(agent.agentType, access, agent.modelFamily || null),
  folderRefusal: (agent) =>
    confinedFolderRefusal(agent, agent.cwd, folderRuleState()),
  setAccess: (agentId, grant) => agentManager.setAccess(agentId, grant),
});

// Whether the apps of member `userId` may run: no pack, or a pack with apps
// write (an app runs code as the office's user).
function appsMayRunFor(userId: string | null | undefined): boolean {
  const user = userId ? getUserById(userId) : undefined;
  return (
    user?.role !== "member" || !user.pack || user.pack.areas.apps === "write"
  );
}

// Refuses to run app `name` when its owner's pack has no apps write.
function refuseAppOfPackWithoutApps(name: string): void {
  const app = appRegistry.get(name);
  if (app && !appsMayRunFor(app.userId))
    throw new AppSupervisorError(
      "owner_pack_no_apps",
      "This app's owner has no apps write in their permission pack, so the app cannot run.",
    );
}

// After a member's pack is saved: their agents move down to the ceiling, and
// their apps stop when the pack has no apps write.
function afterMemberPackSaved(userId: string): void {
  memberCeiling.moveMemberAgentsDown(userId).catch((err) => {
    console.error(`[ceiling] the agents of ${userId} did not move down:`, err);
  });
  stopAppsThatMayNotRun((app) => app.userId === userId);
}

// Stops each app among `which` whose owner's pack has no apps write. At boot
// for every app: an app unit is enabled, so a reboot starts it again.
function stopAppsThatMayNotRun(
  which: (app: { userId?: string | null }) => boolean,
): void {
  let apps: ReturnType<typeof appRegistry.list>;
  try {
    apps = appRegistry.list();
  } catch (err) {
    console.error("[ceiling] the app registry could not be read:", err);
    return;
  }
  for (const app of apps) {
    if (!which(app) || appsMayRunFor(app.userId)) continue;
    try {
      appSupervisor.stop(app.name);
    } catch (err) {
      console.error(`[ceiling] the app ${app.name} did not stop:`, err);
    }
  }
}

// The per-session projection and push (server/office-session-projection.ts).
// Created here, right after the identity and visibility policy it reads.
const {
  agentVisibleForSession,
  applyPreferencesChange,
  applyViewChange,
  clampViewFields,
  deliverAskAnswer,
  onUserAccessChanged,
  projectAgentForSession,
  pushAskChange,
  pushCronjobDeltaToEachWs,
  pushCronjobRunEntryToEachWs,
  pushCronjobRunToEachWs,
  pushCronjobsToEachWs,
  pushTaskDeltaToEachWs,
  pushTasksToEachWs,
  pushWebhookDeltaToEachWs,
  replayFrames,
  sendCronjobsTo,
  sendMemberMessage,
  sendProjectedFullState,
  sendTasksTo,
  visibleRoomProjection,
} = createSessionProjection({
  accessibleRoomIdsFor,
  enterpriseLocked: () => enterpriseSeats?.locked() ?? false,
  askAudience,
  attributionFor,
  browsers,
  cronjobFactsById,
  cronjobViewerForSession,
  cronjobsFor,
  emitPrivateUserRecord,
  emitUserUpdated,
  emitUsersList,
  identityFitsAgent: (identity, agentId) =>
    identityFitsAgent(identity, agentId, buildLiveGuardDeps()),
  officeSend,
  officeSendLazy,
  outboxFor,
  roomAllowedForSession,
  sendPresenceListTo,
  sendSessionContext,
  sessionHasFullRoomAccess,
  taskViewerForUser,
  webhookViewerForSession,
});

// The agent and cronjob event fan-out (server/office-event-fanout.ts). Created
// here, right after the last const it reads; startServer calls wireEventSinks.
const { wireEventSinks } = createEventFanout({
  agentVisibleForSession,
  announceCronjobHookAudience,
  apiTokenSockets,
  broadcast,
  browsers,
  cronjobFacts,
  liveEmit,
  officeSend,
  projectAgentForSession,
  pushAllRoomsListToOwners,
  pushCronjobDeltaToEachWs,
  pushCronjobRunEntryToEachWs,
  pushCronjobRunToEachWs,
  pushTaskDeltaToEachWs,
  roomAllowedForSession,
  sendProjectedFullState,
  sessionHasFullRoomAccess,
  wakeTokenLogWaiters,
});
// The session context carries the Claude families limited in the member's own
// env and the models they run, so it goes out again when office or personal
// variables are saved.
function sendSessionContext(ws: ServerWebSocket<OfficeWsData>): void {
  officeSend(
    ws,
    "session_context",
    JSON.stringify({
      type: "session_context",
      context: {
        ...sessionContextFor(ws.data.session, ws.data.connectionId),
        limitedClaudeFamilies: limitedClaudeFamiliesForUserId(
          ws.data.session.userId,
        ),
        claudeFamilyModels: claudeFamilyModelsForUserId(ws.data.session.userId),
      },
    }),
  );
}
function resendSessionContexts(userId?: string): void {
  for (const ws of browsers) {
    if (userId === undefined || ws.data.session.userId === userId)
      sendSessionContext(ws);
  }
}
// The public webhook route's state (counters, limits, delivery logs). Built
// per boot in startServer, before the listener.
let webhookIngress: WebhookIngress | null = null;
function currentWebhookIngress(): WebhookIngress {
  if (!webhookIngress) throw new Error("webhook ingress is not built yet");
  return webhookIngress;
}

// A webhook's agent target: the hook OWNER (not the calling agent) must reach
// the agent's room, as messageTargetAgentId requires for apps, and an owner
// with a permission pack must fit the agent (the messaging rule). Checked when
// the target is set and again on each dispatch, with the live pack.
function webhookAgentReachable(
  userId: string | null,
  agentId: string,
): "ok" | "invalid_id" | "unavailable" {
  if (!isSafeScopeId(agentId)) return "invalid_id";
  const owner = userId ? getUserById(userId) : null;
  const target = agentManager.getAgent(agentId);
  if (!owner || !target) return "unavailable";
  if (!accessibleRoomIdsFor(owner).has(target.roomId)) return "unavailable";
  const identity = withMemberPack(
    { scope: "user", userId: owner.id, role: owner.role, capabilities: [] },
    getUserById,
  );
  return identityFitsAgent(identity, agentId, buildLiveGuardDeps())
    ? "ok"
    : "unavailable";
}

// A room-limited token reaches only the agents in its rooms; every other
// caller reaches any agent (the owner rule is checked apart).
function callerReachesAgent(identity: Identity, agentId: string): boolean {
  if (tokenRooms(identity) === null) return true;
  const target = agentManager.getAgent(agentId);
  return (
    !!target && buildLiveGuardDeps().hasRoomAccess(identity, target.roomId)
  );
}

// A fire of a schedule with an agent target (task a0c26f59): the prompt goes
// to the agent as a message from the schedule. The job OWNER must still reach
// the agent's room, as for a webhook's agent target.
async function deliverCronjobToAgent(
  job: Cronjob & { target: CronjobTarget },
  text: string,
): Promise<
  | { ok: true; messageId: string; agentName: string }
  | { ok: false; reason: LogMessage }
> {
  const agentId = job.target.agentId;
  const unreachable = {
    ok: false as const,
    reason: msg("systemEntries.scheduleRun.agentUnreachable"),
  };
  if (webhookAgentReachable(job.userId, agentId) !== "ok") return unreachable;
  await agentManager.prepareEnqueue(agentId);
  // The await above can outlast a change to the job or to the owner's rooms.
  // Everything from here to the enqueue is synchronous.
  const current = cronjobManager.listCronjobs().find((c) => c.id === job.id);
  if (!current)
    return { ok: false, reason: msg("systemEntries.scheduleRun.jobDeleted") };
  if (
    current.target?.agentId !== agentId ||
    webhookAgentReachable(current.userId, agentId) !== "ok"
  )
    return unreachable;
  const result = agentManager.enqueueMessage(agentId, {
    sender: {
      kind: "cronjob",
      cronjobId: current.id,
      cronjobName: current.name,
    },
    text,
  });
  if (result.ok)
    return {
      ok: true,
      messageId: result.messageId ?? "",
      agentName: agentManager.getAgent(agentId)?.name ?? agentId,
    };
  if (result.error === "agent_stopped" || result.error === "agent_error")
    return { ok: false, reason: msg("systemEntries.scheduleRun.agentStopped") };
  if (result.error === "queue_full")
    return {
      ok: false,
      reason: msg("systemEntries.scheduleRun.agentQueueFull"),
    };
  if (result.status === 404) return unreachable;
  return {
    ok: false,
    reason: msg("systemEntries.scheduleRun.sendFailed", {
      error: result.error,
    }),
  };
}

// A webhook's cronjob target: the hook OWNER must still exist and own the
// cronjob or be an office owner. Checked when the target is set and again on
// each dispatch. The existence check is the fix for an office that deleted a
// member before their hooks passed to the heir (task 438900d2): their hook and
// schedule still name the same deleted id.
function webhookCronjobRunnable(
  userId: string | null,
  cronjobId: string,
): "ok" | "missing" | "forbidden" {
  const job = cronjobManager
    .listCronjobs()
    .find((candidate) => candidate.id === cronjobId);
  if (!job) return "missing";
  if (userId === null) return "forbidden";
  const owner = getUserById(userId);
  if (!owner) return "forbidden";
  if (owner.role === "owner") return "ok";
  return job.userId === userId ? "ok" : "forbidden";
}

// Centralized Idempotency-Key cache. Process-global; reset per boot in
// resetServerModuleState so a repeated in-process harness boot starts clean.
const idempotencyCache = createIdempotencyCache();

// The HTTP executor's deps for the migrated /api surface. Assembled in
// startServer once the managers exist; read by the fetch handler at request time.
let executorDeps: ExecutorDeps;
// read_replies waiters (server/mcp-endpoint.ts), by token id. The token
// log's entry sink (wireEventSinks, server/office-event-fanout.ts) wakes them.
const tokenLogWaiters = new Map<string, Set<() => void>>();
function wakeTokenLogWaiters(tokenId: string): void {
  const waiters = tokenLogWaiters.get(tokenId);
  if (!waiters) return;
  for (const wake of [...waiters]) wake();
}

// One office route run in process as a caller: the /mcp endpoint's tool
// calls and a member's run of an ask's action.
const dispatchInProcess = createInProcessDispatch(() => executorDeps);

// The /mcp endpoint's seams into the executor and the token logs.
const mcpEndpointDeps: McpEndpointDeps = {
  dispatch: (identity, method, path, body) =>
    dispatchInProcess(identity, method, path, body, { via: "mcp" }),
  waitForTokenLogEntry: (tokenId, timeoutMs, signal) =>
    new Promise<void>((resolve) => {
      let waiters = tokenLogWaiters.get(tokenId);
      if (!waiters) {
        waiters = new Set();
        tokenLogWaiters.set(tokenId, waiters);
      }
      const set = waiters;
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        set.delete(done);
        if (set.size === 0 && tokenLogWaiters.get(tokenId) === set)
          tokenLogWaiters.delete(tokenId);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      set.add(done);
      if (signal.aborted) done();
      else signal.addEventListener("abort", done);
    }),
};
// The /mcp/files endpoint's seams: the agent record at the time of each
// request, and the child process that runs a call.
const folderMcpDeps: FolderMcpDeps = {
  agentNow: (agentId) => {
    const agent = agentManager.getAgent(agentId);
    return agent
      ? {
          agentType: agent.agentType,
          access: agentAccessOf(agent),
          folder: agent.cwd,
        }
      : null;
  },
  run: runFolderFiles,
};
// The OAuth MCP flow of this boot (integrations A2b) and its refresh timer.
let mcpOAuth: McpOAuth | null = null;
let mcpOAuthTimer: ReturnType<typeof setInterval> | null = null;
let sudoRequests: SudoRequests | null = null;
// The Enterprise Contract seats of this boot (server/enterprise-seats.ts).
let enterpriseSeats: EnterpriseSeats | null = null;
const MCP_OAUTH_TICK_MS = 60_000;

// Editor file watchers, keyed by connectionId -> (`${agentId}\0${absPath}` ->
// watcher). Rekeyed from a per-WS WeakMap when the editor moved to REST:
// the GET handler has no socket, only the client-supplied X-Isomux-Connection-Id,
// so each open file's watch (mtime poll) + its editor_external_change push bind to the
// connectionId (resolved back to a socket by the connectionId emit projection).
// Watchers close on closeFile (DELETE) or WS disconnect (swept by connectionId).
const editorWatchers = new Map<string, Map<string, FileWatcher>>();

// The HTTP and WebSocket front door (server/office-front-door.ts). Created
// here, right after the last const it reads; startServer calls buildServer.
const { buildServer } = createFrontDoor({
  agentVisibleForSession,
  apiTokenSockets,
  browsers,
  canUserAccessApp,
  currentWebhookIngress,
  editorWatchers,
  executorDeps: () => executorDeps,
  folderMcpDeps,
  handleInboundMessage,
  liveTokenSocket,
  mcpEndpointDeps,
  nextConnectionId,
  officeSend,
  officeSendLazy,
  outboxes,
  pushPresenceListToEachWs,
  replayFrames,
  sendCronjobsTo,
  sendPresenceListTo,
  sendProjectedFullState,
  sendSessionContext,
  sendTasksTo,
  toPublicWire,
});

// No raw ws.send fan-out lives outside emit() and the per-WS direct replies.
// Scoped invite list for a user: owner sees ALL outstanding invites; a member
// sees only their own links. The whole invite
// seam (this projection, the inviteOwnerOrSelf precondition, and the revoke
// branch) keys owner/member off the user RECORD via getUserById, NOT the WS
// session role - because the recipient-scoped emit is
// userId-keyed and must resolve the record anyway. They differ only in the rare
// promote-without-reconnect race; the record is the authoritative source. (Two
// intentional session-role exceptions remain, both pre-existing emit/guard infra
// rather than this seam's projection: the invites.mint officeOwner guard, and the
// shared owners-audience fan-out - ownerSessions in liveEmitDeps - that selects
// recipients for invite_revoked/session_revoked.)
function scopedInvitesFor(userId: string | null): InviteWire[] {
  if (!userId) return [];
  const u = getUserById(userId);
  if (!u) return [];
  return u.role === "owner" ? listInvites() : listInvitesForUser(u);
}

// Emit one recipient-scoped invites_list to all of a single user's sockets.
// Fail-closed: an unknown userId (no record) emits nothing. Reused as the
// per-user step of emitInvitesList().
function emitInvitesListForUser(userId: string): void {
  if (!getUserById(userId)) return;
  liveEmit("invites_list", { invites: scopedInvitesFor(userId) }, { userId });
}

// Fan out a freshly-scoped invites_list to EVERY connected user (each socket of
// each user gets that user's own projection). Replaces pushInvitesListToEachWs:
// loops DISTINCT connected userIds so the scope is computed once per user, then
// the recipient-scoped emit (userId → sessionsForUser) delivers to all of that
// user's sockets. Used after every MUTATION (mint / self-mint / revoke /
// access-settings self-mint / invite-consumed) - NEVER for a pure list read.
function emitInvitesList(): void {
  const seen = new Set<string>();
  for (const ws of browsers) {
    const uid = ws.data.session.userId;
    if (seen.has(uid)) continue;
    seen.add(uid);
    emitInvitesListForUser(uid);
  }
  // A link made or taken back may be the change a step ask waits for.
  stepsChanged();
}

// The removed members, to every owner (task 321e7b8e).
function emitRemovedMembers(): void {
  liveEmit("removed_members", {
    members: listRemovedMembers().map(removedMemberWire),
  });
}

// A removed member is deleted for good (Delete now, or 30 days passed): the
// archive, any live connection file a restore cut short left, and their
// provider homes with their conversations (task 548d607b).
function purgeRemovedMember(userId: string): void {
  dropRemovedMember(userId);
  if (getUserById(userId)) return;
  const sources = createMcpServerSources();
  sources.secrets.removeMember(userId);
  sources.servers.removeMember(userId);
  removeManagedUserEnv(userId);
  removePersonalProviderHomes(userId);
}

// Boot and the minute sweep: the members removed 30 days ago or more go.
// How many went.
function purgeExpiredMembers(): number {
  const purged = purgeExpiredRemovedMembers(Date.now());
  for (const id of purged) purgeRemovedMember(id);
  if (purged.length > 0) emitRemovedMembers();
  return purged.length;
}

// Boot: the live record wins (an unfinished removal or a finished restore),
// then the expired members go. Never blocks the boot.
function settleRemovedMembers(): void {
  try {
    reconcileRemovedMembers(listUsers().map((user) => user.id));
    purgeExpiredMembers();
  } catch (err) {
    console.error("[users] removed members were not settled:", err);
  }
  // The provider homes of ids that are neither live nor removed (members
  // removed before Removed members existed). Never on a users.json that
  // lists no owner: an unreadable one loads as empty. An unreadable
  // removed-members.json throws, and nothing goes.
  try {
    if (hasOwner())
      sweepPersonalProviderHomes([
        ...listUsers().map((user) => user.id),
        ...listRemovedMembers().map((member) => member.user.id),
      ]);
  } catch (err) {
    console.error("[users] old provider homes were not swept:", err);
  }
}

// Scoped session list for a user: owner sees ALL active sessions; a member sees
// only their own by stable, rename-safe userId. Same record-role rationale as
// scopedInvitesFor.
function scopedSessionsFor(userId: string | null): SessionWire[] {
  if (!userId) return [];
  const u = getUserById(userId);
  if (!u) return [];
  return u.role === "owner"
    ? listActiveSessions()
    : listActiveSessionsForUserId(userId);
}

// Emit one recipient-scoped sessions_active_list to all of a single user's
// sockets. Fail-closed on an unknown userId. Per-user step of emitSessionsList().
function emitSessionsListForUser(userId: string): void {
  if (!getUserById(userId)) return;
  liveEmit(
    "sessions_active_list",
    { sessions: scopedSessionsFor(userId) },
    { userId },
  );
}

// Fan out a freshly-scoped sessions_active_list to EVERY connected user (loops
// distinct userIds; each user's sockets get that user's own projection).
// Replaces pushSessionsListToEachWs and is wired into fireSessionsChangedHook,
// so it fires from EVERY session mutation (revoke / logout / evict / expiry).
function emitSessionsList(): void {
  const seen = new Set<string>();
  for (const ws of browsers) {
    const uid = ws.data.session.userId;
    if (seen.has(uid)) continue;
    seen.add(uid);
    emitSessionsListForUser(uid);
  }
}

// Core access policy for the office.getAccess / office.setAccess routes.

// Effective access policy for the owner UI. Mirrors the boot-time inference
// exactly: an explicit cfg.externalAccess wins; otherwise external is implied by
// a saved publicOrigin.
function computeAccessSettings(installKind: InstallKind): AccessSettings {
  const cfg = loadServerConfig();
  const effectiveExternal = cfg.externalAccess ?? cfg.publicOrigin !== null;
  return {
    hosted: isHostedAccess(installKind, cfg.publicOrigin),
    externalAccess: effectiveExternal,
    publicOrigin: cfg.publicOrigin,
    // Kept for wire compatibility: this field reports whether outside access
    // is blocked, not the listener's raw interface selection.
    boundLoopback: isOutsideReachabilityBlocked(),
  };
}

// Result of an access-settings mutation; REST selects signInUrl and restartRequired.
type ApplyAccessResult =
  | {
      ok: true;
      externalAccess: boolean;
      publicOrigin: string | null;
      signInUrl: string | null;
      restartRequired: boolean;
    }
  | {
      ok: false;
      status: HandlerErrorStatus;
      error: string;
      code?: string;
    };

// A hosted box accepts only an unchanged, already-enabled address, except the
// installer's first enable to the office's isomux.app address, which takes the
// self-hosted path. Self-hosted changes persist and
// require a restart; enabling also mints an owner invite. A failed mint leaves
// the saved settings in place and returns no sign-in URL.
async function applyAccessSettings(
  externalAccess: boolean,
  publicOrigin: string,
  userId: string | null,
  installKind: InstallKind,
): Promise<ApplyAccessResult> {
  const rawOrigin = publicOrigin.trim();
  const origin = rawOrigin ? normalizePublicOrigin(rawOrigin) : null;
  const current = computeAccessSettings(installKind);
  const hosted = hostedAccessRule(current, externalAccess, origin);
  if (hosted === "managed")
    return {
      ok: false,
      status: 403,
      code: "hosted_access_managed",
      error:
        "Hosted Isomux manages this office's address; it cannot be changed.",
    };
  if (hosted === "kept")
    return {
      ok: true,
      externalAccess: true,
      publicOrigin: current.publicOrigin,
      signInUrl: null,
      restartRequired: false,
    };
  if (rawOrigin && !origin) {
    return {
      ok: false,
      status: 400,
      error:
        "Public URL must be https://<host> or http://localhost (no path, query, or fragment).",
    };
  }
  if (externalAccess && !origin) {
    return {
      ok: false,
      status: 400,
      error: "Enabling external access requires a public URL.",
    };
  }
  try {
    saveServerConfig({ publicOrigin: origin, externalAccess });
  } catch (err) {
    return { ok: false, status: 500, error: errMessage(err) };
  }
  let signInUrl: string | null = null;
  if (externalAccess && origin) {
    const me = userId ? getUserById(userId) : undefined;
    if (me) {
      const minted = await mintInvite({
        userId: me.id,
        createdBy: me.name,
        ttlMs: SELF_INVITE_TTL_MS,
      });
      if (minted.ok) {
        signInUrl = `${origin}/i/${minted.rawToken}`;
        emitInvitesList();
      } else {
        console.warn(
          `[auth] applyAccessSettings: self-invite mint failed: ${minted.error}`,
        );
      }
    }
  }
  return {
    ok: true,
    externalAccess,
    publicOrigin: origin,
    signInUrl,
    restartRequired: true,
  };
}

// office.setSettings / validate.env / backends.listModels each delegate to ONE
// core here (the single validation+mutation seam its REST handler calls). The WS
// arms that once shared these cores are all retired (3d slices 1 and 2, and the
// office/tasks slice). Object-level AUTH is NOT here: REST enforces it in the
// route table (guard + precondition).

// Optimistic-concurrency version over the office settings. The prompt is not
// in it: the office instructions have their own version. The persisted envFile
// remains in the version until the boot import clears it.
// Canonical array serialization (stable order, distinguishes
// null from ""), hashed with the same versionOf as memory files.
function officeSettingsVersion(): string {
  const s = agentManager.getOfficeSettings();
  return versionOf(
    JSON.stringify([
      s.envFile,
      s.name,
      memberUsageCap().isEnabled(),
      memberUsageCap().share(),
      loadRecordTerminals(),
      providerFallback().isEnabled(),
      loadProcessIsolation(),
      loadClaudeIsomuxLabel(),
    ]),
  );
}

// What the owner's switch gives on this host: "on", or why agents do not run
// in their own PID namespace (server/process-isolation.ts).
function processIsolationStatusLine(): "on" | ProcessIsolationReason {
  const status = processIsolationNow();
  return status.state === "on" ? "on" : status.reason;
}

// office.setInstructions core: the prompt alone, guarded by the version of the
// text. The same setOfficeSettings write as applyOfficeSettings, so the event
// is the same.
function applyOfficeInstructions(
  prompt: string | null,
  expectedVersion: string,
): { ok: true; instructions: string | null } | { ok: false; version: string } {
  const current = agentManager.getOfficeSettings();
  const currentVersion = versionOf(current.prompt ?? "");
  if (expectedVersion !== currentVersion)
    return { ok: false, version: currentVersion };
  agentManager.setOfficeSettings(prompt, current.envFile, current.name);
  const stored = agentManager.getOfficeSettings().prompt;
  notePromptContent(stored);
  return { ok: true, instructions: stored };
}

// office.setSettings core. The version guard runs FIRST (a stale writer is told
// to re-read before hearing about field validation), then validates the name
// before it mutates/emits. Omitted fields PRESERVE their current values, for
// stale clients and for an agent that changes one field. A null or empty name
// CLEARS it. The prompt is kept: office.setInstructions writes it.
// setOfficeSettings emits office_settings_updated via the sink.
function applyOfficeSettings(
  input: {
    name?: string | null;
    memberUsageCap?: boolean;
    memberUsageShare?: number;
    recordTerminals?: boolean;
    providerFallback?: boolean;
    processIsolation?: boolean;
    claudeIsomuxLabel?: boolean;
    expectedVersion: string;
  },
  actor: AuditActor,
):
  | { ok: true }
  | { ok: false; status: 400; error: string }
  | { ok: false; conflict: true; version: string } {
  const currentVersion = officeSettingsVersion();
  if (input.expectedVersion !== currentVersion) {
    return { ok: false, conflict: true, version: currentVersion };
  }
  const rawName =
    input.name === undefined
      ? agentManager.getOfficeSettings().name
      : typeof input.name === "string" && input.name.trim()
        ? input.name.trim()
        : null;
  if (rawName && rawName.length > OFFICE_NAME_MAX) {
    return {
      ok: false,
      status: 400,
      error: `Office name must be ${OFFICE_NAME_MAX} characters or fewer`,
    };
  }
  agentManager.setOfficeSettings(
    agentManager.getOfficeSettings().prompt,
    agentManager.getOfficeSettings().envFile,
    rawName,
  );
  if (
    input.memberUsageCap !== undefined &&
    input.memberUsageCap !== memberUsageCap().isEnabled()
  )
    memberUsageCap().setEnabled(input.memberUsageCap);
  if (
    input.memberUsageShare !== undefined &&
    input.memberUsageShare !== memberUsageCap().share()
  )
    memberUsageCap().setShare(input.memberUsageShare);
  // Agents move to or from the office sign-in at their next turn.
  if (
    input.providerFallback !== undefined &&
    input.providerFallback !== providerFallback().isEnabled()
  )
    providerFallback().setEnabled(input.providerFallback);
  if (
    input.recordTerminals !== undefined &&
    input.recordTerminals !== loadRecordTerminals()
  ) {
    saveRecordTerminals(input.recordTerminals);
    // Its own row, with the new value in the operation: the executor's row
    // names the fields, never their values. Nobody turns recording off, acts
    // and turns it back on without a trace.
    recordAudit({
      actor,
      operation: input.recordTerminals
        ? "terminal.recordingOn"
        : "terminal.recordingOff",
      targets: ["office"],
      fields: [],
    });
  }
  // Session starts from here on follow it; running sessions keep their form.
  if (input.processIsolation !== undefined)
    saveProcessIsolation(input.processIsolation);
  // Claude sessions that start from here on follow it.
  if (input.claudeIsomuxLabel !== undefined)
    saveClaudeIsomuxLabel(input.claudeIsomuxLabel);
  return { ok: true };
}

// Shared core for the validate.env REST handler. Resolves the scope/user's
// env-file path and counts its keys. AUTH lives outside (the
// validateEnvBodySelfSubject precondition). The resolved path is returned but
// the REST handler drops it (the retired request_settings_validation WS arm used
// to echo it). An absent env file is trivially ok (nothing to validate). For
// scope:"user", an explicit username targets THAT user; an omitted username
// targets the CALLER's OWN env (selfUserId) - the subject the precondition
// already authorized as "self". Without this self-resolution an authorized
// own-env probe would validate nothing and return a false ok. The caller never
// names the file: the core reads only the office env file or a user's managed
// env file, because a parse error quotes the line it failed on.
function resolveAndValidateEnv(
  scope: string,
  username: string | undefined,
  selfUserId: string | undefined,
): { ok: boolean; keyCount?: number; error?: string; envFile: string | null } {
  let envFile: string | null = null;
  if (scope === "office") {
    envFile = agentManager.getOfficeSettings().envFile;
  } else if (scope === "user") {
    const rec = username
      ? getUser(username)
      : selfUserId
        ? getUserById(selfUserId)
        : undefined;
    envFile =
      rec && managedUserEnvExists(rec.id) ? managedUserEnvPath(rec.id) : null;
  }
  if (!envFile) return { ok: true, envFile: null };
  try {
    return {
      ok: true,
      keyCount: agentManager.validateEnvPath(envFile),
      envFile,
    };
  } catch (err) {
    // A parse error quotes the line it failed on. Not for a credential file.
    return {
      ok: false,
      error: isCredentialStorePath(envFile)
        ? "Invalid env file"
        : errMessage(err, "Invalid env file"),
      envFile,
    };
  }
}

// The check of each OpenCode agent's model against the list the model picker
// reads (task 73951c9f). Lazy agents count too: listing wakes no session.
async function checkOpenCodeAgentModels(): Promise<void> {
  const checked = agentManager
    .getAllAgents()
    .filter((agent) => agent.agentType === "opencode")
    .map(({ id, userId, cwd, modelFamily }) => ({
      id,
      userId,
      cwd,
      modelFamily,
    }));
  const statuses = await checkOpenCodeModels(checked, async (userId, cwd) => {
    const listed = await listBackendModels({
      agentType: "opencode",
      cwd,
      includeHidden: true,
      userId,
      // No member waits on the check: a server it starts stops at its end.
      stopIfStarted: true,
    });
    if (!listed.ok) throw new Error(listed.error);
    return listed.models;
  });
  for (const agent of checked) {
    const now = agentManager.getAgent(agent.id);
    // The model changed during the check: the result is about the old one.
    if (now?.agentType !== "opencode" || now.modelFamily !== agent.modelFamily)
      continue;
    const status = statuses.get(agent.id);
    if (status === "gone")
      agentManager.setGoneModel(agent.id, agent.modelFamily);
    else if (status === "listed") agentManager.setGoneModel(agent.id, null);
  }
}

// backends.listModels. Resolves the per-user env stack and
// checks the cwd EXACTLY like a real spawn (so office and managed personal variable overrides are reflected),
// lists, and maps to the wire shape. On failure, flags backend-specific auth
// errors via detectAuthError so the UI can render login instructions.
async function listBackendModels(input: {
  agentType: string;
  cwd: string;
  includeHidden: boolean;
  userId: string | null;
  signal?: AbortSignal;
  stopIfStarted?: boolean;
}): Promise<
  | { ok: true; models: BackendModelWire[] }
  | { ok: false; error: string; authError: boolean }
> {
  try {
    const backend = getBackend(input.agentType as AgentBackendType);
    // The spawn check: an existing directory. Throws before any backend starts.
    const cwd = validateCwd(input.cwd);
    const env =
      input.agentType === "opencode"
        ? agentManager.buildOpenCodeLaunchEnvironmentForUserId(input.userId)
        : agentManager.buildEnvForUserId(input.userId);
    const models = await backend.listModels({
      cwd,
      env,
      environmentKey: agentManager.environmentSourceKeyForUserId(input.userId),
      environmentRevision:
        input.agentType === "opencode"
          ? agentManager.openCodeEnvironmentRevisionForUserId(input.userId)
          : agentManager.environmentSourceRevisionForUserId(input.userId),
      ...(input.agentType === "opencode"
        ? {
            skillPaths: agentManager.openCodeSkillPathsForUserId(input.userId),
          }
        : {}),
      includeHidden: input.includeHidden,
      signal: input.signal,
      stopIfStarted: input.stopIfStarted,
    });
    const wire: BackendModelWire[] = models.map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      isDefault: m.isDefault,
      hidden: m.hidden,
      isFree: m.isFree,
      supportedEfforts: m.supportedEfforts,
      defaultEffort: m.defaultEffort,
    }));
    return { ok: true, models: wire };
  } catch (err) {
    const message = errMessage(err);
    const authError = (() => {
      try {
        return getBackend(input.agentType as AgentBackendType).detectAuthError(
          message,
        );
      } catch {
        return false;
      }
    })();
    return { ok: false, error: message, authError };
  }
}

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of browsers) {
    officeSend(ws, msg.type, data);
  }
}

// Build the per-recipient presence_list. Each entry carries the sender's stable
// currentRoomId; entries whose room isn't VISIBLE to the recipient are omitted
// (per-recipient filter via visibleRoomProjection), as are off-scene entries
// (currentRoomId = null) per design (UI noise + privacy). The recipient's own
// session is included on the same gate; "self hidden in LogView" is a
// client-local concern.
function buildPresenceListFor(session: SessionLookup): PresenceInfo[] {
  const projection = visibleRoomProjection(session);
  const out: PresenceInfo[] = [];
  for (const p of listAllPresence()) {
    if (p.currentRoomId === null) continue;
    // Per-recipient visibility filter: drop ghosts whose room this session
    // can't see - unknown id, or globalToVisible < 0. Reuses the projection's
    // global roomId→index map rather than a second inline index.
    if (p.currentRoomId !== LOBBY_ROOM_ID) {
      const globalIdx = projection.globalRoomIdToIndex.get(p.currentRoomId);
      if (globalIdx === undefined) continue;
      if (projection.globalToVisible[globalIdx] < 0) continue;
    }
    out.push({
      connectionId: p.connectionId,
      userId: p.userId,
      username: p.username,
      device: p.device,
      avatarColor: p.avatarColor,
      avatarVariant: p.avatarVariant,
      currentRoomId: p.currentRoomId,
      ...(p.currentRoomId === LOBBY_ROOM_ID
        ? { lobbySpotId: p.lobbySpotId ?? null }
        : {}),
      focusedAgentId: p.focusedAgentId,
      viewMode: p.viewMode,
      page: p.page,
    });
  }
  // Deterministic order so client renders don't reshuffle on every
  // broadcast. connectionId is per-WS, stable while the connection
  // lives, and reconnects produce a fresh id (replacing the old entry
  // entirely, not reshuffling the existing ones).
  out.sort((a, b) => a.connectionId.localeCompare(b.connectionId));
  return out;
}

// Distinct online userIds across the WHOLE presence map (not the
// per-recipient filtered `entries`). Off-scene sessions (viewMode
// "away" / currentRoomId === null) are included - "online" here means
// "has a live WS that has sent at least one presence_update", which is
// independent of whether the session is currently visible in a scene.
// Same value broadcast to every recipient; totalOnlineUsers is its size.
// Sorted so equal sets serialize identically regardless of presence-map
// iteration order.
function listOnlineUserIds(): string[] {
  const seen = new Set<string>();
  for (const p of listAllPresence()) seen.add(p.userId);
  return Array.from(seen).sort();
}

function sendPresenceListTo(ws: ServerWebSocket<OfficeWsData>) {
  const onlineUserIds = listOnlineUserIds();
  officeSend(
    ws,
    "presence_list",
    JSON.stringify({
      type: "presence_list",
      entries: buildPresenceListFor(ws.data.session),
      totalOnlineUsers: onlineUserIds.length,
      onlineUserIds,
    }),
  );
}

function pushPresenceListToEachWs() {
  for (const ws of browsers) {
    sendPresenceListTo(ws);
  }
}

// Per-WS room ACL + view projection.
// ACCESS (security): owners reach EVERY room by RULE; members reach their
// explicitly-granted rooms (UserRecord.allowedRooms == member grants). See
// canAccess(). VIEW (non-security): layered ON TOP of access - `hidden`
// (effective shown = accessible \ hidden) and sparse `order` decide WHICH
// accessible rooms appear and in what order. The projection materializes each
// recipient's visible rooms array (accessible ∩ shown, ordered) and filters
// presence/agents to it. Agents and presence carry stable room ids (post-cut
// there are no per-recipient dense `room` indices), so the projection no longer
// rewrites any index - it only decides room-list membership/order and
// per-recipient visibility.
//
// Helpers below are the single source of truth for those translations; per-WS
// event routing and the connect-time full_state both go through them.

// A session has "full access" when it can ACCESS every current room: an owner
// (by rule) or a member whose grants cover all rooms. visibleRoomProjection's
// identity fast-path additionally requires no hidden rooms and no custom order
// (otherwise it falls to the general accessible∩shown-in-order path).
// The receptionist's lobby. One test for room access (canAccess) and the
// turn-end push, which skips the lobby.
function isLobbyRoom(roomId: string): boolean {
  return (
    roomId === LOBBY_ROOM_ID || agentManager.roomById(roomId)?.type === "lobby"
  );
}

// Rule-based room ACCESS. Owners have access to ALL rooms by
// RULE (no materialized grant list); members have access to explicitly-granted
// rooms only (UserRecord.allowedRooms == member grants). This is the SECURITY
// gate. View preference (hidden/order) is a separate, ADDITIVE filter applied
// ON TOP by the projection - never here - so a future re-show path can never
// turn `hidden` into a security gate.
function canAccess(user: UserRecord, roomId: string): boolean {
  // Lobby access is universal; task scopes and room memory use ordinary rooms.
  if (isLobbyRoom(roomId)) return true;
  return user.role === "owner" || user.allowedRooms.includes(roomId);
}

function sessionHasFullRoomAccess(session: SessionLookup): boolean {
  const user = getUserById(session.userId);
  if (!user) return false;
  if (user.role === "owner") return true; // rule: owners can access every room
  for (const r of agentManager.getRooms()) {
    if (!canAccess(user, r.id)) return false;
  }
  return true;
}

function roomAllowedForSession(
  session: SessionLookup,
  roomId: string,
): boolean {
  const user = getUserById(session.userId);
  if (!user) return false;
  return canAccess(user, roomId);
}

// The concrete set of room ids a user can access right now - owner: every
// current room by RULE; member: their explicit grants. For sites that need a
// materialized accessible-set rather than a per-room predicate (e.g. the
// presence currentRoomId clamp + the notifRooms clamp on an access change).
// `allowedRoomsOverride` lets a caller clamp against grants being set in the
// SAME command before they are persisted (update_user computes the new
// accessible set from the incoming allowedRooms); it is ignored for owners,
// who access every live room by rule regardless of their (now empty) grants.
function accessibleRoomIdsFor(
  user: UserRecord,
  allowedRoomsOverride?: readonly string[],
): Set<string> {
  if (user.role === "owner") {
    return new Set(agentManager.getOrdinaryRooms().map((r) => r.id));
  }
  return new Set(allowedRoomsOverride ?? user.allowedRooms);
}

// The rooms a member may limit an API token to: the live rooms they reach,
// not the lobby. The token mint and the api-token action ask both read it.
function tokenLimitableRoomIds(userId: string): Set<string> {
  const user = getUserById(userId);
  if (!user) return new Set<string>();
  const accessible = accessibleRoomIdsFor(user);
  return new Set(
    agentManager
      .getOrdinaryRooms()
      .map((room) => room.id)
      .filter((id) => accessible.has(id)),
  );
}

// Boot: the skill folders of members that are gone go, and (once) the links
// that session starts before the member skill folders wrote into provider
// homes. Never blocks the boot.
function settleMemberSkillFolders(): void {
  try {
    const userIds = listUsers().map((user) => user.id);
    sweepMemberSkillFolders(userIds);
    cleanupLegacySkillLinks({
      codexHome: ISOMUX_CODEX_HOME,
      boxClaudeRoot: officeClaudeSourceRoot(),
      personalHomes: userIds.flatMap((id) =>
        (["claude", "codex"] as const).map((provider) => ({
          provider,
          root: personalProviderHome(id, provider),
        })),
      ),
      sourceRoots: {
        claude: officeClaudeSourceRoot(),
        codex: officeCodexSourceRoot(),
      },
      bundledDir: BUNDLED_SKILLS_DIR,
      marker: join(STATE_ROOT, "member-skills", ".legacy-cleaned"),
    });
  } catch (err) {
    console.error(
      "[skills] member skill folder upkeep failed:",
      errMessage(err),
    );
  }
}

// One-time owner-access migration to the rule-based model.
// Runs at boot AFTER rooms + users are loaded (it needs BOTH): the boot
// ORDERING is the security-critical part (a migration that ran before rooms
// load would see no live rooms and take the all-stale branch for every owner),
// so it is pinned by a real-boot restart() integration test, not just the pure
// planner's unit tests. IDEMPOTENT: the marker is "owner with non-empty
// allowedRooms"; a migrated owner has [], so a re-run is a no-op. The per-owner
// decision (seed hidden from the OLD grants with an effective-coverage guard,
// then clear grants) lives in the PURE planner - see server/access-migration.ts.
function migrateOwnersToRuleBasedAccess(): void {
  // Thin boot wrapper: collect the persisted users + the live room ids (rooms
  // are seeded synchronously by createManagers, so getRooms() is valid here),
  // delegate the per-owner decision to the PURE planner (unit-tested over the
  // full case matrix in access-migration.test.ts), and apply each mutation.
  const liveRoomIds = agentManager.getOrdinaryRooms().map((r) => r.id);
  for (const plan of planOwnerAccessMigration(listUsers(), liveRoomIds)) {
    const r = updateUserById(plan.id, {
      hidden: plan.hidden,
      allowedRooms: plan.allowedRooms,
    });
    if (!r.ok) {
      console.error(
        `[3b migration] owner ${plan.id} rule-based-access migration failed: ${r.error}`,
      );
    }
  }
}

// One-time-per-boot convergence of app tokens (server/app-token-reconcile.ts):
// every registered app ends up with a token whose hash and environment file
// agree, and hashes for apps that no longer exist are dropped. Nothing is
// started, stopped or restarted - a running app picks its token up on its next
// restart.
//
// ADVISORY: a failure here must never stop the office from booting, so the
// whole pass is caught. It is also the reason an app registered before tokens
// existed converges without anyone doing anything by hand.
function reconcileAppTokensAtBoot(): void {
  try {
    const report = reconcileAppTokens({
      list: () => appRegistry.list(),
      tokens: appTokens,
      readToken: (name) => appSupervisor.readToken(name),
      removeToken: (name) => appSupervisor.removeToken(name),
      reloadUnits: () => appSupervisor.reloadUnits(),
      unitInjectsToken: (name) => appSupervisor.unitInjectsToken(name),
      provisionToken: (name, raw) => appSupervisor.provisionToken(name, raw),
      regenerate: (record) => appSupervisor.regenerate(record),
      states: (names) => appSupervisor.states(names),
      restart: (name) => appSupervisor.restart(name),
    });
    const touched =
      report.provisioned.length + report.rewired.length + report.pruned.length;
    if (touched > 0) {
      console.log(
        `[app-tokens] boot: provisioned ${report.provisioned.length}, rewired ${report.rewired.length}, restarted ${report.restarted.length}, restart failed ${report.restartFailed.length}, pruned ${report.pruned.length}`,
      );
    }
  } catch (err) {
    console.error("[app-tokens] boot reconciliation failed:", err);
  }
}

// One-time-per-boot convergence of app URLs (server/app-url-reconcile.ts):
// every app's unit declares the address the office would give it today, and
// apps that were running are restarted once onto it. Runs AFTER the token pass,
// which may write a unit for an app that had none - a unit that pass creates is
// already current, so this one has nothing to do for it.
//
// ADVISORY, for the same reason as the token pass: a failure here must never
// stop the office from booting.
function reconcileAppUrlsAtBoot(): void {
  try {
    const report = reconcileAppUrls({
      list: () => appRegistry.list(),
      expectedUrl: (app) => appPublicUrl(app.hostLabel, appHostDomain()),
      readUnitFile: (name) => appSupervisor.readUnitFile(name),
      restoreUnitFile: (name, contents) =>
        appSupervisor.restoreUnitFile(name, contents),
      regenerate: (record) => appSupervisor.regenerate(record),
      states: (names) => appSupervisor.states(names),
      restart: (name) => appSupervisor.restart(name),
    });
    if (report.converged.length + report.failed.length > 0) {
      console.log(
        `[app-urls] boot: ${report.converged.length} unit(s) updated, ${report.restarted.length} restarted, ${report.failed.length} failed`,
      );
    }
  } catch (err) {
    console.error("[app-urls] boot reconciliation failed:", err);
  }
}

// Production GuardDeps adapter. Wires the guard catalog's injected office-state
// seam to today's materialized-allowedRooms predicates and the live managers.
// Built at boot and exposed on the ServerHandle. See
// server/identity/guard-deps.ts.
function buildLiveGuardDeps(): GuardDeps {
  const readers: GuardDepsLiveReaders = {
    // sessionHasFullRoomAccess / roomAllowedForSession only read session.userId,
    // so a minimal { userId } stands in for the full SessionLookup. The cast is
    // contained here at the seam; this materialized predicate can be swapped for
    // rule-based access by changing this body, never the adapter's shape.
    hasRoomAccessForUser: (userId, roomId) => {
      const session = { userId } as unknown as SessionLookup;
      return (
        sessionHasFullRoomAccess(session) ||
        roomAllowedForSession(session, roomId)
      );
    },
    getAllAgents: () => agentManager.getAllAgents(),
    getRooms: () => agentManager.getRooms(),
    killedAgentManagerUserId: (agentId) =>
      agentManager.killedAgentManagerUserId(agentId),
    killedAgentLastRoomId: (agentId) =>
      agentManager.killedAgentLastRoomId(agentId),
    // The grant a revive installs: the last one, moved down to the agent
    // ceiling of its manager's permission pack. One whose engine cannot run
    // there is judged at the ceiling too, so the revive answers it with 409.
    killedAgentGrant: (agentId) => {
      const record = agentManager.killedAgentCeilingRecord(agentId);
      const clamp = record ? memberCeiling.clampedGrant(record) : null;
      return clamp && clamp.kind !== "keep"
        ? clamp.grant
        : agentManager.killedAgentGrant(agentId);
    },
    agentHeardFrom: (receiverId, writerId) =>
      agentManager.agentHeardFrom(receiverId, writerId),
    memberHeardFrom: (userId, agentId) =>
      agentManager.memberHeardFrom(userId, agentId),
    cronRunVisibleTo: (identity, streamId) => {
      const runPrefix = cronjobRunStreamId("");
      if (!streamId.startsWith(runPrefix)) return false;
      const jobId = cronjobManager.jobIdForRun(
        streamId.slice(runPrefix.length),
      );
      return (
        jobId !== null &&
        cronjobVisibleTo(cronjobFactsById(jobId), cronjobViewerFor(identity))
      );
    },
    getUserByName: (username) => getUserByName(username) ?? null,
    getUserById: (userId) => getUserById(userId) ?? null,
    // A grant can name a closed room, so only live ordinary rooms count.
    memberRoomIds: (userId) => {
      const user = getUserById(userId);
      if (!user) return [];
      const reach = accessibleRoomIdsFor(user);
      return agentManager
        .getOrdinaryRooms()
        .map((room) => room.id)
        .filter((roomId) => reach.has(roomId));
    },
    userRecordById: (userId) => getUserById(userId) ?? null,
    listCronjobs: () => cronjobManager.listCronjobs(),
    listApps: () => appRegistry.list(),
    listWebhooks: () => webhookRegistry.list(),
    resourceRoomId: (kind, id) => {
      if (kind === "app") {
        const app = appRegistry.get(id);
        return app ? (appVisibilityFacts(app).creatorRoomId ?? null) : null;
      }
      if (kind === "webhook") {
        const hook = webhookRegistry.get(id);
        return hook ? webhookTargetRoomId(hook.target) : null;
      }
      return cronjobFactsById(id).liveRoomId;
    },
    apiTokenHeardFrom,
  };
  return buildProductionGuardDeps(readers);
}

// Production EmitDeps adapter. The single transport seam the emit()
// helper uses: audience -> recipient selection is computed in emit() from the
// event registry; this adapter owns only recipient enumeration over the live
// `browsers` set + per-recipient delivery. For 3a's groups the emits are
// all/owners/recipient-scoped ONLY (no room-ACL), so the per-recipient room
// projection is not exercised here; sessionsForRoomAccess is wired for
// completeness and the 3b room-visibility projection. deliver() stamps the
// event id as `type` and sends the
// already-shaped payload (the core op does any per-user shaping before emit()).
const liveEmitDeps: EmitDeps<EventSocket> = {
  sessionsForApiToken: (tokenId) =>
    [...apiTokenSockets].filter((ws) => ws.data.tokenId === tokenId),
  allSessions: () => [...browsers],
  ownerSessions: () =>
    [...browsers].filter((ws) => ws.data.session.role === "owner"),
  sessionsForUser: (userId) =>
    [...browsers].filter((ws) => ws.data.session.userId === userId),
  sessionByConnectionId: (connectionId) => {
    for (const ws of browsers) {
      if (ws.data.connectionId === connectionId) return ws;
    }
    return null;
  },
  sessionsForRoomAccess: (roomIds) =>
    [...browsers].filter((ws) =>
      roomIds.some((roomId) => roomAllowedForSession(ws.data.session, roomId)),
    ),
  roomIdForAgent: (agentId) => {
    const agent = agentManager.getAllAgents().find((a) => a.id === agentId);
    if (!agent) return null;
    // Return the authoritative roomId only if it names a LIVE room.
    // Do NOT lean on downstream audience filtering to fail closed - under the 3b
    // owner rule canAccess() returns true for ANY roomId string, so a dangling
    // id would still route this agent's room-ACL events to owner sockets.
    // Validate here, matching the guard-deps authz posture (pre-3c the
    // out-of-range dense index produced null at getRooms()[agent.room]?.id).
    return agentManager.liveAgentRoom(agent) ? agent.roomId : null;
  },
  deliver: (recipients, id, payload) => {
    // Room-ACL events arrive here with recipients ALREADY filtered
    // to room-access sessions by emit()'s registry audience, so deliver() only
    // performs per-recipient WIRE SHAPING - it does NOT own the audience decision
    // and never broadens recipients (projectAgentForSession's visibility check
    // below is defensive shaping if state/projection disagree, not a second
    // audience gate):
    //   - agent_added: suppress the agent for recipients who can't see its room
    //     (projectAgentForSession returns null). Post-cut there's no dense `room`
    //     to rewrite, so visible recipients get the verbatim agent.
    // Every other event - including room_closed, which post-cut just removes a
    // stable room id and no longer shifts any recipient's dense space - is
    // delivered byte-identical verbatim. This reproduces routeAgentEventToWs
    // (server/office-event-fanout.ts) for the migrated events.
    if (id === "agent_added") {
      const agent = (payload as { agent: AgentInfo }).agent;
      for (const socket of recipients) {
        if (socket.data.kind !== "office") continue;
        const ws = socket as ServerWebSocket<OfficeWsData>;
        const projected = projectAgentForSession(ws.data.session, agent);
        if (projected) {
          officeSend(
            ws,
            "agent_added",
            JSON.stringify({ type: "agent_added", agent: projected }),
          );
        }
      }
      return;
    }
    const data = JSON.stringify({ type: id, ...(payload as object) });
    for (const ws of recipients) {
      if (
        ws.data.kind === "api" &&
        !liveTokenSocket(ws as ServerWebSocket<ApiTokenWsData>)
      )
        continue;
      if (ws.data.kind === "office")
        officeSend(ws as ServerWebSocket<OfficeWsData>, id, data);
      else ws.send(data);
    }
  },
};

// Bind the emit() helper to the production transport seam. The ONLY path to the
// wire for migrated core ops / event sinks (never a raw broadcast()).
function liveEmit<K extends EventId>(
  id: K,
  payload: EventPayloads[K],
  ctx: EmitContext = {},
): void {
  emit(id, payload, ctx, liveEmitDeps);
}

// Project a full UserRecord to the office-wide PUBLIC wire - the ONLY user shape
// allowed on an all-audience event. Single helper so no all-audience emit hand-
// rolls the field set and accidentally leaks a sensitive field (grants/env/
// prompt/view).
function toPublicWire(user: UserRecord): UserPublicWire {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    avatarColor: user.avatarColor,
    avatarVariant: user.avatarVariant,
    createdAt: user.createdAt,
  };
}

// Fan out a single user-record change across the THREE audiences:
//   - user_updated (all): UserPublicWire - public profile only.
//   - user_admin_updated (owners): the FULL record (grants/env/prompt/view).
//   - user_self_updated (the subject's own sockets): the subject's full record.
// The all-audience public event reaches owners + the subject too; the client
// reducer merges, with the admin/self full data winning over public for records
// the recipient is allowed to know. This is the ONLY sanctioned path for
// user_updated - any remaining raw broadcast of user_updated/users_list is a leak.
function emitUserUpdated(user: UserRecord, prevName?: string): void {
  const tail = prevName !== undefined ? { prevName } : {};
  liveEmit("user_updated", { user: toPublicWire(user), ...tail });
  liveEmit("user_admin_updated", { user, ...tail });
  liveEmit("user_self_updated", { user, ...tail }, { userId: user.id });
}

// Fan out a PRIVATE-only record change: owners get the full record on the
// owners-only admin channel, the subject on its own. No public user_updated /
// users_list, because nothing in UserPublicWire changed - emitting them would
// broadcast the TIMING and TARGET of a private edit to every user without
// carrying any observable delta (the leak users.setAccess already avoids).
// Rename is deliberately not supported here: a rename is always a public
// change and belongs on emitUserUpdated's path.
function emitPrivateUserRecord(user: UserRecord): void {
  liveEmit("user_admin_updated", { user });
  liveEmit("user_self_updated", { user }, { userId: user.id });
}

// An enqueue failure as an HTTP error. The code doubles as the message, the
// legacy endpoint's contract, except for a usage cap refusal, which says why
// and carries retryAtMs.
function enqueueFailure(result: Extract<EnqueueResult, { ok: false }>): {
  ok: false;
  status: 400 | 404 | 409 | 429 | 500;
  code: string;
  message: string;
  detail?: Record<string, unknown>;
} {
  return {
    ok: false,
    status: result.status as 400 | 404 | 409 | 429 | 500,
    code: result.error,
    message: result.usageCap
      ? renderLogText(english, usageCapText(result.usageCap))
      : result.error,
    ...(result.usageCap
      ? { detail: { retryAtMs: result.usageCap.retryAtMs } }
      : {}),
  };
}

// The office's conversation-log tree, read-only. Built once: it holds no state
// beyond the directory path, so every log read shares it.
const officeLogSource = fileLogSource(join(STATE_ROOT, "logs"));

// Give a live agent a new manager (task 6a9deaba): the agent manager's core
// mutation, then the apps, schedules and webhooks the agent made that its old
// manager still owns. The agents.setManager route and a member deletion
// (to the oldest office owner) both come here.
async function transferAgentManager(
  agentId: string,
  toUserId: string,
  changedBy: string,
): Promise<AgentInfo | null | "unknown_member" | "cannot_move_down"> {
  const to = getUserById(toUserId);
  if (!to) return "unknown_member";
  const before = agentManager.getAgent(agentId);
  if (!before) return null;
  const from = before.userId;
  if (from === toUserId) return before;
  // A member with a permission pack gets the agent at their agent ceiling: it
  // moves down first, so it never runs above it under them.
  const clamp = memberCeiling.clampFor(
    before,
    to.role === "member" ? to.pack : undefined,
  );
  if (clamp.kind === "cannot") return "cannot_move_down";
  if (clamp.kind === "move") {
    const moved = await agentManager.setAccess(agentId, clamp.grant);
    if (moved === "engine_below_standard") return "cannot_move_down";
    if (!moved) return null;
  }
  // What the agent made and its old manager still owns. A record the agent
  // made that a third member owns now is that member's and stays.
  const made = (record: { createdByAgentId?: string; userId: string | null }) =>
    record.createdByAgentId === agentId && record.userId === from;
  const appAudienceBefore = snapshotAppVisibility(made);
  const webhookAudienceBefore = snapshotWebhookAudience(made);
  const info = await agentManager.setManager(
    agentId,
    to.id,
    to.name,
    changedBy,
  );
  if (!info) return null;
  try {
    for (const app of appRegistry.list().filter(made))
      appRegistry.update(app.name, {
        owner: { userId: to.id, username: to.name },
      });
  } catch (err) {
    console.error(`[manager] the apps of ${agentId} did not move:`, err);
  }
  try {
    for (const job of cronjobManager.listCronjobs())
      if (job.userId === from && cronjobMadeBy(job, agentId))
        cronjobManager.setCronjobOwner(job.id, to.id, to.name);
  } catch (err) {
    console.error(`[manager] the schedules of ${agentId} did not move:`, err);
  }
  // The old manager could read each hook's secret, so a hook moves with a new
  // one (task 37b2876b). Rotate before setOwner, in the one try: a rotate
  // that throws stops the loop before that hook moves, so the old manager
  // keeps it with the secret they knew. The maker agent rotates again to get
  // the new secret.
  try {
    for (const hook of webhookRegistry.list().filter(made)) {
      webhookRegistry.rotateSecret(hook.id);
      webhookRegistry.setOwner(hook.id, to.id, to.name);
    }
  } catch (err) {
    console.error(`[manager] the webhooks of ${agentId} did not move:`, err);
  }
  announceAppAudienceChanges(appAudienceBefore);
  announceWebhookAudienceChanges(webhookAudienceBefore);
  // An app reads only its owner's member secrets: the old manager's leave
  // it, and a running app whose file changed restarts.
  appSecrets.syncNow();
  return agentManager.getAgent(agentId) ?? info;
}

// Whether `agentId` made the job. A job made before jobs recorded their agent
// has only the audit log's cron.create row, matched on the time too: a job id
// is unique only among live jobs, so a deleted job's id can come back.
function cronjobMadeBy(job: Cronjob, agentId: string): boolean {
  if (job.createdByAgentId !== undefined)
    return job.createdByAgentId === agentId;
  try {
    return (
      officeAuditStore().list({
        operation: "cron.create",
        actorKind: "agent",
        actorId: agentId,
        targetId: job.id,
        from: job.createdAt - CRON_AUDIT_MATCH_MS,
        to: job.createdAt + CRON_AUDIT_MATCH_MS,
        limit: 1,
      }).items.length > 0
    );
  } catch (err) {
    console.error("[manager] the audit log could not be read:", err);
    return false;
  }
}
const CRON_AUDIT_MATCH_MS = 10_000;

function backupStatusWire(s: BackupStatus): BackupStatusWire {
  return {
    lastRunAt: s.lastBackupAt,
    ok: s.lastBackupOk ?? false,
    error: s.lastBackupError,
    retention: s.retention,
    intervalHours: s.intervalHours,
    destDir: s.backupDir,
    destDirFromEnv: s.backupDirFromEnv,
  };
}

// The owner export's jobs (task cdd7883d), for the boot sweep and the stop.
let officeExportJobs: OfficeExportJobs | null = null;

// The lock marker's `by` (task cdd7883d): the member's name, or the agent's
// name and its manager's.
function lockdownByName(identity: Identity): string {
  const user = identity.userId ? getUserById(identity.userId) : undefined;
  const member = user?.name ?? identity.userId ?? "unknown";
  if (identity.scope === "agent" && identity.agentId) {
    const agent = agentManager.getAgentDisplay(identity.agentId);
    return `${agent?.name ?? identity.agentId} for ${member}`;
  }
  return member;
}

// Assemble the executor deps for the migrated /api surface. Called from
// startServer once the managers exist. Each resource slice registers its
// handlers (and any precondition enforcers) here over its own slim deps bundle;
// the executor stays ignorant of managers/auth internals.
function buildExecutorDeps(
  backupStatus: () => BackupStatus = getBackupStatus,
  installKind: InstallKind = INSTALL_KIND,
  connectionTestFetch: ConnectionTestFetch = (url, init) => fetch(url, init),
  officeProbe: OfficeProbeOptions = {},
  sudoPath?: string,
  rescue: RescueSeams = {},
): ExecutorDeps {
  const handlers = new Map<string, RouteHandler>();
  // The storage planners and appliers, shared by the storage routes and the
  // action asks. An apply may be the change a step ask waits for.
  const storage = createStorageOps(stepsChanged);
  const preconditions = new Map<RoutePrecondition, PreconditionFn>();
  const register = (hs: Record<string, RouteHandler>): void => {
    for (const [opId, handler] of Object.entries(hs)) {
      handlers.set(opId, handler);
    }
  };

  register(agentReferenceHandlers());
  register(
    enterpriseSeatsHandlers({
      seats: () => {
        if (!enterpriseSeats) throw new Error("enterprise seats not started");
        return enterpriseSeats;
      },
    }),
  );
  register(
    rescueHandlers({
      lockdown: {
        stateRoot: STATE_ROOT,
        closeSockets: closeOfficeSockets,
        audit: ({ actor, reason }) =>
          recordAudit({
            actor,
            operation: "office.lockdown",
            targets: ["office"],
            fields: [],
            lockdown: { reason },
          }),
        requestStop:
          rescue.requestStop ??
          (() =>
            console.log(
              "[lockdown] locked; no stop wired in this process (harness)",
            )),
        now: () => new Date(),
      },
      exports: (officeExportJobs = createOfficeExportJobs({
        stateRoot: STATE_ROOT,
        baseDir: () => rescue.exportBaseDir ?? currentBackupDir(),
        spawnChild: rescue.spawnExportChild ?? spawnExportChildProcess,
        now: () => Date.now(),
      })),
      byName: lockdownByName,
    }),
  );
  register(
    agentDirectoryHandlers({
      originAllowed: checkOrigin,
      roomIdsFor: (identity) => {
        const user = identity.userId ? getUserById(identity.userId) : null;
        if (!user) return new Set<string>();
        return limitToTokenRooms(identity, accessibleRoomIdsFor(user));
      },
      isLobbyRoom: (roomId) => agentManager.roomById(roomId)?.type === "lobby",
      liveManifest: () => agentManager.getManifest(),
      killedAgents: () => agentManager.getKilledAgentSummaries(),
      killedAgentsForManager: (userId) =>
        agentManager.getKilledAgentSummariesForManager(userId),
    }),
  );
  register(
    agentAvatarHandlers({
      outfitOf: (agentId) => agentManager.getAgent(agentId)?.outfit ?? null,
    }),
  );
  register(
    appSignInHandlers({
      mint: (req, url, session) =>
        handleAppMintRequest(req, url, session, {
          appHostDomain: appHostDomain(),
          canAccess: canUserAccessApp,
        }),
    }),
  );
  register(auditHandlers(officeAuditStore));
  register(
    githubSyncHandlers({
      // Read at request time: createManagers makes a new store on each boot.
      links: () => githubLinks,
      roomExists: (roomId) => !!agentManager.roomById(roomId),
      userIdOf: (identity) => identity.userId,
      linked: stepsChanged,
    }),
  );
  register(terminalRecordingHandlers());

  register(
    tasksHandlers({
      history: (id, before) =>
        officeAuditStore().list({ targetId: id, before }, true),
      deletedTask: (id) =>
        officeAuditStore().list({
          targetId: id,
          operation: "tasks.delete",
          limit: 1,
        }).items[0]?.deletedTask ?? null,
      restoreTask: (task) => agentManager.restoreTask(task),
      // The GitHub block is the sync's: a restored task takes the issue's
      // state now, and the detail carries the issue text in its wrapper.
      refreshExternal: (task) => {
        if (!task.external) return task;
        const row = githubLinks.getIssue(
          task.external.repo,
          task.external.number,
        );
        return row
          ? {
              ...task,
              external: {
                ...task.external,
                state: row.state,
                stateReason: row.stateReason,
              },
            }
          : task;
      },
      externalDetail: (task) => {
        const external = task.external!;
        const key = external.repo.toLowerCase();
        const row = githubLinks.getIssue(external.repo, external.number);
        return {
          ...external,
          syncing: githubLinks
            .list()
            .some((link) => link.repo.toLowerCase() === key),
          ...(row ? { issue: formatIssueData(row) } : {}),
        };
      },
      listTasks: () => agentManager.getTasks(),
      liveAgents: () => agentManager.getAllAgents(),
      createTask: ({
        title,
        createdBy,
        createdByAgentId,
        limited,
        username,
        description,
        priority,
        assignee,
        roomId,
      }) =>
        agentManager.addTask(title, createdBy, {
          description,
          priority,
          assignee,
          username,
          roomId,
          createdByAgentId,
          limited,
        }),
      updateTask: (id, changes) => agentManager.updateTask(id, changes),
      deleteTask: (id) => agentManager.deleteTask(id),
      attributionFor,
      accessibleRoomIds: boardRoomIdsForIdentity,
      taskViewer: taskViewerForIdentity,
      defaultCreateRoomId: defaultCreateRoomIdForIdentity,
    }),
  );

  register(
    pagerHandlers({
      asks: askStore!,
      history: officeAskHistory(),
      audience: askAudience,
      compat: pagerCompat,
      accessibleRoomIds: accessibleRoomIdsForIdentity,
      agentSource: (agentId) => {
        const agent = agentManager.getAgent(agentId);
        return agent
          ? {
              managerUserId: agent.userId ?? null,
              sessionId: agentManager.getCurrentSessionId(agentId),
            }
          : null;
      },
      appSource: (appName) => {
        const app = appRegistry.get(appName);
        return app
          ? {
              createdAt: app.createdAt,
              ownerUserId: app.userId,
              targetAgentId:
                app.messageTargetAgentId ?? app.createdByAgentId ?? null,
            }
          : null;
      },
    }),
  );

  // Step asks (task c71cb60f): each predicate reads the state as it is now.
  stepAsks = createStepAsks({
    asks: askStore!,
    isOfficeOwner: (userId) => askAudience.isOfficeOwner(userId),
    providerConnected: async (userId, provider, scope) =>
      (await providerAccountManager.list(userId)).some(
        (account) =>
          account.provider === provider &&
          account.scope === scope &&
          account.accountStatus === "connected",
      ),
    mcpServer: (scope, name) => {
      const server = mcpSources.servers
        .list(scope)
        .find((row) => row.name === name);
      return server
        ? { oauth: server.oauth !== null, signedIn: !!server.oauth?.signedIn }
        : null;
    },
    browserPaired: (userId) => !!extensionService?.store.paired(userId),
    roomLinked: (roomId) => githubLinks.get(roomId) !== null,
    settled: (agentId, askId, line, memberUserId) =>
      agentManager.emitAgentStepAskDone(agentId, askId, line, memberUserId),
    // Action steps (task e3d1bc63).
    runs: officeStepRuns({
      guardDeps: buildLiveGuardDeps,
      officeSettings: officeSettingsNow,
      accessibleRoomIdsFor,
      accessChangeRefusal,
      officeAccess: () => computeAccessSettings(installKind),
      tokenLimitableRoomIds,
      storage,
    }),
  });
  register(
    askHandlers({
      store: askStore!,
      sudoRunInProgress: (agentId) =>
        sudoRequests?.runInProgress(agentId) ?? false,
      history: officeAskHistory(),
      steps: stepAsks,
      stepRuns: {
        routeOf: (step, memberUserId, callerSessionIdHash) =>
          stepAsks!.routeOf(step, memberUserId, callerSessionIdHash),
        dispatch: (identity, route, opts) =>
          dispatchInProcess(identity, route.method, route.path, route.body, {
            via: "ask",
            ...opts,
          }),
      },
      agent: (agentId) => {
        const agent = agentManager.getAgent(agentId);
        return agent
          ? {
              roomId: agent.roomId,
              managerUserId: agent.userId ?? null,
              sessionId: agentManager.getCurrentSessionId(agentId),
            }
          : null;
      },
      app: (appName) => {
        const app = appRegistry.get(appName);
        return app
          ? {
              createdAt: app.createdAt,
              ownerUserId: app.userId,
              targetAgentId:
                app.messageTargetAgentId ?? app.createdByAgentId ?? null,
            }
          : null;
      },
      memberByName: (name) => {
        const user = getUserByName(name);
        return user ? { id: user.id, name: user.name } : null;
      },
      memberName: (userId) => getUserById(userId)?.name ?? null,
      memberCanSeeRoom: askAudience.canSeeRoom,
      memberRoomHidden: askAudience.roomHidden,
      roomMemberIds: askAudience.roomMemberIds,
      // The terminal panel's gate (terminalAllowed), then the agent's access.
      commandRuns: {
        refusal: (identity, agentId) => {
          const agent = agentManager.getAgent(agentId);
          const user = identity.userId ? getUserById(identity.userId) : null;
          if (
            !agent ||
            !user ||
            user.pack ||
            !buildLiveGuardDeps().hasRoomAccess(identity, agent.roomId)
          )
            return "terminal_forbidden";
          return belowStandard(agentAccessOf(agent)) ? "agent_limited" : null;
        },
        start: (agentId, command) =>
          agentManager.runAskCommand(agentId, command),
        notify: (agentId, text, from) =>
          agentManager.emitAgentAskRunReport(
            agentId,
            from.askId,
            from.line,
            from.memberUserId,
            text,
          ),
        now: () => Date.now(),
      },
      recordMemberHeardFrom: (userId, agentId) =>
        agentManager.recordMemberHeardFrom(userId, agentId),
      isOfficeOwner: askAudience.isOfficeOwner,
      canReadAgentLogs: (identity, agentId) =>
        logSearchAccess({
          identity,
          params: { id: agentId },
          deps: buildLiveGuardDeps(),
        }).ok,
      affordances: {
        checkCommand: checkTerminalCommand,
        probeEditFile: (agentId, rawPath) => {
          const agent = agentManager.getAgent(agentId);
          return agent ? probeEditFile(rawPath, agent.cwd) : null;
        },
        probeReadFile: (agentId, rawPath, opts) => {
          const agent = agentManager.getAgent(agentId);
          return agent ? probeReadFile(rawPath, agent.cwd, opts) : null;
        },
        copyReadFile: (agentId, absPath) =>
          agentManager.copyAskReadFile(agentId, absPath),
      },
      filePath: (agentId, filename) => getFilePath(agentId, filename),
      contentTypeFor: (filename) => httpContentTypeForFilename(filename),
      untrustedFileHeaders,
      deliver: deliverAskAnswer,
      agentName: (agentId) => agentManager.getAgent(agentId)?.name ?? null,
      createTask: ({
        title,
        description,
        createdBy,
        username,
        roomId,
        priority,
        limited,
      }) =>
        agentManager.addTask(title, createdBy, {
          description,
          username,
          roomId,
          priority,
          ...(limited ? { limited } : {}),
        }),
      deleteTask: (id) => agentManager.deleteTask(id),
      attributionFor,
      messaging: messagingReplies,
    }),
  );

  register(
    voiceHandlers({
      keyFor: (userId) => voiceKeyForUserId(userId),
      fetch: (input, init) => fetch(input, init),
    }),
  );

  register(
    whatsappHandlers({
      supervisor: whatsappSupervisor,
      routes: whatsappRoutes,
    }),
  );

  register(messagingHandlers({ replies: messagingReplies }));

  register(
    discordHandlers({ supervisor: discordSupervisor, routes: discordRoutes }),
  );

  register(
    integrationChangesHandlers({
      memberChanges: (query) => officeAuditStore().memberChanges(query),
      userName: (userId) => getUserById(userId)?.name ?? null,
    }),
  );

  register(
    pagerSettingsHandlers({
      settings: pagerSettings,
      userIdForUsername: (username) =>
        buildLiveGuardDeps().userIdForUsername(username),
      rescheduleMember: (userId) => {
        pagerDelivery.rescheduleMember(userId);
        webPushDelivery.rescheduleMember(userId);
      },
      sendTest: (userId) => pagerDelivery.sendTest(userId),
    }),
  );

  register(
    pushDevicesHandlers({
      store: webPushStore,
      sendTest: (userId, deviceId) =>
        webPushDelivery.sendTest(userId, deviceId),
    }),
  );

  register(
    appWidgetHandlers({
      get: (name) => appRegistry.get(name),
      registration: appRegistrationGeneration,
      canAccess: canUserAccessApp,
      appUrl: (app) => appPublicUrl(app.hostLabel, appHostDomain()),
      sessionExpiresAt: appSessionExpiresAt,
      chat: (app, identity) => {
        const targetId = app.messageTargetAgentId ?? app.createdByAgentId;
        const target = targetId ? agentManager.getAgent(targetId) : null;
        if (
          !target ||
          !buildLiveGuardDeps().hasRoomAccess(identity, target.roomId)
        )
          return null;
        return {
          agentId: target.id,
          agentName: target.name,
          sessionId: agentManager.getCurrentSessionId(target.id),
        };
      },
      metadata: (app) =>
        readWidgetMetadata({
          app,
          host: new URL(appPublicUrl(app.hostLabel, appHostDomain())!).host,
          apps: appRegistry.list(),
          supervisor: appSupervisor,
          proxySecret: () => productionAppProxySecret(app),
        }),
      revision: appFilesRevision,
      serving: (app) => {
        let running = false;
        try {
          running =
            appSupervisor.states([app.name]).get(app.name)?.state === "running";
        } catch {
          // An unreadable supervisor is not serving.
        }
        return appServing(app, running);
      },
    }),
  );

  // Apps (agent-built web apps). Ownership + attribution come from the token:
  // the app belongs to the caller's USER so it outlives the agent that built
  // it. Registry errors (including a corrupt or unwritable registry) surface as
  // themselves - nothing here converts a failure into a success or an empty
  // list.
  register(
    appsHandlers({
      appHostingUnsupportedReason: appHostingUnsupported,
      list: () => appRegistry.list(),
      get: (name) => appRegistry.get(name),
      register: (input) => appRegistry.register(input),
      folderRefusal: (cwd) =>
        folderOverlapRefusal(cwd, null, folderRuleState()),
      remove: (name) => appRegistry.remove(name),
      update: (name, patch) => appRegistry.update(name, patch),
      resolveMessageTarget: (ownerUserId, agentId, identity) => {
        if (!isSafeScopeId(agentId)) return "invalid_id";
        const owner = ownerUserId ? getUserById(ownerUserId) : null;
        const target = agentManager.getAgent(agentId);
        if (!owner || !target) return "unavailable";
        if (
          tokenRooms(identity) !== null &&
          !buildLiveGuardDeps().hasRoomAccess(identity, target.roomId)
        )
          return "unavailable";
        return accessibleRoomIdsFor(owner).has(target.roomId)
          ? "ok"
          : "unavailable";
      },
      isPrivilegedAgent: (agentId) =>
        agentManager.getAgent(agentId)?.privileged === true,
      resolveCreator: (identity, ownerUserId, agentId) => {
        if (!isSafeScopeId(agentId)) return "invalid_id";
        const owner = ownerUserId ? getUserById(ownerUserId) : null;
        const target = agentManager.getAgent(agentId);
        if (
          !owner ||
          !target ||
          !accessibleRoomIdsFor(owner).has(target.roomId) ||
          !buildLiveGuardDeps().hasRoomAccess(identity, target.roomId)
        )
          return "unavailable";
        return { id: target.id, name: target.name };
      },
      // The token and its environment file, written together. A failure to
      // write the file takes the hash back, so an app either has a usable
      // token or has none - never a hash whose plaintext was lost, which is
      // unrepairable (isomux cannot reproduce a token it does not keep).
      provisionToken: (record) => {
        let minted: string;
        try {
          minted = appTokens.mint(record.name, record.userId);
        } catch (err) {
          console.error(`[apps] "${record.name}" got no token:`, err);
          return false;
        }
        try {
          appSupervisor.provisionToken(record.name, minted);
          return true;
        } catch (err) {
          console.error(
            `[apps] "${record.name}" token could not be delivered, revoking it:`,
            err,
          );
          try {
            appTokens.revoke(record.name);
          } catch (revokeErr) {
            console.error(
              `[apps] "${record.name}" token could not be revoked either:`,
              revokeErr,
            );
          }
          return false;
        }
      },
      syncAppSecrets: () => appSecrets.syncNow(),
      revokeToken: (name) => appTokens.revoke(name),
      retireRegistration: (app) => retireAppRegistration(app),
      invalidateRegistration: (app) =>
        invalidateAppRegistration(
          app.hostLabel,
          appRegistrationGeneration(app),
        ),
      // The app-to-agent message. The SENDER is constructed here from the app
      // name the token resolved to - the same rule the inter-agent branch
      // follows above, and for the same reason: a body-trusted sender is an
      // identity spoof and a prefix-injection vector into the receiver's prompt.
      // No steer option is passed or accepted; an app cannot interrupt a turn.
      sendAsApp: async (appName, targetAgentId, text) => {
        await agentManager.prepareEnqueue(targetAgentId);
        const result = agentManager.enqueueMessage(targetAgentId, {
          sender: { kind: "app", appName },
          text,
        });
        if (result.ok)
          return {
            ok: true,
            messageId: result.messageId,
            ...(result.deduped ? {} : { queued: result.queued }),
          };
        return enqueueFailure(result);
      },
      limiter: appMessageLimiter,
      publicUrl: (app) => appPublicUrl(app.hostLabel, appHostDomain()),
      shortUrl: (app) =>
        appShortUrl(
          app,
          appPublicUrl(app.hostLabel, appHostDomain()),
          buildPublicOrigin().origin,
        ),
      canAccess: canUserAccessApp,
      registrationGeneration: appRegistrationGeneration,
      thumbnails: appThumbnailStore,
      resolveAgentPath: (agentId, rawPath) =>
        agentManager.resolveEditorPathForAgent(agentId, rawPath),
      readThumbnailFile: readCappedFile,
      now: () => Date.now(),
      install: (record) => appSupervisor.install(record),
      // Each verb that runs a new process moves the widget's revision, so an
      // open app frame reloads after the turn (task d7ac4f73). A member's app
      // runs only while their pack has apps write.
      reinstall: (record) => {
        refuseAppOfPackWithoutApps(record.name);
        appSupervisor.reinstall(record);
        appProcessStarted(record.name);
      },
      teardown: (name) => appSupervisor.teardown(name),
      start: (name) => {
        refuseAppOfPackWithoutApps(name);
        appSupervisor.start(name);
        appProcessStarted(name);
      },
      stop: (name) => appSupervisor.stop(name),
      restart: (name) => {
        refuseAppOfPackWithoutApps(name);
        appSupervisor.restart(name);
        appProcessStarted(name);
      },
      states: (names) => appSupervisor.states(names),
      provablyNotRunning: (name) => appSupervisor.provablyNotRunning(name),
      logs: (name, lines) => appSupervisor.logs(name, lines),
      // An app that logs its request headers logs its proxy secret too.
      secretScrubPatterns: () =>
        scrubPatterns([
          ...vaultValues(),
          ...appProxySecretsOf(appRegistry.list(), productionAppProxySecret),
        ]),
      forgetSecrets: (record) => {
        secretStore.dropApp({ name: record.name, createdAt: record.createdAt });
        appSecrets.syncNow();
      },
      attributionFor,
      validateCwd: (cwd) => {
        try {
          return { ok: true, resolved: agentManager.validateCwd(cwd) };
        } catch (err) {
          return { ok: false, error: errMessage(err, "Invalid directory") };
        }
      },
      projectForList: (identity, record, ownerWire) => {
        const visibility = appVisibilityFacts(record);
        const viewer = appViewerFacts(identity, visibility);
        if (!appVisibleTo(visibility, viewer)) return null;
        if (
          viewer.isOfficeOwner ||
          (viewer.userId !== null && viewer.userId === record.userId)
        ) {
          return { ...ownerWire, canManage: true };
        }
        return viewerAppWire(ownerWire);
      },
      announce: (wire, before) => {
        if (before && before.createdByAgentId !== wire.createdByAgentId) {
          announceAppAudienceChanges(
            new Map([[wire.name, appVisibilityFacts(before)]]),
          );
          // Also update viewers who retain access: their app moved rooms too.
        }
        const visibility = appVisibilityFacts(wire);
        pushAppDeltaToEachWs({
          kind: "upserted",
          ownerApp: { ...wire, canManage: true },
          viewerApp: viewerAppWire(wire),
          visibility,
        });
      },
      announceRemoved: (app) =>
        pushAppDeltaToEachWs({
          kind: "deleted",
          name: app.name,
          visibility: appVisibilityFacts(app),
        }),
    }),
  );

  // Webhooks (internal-docs/webhooks-design.md). Ownership and attribution
  // come from the token, as for apps. The target check reads live agents,
  // rooms and cronjobs, so it is a precondition and not a guard.
  register(
    webhooksHandlers({
      registry: webhookRegistry,
      attributionFor,
      visibleTo: (identity, record) =>
        webhookVisibleTo(webhookFacts(record), webhookViewerFor(identity)),
      publicOrigin: () => buildPublicOrigin().origin,
      counters: (id) => currentWebhookIngress().counters(id),
      forget: (id) => currentWebhookIngress().forget(id),
      announce: (wire, before) =>
        pushWebhookDeltaToEachWs({
          kind: "upserted",
          webhook: wire,
          facts: webhookFacts(wire),
          before: before === null ? null : webhookFacts(before),
        }),
      announceRemoved: (record) =>
        pushWebhookDeltaToEachWs({
          kind: "deleted",
          id: record.id,
          before: webhookFacts(record),
        }),
    }),
  );
  preconditions.set(
    "webhookTargetAllowed",
    webhookTargetPrecondition({
      get: (id) => webhookRegistry.get(id),
      agentReachableByUser: webhookAgentReachable,
      callerReachesAgent,
      cronjobExists: (cronjobId) =>
        cronjobManager.listCronjobs().some((job) => job.id === cronjobId),
      // An ordinary agent's own job must also still be within its limits,
      // as for its Run now.
      callerManagesCronjob: (identity, cronjobId) => {
        const manages = cronjobOwnerOrOfficeOwner("id")({
          identity,
          params: { id: cronjobId },
          deps: buildLiveGuardDeps(),
        }).ok;
        if (!manages || !cronOwnOnly(identity)) return manages;
        const job = cronjobManager
          .listCronjobs()
          .find((c) => c.id === cronjobId);
        const limits = ownScheduleLimitsFor(identity);
        return !!job && !!limits && scheduleExceedsAgent(job, limits) === null;
      },
      userMayRunCronjob: (userId, cronjobId) =>
        webhookCronjobRunnable(userId, cronjobId) === "ok",
    }),
  );

  // Memory (isomux-memory). Author + date are server-stamped from the token
  // (authorFor); scopeId is a target selector, not authority. Access follows
  // the rooms through the guard deps. A write whose caller record can't be
  // resolved fails 404 rather than being stamped "unknown".
  // Agent memory writes follow agents.setInstructions (Nil, 2026-11-05).
  const setAgentInstructionsRoute = API_ROUTES.find(
    (r) => r.opId === "agents.setInstructions",
  );
  if (!setAgentInstructionsRoute)
    throw new Error("agents.setInstructions is missing from API_ROUTES");
  register(
    memoryHandlers({
      hasRoomAccess: (identity, roomId) =>
        buildLiveGuardDeps().hasRoomAccess(identity, roomId),
      sharesRoomWithMember: (identity, userId) =>
        sharesRoomWithMember(identity, userId, buildLiveGuardDeps()),
      hasOfficeOwnerReach: (identity) =>
        hasOfficeOwnerReach(identity, buildLiveGuardDeps()),
      editsAgentInstructions: (identity, agentId) =>
        authorizeRoute(
          setAgentInstructionsRoute,
          identity,
          { id: agentId },
          undefined,
          buildLiveGuardDeps(),
        ) === null,
      agentRoomId: (agentId) => agentManager.getAgent(agentId)?.roomId ?? null,
      read: (scope, scopeId) => memoryStore.read(scope, scopeId),
      append: (input) => memoryStore.append(input),
      replace: (input) => memoryStore.replace(input),
      findDuplicate: (scope, scopeId, text) =>
        memoryStore.findDuplicate(scope, scopeId, text),
      authorFor: (identity) => {
        if (identity.scope === "agent" && identity.agentId) {
          const d = agentManager.getAgentDisplay(identity.agentId);
          return d ? d.name : null;
        }
        if (identity.scope === "app")
          return identity.appName ? appActorName(identity.appName) : null;
        if (identity.userId) {
          const u = getUserById(identity.userId);
          return u ? u.name : null;
        }
        return null;
      },
      isSafeScopeId,
      // Existence checks; room and member names are the ones the auto-load
      // labels use.
      roomName: (roomId) =>
        agentManager.getOrdinaryRooms().find((r) => r.id === roomId)?.name ??
        null,
      agentName: (agentId) =>
        agentManager.getAgentDisplay(agentId)?.name ?? null,
      userName: (userId) => getUserById(userId)?.name ?? null,
    }),
  );

  // Cronjob mutation is restricted to its owner or an office owner.
  register(
    cronHandlers({
      listCronjobs: () => cronjobManager.listCronjobs(),
      listCronjobsFor: (identity) => cronjobsFor(cronjobViewerFor(identity)),
      projectCronjobFor: (identity, job) =>
        projectCronjobFor(job, cronjobViewerFor(identity)),
      visibleTo: (identity, jobId) =>
        cronjobVisibleTo(cronjobFactsById(jobId), cronjobViewerFor(identity)),
      // Live ordinary rooms the caller can access: a member's grants can name
      // a room that has since closed.
      assignableRoomIds: (identity) => {
        const accessible = accessibleRoomIdsForIdentity(identity);
        return new Set(
          agentManager
            .getOrdinaryRooms()
            .map((room) => room.id)
            .filter((id) => accessible.has(id)),
        );
      },
      defaultCreateRoomId: defaultCreateRoomIdForIdentity,
      memberWithPack: (userId) => {
        const user = getUserById(userId);
        return user?.role === "member" && user.pack
          ? { id: user.id, name: user.name }
          : null;
      },
      // The webhook rule: the job owner reaches the agent's room, and a
      // room-limited token reaches it too.
      agentTargetReachable: (identity, ownerUserId, agentId) =>
        webhookAgentReachable(ownerUserId, agentId) === "ok" &&
        callerReachesAgent(identity, agentId),
      ownScheduleLimits: ownScheduleLimitsFor,
      // The job runs for its maker: their special instructions follow the
      // member read rule, not the job's audience (hidesManagerData).
      buildCronjobSystemPrompt: (cronjob, caller) =>
        cronjobManager.buildCronjobSystemPrompt(
          cronjob,
          undefined,
          undefined,
          undefined,
          hidesManagerData(
            cronjob.userId ?? getUserByName(cronjob.username)?.id,
            (userId) =>
              sharesRoomWithMember(caller, userId, buildLiveGuardDeps()),
          ),
        ),
      // A Codex job with no model, made or switched to Codex, takes its
      // owner's login default, as a new Codex agent does.
      createCronjob: async (input) =>
        cronjobManager.addCronjob({
          ...input,
          agentType: input.agentType ?? "claude",
          modelFamily:
            input.agentType === "codex" && !input.modelFamily && input.userId
              ? await resolveCodexDefaultModel(input.userId, input.cwd)
              : input.modelFamily,
          // Every caller that can create (a user, an API token, an agent)
          // resolves a member; the fallback only satisfies the
          // definite-string contract.
          username: input.username ?? "unknown",
        }),
      updateCronjob: async (id, changes) => {
        const existing = cronjobManager
          .listCronjobs()
          .find((cronjob) => cronjob.id === id);
        if (
          changes.agentType === "codex" &&
          !changes.modelFamily &&
          existing &&
          existing.agentType !== "codex" &&
          existing.userId
        ) {
          changes = {
            ...changes,
            modelFamily: await resolveCodexDefaultModel(
              existing.userId,
              changes.cwd ?? existing.cwd,
            ),
          };
        }
        return cronjobManager.updateCronjob(id, changes);
      },
      deleteCronjob: (id) => cronjobManager.deleteCronjob(id),
      getPrompt: () => cronjobManager.getCronjobsPrompt(),
      setPrompt: (value) => cronjobManager.setCronjobsPrompt(value),
      runNow: (id, username) => cronjobManager.runCronjobNow(id, username),
      runsForCronjob: (jobId) => cronjobManager.getRunsForCronjob(jobId),
      allRunsByJob: () => cronjobManager.getAllRunsByJob(),
      runTranscript: (jobId, runId) =>
        cronjobManager.getRunTranscript(jobId, runId),
      // Run-message + RUN-affordance core ops. sendRunMessage resolves on
      // acceptance (the user_message is in the run log) or refusal, never on
      // the turn. editRunMessage is fire-and-forget: void-discard the
      // manager's background promise, so the HTTP response never blocks on
      // the fork. The handler threads a messageId override so the persisted
      // user_message entry id === the route ack.
      findRun: (jobId, runId) => cronjobManager.findRun(jobId, runId),
      sendRunMessage: (jobId, runId, text, username, device, opts) =>
        cronjobManager.sendRunMessage(
          jobId,
          runId,
          text,
          username,
          device,
          opts,
        ),
      editRunMessage: (
        jobId,
        runId,
        logEntryId,
        newText,
        username,
        device,
        opts,
      ) => {
        void cronjobManager.editRunMessage(
          jobId,
          runId,
          logEntryId,
          newText,
          username,
          device,
          opts,
        );
      },
      emitCronjobRunReadFile: (jobId, runId, path) =>
        cronjobManager.emitCronjobRunReadFile(jobId, runId, path),
      emitCronjobRunDiff: (jobId, runId, dir, commit) =>
        cronjobManager.emitCronjobRunDiff(jobId, runId, dir, commit),
      attributionFor,
      validateCwd: (cwd) => {
        try {
          agentManager.validateCwd(cwd);
          return null;
        } catch (err) {
          return errMessage(err, "Invalid directory");
        }
      },
      folderRefusal: (cwd) =>
        folderOverlapRefusal(resolveCwd(cwd), null, folderRuleState()),
      modelFamilyError: modelFamilyMismatchError,
      saveRecentCwd,
    }),
  );

  // Agent self-affordances (AGENT bearer; read-file / diff / edit-file /
  // terminal-command / preview-url / browser on the agent's OWN chat). Slim deps: just the
  // manager emit ops. The manager emits room-ACL-projected log_entry via the
  // event sink; handlers never emit. These /api routes are the SOLE affordance
  // surface now - the legacy loopback /agents/:id/* affordance handlers were
  // deleted in the loopback-bypass removal milestone.
  register(
    agentAffordanceHandlers({
      emitAgentReadFile: (agentId, path) =>
        agentManager.emitAgentReadFile(agentId, path),
      emitAgentDiff: (agentId, dir, commit) =>
        agentManager.emitAgentDiff(agentId, dir, commit),
      emitAgentEditRequest: (agentId, path, opts) =>
        agentManager.emitAgentEditRequest(agentId, path, opts),
      emitAgentTerminalCommand: (agentId, command, opts) =>
        agentManager.emitAgentTerminalCommand(agentId, command, opts),
      emitAgentPreviewUrl: (agentId, body, identity) =>
        agentManager.emitAgentPreviewUrl(agentId, body, (url, expiresAt) =>
          previewAppGrant(url, expiresAt, {
            domain: appHostDomain(),
            apps: () => appRegistry.list(),
            agentId,
            mayOpen: (app) => agentMayOpenApp(identity, agentId, app),
          }),
        ),
      runAgentBrowserAction: (agentId, body) =>
        agentManager.runAgentBrowserAction(agentId, body),
      getAgentContextUsage: (agentId) =>
        agentManager.getAgentContextUsage(agentId),
      getAgentSubscriptionUsage: (agentId) =>
        agentManager.getAgentSubscriptionUsage(agentId),
    }),
  );

  // Conversation-log search + retrieval. The index and retrieval modes read
  // straight through the shared file source here; SEARCH mode goes out to a
  // killable child process (log-search-runner.ts),
  // which is both the ReDoS guard for caller-supplied regexes and what keeps an
  // all-session scan off the single process that serves the whole office.
  register(
    logsHandlers({
      listSessionIds: (agentId) =>
        officeLogSource
          .listSessions(agentId)
          .then((ss) => ss.map((s) => s.sessionId)),
      sessionIndex: (agentId, opts) =>
        buildSessionIndex(officeLogSource, agentId, opts),
      retrieveSession: (agentId, sessionId, query) =>
        retrieveSession(officeLogSource, agentId, sessionId, query),
      search: (callerKey, agentId, query) =>
        runSearchInChild(callerKey, agentId, query),
      pendingPrompt: (agentId) => agentManager.pendingPrompt(agentId),
      inFlightTurn: (agentId) => agentManager.inFlightTurnForLogs(agentId),
    }),
  );

  // Terminal output read (agents.terminal): the in-memory PTY buffer only.
  register(
    terminalReadHandlers({
      readTerminal: (agentId) => agentManager.readTerminal(agentId),
    }),
  );

  // The caller's own per-skill use counters drive the Sk-menu sort. Read-only;
  // increments live at the slash-command dispatch site in command-handlers.ts.
  register(
    skillUsageHandlers({
      countsFor: (userId) => getSkillUseCounts(userId),
    }),
  );

  // The skills page: the caller's catalog (their user roots, project skills of
  // agents in rooms they can access) and the listed SKILL.md files.
  const skillContextsFor = (identity: Identity) => {
    const rooms = accessibleRoomIdsForIdentity(identity);
    return agentManager.skillEngineContexts(identity.userId ?? null, (info) =>
      rooms.has(info.roomId),
    );
  };
  const skillCatalogFor = (identity: Identity) => {
    const userId = identity.userId ?? null;
    return buildSkillCatalog(
      skillContextsFor(identity),
      userId ? getSkillUseCounts(userId) : {},
      agentManager.newSkillDir(),
      homedir(),
    );
  };
  register(
    skillsHandlers({
      catalogFor: skillCatalogFor,
      readFile: readSkillFile,
      saveFile: saveSkillFile,
      deleteFile: (entry, rev, identity) =>
        deleteSkillFile(entry, rev, skillContextsFor(identity)),
      createSkill,
      refreshMenus: () => agentManager.refreshSkillMenus(),
    }),
  );

  // Chat uploads + file-serving (agents.* and chatFiles.*; room-ACL gated).
  // Narrow deps: just the persistence helpers (the guards own access,
  // getFilePath owns path-traversal).
  register(
    uploadsHandlers({
      saveFile: (agentId, data, mediaType, originalName) =>
        saveFile(agentId, data, mediaType, originalName),
      getFilePath: (agentId, filename) => getFilePath(agentId, filename),
      contentTypeFor: (filename) => httpContentTypeForFilename(filename),
      untrustedFileHeaders,
    }),
  );

  // Members chat: the author snapshot is token-derived here, never from the
  // body.
  const membersChatAuthorFor = (
    identity: Identity,
  ): MembersChatAuthor | null => {
    if (!identity.userId) return null;
    const user = getUserById(identity.userId);
    if (!user) return null;
    if (identity.scope === "agent" && identity.agentId) {
      const display = agentManager.getAgentDisplay(identity.agentId);
      if (!display) return null;
      return { kind: "agent", userId: user.id, userName: display.name };
    }
    if (identity.scope === "api") {
      return {
        kind: "api",
        userId: user.id,
        userName: user.name,
        ...(identity.apiTokenName ? { device: identity.apiTokenName } : {}),
      };
    }
    return { kind: "user", userId: user.id, userName: user.name };
  };
  register(
    membersChatHandlers({
      setPinned: (id, active) => membersChat.setPinned(id, active),
      page: (opts) => membersChat.page(opts),
      post: (input) => membersChat.post(input),
      edit: (id, content) => membersChat.edit(id, content),
      setThumbsUp: (id, reactor, active) =>
        membersChat.setThumbsUp(id, reactor, active),
      delete: (id) => membersChat.delete(id),
      get: (id) => membersChat.get(id),
      getReadPointer: (userId) => membersChat.getReadPointer(userId),
      setReadPointer: (userId, lastReadId) =>
        membersChat.setReadPointer(userId, lastReadId),
      unreadCount: (userId) => membersChat.unreadCount(userId),
      saveAttachment: (data, mediaType, originalName) =>
        membersChat.saveAttachment(data, mediaType, originalName),
      attachmentPath: (filename) => membersChat.attachmentPath(filename),
      contentTypeFor: (filename) => httpContentTypeForFilename(filename),
      untrustedFileHeaders,
      authorFor: membersChatAuthorFor,
      isOwner: (identity) =>
        hasOfficeOwnerReach(identity, buildLiveGuardDeps()),
      emitMessage: (message, updateOnly) =>
        liveEmit("members_chat_message", {
          message,
          ...(updateOnly ? { updateOnly } : {}),
        }),
      emitDeleted: (id) => liveEmit("members_chat_deleted", { id }),
      emitRead: (userId, readPointer, unread) =>
        liveEmit("members_chat_read", { readPointer, unread }, { userId }),
    }),
  );

  const officeNames = createOfficeNameCache({
    probe: (origin) => probeOffice(origin, officeProbe),
  });
  register(
    floorsHandlers({
      list: () => floors.list(),
      add: (url, name) => floors.add(url, name),
      remove: (id) => floors.remove(id),
      probe: (origin) => probeOffice(origin, officeProbe),
      lookupName: (origin, callerKey) => officeNames.lookup(origin, callerKey),
      emitFloors: (list) => liveEmit("floors_updated", { floors: list }),
    }),
  );

  register(
    createInvitesRoutes({
      attributionFor,
      emitInvitesList,
      liveEmit,
      scopedInvitesFor,
    }),
  );

  // inviteOwnerOrSelf is the FIRST precondition enforcer. Owner (record
  // role) may revoke any invite; a member only one bound to their own name.
  // NON-LEAKING: a foreign prefix AND a nonexistent prefix BOTH return the same
  // 403 envelope (no exists-but-hidden distinction). The revoke dep then
  // re-checks atomically via revokeOutstandingInviteByPrefixForUser.
  preconditions.set("inviteOwnerOrSelf", (ctx) => {
    const u = ctx.identity.userId
      ? getUserById(ctx.identity.userId)
      : undefined;
    if (!u) return fail(403, "forbidden");
    if (u.role === "owner") return null;
    const owns = listInvitesForUser(u).some(
      (i) => i.tokenPrefix === ctx.params.tokenPrefix,
    );
    return owns ? null : fail(403, "forbidden");
  });

  register(createSessionsRoutes({ liveEmit, scopedSessionsFor }));

  // sessionOwnerOrSelf: owner (record role) may revoke any session; a
  // member only one bound to their own stable userId. NON-LEAKING: foreign AND
  // nonexistent prefixes BOTH return the same 403 (mirrors inviteOwnerOrSelf).
  preconditions.set("sessionOwnerOrSelf", (ctx) => {
    const u = ctx.identity.userId
      ? getUserById(ctx.identity.userId)
      : undefined;
    if (!u) return fail(403, "forbidden");
    if (u.role === "owner") return null;
    const owns = listActiveSessionsForUserId(u.id).some(
      (s) => s.sessionPrefix === ctx.params.sessionPrefix,
    );
    return owns ? null : fail(403, "forbidden");
  });

  // Access settings are owner-only; successful enables mint an owner invite.
  register(
    accessHandlers({
      getAccess: () => computeAccessSettings(installKind),
      setAccess: async ({ externalAccess, publicOrigin, identity }) => {
        const r = await applyAccessSettings(
          externalAccess,
          publicOrigin,
          identity.userId,
          installKind,
        );
        if (r.ok) stepsChanged();
        return r.ok
          ? {
              ok: true,
              signInUrl: r.signInUrl,
              restartRequired: r.restartRequired,
            }
          : { ok: false, status: r.status, error: r.error, code: r.code };
      },
    }),
  );

  // The one write path for a member's variables: the whole-map PUT and the
  // per-variable routes.
  const replaceUserEnv = (
    userId: string,
    values: Record<string, string>,
    notes: unknown,
  ) => {
    const user = getUserById(userId);
    if (!user)
      return { ok: false as const, status: 404 as const, code: "not_found" };
    // Checked before either write; the env first, since a read filters
    // the notes to its names.
    const nextNotes = nextManagedEnvNotes(
      values,
      notes,
      readManagedUserEnvNotes(userId),
    );
    const before = readManagedUserEnv(userId);
    writeManagedUserEnv(userId, values);
    writeManagedUserEnvNotes(userId, nextNotes);
    // The member's agents get the new variables: idle ones now, busy ones
    // at the end of their turn.
    if (managedEnvValuesDiffer(before, readManagedUserEnv(userId)))
      agentManager.envChanged([{ kind: "user", userId }]);
    // Agents first: a client that sees the new session_context has the
    // agent records that go with it.
    agentManager.refreshLimitedClaudeFamilies(userId);
    resendSessionContexts(userId);
    return { ok: true as const };
  };
  // The one write path for the office variables, as replaceUserEnv is for a
  // member's.
  const replaceOfficeEnv = (values: Record<string, string>, notes: unknown) => {
    const nextNotes = nextManagedEnvNotes(
      values,
      notes,
      readManagedOfficeEnvNotes(),
    );
    const before = readManagedOfficeEnv();
    writeManagedOfficeEnv(values);
    writeManagedOfficeEnvNotes(nextNotes);
    if (managedEnvValuesDiffer(before, readManagedOfficeEnv()))
      agentManager.envChanged([{ kind: "office" }]);
    // The office variables can change which account (or billing) the
    // office sign-in is: drop the usage cap's readings for both.
    memberUsageCap().invalidate("claude");
    memberUsageCap().invalidate("codex");
    agentManager.refreshLimitedClaudeFamilies();
    resendSessionContexts();
    return { ok: true as const };
  };
  // One variable. The variables routes and the value requests both write
  // through these (connection-writes.ts).
  const setUserVariable = (
    userId: string,
    name: string,
    value: string,
    note: unknown,
  ) =>
    replaceUserEnv(
      userId,
      { ...readManagedUserEnv(userId), [name]: value },
      note === undefined
        ? undefined
        : { ...readManagedUserEnvNotes(userId), [name]: note },
    );
  // As setUserVariable: no await between the read and the write.
  const setOfficeVariable = (name: string, value: string, note: unknown) =>
    replaceOfficeEnv(
      { ...readManagedOfficeEnv(), [name]: value },
      note === undefined
        ? undefined
        : { ...readManagedOfficeEnvNotes(), [name]: note },
    );
  // One variable or one new MCP server, with its after-effects, for the
  // value requests.
  const connectionWrites = createConnectionWrites({
    setUserVariable,
    setOfficeVariable,
    oauth: () => {
      if (!mcpOAuth) throw new Error("the MCP OAuth flow is not ready");
      return mcpOAuth;
    },
    pushOpenCodeSettings: (scope) => agentManager.pushOpenCodeSettings(scope),
  });
  register(
    userEnvHandlers({
      get: (userId) => {
        const user = getUserById(userId);
        if (!user) return { mode: "managed", values: {}, notes: {} };
        return {
          mode: "managed",
          values: readManagedUserEnv(userId) ?? {},
          notes: { ...readManagedUserEnvNotes(userId) },
        };
      },
      // The route has checked integrationOfficeOwner. Drop values and account
      // metadata before the member's connections leave this closure.
      names: async (username) => {
        const user = getUserByName(username);
        if (!user) return null;
        return {
          names: Object.keys(readManagedUserEnv(user.id) ?? {}).sort(),
          notes: { ...readManagedUserEnvNotes(user.id) },
          providers: await providerAccountManager.memberStatuses(user.id),
        };
      },
      replace: replaceUserEnv,
      // Read, change one name, and write through replace, with no await in
      // between, so it cannot interleave with a whole-map PUT.
      setOne: setUserVariable,
      removeOne: (userId, name) => {
        const values = { ...readManagedUserEnv(userId) };
        if (!Object.hasOwn(values, name)) return false;
        delete values[name];
        return replaceUserEnv(userId, values, undefined);
      },
      userIdForUsername: (username) =>
        buildLiveGuardDeps().userIdForUsername(username),
      getOffice: () => ({
        mode: "managed",
        values: readManagedOfficeEnv() ?? {},
        notes: { ...readManagedOfficeEnvNotes() },
      }),
      replaceOffice: replaceOfficeEnv,
      // As setOne and removeOne: no await between the read and the write.
      setOfficeOne: setOfficeVariable,
      removeOfficeOne: (name) => {
        const values = { ...readManagedOfficeEnv() };
        if (!Object.hasOwn(values, name)) return false;
        delete values[name];
        return replaceOfficeEnv(values, undefined);
      },
      pushOpenCodeSettings: (scope) => agentManager.pushOpenCodeSettings(scope),
    }),
  );
  // Secrets: no route returns a value but Show. The runtime pushes each
  // change to the proxy.
  // MCP servers name a secret in the same scope.
  const mcpSources = createMcpServerSources(undefined, {
    isLiveApp: isLiveAppGrant,
  });
  register(
    secretsHandlers({
      store: mcpSources.secrets,
      onChanged: () => secretsChanged(),
      appFor: (name) => {
        const record = appRegistry.get(name);
        return record
          ? {
              name: record.name,
              createdAt: record.createdAt,
              userId: record.userId,
            }
          : null;
      },
      pushOpenCodeSettings: (scope) => agentManager.pushOpenCodeSettings(scope),
      userIdForUsername: (username) =>
        buildLiveGuardDeps().userIdForUsername(username),
      isOfficeOwnerUserId: (userId) =>
        buildLiveGuardDeps().isOfficeOwnerUserId(userId),
      // append, not recordAudit: a Show that cannot be recorded must fail.
      auditReveal: (ctx, operation, targets) =>
        officeAuditStore().append({
          actor: auditActor(
            ctx.identity,
            attributionFor(ctx.identity).createdBy,
          ),
          operation,
          targets,
          fields: [],
        }),
    }),
  );
  // Secret requests: an agent asks, the member types the value in the ask's
  // masked form.
  register(
    secretRequestHandlers(
      createSecretRequests({
        store: mcpSources.secrets,
        asks: askStore!,
        audience: askAudience,
        // The OpenCode servers take the new secret as after a save; every
        // one, since the request names no scope here.
        onChanged: async () => {
          await secretsChanged();
          agentManager.pushOpenCodeSettings({ kind: "office" });
        },
        appFor: (name) => {
          const record = appRegistry.get(name);
          return record
            ? {
                name: record.name,
                createdAt: record.createdAt,
                userId: record.userId,
              }
            : null;
        },
        memberByName: (name) => {
          const user = getUserByName(name);
          return user ? { id: user.id, name: user.name } : null;
        },
        agentUserId: (agentId) => {
          const agent = agentManager.getAgent(agentId);
          return agent ? (agent.userId ?? null) : undefined;
        },
        memberName: (userId) => getUserById(userId)?.name ?? null,
        writes: connectionWrites,
        variableExists: (scope, name) =>
          Object.hasOwn(
            (scope.kind === "office"
              ? readManagedOfficeEnv()
              : readManagedUserEnv(scope.userId)) ?? {},
            name,
          ),
        mcpServerExists: (scope, name) =>
          mcpSources.servers.list(scope).some((server) => server.name === name),
        connectDiscordBot: (userId, token) =>
          discordSupervisor.connect(userId, token),
        settled: (agentId, requestId, outcome, line, answeredBy) =>
          agentManager.emitAgentSecretRequestSettled(
            agentId,
            requestId,
            outcome,
            line,
            answeredBy,
          ),
      }),
      (identity) => askAudienceFor(askAudience, identity),
    ),
  );
  // Sudo requests (task 43a28eed): an agent asks to run a command as root,
  // an office owner types the box account's password in the ask. A hosted
  // office has no sudo for its account.
  sudoRequests = createSudoRequests({
    asks: askStore!,
    audience: askAudience,
    agentUserId: (agentId) => {
      const agent = agentManager.getAgent(agentId);
      return agent ? (agent.userId ?? null) : undefined;
    },
    agentCwd: (agentId) => agentManager.getAgent(agentId)?.cwd ?? null,
    agentLimited: (agentId) => {
      const agent = agentManager.getAgent(agentId);
      return !agent || belowStandard(agentAccessOf(agent));
    },
    isOfficeOwner: (userId) => askAudience.isOfficeOwner(userId),
    memberByName: (name) => {
      const user = getUserByName(name);
      return user ? { id: user.id, name: user.name } : null;
    },
    memberName: (userId) => getUserById(userId)?.name ?? null,
    probe: async () =>
      isHostedAccess(installKind, loadServerConfig().publicOrigin)
        ? "unavailable"
        : probeSudo({ sudoPath }),
    start: (opts) => startSudo({ ...opts, home: homedir(), sudoPath }),
    runs: createSudoRunStore(join(STATE_ROOT, "sudo-runs.json")),
    report: (agentId, requestId, outcome, line, member, notice) =>
      agentManager.emitAgentSudoRequestReport(
        agentId,
        requestId,
        outcome,
        line,
        member,
        notice,
      ),
    now: () => Date.now(),
  });
  register(
    sudoRequestHandlers(sudoRequests, (identity) =>
      askAudienceFor(askAudience, identity),
    ),
  );
  mcpOAuth = createMcpOAuth({
    servers: mcpSources.servers,
    secrets: mcpSources.secrets,
    fetch: connectionTestFetch,
    redirectUri: () => `${buildPublicOrigin().origin}/api/mcp-oauth/callback`,
  });
  register(
    mcpServersHandlers({
      store: mcpSources.servers,
      oauth: mcpOAuth,
      auditSignIn: (ctx, targets) =>
        recordAudit({
          actor: auditActor(
            ctx.identity,
            attributionFor(ctx.identity).createdBy,
          ),
          operation: "mcpOAuth.callback",
          targets,
          fields: [],
        }),
      signedIn: stepsChanged,
      isOfficeOwnerUserId: (userId) =>
        buildLiveGuardDeps().isOfficeOwnerUserId(userId),
      userIdForUsername: (username) =>
        buildLiveGuardDeps().userIdForUsername(username),
      usernameForUserId: (userId) => getUserById(userId)?.name ?? null,
      pushOpenCodeSettings: (scope) => agentManager.pushOpenCodeSettings(scope),
    }),
  );
  register(
    connectionTestsHandlers({
      tester: createConnectionTester({
        sources: mcpSources,
        fetch: connectionTestFetch,
      }),
      userIdForUsername: (username) =>
        buildLiveGuardDeps().userIdForUsername(username),
    }),
  );
  register(
    createUsersRoutes({
      accessibleRoomIdsFor,
      enterpriseSeats: () => {
        if (!enterpriseSeats) throw new Error("enterprise seats not started");
        return enterpriseSeats;
      },
      announceAppAudienceChanges,
      announceWebhookAudienceChanges,
      // A hook edit with the same owner and target: its audience is the same.
      announceWebhookUpdate: (record) =>
        pushWebhookDeltaToEachWs({
          kind: "upserted",
          webhook: webhookWire(record),
          facts: webhookFacts(record),
          before: webhookFacts(record),
        }),
      attributionFor,
      clampViewFields,
      emitInvitesList,
      emitPrivateUserRecord,
      // A removal, restore or delete for good may be the change a step ask
      // waits for.
      emitRemovedMembers: () => {
        emitRemovedMembers();
        stepsChanged();
      },
      emitUserUpdated,
      emitUsersList,
      mcpSources,
      providerAccounts: providerAccountManager,
      purgeRemovedMember,
      pushPresenceListToEachWs,
      secretsChanged,
      snapshotAppVisibility,
      snapshotWebhookAudience,
      transferAgentManager,
      agentsThatCannotMoveDown: memberCeiling.agentsThatCannotMoveDown,
      afterMemberPackSaved,
    }),
  );

  // delete_user preconditions (audit-pinned in routes-table.test.ts; kept
  // SEPARATE so an audit/test failure names the policy that moved). Both run
  // AFTER the selfOrOwner guard, so a member only ever reaches them for their OWN
  // record. userDeleteNotSelfOwner: an owner may not delete their own record
  // (would brick in-browser recovery; sign out / transfer ownership instead).
  preconditions.set("userDeleteNotSelfOwner", (ctx) => {
    if (ctx.identity.scope !== "user" || ctx.identity.role !== "owner") {
      return null;
    }
    const target = getUser(ctx.params.username);
    if (target && target.id === ctx.identity.userId) {
      return fail(
        403,
        "owner_self_delete",
        "An owner can't delete their own user record. Sign out from this session or transfer ownership first.",
      );
    }
    return null;
  });
  // userDeleteNotLastOwner: refuse a delete that would leave the office with no
  // owner record (defense-in-depth; the same invariant the session-revoke lockout
  // guards). Owner-reachable for any :username; a member reaches it only for their
  // own record (the guard), and a member is never the last owner, so it passes.
  preconditions.set("userDeleteNotLastOwner", (ctx) => {
    const target = getUser(ctx.params.username);
    if (target && wouldDeleteLeaveNoOwner(target.id)) {
      return fail(
        409,
        "would_strand_office",
        "This is the last owner record. Promote another user to owner first, then retry.",
      );
    }
    return null;
  });

  // Office settings are owner-only; validation probes and backend models follow.
  // Four narrow deps over the shared cores so REST and the legacy WS arms stay in
  // lockstep. office.setSettings emits office_settings_updated via the
  // AgentManager event sink (the handler never emits). validate.cwd shares
  // agentManager.validateCwd directly; validate.env/backends share the cores.
  register(
    officeSettingsHandlers({
      getSettings: officeSettingsNow,
      // Status reads the providers, so only while the cap is on.
      getMemberUsageStatus: async (provider) => ({
        memberUsageStatus: memberUsageCap().isEnabled()
          ? await memberUsageCap().status(provider)
          : [],
      }),
      applySettings: (input, ctx) => {
        const result = applyOfficeSettings(
          input,
          auditActor(ctx.identity, attributionFor(ctx.identity).createdBy),
        );
        // A setting may be the change a step ask waits for.
        if (result.ok) stepsChanged();
        return result;
      },
      readInstructions: () => agentManager.getOfficeSettings().prompt,
      applyInstructions: applyOfficeInstructions,
    }),
  );
  // Room-structure mutation handlers stay thin; the COMPOUND effects live here
  // in the dep closures (the access/invites EMIT-IN-DEP pattern), faithfully
  // mirroring the now-deleted WS create_room/close_room cases:
  //  - create: rule-based access - anyone authenticated with room:manage creates
  //    a room. OWNERS reach it by RULE (already in the room_created audience,
  //    received live, NO fan-out). A MEMBER creator needs an explicit GRANT to
  //    see their own creation (room_created fired during createRoom, before the
  //    grant, so it was suppressed for them); grant it, and the users.ts access
  //    hook re-projects them. Owners need no re-projection: a new room holds no
  //    tasks or cronjobs yet. No owner allowedRooms/notifRooms fan-out and
  //    NO user_updated broadcast of the creator's grant (that broadcast was the
  //    hidden-room-id leak - a grant change reaches only its own subject).
  //  - close: strip the closed roomId from every user's allowedRooms/notifRooms
  //    so stale references don't accumulate, fanning out user_updated per touched
  //    record + a single users_list. The access hook re-projects each touched
  //    member; owners lose the room by RULE (no record write), so close itself
  //    re-projects every socket's board and cronjobs.
  // Both re-push presence to keep the room-mutation→presence invariant uniform.
  register(
    roomsHandlers({
      create: ({ name, skin, creatorUserId }) => {
        const newRoomId = agentManager.createRoom(name, skin);
        const creator = creatorUserId ? getUserById(creatorUserId) : undefined;
        if (
          creator &&
          creator.role !== "owner" &&
          !creator.allowedRooms.includes(newRoomId)
        ) {
          // The grant re-projects the creator's sockets through the users.ts
          // access hook. A failed write leaves them without the room, as before.
          updateUserById(creator.id, {
            allowedRooms: [...creator.allowedRooms, newRoomId],
          });
        }
        // A new room is empty so no ghost moves post-cut (room ids are stable);
        // the re-push is harmless and keeps every room mutation paired with a
        // presence refresh.
        pushPresenceListToEachWs();
        const room = agentManager.getRooms().find((r) => r.id === newRoomId);
        if (!room) {
          throw new Error(
            `rooms.create: created room ${newRoomId} missing from getRooms()`,
          );
        }
        return { room };
      },
      close: (roomId) => {
        const appAudienceBefore = snapshotAppVisibility(
          (app) => appVisibilityFacts(app).creatorRoomId === roomId,
        );
        const webhookAudienceBefore = snapshotWebhookAudience(
          (record) => webhookFacts(record).liveRoomId === roomId,
        );
        const closed = agentManager.closeRoom(roomId);
        if (!closed) return false;
        // The room's tasks stay; its GitHub link goes (task 7fc83592).
        githubLinks.remove(roomId);
        let touched = false;
        for (const u of listUsers()) {
          const inAllowed = u.allowedRooms.includes(roomId);
          const inNotif = u.notifRooms.includes(roomId);
          const inPush = u.pushRooms.includes(roomId);
          if (!inAllowed && !inNotif && !inPush) continue;
          const changes: {
            allowedRooms?: string[];
            notifRooms?: string[];
            pushRooms?: string[];
          } = {};
          if (inAllowed) {
            changes.allowedRooms = u.allowedRooms.filter((id) => id !== roomId);
          }
          if (inNotif) {
            changes.notifRooms = u.notifRooms.filter((id) => id !== roomId);
          }
          if (inPush) {
            changes.pushRooms = u.pushRooms.filter((id) => id !== roomId);
          }
          const r = updateUserById(u.id, changes);
          if (r.ok) {
            emitUserUpdated(r.user);
            touched = true;
          }
        }
        if (touched) emitUsersList();
        // Drop any ghost orphaned by the close (its currentRoomId was the
        // now-gone room); buildPresenceListFor filters dangling entries.
        pushPresenceListToEachWs();
        // The room's task records stay as they are: office owners keep them
        // on their boards and can re-file, close or delete them; every member
        // loses them (server/task-visibility.ts). Mutations are per-task
        // deltas, so nothing else sweeps a member's board: re-project it here,
        // per recipient, against each socket's own access.
        pushTasksToEachWs();
        // A job filed in the closed room falls back to its maker and office
        // owners; re-project so room members' lists drop it live.
        pushCronjobsToEachWs();
        announceAppAudienceChanges(appAudienceBefore);
        announceWebhookAudienceChanges(webhookAudienceBefore);
        return true;
      },
      rename: (roomId, name) => agentManager.renameRoom(roomId, name),
      setPet: (roomId, pet) => agentManager.setRoomPet(roomId, pet),
      takesSkin: (roomId) => {
        const room = agentManager.getRooms().find((r) => r.id === roomId);
        if (!room) return "unknown";
        return room.type === "lobby" ? "no" : "yes";
      },
      setSkin: (roomId, skin) => agentManager.setRoomSkin(roomId, skin),
      setDecor: (roomId, patch) => agentManager.setRoomDecor(roomId, patch),
      cwdProblem: (cwd) => {
        try {
          agentManager.validateCwd(cwd);
          return null;
        } catch (err) {
          return errMessage(err, "Invalid directory");
        }
      },
      setCwd: (roomId, cwd) => agentManager.setRoomCwd(roomId, cwd),
      getSettings: (roomId) => {
        const room = agentManager.getRooms().find((r) => r.id === roomId);
        // Version over the prompt bytes ("" for a never-set/cleared prompt),
        // same versionOf as memory files. The look rides along unversioned.
        return room
          ? {
              prompt: room.prompt,
              version: versionOf(room.prompt ?? ""),
              skin: room.skin ?? null,
              pet: room.pet ?? null,
              decor: room.decor ?? null,
              cwd: room.cwd ?? null,
            }
          : null;
      },
      setSettings: (roomId, prompt, expectedVersion) => {
        // Check-then-write is atomic on the single-threaded event loop (same
        // reasoning as memory-store.replace). Existence first so an unknown
        // room stays a 404, never a bogus conflict.
        const room = agentManager.getRooms().find((r) => r.id === roomId);
        if (!room) return { ok: false, reason: "room_not_found" };
        const currentVersion = versionOf(room.prompt ?? "");
        if (expectedVersion !== currentVersion) {
          return {
            ok: false,
            reason: "version_conflict",
            version: currentVersion,
          };
        }
        if (!agentManager.setRoomSettings(roomId, prompt))
          return { ok: false, reason: "room_not_found" };
        notePromptContent(
          agentManager.getRooms().find((r) => r.id === roomId)?.prompt ?? null,
        );
        return { ok: true };
      },
    }),
  );
  register(
    createAgentsRoutes({
      ENGINE_BELOW_STANDARD_MESSAGE,
      accessChangeRefusal,
      announceAppAudienceChanges,
      announceWebhookAudienceChanges,
      attributionFor,
      cwdFolderRefusal,
      folderRuleState,
      resolveCodexDefaultModel,
      snapshotAppVisibility,
      snapshotWebhookAudience,
      spawnAccessRefusal,
      spawnRefusal,
      transferAgentManager,
      sharesRoomWithMember: (identity, userId) =>
        sharesRoomWithMember(identity, userId, buildLiveGuardDeps()),
      webhookTargetsAgent,
    }),
  );
  // reviveLastRoomAccess: revive needs access to BOTH the target room
  // (the bodyRoom("roomId") guard) AND the killed agent's lastRoomId. A killed
  // summary that is MISSING or whose lastRoomId the caller can't access BOTH
  // collapse to the same 403 (no existence oracle): the killed-chip list the UI
  // saw was already ACL-filtered by lastRoomId, so a well-behaved client only
  // sends visible ids; this catches stale / hand-crafted commands.
  preconditions.set("reviveLastRoomAccess", (ctx) => {
    const denied = fail(
      403,
      "forbidden",
      "That killed agent is not available to revive.",
    );
    const user = ctx.identity.userId
      ? getUserById(ctx.identity.userId)
      : undefined;
    if (!user) return denied;
    const summary = agentManager
      .getKilledAgentSummaries()
      .find((s) => s.id === ctx.params.id);
    if (!summary || !canAccess(user, summary.lastRoomId)) return denied;
    if (!withinTokenRooms(ctx.identity, summary.lastRoomId)) return denied;
    return null;
  });
  // Conversation (send/edit/cancel/sendNow/newConversation/resume/
  // listSessions). CALL-IN-DEP closures mirror the deleted WS cases: the
  // streaming sends void-discard the manager promise (the turn streams over WS;
  // HTTP only acks), and sendMessage UNIFIES the two messageSend branches (USER
  // chat -> sendMessage with the approval overload; AGENT inter-agent ->
  // enqueueMessage with a server-derived structured sender, the retired POST
  // /agents/:id/message path).
  register(
    conversationHandlers({
      attributionFor,
      resolveAppContext: (identity, agentId, context) => {
        const app = appRegistry.get(context.name);
        if (
          !app ||
          !identity.userId ||
          !canUserAccessApp(app, identity.userId, identity) ||
          appRegistrationGeneration(app) !== context.registration
        )
          return { error: "app_unavailable" };
        if ((app.messageTargetAgentId ?? app.createdByAgentId) !== agentId)
          return { error: "app_target_changed" };
        return { name: app.name };
      },
      sendAsUser: (
        agentId,
        text,
        username,
        device,
        attachments,
        sendNow,
        clientMessageId,
        limits,
      ) =>
        sendMemberMessage(agentId, text, username, device, attachments, {
          sendNow,
          clientMessageId,
          limits,
        }),
      identityFitsAgent: (identity, agentId) =>
        identityFitsAgent(identity, agentId, buildLiveGuardDeps()),
      sendAsApi: (agentId, text, username, device, tokenId, opts) =>
        sendApiTokenMessage(
          tokenId,
          {
            targetAgentId: agentId,
            targetAgentName:
              agentManager.getAgentDisplay(agentId)?.name ?? agentId,
            targetRoomName:
              agentManager.getAgentDisplay(agentId)?.roomName ?? "",
            text,
          },
          () =>
            sendMemberMessage(agentId, text, username, device, undefined, {
              refusePromptAnswer: opts?.refusePromptAnswer,
              limits: opts?.limits,
            }),
        ),
      sendAsAgent: async (
        receiverId,
        senderAgentId,
        text,
        clientMessageId,
        steer,
      ) => {
        if (senderAgentId === receiverId)
          return {
            ok: false,
            status: 400,
            code: "self_send",
            message: "Cannot send a message to self.",
          };
        // Server-derived structured sender (name + room) - never body-trusted -
        // blocks identity spoof + prefix-delimiter injection into the prompt.
        const senderInfo = agentManager.getAgentDisplay(senderAgentId);
        if (!senderInfo)
          return {
            ok: false,
            status: 400,
            code: "unknown_sender",
            message: "Sender is not a known agent.",
          };
        await agentManager.prepareEnqueue(receiverId);
        const result = agentManager.enqueueMessage(
          receiverId,
          {
            sender: {
              kind: "agent",
              agentId: senderAgentId,
              agentName: senderInfo.name,
              roomName: senderInfo.roomName,
            },
            text,
            clientMessageId,
          },
          // Enqueue and interrupt in one call. See enqueueMessage's opts for why
          // this can't be a second request.
          { steer },
        );
        // The sender-side record, so the sender's own log search finds what it
        // sent. Best-effort: the message is already delivered, and a 500 here
        // would make the sender retry it.
        if (result.ok && !result.deduped) {
          try {
            agentManager.addAgentOutbound(senderAgentId, receiverId, text, {
              messageId: result.messageId,
            });
          } catch (err) {
            console.error(
              "Failed to record an agent's sent message in its log:",
              errMessage(err),
            );
          }
        }
        if (result.ok)
          return {
            ok: true,
            messageId: result.messageId,
            // Surfaced so the sender knows whether the receiver reads this now or
            // after their current turn. A deduped retry touched
            // no queue, so it reports nothing rather than the manager's default
            // false - the accepted send already answered. The steer fields ride
            // the same rule: absent unless this call asked to steer, and absent
            // on a deduped retry, which interrupted nobody.
            ...(result.deduped ? {} : { queued: result.queued }),
            ...(result.steered === undefined
              ? {}
              : { steered: result.steered }),
            ...(result.steerDeclined === undefined
              ? {}
              : { steerDeclined: result.steerDeclined }),
          };
        // enqueueMessage's error code passes through verbatim ("agent not found"
        // 404 - normally pre-empted by the messageRecipientExists precondition;
        // agent_stopped / agent_error 409; queue_full 429; persist_failed 500
        // when the durable-queue write failed and the message was rolled back -
        // the sender should retry), preserving the legacy endpoint's
        // status + code contract.
        return enqueueFailure(result);
      },
      sendAsCron: async (receiverId, cronjobId, text, clientMessageId) => {
        const job = cronjobManager
          .listCronjobs()
          .find((candidate) => candidate.id === cronjobId);
        if (!job)
          return {
            ok: false,
            status: 400,
            code: "unknown_sender",
            message: "Sender is not a known schedule.",
          };
        await agentManager.prepareEnqueue(receiverId);
        const result = agentManager.enqueueMessage(receiverId, {
          sender: {
            kind: "cronjob",
            cronjobId: job.id,
            cronjobName: job.name,
          },
          text,
          clientMessageId,
        });
        if (result.ok)
          return {
            ok: true,
            messageId: result.messageId,
            ...(result.deduped ? {} : { queued: result.queued }),
          };
        return enqueueFailure(result);
      },
      // Scheduled messages. Thin pass-throughs: the manager
      // owns validation (future/horizon/quota/idempotency) and returns the
      // status+code discriminated results the handler maps verbatim.
      scheduleMessage: (
        receiverId,
        senderAgentId,
        text,
        deliverAt,
        clientMessageId,
      ) => {
        return scheduledMessageManager.schedule({
          senderAgentId,
          receiverAgentId: receiverId,
          text,
          deliverAt,
          clientMessageId,
        });
      },
      listScheduledMessages: (senderAgentId) =>
        scheduledMessageManager.listBySender(senderAgentId),
      cancelScheduledMessage: (senderAgentId, scheduledId) =>
        scheduledMessageManager.cancel(senderAgentId, scheduledId),
      editMessage: (agentId, logEntryId, newText, username, device, limits) => {
        void agentManager.editMessage(
          agentId,
          logEntryId,
          newText,
          username,
          device,
          limits,
        );
      },
      cancelQueued: (agentId, messageId, senderAgentId) =>
        agentManager.cancelQueued(agentId, messageId, senderAgentId),
      mayCancelAnyQueued: (identity, agentId) =>
        queueCancelAny({
          identity,
          params: { id: agentId },
          deps: buildLiveGuardDeps(),
        }).ok,
      readQueue: (agentId) => agentManager.readQueue(agentId),
      // AWAITED, unlike the fire-and-forget it used to be: the refusal is the
      // point. sendNow resolves as soon as it has decided whether it can flush -
      // the delivery itself still streams over WS.
      sendNow: (agentId, cause) => agentManager.sendNow(agentId, cause),
      attachmentRefusal: (agentId, attachments) => {
        const agent = agentManager.getAgent(agentId);
        if (!agent) return null;
        const access = agentAccessOf(agent);
        if (!belowStandard(access) || stopHasFolder(access)) return null;
        return attachments.every((a) => INLINE_IMAGE_TYPES.has(a.mediaType))
          ? null
          : `${agent.name} has no file tools: only images can go to it.`;
      },
      newConversation: (agentId, agentType) => {
        const current = agentManager.getAgent(agentId);
        if (
          current &&
          agentType &&
          agentType !== current.agentType &&
          // No model goes with this switch: the engine's default.
          !engineRunsAccessHere(agentType, agentAccessOf(current), null)
        )
          return "engine_below_standard";
        // The WS case awaited this purely for handler sequencing; the clear_logs
        // + turn events stream over WS regardless, so void-discard for an
        // immediate ack. .catch swallows (the WS path had no error surface).
        void agentManager.newConversation(agentId, agentType).catch(() => {});
      },
      handoff: async (agentId, text) => {
        // Self-handoff: the manager owns the reset-then-deliver
        // (agentManager.handoff - guarded to one in-flight handoff per agent, so a
        // concurrent second handoff is rejected rather than clobbering this one's
        // brief). AWAIT it and map its
        // outcome honestly: enqueueMessage's transactional persist can fail
        // (persist_failed / agent_stopped / queue_full), and returning {ok:true}
        // regardless would tell the caller a brief was delivered when none was.
        // Same status+code passthrough as sendAsAgent.
        const r = await agentManager.handoff(agentId, text);
        if (r.ok) return { ok: true };
        return enqueueFailure(r);
      },
      resume: (agentId, sessionId) => {
        void agentManager.resume(agentId, sessionId).catch(() => {});
      },
      listSessions: (agentId) => ({
        sessions: agentManager.listSessions(agentId),
        currentSessionId: agentManager.getCurrentSessionId(agentId),
      }),
      respondInteraction: (
        agentId,
        interactionId,
        value,
        username,
        device,
        limits,
      ) =>
        agentManager.respondToChoiceInteraction(
          agentId,
          interactionId,
          value,
          username,
          device,
          limits,
        ),
    }),
  );
  // Send-message preconditions (audit-pinned in routes-table.test.ts;
  // kept out of the pure messageSend guard, which is caller-authorization only).
  preconditions.set("messageRecipientExists", (ctx) => {
    // The AGENT (send-as-self) branch skips the room check (cross-room delivery is
    // allowed), so an absent recipient reaches here -> 404 (recipient existence is
    // never an ACL leak for an agent sender, per the doc). The USER branch was
    // already denied by requiresRoomAccess (403) before preconditions run, so this
    // only meaningfully fires for an agent sender / a post-spawn race.
    if (!agentManager.getAgent(ctx.params.id)) {
      return fail(404, "recipient_not_found", "Recipient not found.");
    }
    return null;
  });
  preconditions.set("messagePendingPermissionBindsParam", () => {
    // The route interprets the text as an allow/deny ONLY for the agent named by
    // the path :id: the USER branch routes to agentManager.sendMessage(:id), which
    // consults :id's OWN pendingPermission; the AGENT branch routes to
    // enqueueMessage (a plain queued message, never a permission reply). The
    // request carries no alternate permission target, so the interpretation binds
    // to :id by construction. We deliberately DON'T reject an inter-agent message
    // to an agent that has a pending permission - the legacy HTTP inter-agent path
    // queued it normally, and rejecting would be a behavior change. This
    // precondition is the explicit, audit-pinned record of that structural bind.
    return null;
  });
  preconditions.set("apiTokenInboxTargetAvailable", (ctx) => {
    const senderAgentId = ctx.identity.agentId;
    const sender = senderAgentId ? agentManager.getAgent(senderAgentId) : null;
    const userId = sender?.userId;
    // A room-limited token takes messages only from agents in its rooms.
    const rooms = apiTokenRoomsById(ctx.params.tokenId);
    return userId &&
      isLiveApiTokenOwnedBy(ctx.params.tokenId, userId) &&
      (rooms === null || rooms.includes(sender.roomId))
      ? null
      : fail(404, "api_token_unavailable", "API token unavailable.");
  });
  register(createEditorRoutes({ browsers, editorWatchers, liveEmit }));
  // REST view.* is the SOLE per-user view-preference surface.
  // The WS update_user notif/default arm is retired, and notif/default are
  // self-only.
  register(
    viewHandlers({
      applyView: (userId, change) => {
        const applied = applyViewChange(userId, change);
        if (applied) stepsChanged();
        return applied;
      },
      // Accessible rooms (hidden included) in office order, id+name only -
      // the re-show read for the hide-rooms UI.
      listAccessibleRooms: (userId) => {
        const user = getUserById(userId);
        if (!user) return null;
        const accessible = accessibleRoomIdsFor(user);
        return agentManager
          .getOrdinaryRooms()
          .filter((r) => accessible.has(r.id))
          .map((r) => ({ id: r.id, name: r.name }));
      },
    }),
  );
  register(browserExtensionHandlers(extensionService!));
  // Personal preferences. Self-only, same audience posture as view.*: the
  // handler is a pure REST mapper and this seam owns mutate -> emit.
  register(
    preferencesHandlers({
      applyPreferences: (userId, change) => {
        const applied = applyPreferencesChange(userId, change);
        if (applied) stepsChanged();
        return applied;
      },
      userIdForUsername: (username) =>
        buildLiveGuardDeps().userIdForUsername(username),
      userById: (userId) => getUserById(userId) ?? null,
      officeName: () => agentManager.getOfficeSettings().name,
      keyStatus: (userId) => {
        const found = voiceKeyForUserId(userId);
        return {
          keySource: found?.source ?? null,
          keyName: found?.name ?? null,
        };
      },
    }),
  );
  register(
    providerAccountsHandlers({
      list: (userId) => providerAccountManager.list(userId),
      refresh: async (userId) => {
        const accounts = await providerAccountManager.list(userId, true);
        liveEmit("provider_accounts_updated", { accounts }, { userId });
        stepsChanged();
        return accounts;
      },
      start: (userId, provider, scope, method) =>
        providerAccountManager.startLogin(userId, provider, scope, method),
      callback: (userId, provider, scope, code) =>
        providerAccountManager.submitCode(userId, provider, scope, code),
      cancel: (userId, provider, scope, allowForeign) =>
        providerAccountManager.cancel(userId, provider, scope, allowForeign),
      disconnect: (userId, provider, scope) =>
        providerAccountManager.disconnect(userId, provider, scope),
    }),
  );
  register(
    openCodeHandlers({
      status: (userId) => ({
        freeLimitAt: agentManager.openCodeFreeLimit.since(),
        keySource: envSourceForUserId(userId, "OPENCODE_API_KEY"),
      }),
    }),
  );
  register(
    connectionsHandlers({
      list: (userId, officeOwner) =>
        buildConnectionsList({
          officeOwner,
          officeVariableNames: () => Object.keys(readManagedOfficeEnv() ?? {}),
          personalVariableNames: () =>
            Object.keys(readManagedUserEnv(userId) ?? {}),
          officeVariableNotes: () => readManagedOfficeEnvNotes(),
          personalVariableNotes: () => readManagedUserEnvNotes(userId),
          accounts: () => providerAccountManager.list(userId),
          claudeConnectorDir: (scope) =>
            providerAccountManager.claudeConnectorDir(userId, scope),
          claudeConnectorsFor,
          claudeConnectorStatusesFor,
          mcpServers: () => mcpServerRows(mcpSources, userId, officeOwner),
          engineMcpServers: () => {
            const officeDir = providerAccountManager.claudeConfigDir(
              userId,
              "office",
            );
            const personalDir = providerAccountManager.claudeConfigDir(
              userId,
              "personal",
            );
            return claudeEngineServersFor(
              agentManager.agentIdsOfUser(userId),
              (dir) =>
                dir === officeDir
                  ? "office"
                  : dir === personalDir
                    ? "personal"
                    : null,
            );
          },
          secrets: (scope) => {
            const secretScope: SecretScope =
              scope === "office"
                ? { kind: "office" }
                : { kind: "user", userId };
            return withoutOAuthOwned(
              secretScope,
              mcpSources.secrets.list(secretScope),
            );
          },
        }),
      forAgent: (userId) =>
        buildAgentConnections(
          {
            officeVariables: readOfficeEnvFile,
            officeVariableNotes: readManagedOfficeEnvNotes,
            memberVariables: (id) => readManagedUserEnv(id) ?? {},
            memberVariableNotes: readManagedUserEnvNotes,
            secrets: {
              list: (scope) =>
                withoutOAuthOwned(scope, mcpSources.secrets.list(scope)),
            },
            mcp: mcpSources,
          },
          userId,
        ),
    }),
  );
  register(
    apiTokenHandlers({
      list: (userId) => listApiTokens(userId),
      // A token made or revoked may be the change a step ask waits for.
      mint: async (input) => {
        const minted = await mintApiToken(input);
        stepsChanged();
        return minted;
      },
      revoke: async (userId, id) => {
        const revoked = await revokeApiToken(userId, id);
        if (revoked) stepsChanged();
        return revoked;
      },
      limitableRoomIds: tokenLimitableRoomIds,
      userIdForUsername: (username) => getUser(username)?.id ?? null,
      sendToInbox: async (input) => {
        const result = await enqueueApiTokenInboxMessage(input);
        return result.ok
          ? {
              ok: true as const,
              messageId: result.message.id,
              lastDrainedAt: result.lastDrainedAt,
              tokenName: result.tokenName,
            }
          : result;
      },
      drainInbox: (tokenId, after) =>
        drainApiTokenInbox(tokenId, undefined, after),
      agentDisplay: (agentId) => agentManager.getAgentDisplay(agentId),
      agentManagerUserId: (agentId) =>
        agentManager.getAgent(agentId)?.userId ?? null,
      echoToAgent: (agentId, tokenName, text) =>
        agentManager.addApiTokenOutbound(agentId, tokenName, text),
    }),
  );
  register(
    validateHandlers({
      validateCwd: (cwd) => {
        try {
          agentManager.validateCwd(cwd);
          return null;
        } catch (err) {
          return errMessage(err, "Invalid directory");
        }
      },
      validateEnv: (scope, username, selfUserId) =>
        resolveAndValidateEnv(scope, username, selfUserId),
    }),
  );
  register(
    backendsHandlers({
      listModels: (input) => listBackendModels(input),
    }),
  );
  // System backup status maps the internal BackupStatus to the normalized
  // /api wire shape (rename + null→false on ok). This is the only backup-status
  // surface now - the legacy /backup/status, which returned the raw shape, is
  // retired.
  register(
    systemHandlers({
      getBackupStatus: () => backupStatusWire(backupStatus()),
      setBackupSettings: (input) => {
        const result = saveBackupSettings(input);
        if (result.ok) stepsChanged();
        return result.ok
          ? {
              ok: true,
              res: {
                ...backupStatusWire(result.status),
                oldBackupsDir: result.oldBackupsDir,
              },
            }
          : result;
      },
      getVersion: () => getVersionInfo(),
    }),
  );
  register(createStorageRoutes(storage));
  register(
    usageHandlers({
      getUserById,
      getReport: (audience) => agentManager.getUsageReportData(audience),
    }),
  );
  // In-UI update trigger (release channel). The conf is read per call so an
  // updater installed after boot is seen without a restart; the launch is
  // detached (systemd), never a child of this process.
  register(
    updateHandlers({
      getUpdateInfo: () => {
        // Managed keys on conf PRESENCE (a damaged conf is still an
        // updater-managed box); serviceKind is null unless cleanly parsed.
        const conf = readUpdateConf();
        const kind =
          conf.state === "parsed" ? conf.values.SERVICE_KIND : undefined;
        return {
          managed: conf.state !== "absent",
          serviceKind: kind === "system" || kind === "user" ? kind : null,
          // Office-wide, NOT the caller's room projection: the restart
          // interrupts every agent, so the confirm count must include rooms
          // hidden from a restricted owner.
          busyAgents: agentManager
            .getAllAgents()
            .filter(
              (a) => a.state === "thinking" || a.state === "tool_executing",
            ).length,
          status: getUpdateStatus(),
        };
      },
      triggerUpdate: (tag) => triggerUpdate(tag),
    }),
  );

  // validateEnvBodySelfSubject: the SOLE object-level policy for
  // validate.env (its guard is just `authenticated`). An owner may validate any
  // scope/user, a member ONLY their own user env. Non-leak: office scope or
  // another user's env both deny with the same 403. (This replaced the equivalent
  // inline checks in the now-retired request_settings_validation WS arm.) It is
  // what keeps the precondition reachable (a member validating their own env is
  // allowed HERE, not denied at the guard as the prior or(officeOwner, selfUser) did).
  //
  // SCOPE GATE: historically office:read (stage 1) implied USER
  // scope, but a PRIVILEGED agent now also holds office:read. The subject policy
  // below keys on the resolved user's RECORD role, so an owner-spawned agent
  // would otherwise inherit owner reach and probe any user's/office env-file
  // metadata (key count, parse errors). Env validation is a human/UI affordance -
  // fail closed for any non-user scope so a privileged agent can never reach it.
  preconditions.set("validateEnvBodySelfSubject", (ctx) => {
    if (ctx.identity.scope !== "user") return fail(403, "forbidden");
    const u = ctx.identity.userId
      ? getUserById(ctx.identity.userId)
      : undefined;
    if (!u) return fail(403, "forbidden");
    if (u.role === "owner") return null;
    const b = (ctx.body ?? {}) as { scope?: unknown; username?: unknown };
    if (b.scope !== "user") return fail(403, "forbidden");
    const username = typeof b.username === "string" ? b.username : undefined;
    if (
      username !== undefined &&
      lowercaseKey(username) !== lowercaseKey(u.name)
    ) {
      return fail(403, "forbidden");
    }
    return null;
  });

  return {
    audit: {
      actor: ({ identity }) => {
        const app = identity.appName ? appRegistry.get(identity.appName) : null;
        return auditActor(
          identity,
          attributionFor(identity).createdBy,
          app ? `${app.name}:${appRegistrationGeneration(app)}` : undefined,
        );
      },
      write: recordAudit,
    },
    guardDeps: buildLiveGuardDeps(),
    idempotency: idempotencyCache,
    handlers,
    preconditions,
  };
}

// Push ONE app mutation to every socket as a per-recipient delta.
// The owner and office owners always see an app. A live creator also grants
// launch-only visibility through its room. appDeltaFor owns both the audience
// transition and the per-recipient projection.
//
// There is no whole-list counterpart to pushTasksToEachWs: an app list costs a
// systemd read, so the Apps tab fetches GET /api/apps when it opens (and after
// a rehydrate) instead of every session paying for a tab it never opens.
function pushAppDeltaToEachWs(change: AppChange) {
  for (const ws of browsers) {
    const delta = appDeltaFor(change, {
      userId: ws.data.session.userId,
      isOfficeOwner: ws.data.session.role === "owner",
      hasRoomAccess: (roomId) => roomAllowedForSession(ws.data.session, roomId),
    });
    if (delta) officeSend(ws, delta.type, JSON.stringify(delta));
  }
}

// Push the unfiltered global rooms list to every owner WS. Used after
// any change to the global rooms array so the owner-only admin view
// (currently: the Allowed Rooms editor in UserSettingsView) keeps
// in sync. Owners with an explicit allowedRooms still see only their
// subset in the main UI; this channel is purely for the admin surface
// where they grant/revoke other users' room access. Members never
// receive this - leaking the full room list across visibility lines
// would defeat the per-user ACL.
function pushAllRoomsListToOwners() {
  const data = JSON.stringify({
    type: "all_rooms_list",
    rooms: agentManager.getOrdinaryRooms(),
  });
  for (const ws of browsers) {
    if (ws.data.session.role === "owner") {
      officeSend(ws, "all_rooms_list", data);
    }
  }
}

// Inbound WS messages. Every durable command moved to REST, so the WS is
// no longer a command bus: the only inbound messages are the three permanent
// exceptions - interactive terminal IO, presence_update (ephemeral cursor
// telemetry), and ping. None is a durable command with an outcome worth
// idempotency, so they are fire-and-forget. The top-level try/catch keeps a
// per-message throw from tearing down the socket loop (log and move on); no
// *_response remains (those all migrated to REST). The wire still carries
// `username` on presence_update, but the server authority is always
// session.username; trusting cmd.username would let a member spoof another's
// display name. (Switch body left at its prior indentation; prettier normalizes
// post-review.)
async function handleInboundMessage(
  cmd: ClientCommand,
  ws: ServerWebSocket<OfficeWsData>,
) {
  const session = ws.data.session;
  try {
    switch (cmd.type) {
      case "ping":
        // Past the outbox: the pong carries no state, and behind a long
        // replay it would miss the client's heartbeat grace.
        if (ws.send(JSON.stringify({ type: "pong" })) === 0) ws.terminate();
        break;
      case "lobby_move": {
        if (
          typeof cmd.spotId === "string" &&
          moveLobbyPresence(ws.data.connectionId, cmd.spotId)
        ) {
          pushPresenceListToEachWs();
        }
        break;
      }
      case "presence_update": {
        // Live-avatars: the sender tells us where its ghost should appear, as a
        // stable global room id. It must name a LIVE room the sender can
        // access, else it is clamped to null (the common cause is a race with
        // an allowedRooms change). Access, not visibility, is the gate:
        // buildPresenceListFor filters each recipient by their own visibility,
        // so this can't leak a ghost into a room a recipient can't see. The
        // user record supplies avatarColor + avatarVariant.
        const user = getUserById(session.userId);
        if (!user) break;
        // A stale inbound id (the client raced a room close) is an expected
        // sanitize-to-null case. canAccess first as the cheap short-circuit (a
        // member without the grant never scans the rooms).
        const roomId =
          cmd.currentRoomId !== null &&
          canAccess(user, cmd.currentRoomId) &&
          (cmd.currentRoomId === LOBBY_ROOM_ID ||
            agentManager.getRooms().some((r) => r.id === cmd.currentRoomId))
            ? cmd.currentRoomId
            : null;
        // Clamp focusedAgentId: must reference a real agent whose room
        // matches the claimed roomId (so a stale cross-room focus claim
        // becomes null server-side instead of degrading to lobby on the
        // recipient). Membership in user.allowedRooms is implicit in the
        // roomId === agentRoomId check, since roomId was already
        // sanitized against allowedRooms above.
        let focusedAgentId: string | null = null;
        if (
          typeof cmd.focusedAgentId === "string" &&
          cmd.focusedAgentId &&
          roomId !== null
        ) {
          const agent = agentManager
            .getAllAgents()
            .find((a) => a.id === cmd.focusedAgentId);
          // Read the agent's authoritative roomId directly.
          const agentRoomId = agent?.roomId ?? null;
          if (agentRoomId === roomId) {
            focusedAgentId = cmd.focusedAgentId;
          }
        }
        const viewMode: "office" | "log" | "away" =
          cmd.viewMode === "log" || cmd.viewMode === "away"
            ? cmd.viewMode
            : "office";
        // Device label is client-supplied; trim and treat empty as null
        // so a device that hasn't named itself doesn't add "()" noise to
        // the name-tag chip.
        const device =
          typeof cmd.device === "string" && cmd.device.trim()
            ? cmd.device.trim().slice(0, 24)
            : null;
        // Stamp the label onto the auth SESSION too, so the
        // Sessions pane can show which device each session is. Last non-null
        // wins (an unnamed tab never erases a learned label); on an actual
        // change, fan out the scoped sessions list so open panes update live.
        if (
          device !== null &&
          noteSessionDeviceByHash(session.sessionIdHash, device)
        ) {
          emitSessionsList();
        }
        const changed = setPresence({
          connectionId: ws.data.connectionId,
          userId: session.userId,
          username: user.name,
          device,
          avatarColor: user.avatarColor,
          avatarVariant: user.avatarVariant,
          currentRoomId: roomId,
          focusedAgentId,
          viewMode,
          page: presencePageFromWire(viewMode, cmd.page),
          lastSeenAt: Date.now(),
        });
        if (changed) {
          pushPresenceListToEachWs();
        }
        break;
      }
      case "terminal_open": {
        if (!terminalAllowed(session, cmd.agentId)) break;
        const opened = agentManager.openTerminal(cmd.agentId, {
          kind: "member",
          id: session.userId,
          name: getUserById(session.userId)?.name ?? session.userId,
        });
        if (opened) {
          // Seed ONLY the requester that just opened the terminal. The live
          // terminal_output stream is ACL-gated on the live emit path (it is a
          // room-ACL event), so other visible sockets stay current without this
          // replay; broadcasting the backlog to every socket leaked it to
          // sockets without access to the agent's room and could
          // duplicate the backlog into another already-open terminal panel for
          // the same agent.
          const buffer = agentManager.getTerminalBuffer(cmd.agentId);
          if (buffer) {
            officeSend(
              ws,
              "terminal_output",
              JSON.stringify({
                type: "terminal_output",
                agentId: cmd.agentId,
                data: buffer,
                // Marks the chunk as scrollback, so the panel parses it with
                // the terminal's query answers suppressed. Without the mark a
                // query left in the scrollback is answered on every mount and
                // the answer lands at the shell prompt as if typed.
                replay: true,
              }),
            );
          }
          agentManager.terminalStatus(cmd.agentId);
        }
        break;
      }
      case "terminal_input":
        if (!terminalAllowed(session, cmd.agentId)) break;
        // The typist is the socket's member, never a field of the frame.
        agentManager.terminalInput(cmd.agentId, cmd.data, {
          kind: "member",
          id: session.userId,
          name: getUserById(session.userId)?.name ?? session.userId,
        });
        break;
      case "terminal_status_request":
        if (!terminalAllowed(session, cmd.agentId)) break;
        agentManager.terminalStatus(cmd.agentId);
        break;
      case "terminal_resize":
        if (!terminalAllowed(session, cmd.agentId)) break;
        agentManager.terminalResize(cmd.agentId, cmd.cols, cmd.rows, {
          kind: "member",
          id: session.userId,
          name: getUserById(session.userId)?.name ?? session.userId,
        });
        break;
      case "terminal_close":
        if (!terminalAllowed(session, cmd.agentId)) break;
        agentManager.closeTerminal(cmd.agentId, {
          kind: "member",
          id: session.userId,
          name: getUserById(session.userId)?.name ?? session.userId,
        });
        break;
      case "terminal_restart":
        // Restart is a terminal-I/O capability: it can kill a foreground
        // process, so it carries the same room visibility gate as open/input.
        if (!terminalAllowed(session, cmd.agentId)) break;
        agentManager.restartTerminal(cmd.agentId, {
          kind: "member",
          id: session.userId,
          name: getUserById(session.userId)?.name ?? session.userId,
        });
        break;
    }
  } catch (err) {
    console.error(`[inbound] ${cmd.type} failed:`, err);
  }
}

// logBootBanners: the two boot-time console banners (resolved public-origin
// note + the pre-claim SSH/claim instructions). Pure logging; startServer()
// calls it only when not quiet. Body left at prior indentation.
function logBootBanners(): void {
  // The public origin is the canonical URL the server expects browsers to hit.
  // We compare it against the Origin header on WS upgrades and unsafe HTTP
  // requests, and bake it into invite URLs. Resolution precedence is
  // office-config.json `publicOrigin` > localhost fallback. Pre-claim we
  // force the localhost fallback so the cookie attributes match the bind;
  // any configured value re-engages once an owner exists.
  {
    const resolved = buildPublicOrigin();
    // Pre-claim: the banner below covers everything, no need for a separate
    // log line.
    if (!isProcessPreClaim()) {
      if (resolved.source === "config") {
        console.log(
          `[auth] using publicOrigin from office-config.json: ${resolved.origin}`,
        );
      } else if (resolved.source === "localhost") {
        console.log(
          `[auth] local-only mode: no public origin configured, using ${resolved.origin}. See https://isomux.com/docs/access-and-invites for remote-access setups.`,
        );
      }
    }
  }

  // First-time-setup banner. When no owner exists, the SPA shell is replaced
  // by the setup form (name + setup key) at http://localhost:PORT/setup. The
  // listener binds loopback before the claim, so the form is reachable from
  // the same machine or through an SSH port-forward from another. The link
  // carries the key in its fragment, so a click fills the form.
  //
  // The SSH target is printed as a template (<user>@<host>) rather than auto-
  // detecting via os.userInfo()/os.hostname(): the local username on the
  // server box is often not the SSH login name (think `nil` vs `root`, or
  // hosting-provider-assigned users), and os.hostname() returns the box's
  // internal hostname rather than a network-routable address. We do show the
  // detected values as a hint, but the operator is supposed to replace them
  // with whatever SSH target they normally use for this machine.
  const setupKey = activeSetupKey();
  if (isProcessPreClaim() && setupKey) {
    let detectedUser = "";
    try {
      detectedUser = userInfo().username;
    } catch {}
    let detectedHost = "";
    try {
      detectedHost = osHostname();
    } catch {}
    const detectedHint =
      detectedUser && detectedHost
        ? ` (this machine reports ${detectedUser}@${detectedHost}; use whatever you actually SSH as)`
        : "";
    const link =
      setupKey.source === "file"
        ? `http://localhost:${PORT}/setup#key=${setupKey.key}`
        : `http://localhost:${PORT}/setup`;
    console.log("");
    console.log(
      "================================================================",
    );
    console.log("  Isomux: no owner has been set up for this office yet.");
    console.log("");
    console.log("  TO CLAIM OWNERSHIP from THIS machine, open:");
    console.log(`    ${link}`);
    if (setupKey.source === "file") {
      console.log(`  The setup key is also in ${setupKeyFile()}.`);
    } else {
      console.log("  The setup key is the value of ISOMUX_SETUP_KEY.");
    }
    console.log("");
    console.log("  TO CLAIM OWNERSHIP from another machine:");
    console.log(
      `    1. On that machine, open a tunnel to this box${detectedHint}:`,
    );
    console.log(`         ssh -L ${PORT}:localhost:${PORT} <user>@<host>`);
    console.log("    2. Open the link above in that browser.");
    console.log("");
    console.log(
      "  After you claim, Settings → Office → Access lets you enable",
    );
    console.log(
      "  external access so everyday use doesn't need the SSH tunnel.",
    );
    console.log(
      "================================================================",
    );
    console.log("");
  }
} // end logBootBanners

// runBackgroundBoot: post-listen boot work (turn-runner deps, agent restore,
// schedulers, backup, admin socket). Each
// background job is individually skippable so the in-process test harness boots
// with no timers / no network / no LLM. Returns the restore promise
// so the harness can await a fully-restored office; production fires and forgets
// (listener already up). Body left at prior indentation; prettier normalizes.
function runBackgroundBoot(
  startOpts: StartServerOpts,
  server: Server<WsData>,
): Promise<void> {
  if (!startOpts.skipUpdateChecker) {
    onUpdateChange((status) => {
      broadcast({ type: "update_status", ...status });
    });
    startUpdateChecker();
  }

  agentManager.configureAgentTurnDeps();
  // Before the boot restore: an agent above its manager's agent ceiling comes
  // back at the ceiling.
  agentManager.setMemberCeilingClamp(memberCeiling.clampedGrant);
  // The apps of a member whose pack has no apps write stay stopped across a
  // reboot or a crash between a pack save and its stops.
  stopAppsThatMayNotRun(() => true);
  // The first boot after an unlock starts the apps the lock stopped.
  try {
    const started = restartAppsAfterLock(
      STATE_ROOT,
      lockdownApps(appSupervisor),
      (name) => appsMayRunFor(appRegistry.get(name)?.userId),
    );
    if (started.length > 0)
      console.log(
        `[lockdown] started the apps the lock stopped: ${started.join(", ")}`,
      );
  } catch (err) {
    console.error("[lockdown] could not start the apps the lock stopped:", err);
  }

  const restorePromise = (async () => {
    const restored = await agentManager.restoreAgents();
    if (restored.length > 0) {
      console.log(
        `Restored ${restored.length} agent(s): ${restored.map((a) => a.name).join(", ")}`,
      );
    }
    migrateOldPages(startOpts);
    // A step done while the server was down closes its ask now, once the
    // agents are back to hear it.
    stepsChanged();
    // A sudo run in progress when the server stopped: its agent hears now
    // that the result is unknown.
    sudoRequests?.recover();
    // An ask's Run in progress when the server stopped (task c3b91695): the
    // card shows it lost, and its agent hears that the result is unknown.
    try {
      for (const { entry, run } of askStore?.markLostRuns() ?? [])
        agentManager.emitAgentAskRunReport(
          entry.agentId,
          entry.id,
          askRunLine(run),
          run.by,
          askRunLostNotice(
            entry.id,
            getUserById(run.by)?.name ?? "A member",
            run,
          ),
        );
    } catch (err) {
      console.warn("[bootstrap] the lost ask runs could not be marked:", err);
    }
    try {
      backfillOfficeFreeModelMarks();
    } catch (err) {
      console.warn("[bootstrap] free model mark backfill failed:", err);
    }
    try {
      const justClaimedOwner = listUsers().find((u) => u.role === "owner");
      if (justClaimedOwner && takeOwnerClaimedInThisProcess()) {
        await seedWelcomeAgentsForFirstOwner!(justClaimedOwner.name);
      }
      await ensureReceptionistAtBoot();
    } catch (err) {
      console.warn("[bootstrap] onboarding boot check failed:", err);
    }
    // One-time hygiene pass: remove any stale roomIds from users'
    // allowedRooms / notifRooms that don't match a currently-existing
    // room. Catches references left behind by close_room calls from
    // earlier versions that didn't prune user records inline. Cheap
    // no-op once a deployment has converged.
    const validIds = agentManager.getOrdinaryRooms().map((r) => r.id);
    const pruned = pruneStaleRoomRefs(validIds);
    if (pruned > 0) {
      console.log(
        `[startup] pruned stale room refs from ${pruned} user record(s)`,
      );
      emitUsersList();
    }
  })();

  if (!startOpts.skipSchedulers) cronjobManager.startCronjobScheduler();

  // Boot the scheduled-message tick loop (catch-up of past-due entries happens
  // on its first, slightly-delayed tick). Same skipSchedulers gate as cron so
  // `bun test` runs no timers; stopServer() clears the timers defensively.
  if (!startOpts.skipSchedulers) scheduledMessageManager.start();

  // Start a WhatsApp bridge for each linked member. An office with none
  // downloads and starts nothing.
  void whatsappSupervisor.boot().catch(() => {
    console.error("[whatsapp] the boot of the WhatsApp bridges failed");
  });
  // Start a gateway child for each connected Discord bot.
  void discordSupervisor.boot().catch(() => {
    console.error("[discord] the boot of the Discord bots failed");
  });

  // Resume the repeat of open pages from their saved last attempt.
  if (!startOpts.skipSchedulers) {
    pagerDelivery.start();
    webPushDelivery.start();
    githubSync.start();
  }

  // OAuth MCP servers: a refresh pass now (the access tokens are in memory
  // only), then one a minute for tokens near their expiry.
  if (!startOpts.skipSchedulers && mcpOAuth) {
    const oauth = mcpOAuth;
    // A backstop: the refresher catches its own failures.
    const refresh = () =>
      void oauth.refreshDue().catch(() => {
        console.error("[mcp] an OAuth refresh pass failed");
      });
    refresh();
    mcpOAuthTimer = setInterval(refresh, MCP_OAUTH_TICK_MS);
  }

  // Daily ~/.isomux/ backup tarball with N=7 retention. See server/backup.ts.
  if (!startOpts.skipBackups) startBackupScheduler();

  if (!startOpts.quiet)
    console.log(`Isomux running at http://localhost:${server.port}`);

  // Admin Unix socket - lets root mint a recovery URL for an existing owner.
  // Starts after the HTTP listener so the printed URL is immediately
  // openable. Optional surface; a startup failure logs but doesn't block the
  // server.
  if (!startOpts.skipAdminSocket) startAdminSocket();

  return restorePromise;
} // end runBackgroundBoot

// startServer: the single boot entrypoint. Composes the extracted boot steps in
// the exact order the old top-level body ran them. Production calls it from the
// import.meta.main guard below; the in-process test harness imports and calls
// it with injected managers / a FakeBackend resolver on an ephemeral port.
// Production behavior is unchanged (opts default to today's defaults).
//
// SINGLE INSTANCE PER PROCESS: it binds a listener and writes process-global
// module state (managers, auth boot state, the loopback-origin port). Call the
// returned ServerHandle.stop() before calling startServer() again in the same
// process, or the prior listener leaks. The test harness (startTestServer)
// enforces this with a process-global lock; a direct caller must self-manage.

export interface RescueSeams {
  requestStop?: () => void;
  spawnExportChild?: OfficeExportJobsDeps["spawnChild"];
  /** The folder exports/ goes in. Default: the backup folder. */
  exportBaseDir?: string;
}

export interface StartServerOpts {
  // Isolated browser-action deadline seam; production uses 30 seconds.
  browserExtensionActionDeadline?: () => number;
  // Tests override the production install-kind marker without touching /etc.
  installKind?: InstallKind;
  // Tests override the host platform to exercise the non-Linux seeding and
  // engine availability without a Mac.
  hostPlatform?: NodeJS.Platform;
  // The sudo that sudo requests probe and run (task 43a28eed). Production
  // omits it (/usr/bin/sudo); tests pass a stand-in that never runs as root.
  sudoPath?: string;
  // Listen port. Omit → process.env.PORT || 4000 (production). Tests pass 0 for
  // an ephemeral port.
  port?: number;
  // Account-client factories are a narrow test seam around provider CLI probes.
  // Production omits them and uses the real Codex and Claude clients.
  createCodexAccountClient?: CreateCodexAccountClient;
  createClaudeAccountClient?: CreateClaudeAccountClient;
  // Override the backend resolver for both factories (tests pass a FakeBackend
  // resolver). Ignored when agentManager/cronjobManager are supplied directly.
  resolveBackend?: typeof getBackend;
  // Test seam for first-office OpenCode discovery. Production uses the same
  // backend model-list path as the picker.
  discoverWelcomeOpenCodeModels?: (
    userId: string,
  ) => Promise<BackendModelWire[]>;
  // Test seam for the seed's discovery timeout and the background retry after
  // a seed used the fallback model.
  welcomeModelTiming?: WelcomeModelTiming;
  // Test seam for the timeout of one check of a free model, and the budget
  // of a search over the candidates.
  freeModelProbeTiming?: FreeModelProbeTiming;
  // Test seam for the Codex default-model discovery of a spawn or cron job
  // with no model. Production uses the same backend model-list path as the
  // picker. The resolver aborts `signal` at its timeout.
  listCodexModels?: (input: {
    userId: string;
    cwd: string;
    signal: AbortSignal;
  }) => Promise<BackendModelWire[]>;
  // Test seam for that discovery's timeout (production: 10 s).
  codexModelDiscoveryTimeoutMs?: number;
  // Inject the app supervisor. Tests MUST pass a fake: the production one
  // writes systemd unit files and runs systemctl against the real user manager,
  // which is shared with whatever office is running on the same box.
  appSupervisor?: AppSupervisor;
  // Inject the pager's HTTP send. Tests pass a stub: no test sends to Discord.
  pagerFetch?: (url: string, init: RequestInit) => Promise<Response>;
  // Inject the GitHub issue sync's HTTP calls (task 7fc83592). Tests pass a
  // fake GitHub: no test calls api.github.com.
  githubSyncFetch?: (url: string, init: RequestInit) => Promise<Response>;
  // The same for Web Push: no test sends to a push service.
  webPushFetch?: (url: string, init: RequestInit) => Promise<Response>;
  // Inject the Test button's HTTP calls (integrations A3). Tests pass a stub.
  connectionTestFetch?: ConnectionTestFetch;
  // The floors.add probe's fetch and timeout (server/office-card.ts). Tests
  // shorten the timeout; production uses the real fetch and the default.
  officeProbe?: OfficeProbeOptions;
  // Background-job skips. Tests set these so `bun test` does no timers, no
  // network (update checker), no daily backup, and no admin socket.
  skipSchedulers?: boolean;
  skipBackups?: boolean;
  // The rescue routes' seams (task cdd7883d). Only the production main passes
  // requestStop (requestStopForLock); without it a lock only logs, so no test
  // can SIGTERM its own process. Tests pass a fake export child and folder.
  rescue?: RescueSeams;
  skipAdminSocket?: boolean;
  skipUpdateChecker?: boolean;
  // Internal backup status provider. The in-process harness supplies a fresh
  // value so a skipped backup scheduler cannot expose host backup state. The
  // route's production projection still runs over this internal shape.
  getBackupStatus?: () => BackupStatus;
  // The roots the storage route and /isomux-storage measure. Defaults to
  // productionStorageRoots over getBackupStatus; the harness supplies its own
  // so a test boot reads neither the host backup dir nor update.conf.
  storageRoots?: () => StorageRoots;
  // Await agent restore before resolving (tests that assert on a
  // fully-restored office). Production leaves this false: fire-and-forget so the
  // listener is up immediately, matching today's behavior.
  awaitRestore?: boolean;
  // Suppress the boot banners / "running at" log (tests).
  quiet?: boolean;
  // The webhook ingress clock (dedup window, limits, row times). Tests pass a
  // fake clock; production uses Date.now.
  webhookNow?: () => number;
  // The Enterprise Contract seat service (server/enterprise-seats.ts). Tests
  // point it at a fake service and shorten the timeout; production uses
  // cloud.isomux.com and 10 s.
  enterpriseSeats?: { url?: string; timeoutMs?: number };
}

export interface ServerHandle {
  server: Server<WsData>;
  port: number;
  agentManager: AgentManager;
  cronjobManager: CronjobManager;
  // The GitHub issue sync (task 7fc83592). skipSchedulers leaves its timer
  // off; a test runs a pass with tick().
  githubSync: GithubSync;
  // Production GuardDeps adapter exposed for the contract to assert agreement
  // with the live ACL.
  guardDeps: GuardDeps;
  // Stop the listener (force-closing live sockets) and return the in-process
  // module singletons to a known-idle state so the next startServer() in the
  // same process is clean. See stopServer.
  stop: () => Promise<void>;
}

// Reset this module's own module-level collections so a repeated in-process boot
// doesn't inherit a prior server's sockets / id counter.
function resetServerModuleState(): void {
  resetMemberUsageCap();
  resetProviderFallback();
  browsers.clear();
  apiTokenSockets.clear();
  connectionIdCounter = 0;
  idempotencyCache._reset();
  resetOfficeLockGate();
}

async function stopServer(server: Server<WsData>): Promise<void> {
  // First, before any await: this manager's sessions stay open (below), and a
  // late event from one must not write this office over the next boot's files.
  agentManager.stop();
  // Force-close active sockets and stop accepting, freeing the (ephemeral) port
  // before the next harness boot.
  extensionService?.stop();
  extensionSessions?.stop();
  pagerDelivery?.stop();
  webPushDelivery?.stop();
  // Ends the bridges and keeps the links: the next start connects again.
  await whatsappSupervisor?.shutdown();
  // Delivers the waiting Discord messages, then ends the gateway children.
  await discordSupervisor?.shutdown();
  githubSync?.stop();
  uiBuildTracker?.stop();
  officeExportJobs?.stop();
  if (mcpOAuthTimer) clearInterval(mcpOAuthTimer);
  mcpOAuthTimer = null;
  await server.stop(true);
  // Editor file-watches are keyed by connectionId in editorWatchers; the WS
  // close handlers that server.stop(true) triggers unregister them. There is no
  // global watch registry, and 0.3 opens no editor files, so a stopAllWatches()
  // is intentionally out of 0.3 scope - add a real registry only if a later
  // harness opens editor files (don't add speculative plumbing now).
  //
  // Agent backend sessions are likewise not closed here: the next
  // createManagers() drops this manager instance, and agentManager.stop() above
  // keeps their late events off the state files.
  browsers.clear();
  apiTokenSockets.clear();
  _testClearPresence();
  // Neutralize the auth.ts boot hooks so a stale closure from this boot can't
  // fire into a torn-down broadcast set between stop() and the next start();
  // the next startServer() re-registers them against the new instance.
  setRoomsSnapshotProvider(() => []);
  setOnInviteConsumed(() => {});
  setOnSessionsChanged(() => {});
  setOnUserAccessChanged(() => {});
  setOnOwnerCreated(async () => {});
  setInviteSeatGate(null);
  setAppOwnerAgentResolver(() => null);
  seedWelcomeAgentsForFirstOwner = null;
  stopFallbackRepick();
  setApiTokenStreamSinks({ logEntry: () => {}, revoked: () => {} });
  // Clear the cron module-read bridge so command-handlers/usage-report don't
  // read a dead manager between boots, and the loopback origin port.
  registerProductionCronjobManagerForModuleReads(null);
  // The env-loader reads the office env file through this manager's state; a
  // later spawn in the same process must not see a stopped server's file.
  setOfficeEnvFileProvider(() => null);
  // Stop the scheduled-message tick timers so a stale closure can't fire into
  // the next boot's agentManager (idempotent; a no-op when skipSchedulers kept
  // them from starting).
  scheduledMessageManager?.stop();
  setLoopbackOriginPort(null);
}

// Pages are paged asks (task 74e8fc07). The agent manager's own page (a gone
// OpenCode model) raises one. Before any route serves, each open paged ask
// gets its page id and its page index row.
function bootPagedAsks(): void {
  const asks = askStore;
  if (!asks) return;
  agentManager.attachPagerStore({
    raise: ({ source, targetUserId, fields }) => {
      const agentId = source.kind === "agent" ? source.agentId : "";
      const result = raisePage(asks, {
        source: { kind: "agent", agentId },
        agentId,
        memberUserId: targetUserId,
        fields,
      });
      return result.outcome === "created" || result.outcome === "updated"
        ? {
            outcome: result.outcome,
            entry: pagerEntryFromAsk(result.entry, null, pagerCompat),
          }
        : { outcome: "too_many" };
    },
  });
  try {
    asks.backfillPages();
  } catch (err) {
    console.error(`[pager] the page id backfill failed: ${errMessage(err)}`);
  }
}

// The old pager store's pages become paged asks and closed asks
// (server/pager-migration.ts), once the agents are back: a page whose agent
// is not restored would close. The old files are only read. The delivery
// engines started before it, so each migrated page is armed on its send
// record's schedule.
function migrateOldPages(startOpts: StartServerOpts): void {
  const asks = askStore;
  if (!asks) return;
  const pages = migratePagerAtBoot(
    {
      pager: join(STATE_ROOT, "pager.json"),
      archive: join(STATE_ROOT, "pager-resolved.jsonl"),
      done: join(STATE_ROOT, "pager-migration.json"),
    },
    {
      asks,
      history: officeAskHistory(),
      transaction: (fn) => officeAuditStore().db.transaction(fn)(),
      now: () => Date.now(),
      agentLive: (agentId) => agentManager.getAgent(agentId) !== undefined,
      isMember: (userId) => getUserById(userId) !== undefined,
      memberIdByName: (name) => getUserByName(name)?.id ?? null,
      app: (name, registrationGen) => {
        const app = appRegistry.get(name);
        if (!app || appRegistrationGeneration(app) !== registrationGen)
          return null;
        const target = app.messageTargetAgentId ?? app.createdByAgentId;
        return {
          createdAt: app.createdAt,
          targetAgentId:
            target && agentManager.getAgent(target) ? target : null,
        };
      },
    },
  );
  if (startOpts.skipSchedulers || pages.length === 0) return;
  const ids = new Set(pages.map((page) => page.id));
  const members = new Set(
    asks
      .listAll()
      .filter((e) => e.page?.pageId !== undefined && ids.has(e.page.pageId))
      .flatMap((e) => Object.keys(e.page?.delivery ?? {})),
  );
  for (const userId of members) {
    pagerDelivery.rescheduleMember(userId);
    webPushDelivery.rescheduleMember(userId);
  }
}

export async function startServer(
  opts: StartServerOpts = {},
): Promise<ServerHandle> {
  resetServerModuleState();
  bootPrelude();
  createManagers(opts, {
    liveEmit,
    stepsChanged,
    mayUseExtension,
    mayReachExtension,
    shareWithAgent,
    deliverCronjobToAgent,
    ordinaryScheduleMaker,
    pushAskChange,
    askAudienceIds: (entry) => askMemberIds(entry, askAudience),
    askAudience,
    secretStore,
    broadcast,
    canAccess,
    isLobbyRoom,
    UI_DIST,
  });
  bootPagedAsks();
  configureWelcomeModelTiming(opts);
  migrateManagedEnvAtBoot({
    office: {
      label: "office variables",
      path: agentManager.getOfficeSettings().envFile,
      legacyExists: legacyEnvFileExists,
      managedExists: managedOfficeEnvExists,
      readManaged: readManagedOfficeEnv,
      readLegacy: readEnvFile,
      writeManaged: writeManagedOfficeEnv,
      clearLegacyPath: () => {
        const settings = agentManager.getOfficeSettings();
        agentManager.setOfficeSettings(settings.prompt, null, settings.name);
      },
    },
    log: (message) => console.error(message),
  });
  registerBootHooks();
  wireEventSinks();
  // Migrate any PERSISTED owner from the old materialized-grants model to
  // rule-based access (seed hidden from old grants, then clear
  // grants). Idempotent; needs rooms (createManagers, synchronous) + users
  // (lazy load) ready. Fresh-install owners are created later via /auth/claim
  // and seeded grants=[] directly (auth.ts), so this is a no-op for them.
  migrateOwnersToRuleBasedAccess();
  settleMemberSkillFolders();
  settleRemovedMembers();
  // After the managers (the supervisor is assigned in createManagers) and
  // before the listener: an app's token should be settled before anything can
  // present one.
  const appsOff = appHostingUnsupported();
  if (appsOff !== null) {
    console.log(`[apps] app hosting is off: ${appsOff}`);
  } else {
    reconcileAppTokensAtBoot();
    // Then their addresses, on the units the pass above may just have written.
    reconcileAppUrlsAtBoot();
    // Then their vault secrets: a lost file is written again, and a unit
    // written before app secrets existed gets its line.
    await appSecrets.sync({ boot: true });
  }
  // A member renamed before renames reached the hooks (task 3278f29c): each
  // hook takes its owner's name now. No record keeps the name.
  webhookRegistry.syncOwnerNames((userId) => getUserById(userId)?.name);
  // Before the listener: the delivery logs load (and a crash's `pending` rows
  // become retryable) before the first delivery can arrive.
  webhookIngress = createWebhookIngress({
    registry: webhookRegistry,
    now: opts.webhookNow,
    agentReachableByUser: webhookAgentReachable,
    prepareAgent: (agentId) => agentManager.prepareEnqueue(agentId),
    // As sendAsApp: no steer, so a delivery never interrupts a turn.
    enqueueToAgent: (agentId, sender, text) => {
      const result = agentManager.enqueueMessage(agentId, { sender, text });
      return result.ok ? { ok: true } : { ok: false, code: result.error };
    },
    cronjobRunnableByUser: webhookCronjobRunnable,
    startCronjobRun: (cronjobId, webhook, block) => {
      const run = cronjobManager.runCronjobFromWebhook(
        cronjobId,
        webhook,
        block,
      );
      return run ? { runId: run.id } : null;
    },
  });
  webhookIngress.recover();
  enterpriseSeats = createEnterpriseSeats({
    stateRoot: STATE_ROOT,
    countMembers: () => listUsers().length,
    installKind: opts.installKind ?? INSTALL_KIND,
    publicOrigin: () => loadServerConfig().publicOrigin ?? null,
    url: opts.enterpriseSeats?.url,
    timeoutMs: opts.enterpriseSeats?.timeoutMs,
    onLockChange: (locked) => liveEmit("office_enterprise_lock", { locked }),
  });
  executorDeps = buildExecutorDeps(
    opts.getBackupStatus,
    opts.installKind,
    opts.connectionTestFetch,
    opts.officeProbe,
    opts.sudoPath,
    opts.rescue,
  );
  // What a crash or an earlier run left in the exports folder: no owner
  // export outlives the office that made it.
  officeExportJobs?.sweep();
  const server = buildServer(opts);
  // Bun.serve resolves a concrete TCP port (including when opts.port is 0). The
  // `| undefined` in the type is for unix-socket servers, which we never create.
  const port = server.port;
  if (port == null) {
    await server.stop(true);
    throw new Error("startServer: Bun.serve did not resolve a TCP port");
  }
  // Make buildPublicOrigin's loopback fallback match the actual bound port so
  // origin checks (WS upgrade + HTTP form posts) and minted localhost URLs are
  // consistent. Production: server.port === PORT, so byte-for-byte unchanged.
  setLoopbackOriginPort(port);
  if (!opts.quiet) logBootBanners();
  const restore = runBackgroundBoot(opts, server);
  if (opts.awaitRestore) {
    // The listener is already bound; if restore rejects, stop it so we do not
    // leak the port (and the harness single-instance lock), then rethrow.
    try {
      await restore;
    } catch (err) {
      await stopServer(server);
      throw err;
    }
  }
  return {
    server,
    port,
    agentManager,
    cronjobManager,
    githubSync,
    guardDeps: buildLiveGuardDeps(),
    stop: () => stopServer(server),
  };
}

/**
 * Process entry point: the CLI fast-path, the server boot, and the background
 * sweeps only the main process should own.
 *
 * A function rather than a bare `import.meta.main` block because there are two
 * ways in - this file directly (current units) or the `server/index.ts` shim
 * (units written before the rename). Only one of them is `import.meta.main`, so
 * the guard on its own would leave the shim path booting nothing.
 */
// The locked office's listener binds where the office's would: loopback
// unless the deployment opened it (bootPrelude has the full rule; a locked
// office reads the config without writing it back).
async function startLockedOfficeFromBoot(): Promise<void> {
  const cfg = loadServerConfig();
  const external = cfg.externalAccess ?? cfg.publicOrigin !== null;
  const loopback = cfg.networkBind === "loopback" || !external;
  await startLockedOffice({
    stateRoot: STATE_ROOT,
    exportBaseDir: lockExportBaseDir(),
    port: PORT,
    ...(loopback ? { hostname: "127.0.0.1" } : {}),
    apps: lockdownApps(defaultAppSupervisor(process.platform)),
  });
}

/** The lock effects over this office's state, at the lockdown route's stop. */
function applyOfficeLockEffects(): void {
  applyLockEffects({
    stateRoot: STATE_ROOT,
    apps: lockdownApps(appSupervisor),
    exportBaseDir: lockExportBaseDir(),
    now: new Date(),
  });
}

function lockdownApps(supervisor: AppSupervisor): LockdownApps {
  return {
    list: () => appRegistry.list().map((app) => app.name),
    // Anything not known to be stopped is stopped (fail safe).
    isActive: (name) =>
      supervisor.states([name]).get(name)?.state !== "stopped",
    stop: (name) => supervisor.stop(name),
    start: (name) => supervisor.start(name),
  };
}

function lockExportBaseDir(): string | null {
  try {
    return currentBackupDir();
  } catch (err) {
    console.error("[lockdown] could not read the backup folder:", err);
    return null;
  }
}

export async function runOfficeMain(): Promise<void> {
  // CLI sub-command fast-path. `bun run server/isomux-office.ts owner-login
  // --name X` dynamic-imports the CLI, which prints the root recovery command,
  // and exits before the heavy boot below. Inside this function rather than at
  // module scope, so importing this module (the in-process test harness) can
  // never process-exit on a stray argv token.
  if (process.argv[2] === "owner-login") {
    const { runAdminCli } = await import("./admin-cli.ts");
    runAdminCli(process.argv.slice(2));
    process.exit(0);
  }
  // Name this process `isomux` rather than `bun`, so out-of-memory protection
  // can shield the office server without also shielding the agent builds that
  // share the name `bun` (see server/process-name.ts). Here rather than at
  // module scope because it renames the calling thread: the in-process test
  // harness calls startServer() directly and must not rename itself. After the
  // CLI fast-path above, which is a different program and keeps its own name.
  setProcessName();
  // At a systemd stop, SIGKILL what still runs in the unit's cgroup a short
  // grace after the signal, so a process that ignores SIGTERM cannot hold the
  // restart for the unit's stop timeout (server/stop-reap.ts). Decided before
  // the marker is set: every process this office starts inherits it.
  armStopReap();
  // A locked office (task cdd7883d) starts nothing but the locked page: no
  // auth state, secrets proxy, agent, schedule or bridge. The root marker's
  // dir is the constant, never an override from the environment.
  if (readLockState(STATE_ROOT).locked) {
    await startLockedOfficeFromBoot();
    return;
  }
  // Before anything reads PATH: agents and terminals inherit it.
  if (process.env.PATH)
    process.env.PATH = pathWithBundledClaude(
      normalizeBunRunPath(process.env.PATH, process.cwd()),
      CLAUDE_NATIVE_BIN,
    );
  // The other half of the same protection: mark every process this office
  // starts as a better candidate for the kill than the office itself, since
  // they all inherit the server's own score otherwise (server/oom-stamp.ts).
  // Here for the same reason as the sweeps below - main process only, never
  // inherited by the in-process test harness - and it stamps whatever is
  // already running, so it can start before the server does.
  startAgentOomStamping();
  // Split mode (task 01f5038c): agents run as a second OS user through the
  // agent runner. A failed check stops the start; there is no fallback.
  const split = await startSplitMode(process.env, STATE_ROOT);
  if (split.mode === "refused") {
    for (const reason of split.reasons)
      console.error(`[split] refusing to start: ${reason}`);
    process.exit(1);
  }
  if (split.mode === "split") setAgentHost(split.host);
  // Close the state root to other OS users (task fe7619bc). After the split
  // check, which must still see and refuse a root that is not private.
  secureStateRoot();
  // Before any agent starts: an office with a secret gets its proxy and its
  // placeholders. An office without one changes nothing.
  try {
    await secretsRuntime.enable();
  } catch {
    console.error("[secret-proxy] could not start the secrets proxy");
  }
  // Each agent in its own PID namespace (task 8db21c8b): the probe ends
  // before the restore starts any agent, through the agent host that spawns.
  // A wrapped spawn that fails its bwrap setup probes again.
  setIsolationSetupFailureListener(() => void reportIsolationSetupFailure());
  await runProcessIsolationProbe();
  // The Codex hook build and trust probe take seconds, so the boot does not
  // wait for them: a Codex spawn that starts before they end waits for them.
  // After the isolation probe, so the trust probe sees its result. Codex
  // preflight is deliberately fail-open. Keep the office available; every
  // later Codex spawn retries preparation and emits the loud safety warning
  // if the artifact is still unavailable.
  void prepareCodexSafetyHookArtifact().catch((err) => {
    console.error("[codex safety] artifact unavailable at boot:", err);
  });
  const handle = await startServer({
    rescue: { requestStop: () => requestStopForLock(applyOfficeLockEffects) },
  });
  // An owner export's child ends with the office.
  runAtServerStop(async () => officeExportJobs?.stop());
  // Idle-eviction sweep: every minute, demote agents idle past the threshold to
  // lazy so they release their ~165MB subprocess. (Boot already lazy-restores
  // everyone; this re-demotes agents that woke and then went quiet again.) Lives
  // here, NOT in startServer - the in-process test harness calls startServer()
  // directly and must not inherit a background timer. unref so it never keeps
  // the process alive on its own.
  const idleSweep = setInterval(() => {
    void handle.agentManager
      .sweepIdleAgents()
      .catch((err) => console.error("[idle-evict] sweep failed:", err));
    try {
      // A delete for good may be the change a step ask waits for. At boot,
      // the reconcile after the agents' restore reads it.
      if (purgeExpiredMembers() > 0) stepsChanged();
    } catch (err) {
      console.error("[users] the removed-member purge failed:", err);
    }
  }, 60_000);
  idleSweep.unref?.();
  // Queue delivery watchdog: self-heal sweep so a queued message can never sit
  // indefinitely while its agent is idle - re-triggers
  // missed flushes and force-recovers wedged ones (see sweepStuckFlushes).
  // Same placement rationale as the idle sweep: main-process only, so the
  // in-process test harness never inherits a background timer.
  const queueWatchdog = setInterval(() => {
    void handle.agentManager
      .sweepStuckFlushes()
      .catch((err) => console.error("[queue-watchdog] sweep failed:", err));
  }, 30_000);
  queueWatchdog.unref?.();
  // OpenCode agents' models: a while after boot, so the check does not race
  // the restore, then once a day.
  const modelCheck = () =>
    void checkOpenCodeAgentModels().catch((err) =>
      console.error("[opencode] model check failed:", err),
    );
  const modelCheckStart = setTimeout(() => {
    modelCheck();
    setInterval(modelCheck, OPENCODE_MODEL_CHECK_INTERVAL_MS).unref?.();
  }, OPENCODE_MODEL_CHECK_BOOT_DELAY_MS);
  modelCheckStart.unref?.();
  // Enterprise seats: the office tells the seat service its member count a
  // few seconds after boot, then every hour, so the account corrects drift.
  // Same placement rationale as the idle sweep.
  const enterpriseCheckIn = () => {
    try {
      void enterpriseSeats
        ?.checkIn()
        .catch((err) =>
          console.error(
            "[enterprise-seats] check-in failed:",
            err instanceof Error ? err.message : "error",
          ),
        );
    } catch (err) {
      console.error(
        "[enterprise-seats] check-in failed:",
        err instanceof Error ? err.message : "error",
      );
    }
  };
  const enterpriseCheckInStart = setTimeout(() => {
    enterpriseCheckIn();
    setInterval(enterpriseCheckIn, ENTERPRISE_CHECK_IN_INTERVAL_MS).unref?.();
  }, ENTERPRISE_CHECK_IN_BOOT_DELAY_MS);
  enterpriseCheckInStart.unref?.();
}

const OPENCODE_MODEL_CHECK_BOOT_DELAY_MS = 2 * 60_000;
const OPENCODE_MODEL_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const ENTERPRISE_CHECK_IN_BOOT_DELAY_MS = 5_000;
const ENTERPRISE_CHECK_IN_INTERVAL_MS = 60 * 60_000;

if (import.meta.main) await runOfficeMain();
