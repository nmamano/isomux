import type { Server, ServerWebSocket } from "bun";
import type {
  ServerMessage,
  ClientCommand,
  BackendModelWire,
  AgentBackendType,
  AgentInfo,
  RoomWire,
  PresenceInfo,
  UserRecord,
  OfficeWire,
} from "../shared/types.ts";
import {
  listAllPresence,
  refreshPresenceForUser,
  removePresence,
  setPresence,
  _testClearPresence,
} from "./presence.ts";
import type { AgentEvent } from "./internal-types.ts";
import { runPreUseridBackupIfNeeded } from "./migrations.ts";
import { createProductionAgentManager } from "./agent-manager.ts";
import type { AgentManager } from "./agent-manager.ts";
import { getBackend } from "./backends/index.ts";
import {
  createProductionCronjobManager,
  registerProductionCronjobManagerForModuleReads,
} from "./cronjob-manager.ts";
import type { CronjobManager } from "./cronjob-manager.ts";
import {
  loadRecentCwds,
  saveRecentCwd,
  getFilePath,
  saveFile,
  loadServerConfig,
  saveServerConfig,
  loadEnabledPlugins,
} from "./persistence.ts";
import { loadPlugins } from "./plugins.ts";
import { normalizePublicOrigin } from "../shared/public-origin.ts";
import { KILLED_AGENT_CHIP_CAP } from "../shared/types.ts";
import type { Attachment, InviteWire, SessionWire } from "../shared/types.ts";
import {
  startUpdateChecker,
  getUpdateStatus,
  onUpdateChange,
} from "./update-checker.ts";
import { startBackupScheduler, getBackupStatus } from "./backup.ts";
import { resolveCwd } from "./cwd-utils.ts";
import type { TaskItem } from "../shared/types.ts";
import {
  CODEX_MODELS,
  isValidStatus,
  isValidPriority,
  type AgentOutfit,
} from "../shared/types.ts";
import { errMessage } from "../shared/errors.ts";
import {
  buildProductionGuardDeps,
  type GuardDepsLiveReaders,
} from "./identity/guard-deps.ts";
import { type GuardDeps } from "./identity/guards.ts";
import {
  listUsers,
  getUser,
  getUserById,
  getUserByName,
  pruneStaleRoomRefs,
  updateUserById,
  deleteUser,
  wouldDeleteLeaveNoOwner,
} from "./users.ts";
import { hostname as osHostname, userInfo } from "os";
import { watchFile, stopWatch, type FileWatcher } from "./file-editor.ts";
import { mimeTypeForFilename } from "./mime-types.ts";
import { join } from "path";
import {
  authenticate,
  checkOrigin,
  securityHeaders,
  setOnOwnerCreated,
  tryHandleAuthRoute,
} from "./auth-middleware.ts";
import {
  buildPublicOrigin,
  evictSessionsForUserId,
  freezeBootState,
  isProcessBoundLoopback,
  isProcessPreClaim,
  listActiveSessions,
  listActiveSessionsForUserId,
  listInvites,
  listInvitesForUsername,
  logoutBySessionHash,
  mintInvite,
  readSessionCookie,
  registerSocket,
  resolveSessionHashByPrefix,
  revalidateByHash,
  revokeActiveSessionByPrefixForUserId,
  revokeInviteByPrefix,
  revokeOutstandingInviteByPrefixForUsername,
  revokeSessionByPrefix,
  toInviteWire,
  sessionContextFor,
  setOnInviteConsumed,
  setOnSessionsChanged,
  setPublicOriginFallback,
  setLoopbackOriginPort,
  setRoomsSnapshotProvider,
  unregisterSocket,
  validateSession,
  wouldRevokeLeaveOfficeUnreachable,
  type MintErr,
  type RevokeResult,
  type ScopedSessionRevokeResult,
  type SessionLookup,
} from "./auth.ts";
import { lowercaseKey } from "../shared/identity.ts";
import { startAdminSocket } from "./admin-socket.ts";
import { matchRoute } from "./routes/match.ts";
import { API_ROUTES, type RoutePrecondition } from "./routes/table.ts";
import {
  executeRoute,
  errorResponse,
  fail,
  type ExecutorDeps,
  type RouteHandler,
  type PreconditionFn,
  type HandlerErrorStatus,
} from "./routes/executor.ts";
import { tasksHandlers } from "./routes/handlers/tasks.ts";
import { memoryHandlers } from "./routes/handlers/memory.ts";
import { memoryStore, isSafeScopeId } from "./memory-store.ts";
import { cronHandlers } from "./routes/handlers/cron.ts";
import { agentAffordanceHandlers } from "./routes/handlers/agent-affordances.ts";
import { uploadsHandlers } from "./routes/handlers/uploads.ts";
import { invitesHandlers } from "./routes/handlers/invites.ts";
import { sessionsHandlers } from "./routes/handlers/sessions.ts";
import { accessHandlers } from "./routes/handlers/access.ts";
import { usersHandlers } from "./routes/handlers/users.ts";
import { officeSettingsHandlers } from "./routes/handlers/office-settings.ts";
import { validateHandlers } from "./routes/handlers/validate.ts";
import { backendsHandlers } from "./routes/handlers/backends.ts";
import { systemHandlers } from "./routes/handlers/system.ts";
import { viewHandlers } from "./routes/handlers/view.ts";
import { roomsHandlers } from "./routes/handlers/rooms.ts";
import { agentsHandlers } from "./routes/handlers/agents.ts";
import { conversationHandlers } from "./routes/handlers/conversation.ts";
import { editorHandlers } from "./routes/handlers/editor.ts";
import type {
  AccessSettings,
  UserPublicWire,
} from "../shared/contract-shapes.ts";
import { createIdempotencyCache } from "./transport/idempotency.ts";
import { emit, type EmitContext, type EmitDeps } from "./events/emit.ts";
import type { EventId, EventPayloads } from "./events/registry.ts";
import { planOwnerAccessMigration } from "./access-migration.ts";
import { type Identity } from "./identity/index.ts";

// Boot is extracted into startServer() at the end of this file. The CLI
// fast-path (`bun run server/index.ts owner-login`) and the production
// auto-start both live in the `if (import.meta.main)` guard there, so importing
// this module (the in-process test harness) has no boot side effects.

// bootPrelude: pre-userid backup migration, access-settings resolution, and
// boot-state freeze. Extracted from module top-level so startServer() controls
// timing (production via import.meta.main; tests via the in-process harness).
// Body left at its prior indentation; prettier normalizes post-review.
function bootPrelude(): void {
  // Pre-userid backup is the migration safety snapshot (NOT the daily backup
  // scheduler), so it runs UNCONDITIONALLY — skipBackups controls only the daily
  // scheduler in runBackgroundBoot. It must run before any user/session/agent/
  // cronjob state touches disk; the state modules above lazy-load (no top-level
  // disk reads), so this top-of-body call is in time — but it is fragile to
  // future eager-load refactors. Audit if any imported module starts loading
  // eagerly. On a fresh harness boot it is a no-op (no pre-userid state).
  runPreUseridBackupIfNeeded();

  // Resolve access settings from office-config.json + the deprecated
  // ISOMUX_PUBLIC_ORIGIN env var, write any migration / backfill back to disk,
  // then lock the boot-time state. Cookie attributes and origin policy are
  // frozen from this point, so the bind decision can't disagree with the
  // minted cookies if a claim flips hasOwner() mid-process.
  {
    let cfg = loadServerConfig();
    const envRaw = process.env.ISOMUX_PUBLIC_ORIGIN?.trim();
    const envOrigin = envRaw ? normalizePublicOrigin(envRaw) : null;

    // Env-var migration. ISOMUX_PUBLIC_ORIGIN is deprecated; copy its value
    // into office-config.json (only when JSON's slot is empty, never clobber
    // an explicit JSON value) and warn the operator. The env var still wins
    // for THIS boot via buildPublicOrigin's precedence chain — the message
    // tells the operator that removing the env var will silently start
    // using the JSON value, which matches what we wrote.
    let configDirty = false;
    if (envOrigin) {
      if (cfg.publicOrigin === null) {
        console.log(
          `[auth] ISOMUX_PUBLIC_ORIGIN is deprecated. Migrating "${envOrigin}" into office-config.json so it survives without the env var. Remove ISOMUX_PUBLIC_ORIGIN from your env on your next deploy.`,
        );
        cfg = { ...cfg, publicOrigin: envOrigin };
        configDirty = true;
      } else if (cfg.publicOrigin === envOrigin) {
        console.log(
          `[auth] ISOMUX_PUBLIC_ORIGIN env var is redundant with office-config.json#publicOrigin (${cfg.publicOrigin}) and is deprecated. Remove it from your env on your next deploy.`,
        );
      } else {
        console.error(
          `[auth] ISOMUX_PUBLIC_ORIGIN ("${envOrigin}") differs from office-config.json#publicOrigin ("${cfg.publicOrigin}"). The env var is deprecated; isomux uses the env value for THIS boot but will use the JSON value once the env var is removed. Reconcile by editing one and removing the other.`,
        );
      }
    } else if (envRaw) {
      // Env set but invalid. evaluateEnvOrigin (and normalizePublicOrigin
      // here) already logged the rejection; nothing to migrate.
    }

    // External-access backfill. When the field is absent from JSON
    // (pre-redesign install), default to true if any publicOrigin source
    // exists so the office stays reachable at its old address after the
    // upgrade. Write the resolved value back so subsequent boots don't
    // re-run this inference.
    let externalAccess: boolean;
    if (cfg.externalAccess !== null) {
      externalAccess = cfg.externalAccess;
    } else {
      externalAccess = cfg.publicOrigin !== null || envOrigin !== null;
      configDirty = true;
    }

    if (configDirty) {
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
    freezeBootState({ externalAccess });
  }
} // end bootPrelude

// AgentManager / CronjobManager instances. Module-level `let` (not top-level
// `const`) so startServer() can inject test doubles or a FakeBackend resolver;
// production passes none and gets the real factories. The many handler closures
// below read these after startServer() has assigned them (never before).
let agentManager: AgentManager;
let cronjobManager: CronjobManager;

function createManagers(startOpts: StartServerOpts): void {
  // createProductionAgentManager() loads the persisted office/agents snapshot
  // synchronously (getRooms() valid before the async restore) and registers the
  // office env-file provider. createProductionCronjobManager() wires the real
  // backend/env/user/persistence + clock/timers. Tests pass a pre-built manager
  // (or just a resolveBackend override) so a FakeBackend drives the same wiring.
  agentManager =
    startOpts.agentManager ??
    createProductionAgentManager({ resolveBackend: startOpts.resolveBackend });
  cronjobManager =
    startOpts.cronjobManager ??
    createProductionCronjobManager({
      resolveBackend: startOpts.resolveBackend,
    });
  // Register the production instance for the module-read bridge that
  // command-handlers/usage-report use (they don't hold the instance).
  registerProductionCronjobManagerForModuleReads(cronjobManager);
}

// registerBootHooks: install the auth.ts callbacks (room-snapshot provider,
// invite/session change fanout, first-owner welcome-agent seed) against the
// active manager instance. Extracted so startServer() controls when they run.
// The welcome-agent helpers below are local to this function (used only here).
// Body left at prior indentation; prettier normalizes post-review.
function registerBootHooks(): void {
  // Inject the room snapshot provider auth.ts uses when seeding a new
  // owner's allowedRooms at invite-acceptance time. The provider closes
  // over agentManager.getRooms() rather than auth.ts importing
  // agent-manager directly — keeps the dependency graph one-way.
  setRoomsSnapshotProvider(() => agentManager.getRooms().map((r) => r.id));

  // When an invite is consumed (typically via HTTP POST /auth/accept,
  // which never touches the WS dispatch loop), fan out an updated
  // invites_list to every owner WS so their Access pane re-renders in
  // real time. Without this hook, a browser that minted an invite while a
  // *separate* browser opened the /i/ URL would have to reconnect to see
  // the consumed invite drop off the Outstanding list.
  setOnInviteConsumed(() => {
    emitInvitesList();
    emitSessionsList();
  });

  // Owner AccessPane sessions table stays fresh on any server-initiated
  // session invalidation: revoke, logout, delete-user fanout, and the
  // hot-path expiry / orphan branches in validateByHash. Without this,
  // e.g. deleting a member silently leaves their row in the table until
  // the owner reloads. Per-WS pushers also keep the member's
  // "My devices" sessions table consistent on the same events.
  setOnSessionsChanged(() => {
    emitSessionsList();
  });

  // First-install onboarding: pre-spawn one Claude and one Codex welcome agent
  // so the new owner can try whichever backend they're set up for. Spawn is
  // always allowed (no CLI install check); the other backend surfaces a
  // chat-visible error on first message — missing CLI, missing auth, all the
  // same UX. Per-spawn try/catch is defense in depth against any unexpected
  // throw. Awaited so both agents are in officeState before the redirected
  // browser reads `full_state`. Guarded so an owner-recovery on an existing
  // office doesn't double-seed.
  function welcomeAgentPrompt(agentType: "claude" | "codex"): string {
    const selfName =
      agentType === "claude" ? "Claude Welcome Agent" : "Codex Welcome Agent";
    const selfFamily = agentType === "claude" ? "Claude" : "Codex";
    const otherName =
      agentType === "claude" ? "Codex Welcome Agent" : "Claude Welcome Agent";
    const otherFamily = agentType === "claude" ? "Codex" : "Claude";
    return `You are the ${selfName} in this user's new Isomux office. Isomux is a persistent office of AI agents reachable from any device; each agent lives at a desk in a room with its own chat. New offices come preset with two welcome agents — you (a ${selfFamily} agent) and "${otherName}" (a ${otherFamily} agent). If the user messages you without a specific request, welcome them to the office and suggest \`/help\` to see your available commands, skills, and tips. You can also offer to walk them through spawning their first agent or to showcase agent-to-agent communication. If they ask for the showcase, check ~/.isomux/agents-summary.json to confirm the other welcome agent is present and then send them a message asking for a message back. Be brief, friendly, and focus on what the user asks. For deeper Isomux questions, use https://github.com/nmamano/isomux/blob/main/README.md or https://isomux.com as references.`;
  }

  // Fixed outfits so both welcome agents have a recognizable, friendly look on
  // every fresh install instead of the random palette new spawns get. Claude =
  // blue/glasses, Codex = pink/tie — visually distinct so the user can tell
  // them apart at a glance from the desk view.
  const CLAUDE_WELCOME_OUTFIT: AgentOutfit = {
    hat: "bow",
    color: "#45B7D1",
    hair: "#6C5CE7",
    hairStyle: "long",
    skin: "#FDEBD0",
    beard: "none",
    accessory: "glasses",
  };
  const CODEX_WELCOME_OUTFIT: AgentOutfit = {
    hat: "none",
    color: "#E85D75",
    hair: "#E84393",
    hairStyle: "ponytail",
    skin: "#FDEBD0",
    beard: "stubble",
    accessory: "tie",
  };

  async function spawnWelcomeAgent(
    name: string,
    agentType: "claude" | "codex",
    modelFamily: string,
    permissionMode: "auto" | "on-request",
    outfit: AgentOutfit,
    username: string,
  ): Promise<void> {
    try {
      const created = await agentManager.spawn(
        name,
        "~",
        permissionMode,
        undefined,
        welcomeAgentPrompt(agentType),
        undefined,
        outfit,
        modelFamily,
        undefined,
        username,
        agentType,
        undefined,
        undefined,
      );
      if (!created) {
        console.warn(
          `[bootstrap] ${name} spawn returned null (duplicate name or full room?)`,
        );
      }
    } catch (err) {
      console.warn(`[bootstrap] ${name} spawn threw:`, err);
    }
  }

  // Seed welcome agents on the first owner of a fresh office. Fires for
  // both the tokenless claim form (handleClaim) and the legacy bootstrap-
  // invite accept (handleAccept where isBootstrap is true). The hook only
  // fires on first-claim flows by design; the agent-count guard below is
  // defensive in case a future call path fires it against an already-
  // populated office.
  setOnOwnerCreated(async ({ username }) => {
    if (agentManager.getAllAgents().length > 0) return;
    await spawnWelcomeAgent(
      "Claude Welcome Agent",
      "claude",
      "opus",
      "auto",
      CLAUDE_WELCOME_OUTFIT,
      username,
    );
    await spawnWelcomeAgent(
      "Codex Welcome Agent",
      "codex",
      CODEX_MODELS[0].value,
      "on-request",
      CODEX_WELCOME_OUTFIT,
      username,
    );
  });
} // end registerBootHooks

// Each WS carries the session it was authenticated with at upgrade time. The
// session reference is used per-message (so revoke kicks in on the next msg)
// and to attribute writes to the right user without trusting client-supplied
// `username` fields. The `connectionId` is a per-WS identifier (NOT per
// auth session) — multiple tabs of the same user share `session.sessionIdHash`
// but get distinct `connectionId`s, so live-avatars presence keyed by
// connectionId gives one ghost per tab (the design contract).
interface WsData {
  session: SessionLookup;
  connectionId: string;
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

const browsers = new Set<ServerWebSocket<WsData>>();

// Centralized Idempotency-Key cache (Phase 3a). Process-global; reset per boot in
// resetServerModuleState so a repeated in-process harness boot starts clean.
const idempotencyCache = createIdempotencyCache();

// The HTTP executor's deps for the migrated /api surface (Phase 3a). Assembled in
// startServer once the managers exist; read by the fetch handler at request time.
let executorDeps: ExecutorDeps;

// Editor file watchers, keyed by connectionId -> (`${agentId}\0${absPath}` ->
// watcher). Rekeyed from a per-WS WeakMap when the editor moved to REST (3d.6b):
// the GET handler has no socket, only the client-supplied X-Isomux-Connection-Id,
// so each open file's fs.watch + its editor_external_change push bind to the
// connectionId (resolved back to a socket by the connectionId emit projection).
// Watchers close on closeFile (DELETE) or WS disconnect (swept by connectionId).
const editorWatchers = new Map<string, Map<string, FileWatcher>>();

function editorKey(agentId: string, absPath: string): string {
  return `${agentId}\0${absPath}`;
}

// (broadcastToOwners removed in 3a.4b: the only owner-scoped events,
// invite_revoked + session_revoked, now flow through liveEmit() with their
// registry audience "owners" — server/events/emit.ts owns the owner fan-out, so
// the bespoke helper is dead. No raw ws.send fan-out lives outside emit()/the
// per-WS direct replies anymore.)

// --- Invites: recipient-scoped projection + emit (3a.4a) -------------------
// Map an auth MintErr code → the REST status for the invite mint routes (locked
// with Reviewer1): bad input → 400, conflict (user/role already exists) → 409.
function mintErrStatus(code: MintErr["code"]): HandlerErrorStatus {
  switch (code) {
    case "USER_EXISTS":
    case "ROLE_MISMATCH":
      return 409;
    case "INVALID_USERNAME":
    case "INVALID_ROLE":
      return 400;
  }
}

// Scoped invite list for a user (record role — Reviewer1 Option A): owner sees
// ALL outstanding invites; a member sees only invites bound to their own current
// display name. The whole invite seam (this projection, the inviteOwnerOrSelf
// precondition, and the revoke branch) keys owner/member off the user RECORD via
// getUserById, NOT the WS session role — because the recipient-scoped emit is
// userId-keyed and must resolve the record anyway. They differ only in the rare
// promote-without-reconnect race; the record is the authoritative source. (Two
// intentional session-role exceptions remain, both pre-existing emit/guard infra
// rather than this seam's projection: the invites.mint officeOwner guard, and the
// shared owners-audience fan-out — ownerSessions in liveEmitDeps — that selects
// recipients for invite_revoked/session_revoked.)
function scopedInvitesFor(userId: string | null): InviteWire[] {
  if (!userId) return [];
  const u = getUserById(userId);
  if (!u) return [];
  return u.role === "owner" ? listInvites() : listInvitesForUsername(u.name);
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
// access-settings self-mint / invite-consumed) — NEVER for a pure list read.
function emitInvitesList(): void {
  const seen = new Set<string>();
  for (const ws of browsers) {
    const uid = ws.data.session.userId;
    if (seen.has(uid)) continue;
    seen.add(uid);
    emitInvitesListForUser(uid);
  }
}

// Shared invite-revoke core for BOTH transports (the REST invites.revoke dep and
// the legacy WS revoke_invite arm). Branches owner/member off the user RECORD,
// calls the matching auth core op, and on success emits invite_revoked
// (owners-only via liveEmit) + the scoped invites_list fan-out. Returns the raw
// RevokeResult so the REST dep can apply the non-leak HTTP status policy (owner:
// honest 404/409; member: uniform 403). One path, no WS-vs-REST divergence.
async function revokeInviteForUserRecord(
  u: UserRecord,
  tokenPrefix: string,
): Promise<RevokeResult> {
  const result =
    u.role === "owner"
      ? await revokeInviteByPrefix(tokenPrefix)
      : await revokeOutstandingInviteByPrefixForUsername(tokenPrefix, u.name);
  if (result === "ok") {
    liveEmit("invite_revoked", { tokenPrefix });
    emitInvitesList();
  } else if (result === "ambiguous" && u.role === "owner") {
    // Owner-only diagnostic (a member never learns a prefix is ambiguous — that
    // would leak existence). Mirrors the legacy revoke_invite warning.
    console.warn(
      `[auth] ambiguous invite prefix ${tokenPrefix} — refused revoke`,
    );
  }
  return result;
}

// --- Sessions: recipient-scoped projection + emit (3a.4b) ------------------
// Lockout reasons (shared by the REST preconditions + the legacy WS arms) for
// the invariant "the office must always keep one owner with an active session,
// so an operator can recover from inside the browser".
const SESSION_REVOKE_LOCKOUT_REASON =
  "Refused: this is the last active owner session in the office. Mint an " +
  "additional invite for an owner first, accept it on another device, then retry.";
const SESSION_LOGOUT_LOCKOUT_REASON =
  "You're the only owner with an active session. Signing out would lock the " +
  "office out of in-browser recovery. Mint an additional invite for yourself " +
  "and accept it on another device first.";

// Scoped session list for a user (record role — Option A, mirrors invites):
// owner sees ALL active sessions; a member sees only their own (by stable
// userId, rename-safe). Same record-role rationale as scopedInvitesFor.
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

// Shared session-revoke core for BOTH transports (the REST sessions.revoke dep
// and the legacy WS revoke_session arm). Branches owner/member off the user
// RECORD; owner uses the unrestricted revoker (its lockout is pre-checked by the
// caller — the REST precondition or the WS arm), member uses the scoped mutator
// whose folded lockout returns "would_strand_office". On success emits
// session_revoked (owners-only via liveEmit); sessions_active_list rides
// fireSessionsChangedHook→emitSessionsList and session_expired + socket close
// ride the forceExpireSocketsForSession bridge, both inside the auth core ops.
async function revokeSessionForUserRecord(
  u: UserRecord,
  sessionPrefix: string,
): Promise<ScopedSessionRevokeResult> {
  const result =
    u.role === "owner"
      ? await revokeSessionByPrefix(sessionPrefix)
      : await revokeActiveSessionByPrefixForUserId(sessionPrefix, u.id);
  if (result === "ok") {
    liveEmit("session_revoked", { sessionPrefix });
  } else if (result === "ambiguous" && u.role === "owner") {
    console.warn(
      `[auth] ambiguous session prefix ${sessionPrefix} — refused revoke`,
    );
  }
  return result;
}

// --- Access settings: shared read + mutation cores (3a.4c) -----------------
// Both transports (the WS get_access_settings / update_access_settings arms and
// the REST office.getAccess / office.setAccess routes) go through these, so the
// bind/origin policy can't drift between them.

// Effective access policy for the owner UI. Mirrors the boot-time inference
// exactly: an explicit cfg.externalAccess wins; otherwise external is implied by
// a saved publicOrigin OR a VALID env origin. envOriginSet is the raw "is the
// env var defined at all" flag (so the UI can show "set but invalid").
function computeAccessSettings(): AccessSettings {
  const cfg = loadServerConfig();
  const envRaw = process.env.ISOMUX_PUBLIC_ORIGIN?.trim() ?? "";
  const envOriginSet = envRaw.length > 0;
  const envOrigin = envRaw ? normalizePublicOrigin(envRaw) : null;
  const effectiveExternal =
    cfg.externalAccess !== null
      ? cfg.externalAccess
      : cfg.publicOrigin !== null || envOrigin !== null;
  return {
    externalAccess: effectiveExternal,
    publicOrigin: cfg.publicOrigin,
    envOriginSet,
    envOrigin,
    boundLoopback: isProcessBoundLoopback(),
  };
}

// Result of an access-settings mutation. The RICHER object (externalAccess /
// publicOrigin / envOrigin) feeds the WS access_settings_updated payload; the
// REST handler selects just { signInUrl, restartRequired }.
type ApplyAccessResult =
  | {
      ok: true;
      externalAccess: boolean;
      publicOrigin: string | null;
      signInUrl: string | null;
      restartRequired: boolean;
      envOrigin: string | null;
    }
  | {
      ok: false;
      status: HandlerErrorStatus;
      error: string;
      envOrigin?: string;
    };

// Validate → persist → (on enable) mint the owner self-invite bound to the NEW
// origin + emitInvitesList(). The change persists immediately but the running
// process keeps its boot-frozen bind/origin until restart (restartRequired:true).
// Status: invalid origin / enable-without-origin → 400; an enable that conflicts
// with a differing ISOMUX_PUBLIC_ORIGIN env (which would win after restart and
// 403 the minted URL) → 409; save failure → 500. If the self-invite mint fails
// AFTER the save, we log and still return ok with signInUrl:null (preserved
// legacy behavior — the config change is what matters).
async function applyAccessSettings(
  externalAccess: boolean,
  publicOrigin: string,
  userId: string | null,
): Promise<ApplyAccessResult> {
  const rawOrigin = publicOrigin.trim();
  let origin: string | null = null;
  if (rawOrigin) {
    const normalized = normalizePublicOrigin(rawOrigin);
    if (!normalized) {
      return {
        ok: false,
        status: 400,
        error:
          "Public URL must be https://<host> or http://localhost (no path, query, or fragment).",
      };
    }
    origin = normalized;
  }
  if (externalAccess && !origin) {
    return {
      ok: false,
      status: 400,
      error: "Enabling external access requires a public URL.",
    };
  }
  const envRaw = process.env.ISOMUX_PUBLIC_ORIGIN?.trim() ?? "";
  const envOrigin = envRaw ? normalizePublicOrigin(envRaw) : null;
  if (externalAccess && envOrigin && origin && envOrigin !== origin) {
    return {
      ok: false,
      status: 409,
      error: `ISOMUX_PUBLIC_ORIGIN is still set to ${envOrigin}. Remove it from the service environment or set the Public URL to the same value, then save again.`,
      envOrigin,
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
        username: me.name,
        role: me.role,
        createdBy: me.name,
        allowExisting: true,
        replacePriorForUsername: true,
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
    envOrigin,
  };
}

// --- Validate-then-apply cores for the office/validate/backends REST handlers -
// office.setSettings / validate.env / backends.listModels each delegate to ONE
// core here (the single validation+mutation seam its REST handler calls). The WS
// arms that once shared these cores are all retired (3d slices 1 and 2, and the
// office/tasks slice). Object-level AUTH is NOT here: REST enforces it in the
// route table (guard + precondition).

// office.setSettings core. Validates COMPLETELY before it mutates/emits (no
// double-signal on an invalid env path or over-long name). name === undefined
// PRESERVES the current name (a caller that omits it, e.g. a stale tab); null or
// empty CLEARS it. setOfficeSettings emits office_settings_updated via the sink.
function applyOfficeSettings(input: {
  prompt: string | null;
  envFile: string | null;
  name?: string | null;
}): { ok: true } | { ok: false; status: 400; error: string } {
  const envFile =
    input.envFile && input.envFile.trim() ? input.envFile.trim() : null;
  if (envFile) {
    try {
      agentManager.validateEnvPath(envFile);
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: errMessage(err, "Invalid env file"),
      };
    }
  }
  const rawName =
    input.name === undefined
      ? agentManager.getOfficeSettings().name
      : typeof input.name === "string" && input.name.trim()
        ? input.name.trim()
        : null;
  if (rawName && rawName.length > 60) {
    return {
      ok: false,
      status: 400,
      error: "Office name must be 60 characters or fewer",
    };
  }
  agentManager.setOfficeSettings(input.prompt, envFile, rawName);
  return { ok: true };
}

// Shared core for the validate.env REST handler. Resolves the scope/user's
// env-file path and counts its keys. AUTH lives outside (the
// validateEnvBodySelfSubject precondition). The resolved path is returned but
// the REST handler drops it (the retired request_settings_validation WS arm used
// to echo it). An absent env file is trivially ok (nothing to validate). For
// scope:"user", an explicit username targets THAT user; an omitted username
// targets the CALLER's OWN env (selfUserId) — the subject the precondition
// already authorized as "self". Without this self-resolution an authorized
// own-env probe would validate nothing and return a false ok.
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
    envFile = rec?.envFile ?? null;
  }
  if (!envFile) return { ok: true, envFile: null };
  try {
    return {
      ok: true,
      keyCount: agentManager.validateEnvPath(envFile),
      envFile,
    };
  } catch (err) {
    return { ok: false, error: errMessage(err, "Invalid env file"), envFile };
  }
}

// backends.listModels. Resolves the per-user env stack and
// cwd EXACTLY like a real spawn (so office/user env-file overrides are reflected),
// lists, and maps to the wire shape. On failure, flags backend-specific auth
// errors via detectAuthError so the UI can render login instructions.
async function listBackendModels(input: {
  agentType: string;
  cwd: string;
  includeHidden: boolean;
  userId: string;
}): Promise<
  | { ok: true; models: BackendModelWire[] }
  | { ok: false; error: string; authError: boolean }
> {
  try {
    const backend = getBackend(input.agentType as AgentBackendType);
    const env = agentManager.buildEnvForUserId(input.userId);
    const models = await backend.listModels({
      // The codex subprocess's cwd must be a real directory or posix_spawn fails
      // with ENOENT before our error path can clean up — resolve `~` here the
      // same way agentManager.spawn does before persisting.
      cwd: resolveCwd(input.cwd),
      env,
      includeHidden: input.includeHidden,
    });
    const wire: BackendModelWire[] = models.map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      isDefault: m.isDefault,
      hidden: m.hidden,
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
    ws.send(data);
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
    // can't see — unknown id, or globalToVisible < 0. Reuses the projection's
    // global roomId→index map rather than a second inline index.
    const globalIdx = projection.globalRoomIdToIndex.get(p.currentRoomId);
    if (globalIdx === undefined) continue;
    if (projection.globalToVisible[globalIdx] < 0) continue;
    out.push({
      connectionId: p.connectionId,
      userId: p.userId,
      username: p.username,
      device: p.device,
      avatarColor: p.avatarColor,
      avatarVariant: p.avatarVariant,
      currentRoomId: p.currentRoomId,
      focusedAgentId: p.focusedAgentId,
      viewMode: p.viewMode,
    });
  }
  // Deterministic order so client renders don't reshuffle on every
  // broadcast. connectionId is per-WS, stable while the connection
  // lives, and reconnects produce a fresh id (replacing the old entry
  // entirely, not reshuffling the existing ones).
  out.sort((a, b) => a.connectionId.localeCompare(b.connectionId));
  return out;
}

// Count distinct online userIds across the WHOLE presence map (not the
// per-recipient filtered `entries`). Off-scene sessions (viewMode
// "away" / currentRoomId === null) are included — "online" here means
// "has a live WS that has sent at least one presence_update", which is
// independent of whether the session is currently visible in a scene.
// Same value broadcast to every recipient.
function countTotalOnlineUsers(): number {
  const seen = new Set<string>();
  for (const p of listAllPresence()) seen.add(p.userId);
  return seen.size;
}

function sendPresenceListTo(ws: ServerWebSocket<WsData>) {
  ws.send(
    JSON.stringify({
      type: "presence_list",
      entries: buildPresenceListFor(ws.data.session),
      totalOnlineUsers: countTotalOnlineUsers(),
    }),
  );
}

function pushPresenceListToEachWs() {
  for (const ws of browsers) {
    sendPresenceListTo(ws);
  }
}

// ---------------------------------------------------------------------------
// Per-WS room ACL + view projection (Phase 3b)
//
// ACCESS (security): owners reach EVERY room by RULE; members reach their
// explicitly-granted rooms (UserRecord.allowedRooms == member grants). See
// canAccess(). VIEW (non-security): layered ON TOP of access — `hidden`
// (effective shown = accessible \ hidden) and sparse `order` decide WHICH
// accessible rooms appear and in what order. The projection materializes each
// recipient's visible rooms array (accessible ∩ shown, ordered) and filters
// presence/agents to it. Agents and presence carry stable room ids (post-cut
// there are no per-recipient dense `room` indices), so the projection no longer
// rewrites any index — it only decides room-list membership/order and
// per-recipient visibility.
//
// Helpers below are the single source of truth for those translations; per-WS
// event routing and the connect-time full_state both go through them.

// A session has "full access" when it can ACCESS every current room: an owner
// (by rule) or a member whose grants cover all rooms. visibleRoomProjection's
// identity fast-path additionally requires no hidden rooms and no custom order
// (otherwise it falls to the general accessible∩shown-in-order path).
// Rule-based room ACCESS (Phase 3b slice 3). Owners have access to ALL rooms by
// RULE (no materialized grant list); members have access to explicitly-granted
// rooms only (UserRecord.allowedRooms == member grants). This is the SECURITY
// gate. View preference (hidden/order) is a separate, ADDITIVE filter applied
// ON TOP by the projection — never here — so a future re-show path can never
// turn `hidden` into a security gate.
function canAccess(user: UserRecord, roomId: string): boolean {
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

// The concrete set of room ids a user can access right now — owner: every
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
    return new Set(agentManager.getRooms().map((r) => r.id));
  }
  return new Set(allowedRoomsOverride ?? user.allowedRooms);
}

// Phase 3b slice 3 — one-time owner-access migration to the rule-based model.
// Runs at boot AFTER rooms + users are loaded (it needs BOTH): the boot
// ORDERING is the security-critical part (a migration that ran before rooms
// load would see no live rooms and take the all-stale branch for every owner),
// so it is pinned by a real-boot restart() integration test, not just the pure
// planner's unit tests. IDEMPOTENT: the marker is "owner with non-empty
// allowedRooms"; a migrated owner has [], so a re-run is a no-op. The per-owner
// decision (seed hidden from the OLD grants with an effective-coverage guard,
// then clear grants) lives in the PURE planner — see server/access-migration.ts.
function migrateOwnersToRuleBasedAccess(): void {
  // Thin boot wrapper: collect the persisted users + the live room ids (rooms
  // are seeded synchronously by createManagers, so getRooms() is valid here),
  // delegate the per-owner decision to the PURE planner (unit-tested over the
  // full case matrix in access-migration.test.ts), and apply each mutation.
  const liveRoomIds = agentManager.getRooms().map((r) => r.id);
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

// Production GuardDeps adapter (Phase 2.3, deferred from 2.2). Wires the guard
// catalog's injected office-state seam to today's materialized-allowedRooms
// predicates + the live managers. Built at boot and exposed (dormant) on the
// ServerHandle; nothing consumes it in 2.3 — Phase 3 feeds it to authorize()
// when routes migrate. See server/identity/guard-deps.ts.
function buildLiveGuardDeps(): GuardDeps {
  const readers: GuardDepsLiveReaders = {
    // sessionHasFullRoomAccess / roomAllowedForSession only read session.userId,
    // so a minimal { userId } stands in for the full SessionLookup. The cast is
    // contained here at the seam; Phase 3b swaps this materialized predicate for
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
    getUserByName: (username) => getUserByName(username) ?? null,
    listCronjobs: () => cronjobManager.listCronjobs(),
  };
  return buildProductionGuardDeps(readers);
}

// Production EmitDeps adapter (Phase 3a). The single transport seam the emit()
// helper uses: audience -> recipient selection is computed in emit() from the
// event registry; this adapter owns only recipient enumeration over the live
// `browsers` set + per-recipient delivery. For 3a's groups the emits are
// all/owners/recipient-scoped ONLY (no room-ACL), so the per-recipient room
// projection is not exercised here; sessionsForRoomAccess is wired for
// completeness and the 3b room-visibility projection. deliver() stamps the
// event id as `type` and sends the
// already-shaped payload (the core op does any per-user shaping before emit()).
const liveEmitDeps: EmitDeps<ServerWebSocket<WsData>> = {
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
    // Phase 3c: return the authoritative roomId only if it names a LIVE room.
    // Do NOT lean on downstream audience filtering to fail closed — under the 3b
    // owner rule canAccess() returns true for ANY roomId string, so a dangling
    // id would still route this agent's room-ACL events to owner sockets.
    // Validate here, matching the guard-deps authz posture (pre-3c the
    // out-of-range dense index produced null at getRooms()[agent.room]?.id).
    return agentManager.roomById(agent.roomId) ? agent.roomId : null;
  },
  deliver: (recipients, id, payload) => {
    // Slice 3b.1: room-ACL events arrive here with recipients ALREADY filtered
    // to room-access sessions by emit()'s registry audience, so deliver() only
    // performs per-recipient WIRE SHAPING — it does NOT own the audience decision
    // and never broadens recipients (projectAgentForSession's visibility check
    // below is defensive shaping if state/projection disagree, not a second
    // audience gate):
    //   - agent_added: suppress the agent for recipients who can't see its room
    //     (projectAgentForSession returns null). Post-cut there's no dense `room`
    //     to rewrite, so visible recipients get the verbatim agent.
    // Every other event — including room_closed, which post-cut just removes a
    // stable room id and no longer shifts any recipient's dense space — is
    // delivered byte-identical verbatim. This reproduces routeAgentEventToWs for
    // the migrated events.
    if (id === "agent_added") {
      const agent = (payload as { agent: AgentInfo }).agent;
      for (const ws of recipients) {
        const projected = projectAgentForSession(ws.data.session, agent);
        if (projected) {
          ws.send(JSON.stringify({ type: "agent_added", agent: projected }));
        }
      }
      return;
    }
    const data = JSON.stringify({ type: id, ...(payload as object) });
    for (const ws of recipients) ws.send(data);
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

// Project a full UserRecord to the office-wide PUBLIC wire — the ONLY user shape
// allowed on an all-audience event. Single helper so no all-audience emit hand-
// rolls the field set and accidentally leaks a sensitive field (grants/env/
// prompt/view). Phase 3b slice 5.
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

// Fan out a single user-record change across the THREE audiences (3b.5):
//   - user_updated (all): UserPublicWire — public profile only.
//   - user_admin_updated (owners): the FULL record (grants/env/prompt/view).
//   - user_self_updated (the subject's own sockets): the subject's full record.
// The all-audience public event reaches owners + the subject too; the client
// reducer merges, with the admin/self full data winning over public for records
// the recipient is allowed to know. This is the ONLY sanctioned path for
// user_updated — any remaining raw broadcast of user_updated/users_list is a leak.
function emitUserUpdated(user: UserRecord, prevName?: string): void {
  const tail = prevName !== undefined ? { prevName } : {};
  liveEmit("user_updated", { user: toPublicWire(user), ...tail });
  liveEmit("user_admin_updated", { user, ...tail });
  liveEmit("user_self_updated", { user, ...tail }, { userId: user.id });
}

// Fan out the whole roster: PUBLIC list to all, FULL admin list to owners. The
// per-user self record is NOT sent here — it rides emitUserUpdated on a change
// and the connect hydration. A bulk op that changes self-visible fields for
// specific users should also emitUserUpdated() each touched user.
function emitUsersList(): void {
  const all = listUsers();
  liveEmit("users_list", { users: all.map(toPublicWire) });
  liveEmit("users_admin_list", { users: all });
}

// Token-derived task/cron attribution (Phase 3a). createdBy is the caller's
// display identity (agent name, or the human's name on a user token); username
// is the token's owning user. Never sourced from a request body.
function attributionFor(identity: Identity): {
  createdBy: string;
  username: string | undefined;
} {
  let createdBy = "unknown";
  let username: string | undefined = undefined;
  if (identity.userId) {
    const user = getUserById(identity.userId);
    if (user) {
      username = user.name;
      createdBy = user.name;
    }
  }
  if (identity.scope === "agent" && identity.agentId) {
    const display = agentManager.getAgentDisplay(identity.agentId);
    if (display) createdBy = display.name;
  }
  return { createdBy, username };
}

// Assemble the executor deps for the migrated /api surface. Called from
// startServer once the managers exist. Each resource slice registers its
// handlers (and any precondition enforcers) here over its own slim deps bundle;
// the executor stays ignorant of managers/auth internals.
function buildExecutorDeps(): ExecutorDeps {
  const handlers = new Map<string, RouteHandler>();
  const preconditions = new Map<RoutePrecondition, PreconditionFn>();
  const register = (hs: Record<string, RouteHandler>): void => {
    for (const [opId, handler] of Object.entries(hs)) {
      handlers.set(opId, handler);
    }
  };

  // 3a.1 — Tasks (global shared board; attribution from token).
  register(
    tasksHandlers({
      listTasks: () => agentManager.getTasks(),
      createTask: ({
        title,
        createdBy,
        username,
        description,
        priority,
        assignee,
      }) =>
        agentManager.addTask(title, createdBy, {
          description,
          priority,
          assignee,
          username,
        }),
      updateTask: (id, changes) => agentManager.updateTask(id, changes),
      deleteTask: (id) => agentManager.deleteTask(id),
      attributionFor,
    }),
  );

  // Memory (isomux-memory; slice 3a agent-scope tracer). Author + date are
  // server-stamped from the token (authorFor); scopeId is a target selector, not
  // authority. A write whose caller record can't be resolved fails 404 rather
  // than being stamped "unknown".
  register(
    memoryHandlers({
      read: (scope, scopeId) => memoryStore.read(scope, scopeId),
      append: (input) => memoryStore.append(input),
      authorFor: (identity) => {
        if (identity.scope === "agent" && identity.agentId) {
          const d = agentManager.getAgentDisplay(identity.agentId);
          return d ? d.name : null;
        }
        if (identity.userId) {
          const u = getUserById(identity.userId);
          return u ? u.name : null;
        }
        return null;
      },
      isSafeScopeId,
      // EXISTENCE only — no access gate (permissive model, Nil's call).
      roomExists: (roomId) =>
        agentManager.getRooms().some((r) => r.id === roomId),
      agentExists: (agentId) => agentManager.getAgentDisplay(agentId) != null,
      userExists: (userId) => getUserById(userId) != null,
    }),
  );

  // 3a.2 — Cronjobs (metadata + runs; mutation tightened to owner/office-owner).
  register(
    cronHandlers({
      listCronjobs: () => cronjobManager.listCronjobs(),
      createCronjob: (input) =>
        cronjobManager.addCronjob({
          ...input,
          agentType: input.agentType ?? "claude",
          // cron:manage is USER-only, so a valid caller always resolves a
          // username; the fallback only satisfies the definite-string contract.
          username: input.username ?? "unknown",
        }),
      updateCronjob: (id, changes) => cronjobManager.updateCronjob(id, changes),
      deleteCronjob: (id) => cronjobManager.deleteCronjob(id),
      setPrompt: (value) => cronjobManager.setCronjobsPrompt(value),
      runNow: (id, username) => cronjobManager.runCronjobNow(id, username),
      runsForCronjob: (jobId) => cronjobManager.getRunsForCronjob(jobId),
      allRunsByJob: () => cronjobManager.getAllRunsByJob(),
      runTranscript: (jobId, runId) =>
        cronjobManager.getRunTranscript(jobId, runId),
      // 3a.2b — run-message + RUN-affordance core ops. sendRunMessage/
      // editRunMessage are fire-and-forget: void-discard the manager's
      // background promise (like the legacy WS arms), so the HTTP response
      // never blocks on the turn/fork. The handler threads a messageId override
      // so the persisted user_message entry id === the route ack.
      findRun: (jobId, runId) => cronjobManager.findRun(jobId, runId),
      sendRunMessage: (jobId, runId, text, username, device, opts) => {
        void cronjobManager.sendRunMessage(
          jobId,
          runId,
          text,
          username,
          device,
          opts,
        );
      },
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
      saveRecentCwd,
    }),
  );

  // 3a.3a — Agent self-affordances (AGENT bearer; read-file / diff / edit-file /
  // terminal-command on the agent's OWN chat). Slim deps: just the four manager
  // emit ops. The manager emits room-ACL-projected log_entry via the event sink;
  // handlers never emit. These /api routes are the SOLE affordance surface now —
  // the legacy loopback /agents/:id/* affordance handlers were deleted in the
  // loopback-bypass removal milestone.
  register(
    agentAffordanceHandlers({
      emitAgentReadFile: (agentId, path) =>
        agentManager.emitAgentReadFile(agentId, path),
      emitAgentDiff: (agentId, dir, commit) =>
        agentManager.emitAgentDiff(agentId, dir, commit),
      emitAgentEditRequest: (agentId, path) =>
        agentManager.emitAgentEditRequest(agentId, path),
      emitAgentTerminalCommand: (agentId, command) =>
        agentManager.emitAgentTerminalCommand(agentId, command),
    }),
  );

  // 3a.3b — Uploads + file-serving (browser surfaces; room-ACL gated). Narrow
  // deps: just the persistence helpers (the guard owns access, getFilePath owns
  // path-traversal). agents.getFile is room-ACL-gated [behavior-change]; the
  // legacy /api/upload + /api/files + /api/images stay untouched.
  register(
    uploadsHandlers({
      saveFile: (agentId, data, mediaType, originalName) =>
        saveFile(agentId, data, mediaType, originalName),
      getFilePath: (agentId, filename) => getFilePath(agentId, filename),
      contentTypeFor: (filename) => mimeTypeForFilename(filename),
    }),
  );

  // 3a.4a — Invites (auth surface; recipient-scoped emit). EMIT-IN-DEP: there is
  // no auth event sink, so the seam owns mutate→emit — mint/self-mint/revoke fan
  // out emitInvitesList(), and revoke also liveEmits invite_revoked (owners). The
  // handlers stay pure REST mappers. Owner/member resolves from the user RECORD
  // (Reviewer1 Option A) uniformly across the scoped list, the inviteOwnerOrSelf
  // precondition, and the revoke branch; invites.mint alone stays on the table's
  // officeOwner (session) guard — an accepted asymmetry. (The owners-audience
  // fan-out for invite_revoked/session_revoked also keys on session role, via the
  // pre-existing shared ownerSessions in liveEmitDeps.)
  register(
    invitesHandlers({
      mint: async ({ username, role, allowExisting, identity }) => {
        const { createdBy } = attributionFor(identity);
        const r = await mintInvite({
          username,
          role,
          createdBy,
          allowExisting,
        });
        if (!r.ok) {
          return { ok: false, status: mintErrStatus(r.code), error: r.error };
        }
        emitInvitesList();
        return {
          ok: true,
          url: `${buildPublicOrigin().origin}/i/${r.rawToken}`,
          invite: toInviteWire(r.invite),
        };
      },
      mintSelf: async (identity) => {
        const me = identity.userId ? getUserById(identity.userId) : undefined;
        if (!me) {
          return {
            ok: false,
            status: 404,
            error: "Your user record is missing; reload and try again.",
          };
        }
        const r = await mintInvite({
          username: me.name,
          role: me.role === "owner" ? "owner" : "member",
          createdBy: me.name,
          allowExisting: true,
          replacePriorForUsername: true,
        });
        if (!r.ok) {
          return { ok: false, status: mintErrStatus(r.code), error: r.error };
        }
        emitInvitesList();
        return {
          ok: true,
          url: `${buildPublicOrigin().origin}/i/${r.rawToken}`,
          invite: toInviteWire(r.invite),
        };
      },
      listScoped: (identity) => scopedInvitesFor(identity.userId),
      revoke: async (identity, tokenPrefix) => {
        const u = identity.userId ? getUserById(identity.userId) : undefined;
        // inviteOwnerOrSelf already passed; a missing record here is a torn-down
        // session — uniform 403, no leak.
        if (!u) return { ok: false, status: 403, code: "forbidden" };
        const result = await revokeInviteForUserRecord(u, tokenPrefix);
        if (result === "ok") return { ok: true };
        if (u.role === "owner") {
          // Owner has full visibility, so an honest status leaks nothing.
          return result === "ambiguous"
            ? { ok: false, status: 409, code: "ambiguous_prefix" }
            : { ok: false, status: 404, code: "not_found" };
        }
        // Member post-precondition not_found/ambiguous (TOCTOU): uniform 403,
        // same envelope as the precondition — never reveal which case occurred.
        return { ok: false, status: 403, code: "forbidden" };
      },
    }),
  );

  // 3a.4a — inviteOwnerOrSelf: the FIRST precondition enforcer. Owner (record
  // role) may revoke any invite; a member only one bound to their own name.
  // NON-LEAKING: a foreign prefix AND a nonexistent prefix BOTH return the same
  // 403 envelope (no exists-but-hidden distinction). The revoke dep then
  // re-checks atomically via revokeOutstandingInviteByPrefixForUsername.
  preconditions.set("inviteOwnerOrSelf", (ctx) => {
    const u = ctx.identity.userId
      ? getUserById(ctx.identity.userId)
      : undefined;
    if (!u) return fail(403, "forbidden");
    if (u.role === "owner") return null;
    const owns = listInvitesForUsername(u.name).some(
      (i) => i.tokenPrefix === ctx.params.tokenPrefix,
    );
    return owns ? null : fail(403, "forbidden");
  });

  // 3a.4b — Sessions (auth surface; recipient-scoped emit, mirrors invites).
  // session_revoked → liveEmit (owners) in the shared core; sessions_active_list
  // rides fireSessionsChangedHook→emitSessionsList; session_expired + socket
  // close ride the forceExpireSocketsForSession bridge inside the auth core ops.
  register(
    sessionsHandlers({
      listScoped: (identity) => scopedSessionsFor(identity.userId),
      revoke: async (identity, sessionPrefix) => {
        const u = identity.userId ? getUserById(identity.userId) : undefined;
        if (!u) return { ok: false, status: 403, code: "forbidden" };
        const result = await revokeSessionForUserRecord(u, sessionPrefix);
        if (result === "ok") return { ok: true };
        if (result === "would_strand_office") {
          return {
            ok: false,
            status: 409,
            code: "would_strand_office",
            message: SESSION_REVOKE_LOCKOUT_REASON,
          };
        }
        if (u.role === "owner") {
          // Owner has full visibility, so an honest status leaks nothing.
          return result === "ambiguous"
            ? { ok: false, status: 409, code: "ambiguous_prefix" }
            : { ok: false, status: 404, code: "not_found" };
        }
        // Member post-precondition not_found/ambiguous (TOCTOU): uniform 403,
        // same envelope as the precondition — never reveal which case occurred.
        return { ok: false, status: 403, code: "forbidden" };
      },
      logout: async (callerSessionIdHash) => {
        // Fail closed: a bearer (non-cookie) caller has no current browser
        // session to end (Reviewer1 correction — NEVER a 204 no-op).
        if (!callerSessionIdHash) {
          return { ok: false, status: 403, code: "forbidden" };
        }
        await logoutBySessionHash(callerSessionIdHash);
        return { ok: true };
      },
    }),
  );

  // 3a.4b — sessionOwnerOrSelf: owner (record role) may revoke any session; a
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

  // 3a.4b — notLastOwnerLockout: ONE enforcer for both sessions.revoke (carries
  // the :sessionPrefix param) and sessions.logout (/current, no param → the
  // caller's OWN session). Refuses an op that would leave the office with zero
  // active owner sessions (shell-recovery lockout).
  preconditions.set("notLastOwnerLockout", (ctx) => {
    if (ctx.params.sessionPrefix !== undefined) {
      // revoke: only the owner GLOBAL path pre-checks lockout here. A member's
      // lockout is folded into the atomic mutator (so "would_strand_office"
      // only ever surfaces for a session the member actually owns — non-leak).
      const u = ctx.identity.userId
        ? getUserById(ctx.identity.userId)
        : undefined;
      if (u?.role !== "owner") return null;
      const hash = resolveSessionHashByPrefix(ctx.params.sessionPrefix);
      if (hash && wouldRevokeLeaveOfficeUnreachable(hash)) {
        return fail(409, "would_strand_office", SESSION_REVOKE_LOCKOUT_REASON);
      }
      return null;
    }
    // logout: act on the caller's OWN session. Fail closed if there is none (a
    // bearer caller) — DELETE /api/sessions/current can't identify a session.
    const hash = ctx.callerSessionIdHash;
    if (!hash) return fail(403, "forbidden");
    if (wouldRevokeLeaveOfficeUnreachable(hash)) {
      return fail(409, "would_strand_office", SESSION_LOGOUT_LOCKOUT_REASON);
    }
    return null;
  });

  // 3a.4c — Access settings (owner-only; office:admin + officeOwner guard, no
  // precondition). Both handlers delegate to the shared cores so the WS arms and
  // REST stay in lockstep; setAccess fans out invites_list via the self-invite
  // mint inside applyAccessSettings. REST selects the narrow { signInUrl,
  // restartRequired } shape from the richer core result.
  register(
    accessHandlers({
      getAccess: () => computeAccessSettings(),
      setAccess: async ({ externalAccess, publicOrigin, identity }) => {
        const r = await applyAccessSettings(
          externalAccess,
          publicOrigin,
          identity.userId,
        );
        return r.ok
          ? {
              ok: true,
              signInUrl: r.signInUrl,
              restartRequired: r.restartRequired,
            }
          : { ok: false, status: r.status, error: r.error };
      },
    }),
  );

  // 3d.9b — Users (auth surface; EXPAND+CUT). The users.* handlers were never
  // registered (Phase 1 probe: legacy-shape 401), so this BUILDS them. The
  // update_user SPLIT lands as OPTION A (Nil-gated): users.update = record fields
  // only; users.setAccess = allowedRooms + a prune-clamp of the target's existing
  // notif/default; view prefs stay self-only via view.*. EMIT-IN-DEP (no user
  // event sink): the seam runs updateUserById/deleteUser + the fanout, mirroring
  // the retired WS arms. Role/self authz is the route guard's (selfOrOwner /
  // officeOwner); the two delete preconditions add owner!=self + not-last-owner.
  register(
    usersHandlers({
      update: async ({ username, changes }) => {
        const target = getUser(username);
        if (!target) {
          return {
            ok: false,
            status: 404,
            code: "not_found",
            error: `User ${username} not found`,
          };
        }
        // Validate envFile against the same seam the WS arm used.
        if (changes.envFile && changes.envFile.trim()) {
          try {
            agentManager.validateEnvPath(changes.envFile.trim());
          } catch (err) {
            return {
              ok: false,
              status: 400,
              code: "invalid_env",
              error: errMessage(err, "Invalid env file"),
            };
          }
        }
        // Record fields ONLY — allowedRooms/notif/default are NOT in
        // UserUpdateReq (access → users.setAccess; view prefs → view.*). Resolve
        // by id so a rename can't strand the write.
        const result = updateUserById(target.id, {
          name: changes.name,
          envFile: changes.envFile,
          memberPrompt: changes.memberPrompt,
          avatarColor: changes.avatarColor,
          avatarVariant: changes.avatarVariant,
        });
        if (!result.ok) {
          const taken = /already exists/i.test(result.error);
          return {
            ok: false,
            status: taken ? 409 : 400,
            code: taken ? "name_taken" : "invalid_request",
            error: result.error,
          };
        }
        const renamed =
          username.toLowerCase() !== result.user.name.toLowerCase();
        // Condition the PUBLIC refresh on an actual public-field delta (0236f470).
        // users.update can touch PUBLIC fields or PRIVATE-only ones. UserPublicWire
        // is id|name|role|avatarColor|avatarVariant|createdAt, and of those this
        // route mutates only name/avatarColor/avatarVariant; env/prompt are private.
        // A private-only edit changes nothing in the public projection, so a public
        // user_updated/users_list would be a pure timing signal that the record
        // changed — the leak setAccess avoids. Mirror setAccess: owners always get
        // the full record via the owners-only admin event and the subject via its
        // own self event; the all-audience public channels fire ONLY when a public
        // field actually changed. (`target` is the pre-image: updateUserById writes
        // a new record, it does not mutate the object getUser returned.)
        const publicChanged =
          result.user.name !== target.name ||
          result.user.avatarColor !== target.avatarColor ||
          result.user.avatarVariant !== target.avatarVariant;
        if (publicChanged) {
          emitUserUpdated(result.user, renamed ? username : undefined);
          emitUsersList();
        } else {
          liveEmit("user_admin_updated", { user: result.user });
          liveEmit(
            "user_self_updated",
            { user: result.user },
            { userId: result.user.id },
          );
        }
        const presenceTouched = refreshPresenceForUser(result.user.id, {
          name: result.user.name,
          avatarColor: result.user.avatarColor,
          avatarVariant: result.user.avatarVariant,
        });
        if (presenceTouched) pushPresenceListToEachWs();
        return { ok: true, user: result.user };
      },
      setAccess: async ({ username, allowedRooms }) => {
        const target = getUser(username);
        if (!target) {
          return {
            ok: false,
            status: 404,
            code: "not_found",
            error: `User ${username} not found`,
          };
        }
        // ATOMIC clamp (deferred from slice 6): compute the new accessible set
        // from the INCOMING allowedRooms and prune the target's existing
        // notif/default to fit, in ONE updateUserById write. An empty `change`
        // re-clamps the current view fields (clampViewFields reads `current`).
        const accessible = accessibleRoomIdsFor(target, allowedRooms);
        const clamped = clampViewFields(accessible, target, {});
        const changes: {
          allowedRooms: string[];
          notifRooms: string[];
          defaultRoomId?: string | null;
        } = { allowedRooms, notifRooms: clamped.notifRooms };
        if (clamped.defaultRoomId !== target.defaultRoomId) {
          changes.defaultRoomId = clamped.defaultRoomId;
        }
        const result = updateUserById(target.id, changes);
        if (!result.ok) {
          return {
            ok: false,
            status: 500,
            code: "set_access_failed",
            error: result.error,
          };
        }
        // setAccess is a PRIVATE-only mutation (allowedRooms + the notif/default
        // clamp), so it emits ONLY the scoped channels — NO public user_updated /
        // users_list, which would leak the timing+target of an access change to
        // every user (Option A boundary, Reviewer1). Owners get the new grants via
        // the owners-only admin event; the target re-projects via full_state +
        // its own self event; presence sanitizes currentRoomId.
        liveEmit("user_admin_updated", { user: result.user });
        liveEmit(
          "user_self_updated",
          { user: result.user },
          { userId: result.user.id },
        );
        pushProjectedFullStateForUserId(result.user.id);
        const presenceTouched = refreshPresenceForUser(
          result.user.id,
          {
            name: result.user.name,
            avatarColor: result.user.avatarColor,
            avatarVariant: result.user.avatarVariant,
          },
          accessibleRoomIdsFor(result.user),
        );
        if (presenceTouched) pushPresenceListToEachWs();
        return { ok: true, user: result.user };
      },
      delete: async ({ username }) => {
        const target = getUser(username);
        // Re-check the lockout invariant atomically (the precondition is TOCTOU-
        // prone). owner!=self is enforced by userDeleteNotSelfOwner upstream.
        if (target && wouldDeleteLeaveNoOwner(target.id)) {
          return {
            ok: false,
            status: 409,
            code: "would_strand_office",
            error:
              "This is the last owner record. Promote another user to owner first, then retry.",
          };
        }
        // Idempotent: deleteUser is a no-op for an unknown username; the
        // users_list broadcast still fires so a watcher sees the target absent.
        deleteUser(username);
        emitUsersList();
        if (target) await evictSessionsForUserId(target.id);
        return { ok: true };
      },
    }),
  );

  // 3d.9b — delete_user preconditions (audit-pinned in routes-table.test.ts; kept
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

  // 3a.5 — Office settings (owner-only) + validation probes + backend models.
  // Four narrow deps over the shared cores so REST and the legacy WS arms stay in
  // lockstep. office.setSettings emits office_settings_updated via the
  // AgentManager event sink (the handler never emits). validate.cwd shares
  // agentManager.validateCwd directly; validate.env/backends share the cores.
  register(
    officeSettingsHandlers({
      getSettings: () => agentManager.getOfficeSettings(),
      applySettings: (input) => applyOfficeSettings(input),
    }),
  );
  // 3d.6 — room-structure mutations (rooms CRUD). The handlers stay thin; the
  // COMPOUND effects live here in the dep closures (the access/invites
  // EMIT-IN-DEP pattern), faithfully mirroring the now-deleted WS create_room/
  // close_room cases:
  //  - create: rule-based access — anyone authenticated with room:manage creates
  //    a room. OWNERS reach it by RULE (already in the room_created audience,
  //    received live, NO fan-out). A MEMBER creator needs an explicit GRANT to
  //    see their own creation (room_created fired during createRoom, before the
  //    grant, so it was suppressed for them); grant it, then push a projected
  //    full_state to catch them up. No owner allowedRooms/notifRooms fan-out and
  //    NO user_updated broadcast of the creator's grant (that broadcast was the
  //    hidden-room-id leak — a grant change reaches only its own subject).
  //  - close: strip the closed roomId from every user's allowedRooms/notifRooms
  //    so stale references don't accumulate, fanning out user_updated per touched
  //    record + a single users_list.
  // Both re-push presence to keep the room-mutation→presence invariant uniform.
  register(
    roomsHandlers({
      create: ({ name, creatorUserId }) => {
        const newRoomId = agentManager.createRoom(name);
        const creator = creatorUserId ? getUserById(creatorUserId) : undefined;
        if (
          creator &&
          creator.role !== "owner" &&
          !creator.allowedRooms.includes(newRoomId)
        ) {
          const result = updateUserById(creator.id, {
            allowedRooms: [...creator.allowedRooms, newRoomId],
          });
          if (result.ok) pushProjectedFullStateForUserId(creator.id);
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
        const closed = agentManager.closeRoom(roomId);
        if (!closed) return false;
        let touched = false;
        for (const u of listUsers()) {
          const inAllowed = u.allowedRooms.includes(roomId);
          const inNotif = u.notifRooms.includes(roomId);
          if (!inAllowed && !inNotif) continue;
          const changes: { allowedRooms?: string[]; notifRooms?: string[] } =
            {};
          if (inAllowed) {
            changes.allowedRooms = u.allowedRooms.filter((id) => id !== roomId);
          }
          if (inNotif) {
            changes.notifRooms = u.notifRooms.filter((id) => id !== roomId);
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
        return true;
      },
      rename: (roomId, name) => agentManager.renameRoom(roomId, name),
      setSettings: (roomId, prompt) =>
        agentManager.setRoomSettings(roomId, prompt),
    }),
  );
  // 3d.7 — agent lifecycle. The cores own the token lifecycle (spawn/revive mint,
  // kill/rollback revoke) + the agent_*/killed_* broadcasts, so these closures
  // just delegate (handlers stay contract-shaped). move returns a DISCRIMINATED
  // result the handler maps to status: moved / same-room idempotent -> { agent };
  // full target -> no_free_desk; absent target (owner-only) / post-guard race ->
  // room_not_found / agent_not_found. spawn/edit add validateCwd + saveRecentCwd
  // + null-disambiguation; revive delegates straight through (its lastRoomId ACL
  // is the reviveLastRoomAccess precondition below).
  register(
    agentsHandlers({
      kill: (agentId) => agentManager.kill(agentId),
      abort: (agentId) => agentManager.abort(agentId),
      move: (agentId, targetRoomId) => {
        const current = agentManager.getAgent(agentId);
        // agentParam proved the agent existed; a miss here is a post-guard race.
        if (!current) return { ok: false, reason: "agent_not_found" };
        // Same-room move is an idempotent no-op (the core returns no events);
        // return the unchanged agent, not a false failure.
        if (current.roomId === targetRoomId)
          return { ok: true, agent: current };
        if (agentManager.moveAgent(agentId, targetRoomId)) {
          const moved = agentManager.getAgent(agentId);
          return moved
            ? { ok: true, agent: moved }
            : { ok: false, reason: "agent_not_found" };
        }
        // Move didn't apply, agent exists, not same-room: the target room is
        // FULL, or (for an owner whose rule-based access passed bodyRoom) ABSENT.
        return agentManager.getRooms().some((r) => r.id === targetRoomId)
          ? { ok: false, reason: "no_free_desk" }
          : { ok: false, reason: "room_not_found" };
      },
      // agent-manager.swapDesks is (deskA, deskB, roomId); the dep takes
      // (roomId, deskA, deskB) so the handler reads room from the path param.
      swapDesks: (roomId, deskA, deskB) =>
        agentManager.swapDesks(deskA, deskB, roomId),
      setTopic: (agentId, topic) => agentManager.setTopic(agentId, topic),
      clearTopic: (agentId) => agentManager.resetTopic(agentId),
      // 7b response-driven trio. attributionFor derives the spawning user from
      // the token (never the body). spawn/edit do validateCwd + saveRecentCwd;
      // spawn disambiguates a null return; revive delegates to the core.
      attributionFor,
      spawn: async (input) => {
        try {
          agentManager.validateCwd(input.cwd);
        } catch (err) {
          return {
            ok: false,
            reason: "invalid_cwd",
            message: errMessage(err, "Invalid directory"),
          };
        }
        saveRecentCwd(input.cwd);
        try {
          const spawned = await agentManager.spawn(
            input.name,
            input.cwd,
            input.permissionMode ?? "default",
            input.desk,
            input.customInstructions,
            input.roomId,
            input.outfit,
            input.modelFamily,
            input.effort,
            input.username,
            input.agentType,
            input.codexSandbox,
            input.userId,
          );
          if (spawned) return { ok: true, agent: spawned };
          // null = duplicate name OR full room (neither throws). Disambiguate
          // AFTER the null, exactly as the WS arm did, so the dialog routes the
          // error to the right field.
          const trimmed = input.name.trim();
          const dup = agentManager
            .getAllAgents()
            .some((a) => a.name.toLowerCase() === trimmed.toLowerCase());
          return dup
            ? {
                ok: false,
                reason: "name_taken",
                message: `Name "${trimmed}" is already taken.`,
              }
            : {
                ok: false,
                reason: "no_free_desk",
                message: "The target room has no free desks.",
              };
        } catch (err) {
          return {
            ok: false,
            reason: "spawn_failed",
            message: errMessage(err, "Spawn failed"),
          };
        }
      },
      revive: (agentId, roomId, desk) =>
        agentManager.revive(agentId, roomId, desk),
      edit: async (agentId, changes) => {
        if (changes.cwd) {
          try {
            agentManager.validateCwd(changes.cwd);
          } catch (err) {
            return {
              ok: false,
              reason: "invalid_cwd",
              message: errMessage(err, "Invalid directory"),
            };
          }
          saveRecentCwd(changes.cwd);
        }
        try {
          // EditAgentReq.customInstructions is string|null|undefined (the
          // AgentInfo Pick widens it); editAgent wants string|undefined. The WS
          // edit_agent command never carried null (the dialog clears via ""), so
          // coerce null->undefined to preserve parity.
          await agentManager.editAgent(agentId, {
            ...changes,
            customInstructions: changes.customInstructions ?? undefined,
          });
          const agent = agentManager.getAgent(agentId);
          return agent
            ? { ok: true, agent }
            : {
                ok: false,
                reason: "agent_not_found",
                message: "Agent not found.",
              };
        } catch (err) {
          return {
            ok: false,
            reason: "edit_failed",
            message: errMessage(err, "Edit failed"),
          };
        }
      },
      setPrivileged: (agentId, privileged) =>
        agentManager.setPrivileged(agentId, privileged),
    }),
  );
  // 3d.7b — reviveLastRoomAccess: revive needs access to BOTH the target room
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
    return null;
  });
  // 3d.6a — conversation (send/edit/cancel/sendNow/newConversation/resume/
  // listSessions). CALL-IN-DEP closures mirror the deleted WS cases: the
  // streaming sends void-discard the manager promise (the turn streams over WS;
  // HTTP only acks), and sendMessage UNIFIES the two messageSend branches (USER
  // chat -> sendMessage with the approval overload; AGENT inter-agent ->
  // enqueueMessage with a server-derived structured sender, the retired POST
  // /agents/:id/message path).
  register(
    conversationHandlers({
      attributionFor,
      sendAsUser: (agentId, text, username, device, attachments) => {
        // Bare void mirrors the deleted WS send_message case: sendMessage owns the
        // echo / queue / recovery / slash / approval-reply overload and streams
        // the turn over WS; it handles its own errors as log entries (no reject).
        void agentManager.sendMessage(
          agentId,
          text,
          username,
          device,
          attachments,
        );
      },
      sendAsAgent: (receiverId, senderAgentId, text, clientMessageId) => {
        if (senderAgentId === receiverId)
          return {
            ok: false,
            status: 400,
            code: "self_send",
            message: "Cannot send a message to self.",
          };
        // Server-derived structured sender (name + room) — never body-trusted —
        // blocks identity spoof + prefix-delimiter injection into the prompt.
        const senderInfo = agentManager.getAgentDisplay(senderAgentId);
        if (!senderInfo)
          return {
            ok: false,
            status: 400,
            code: "unknown_sender",
            message: "Sender is not a known agent.",
          };
        const result = agentManager.enqueueMessage(receiverId, {
          sender: {
            kind: "agent",
            agentId: senderAgentId,
            agentName: senderInfo.name,
            roomName: senderInfo.roomName,
          },
          text,
          clientMessageId,
        });
        if (result.ok) return { ok: true, messageId: result.messageId };
        // enqueueMessage's error code passes through verbatim ("agent not found"
        // 404 — normally pre-empted by the messageRecipientExists precondition;
        // agent_stopped / agent_error 409; queue_full 429), preserving the legacy
        // endpoint's status + code contract.
        return {
          ok: false,
          status: result.status as 400 | 404 | 409 | 429,
          code: result.error,
          message: result.error,
        };
      },
      editMessage: (agentId, logEntryId, newText, username, device) => {
        void agentManager.editMessage(
          agentId,
          logEntryId,
          newText,
          username,
          device,
        );
      },
      cancelQueued: (agentId, messageId) => {
        agentManager.cancelQueued(agentId, messageId);
      },
      sendNow: (agentId) => {
        void agentManager.sendNow(agentId);
      },
      newConversation: (agentId, agentType) => {
        // The WS case awaited this purely for handler sequencing; the clear_logs
        // + turn events stream over WS regardless, so void-discard for an
        // immediate ack. .catch swallows (the WS path had no error surface).
        void agentManager.newConversation(agentId, agentType).catch(() => {});
      },
      resume: (agentId, sessionId) => {
        void agentManager.resume(agentId, sessionId).catch(() => {});
      },
      listSessions: (agentId) => ({
        sessions: agentManager.listSessions(agentId),
        currentSessionId: agentManager.getCurrentSessionId(agentId),
      }),
    }),
  );
  // 3d.6a — send-message preconditions (audit-pinned in routes-table.test.ts;
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
    // to an agent that has a pending permission — the legacy HTTP inter-agent path
    // queued it normally, and rejecting would be a behavior change. This
    // precondition is the explicit, audit-pinned record of that structural bind.
    return null;
  });
  // 3d.6b — editor (open/save/close). EMIT/CALL-IN-DEP closures own the stateful
  // watch lifecycle (the seam has `browsers` + the editorWatchers registry +
  // liveEmit in scope). openFile arms a watch bound to the caller's connectionId
  // that pushes editor_external_change to that socket; closeFile disarms it; the
  // connection is verified to belong to the caller's EXACT session first.
  register(
    editorHandlers({
      verifyConnection: (connectionId, callerSessionIdHash) => {
        // Exact-session match (not just same-user): a client can't aim a watch /
        // external-change push at another tab's socket. A bearer caller has no
        // callerSessionIdHash and fails closed (editor:use is USER-only).
        if (!callerSessionIdHash) return false;
        for (const ws of browsers) {
          if (ws.data.connectionId === connectionId)
            return ws.data.session.sessionIdHash === callerSessionIdHash;
        }
        return false;
      },
      openFile: (agentId, path, connectionId) => {
        const probe = agentManager.openEditorFile(agentId, path);
        if (!probe.ok) {
          // not_agent is normally pre-empted by the agentParam guard (403); a miss
          // here is a post-guard race. bad_path -> 400.
          return probe.error === "not_agent"
            ? {
                ok: false as const,
                status: 404,
                code: "agent_not_found",
                message: "Agent not found.",
              }
            : {
                ok: false as const,
                status: 400,
                code: "bad_path",
                message: "Invalid path.",
              };
        }
        const r = probe.result;
        if (r.kind === "not_found")
          return {
            ok: false,
            status: 404,
            code: "not_found",
            message: "File not found.",
          };
        if (r.kind === "not_file")
          return {
            ok: false,
            status: 422,
            code: "not_a_file",
            message: "Not a file.",
          };
        if (r.kind === "binary")
          return {
            ok: false,
            status: 422,
            code: "binary",
            message: "Binary file (text only).",
          };
        if (r.kind === "too_large")
          return {
            ok: false,
            status: 422,
            code: "too_large",
            message: `File is too large (${(r.size / 1024).toFixed(1)} KB, 1 MB limit).`,
          };
        if (r.kind === "io_error")
          return {
            ok: false,
            status: 500,
            code: "io_error",
            message: r.message,
          };
        // r.kind === "ok": install (or replace) the watch for this connection; the
        // callback pushes editor_external_change to the connection's socket.
        const map =
          editorWatchers.get(connectionId) ?? new Map<string, FileWatcher>();
        editorWatchers.set(connectionId, map);
        const key = editorKey(agentId, r.path);
        const old = map.get(key);
        if (old) {
          stopWatch(old);
          map.delete(key); // drop the stale entry up front; re-set below only if
          // the new watch installs (a vanished file -> watchFile null -> no
          // dangling closed watcher left under the key).
        }
        const watcher = watchFile(r.path, agentId, (mtime) => {
          liveEmit(
            "editor_external_change",
            { agentId, path: r.path, mtime },
            { connectionId },
          );
        });
        if (watcher) map.set(key, watcher);
        return {
          ok: true,
          path: r.path,
          content: r.content,
          mtime: r.mtime,
          language: r.language,
          size: r.size,
        };
      },
      saveFile: (agentId, path, content, expectedMtime, force) => {
        const abs = agentManager.resolveEditorPathForAgent(agentId, path);
        if (!abs)
          return {
            ok: false,
            status: 404,
            code: "agent_not_found",
            message: "Agent not found.",
          };
        const result = agentManager.saveEditorFile(
          abs,
          content,
          expectedMtime,
          force,
        );
        if (result.kind === "ok") return { ok: true, mtime: result.mtime };
        if (result.kind === "stale")
          return { ok: false, stale: true, currentMtime: result.currentMtime };
        return {
          ok: false,
          status: 500,
          code: "io_error",
          message: result.message,
        };
      },
      closeFile: (agentId, path, connectionId) => {
        const abs = agentManager.resolveEditorPathForAgent(agentId, path);
        if (!abs) return;
        const map = editorWatchers.get(connectionId);
        if (!map) return;
        const key = editorKey(agentId, abs);
        const w = map.get(key);
        if (w) {
          stopWatch(w);
          map.delete(key);
        }
        if (map.size === 0) editorWatchers.delete(connectionId);
      },
    }),
  );
  // 3b.4 — per-user view preferences. REST view.* is the SOLE surface now: group 7
  // (3d.9b) retired the WS update_user notif/default arm, and under Option A
  // notif/default are self-only. reorder_rooms cut over to view.setOrder in slice 6.
  register(
    viewHandlers({
      applyView: (userId, change) => applyViewChange(userId, change),
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
  // 3a.6 — System backup status. Maps the internal BackupStatus to the normalized
  // /api wire shape (rename + null→false on ok); the legacy /backup/status keeps
  // its raw shape.
  register(
    systemHandlers({
      getBackupStatus: () => {
        const s = getBackupStatus();
        return {
          lastRunAt: s.lastBackupAt,
          ok: s.lastBackupOk ?? false,
          error: s.lastBackupError,
          retention: s.retention,
          destDir: s.backupDir,
        };
      },
    }),
  );

  // 3a.5 — validateEnvBodySelfSubject: the SOLE object-level policy for
  // validate.env (its guard is just `authenticated`). An owner may validate any
  // scope/user, a member ONLY their own user env. Non-leak: office scope or
  // another user's env both deny with the same 403. (This replaced the equivalent
  // inline checks in the now-retired request_settings_validation WS arm.) It is
  // what keeps the precondition reachable (a member validating their own env is
  // allowed HERE, not denied at the guard as the prior or(officeOwner, selfUser) did).
  //
  // SCOPE GATE (task 98d63ef7): historically office:read (stage 1) implied USER
  // scope, but a PRIVILEGED agent now also holds office:read. The subject policy
  // below keys on the resolved user's RECORD role, so an owner-spawned agent
  // would otherwise inherit owner reach and probe any user's/office env-file
  // metadata (key count, parse errors). Env validation is a human/UI affordance —
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
    guardDeps: buildLiveGuardDeps(),
    idempotency: idempotencyCache,
    handlers,
    preconditions,
  };
}

// Shared cron-mutation authorization for the LEGACY WS shims (Phase 3a). The new
// REST routes enforce cronjobOwnerOrOfficeOwner / officeOwner via authorize();
// the still-living WS arms must enforce the SAME tightening at the shared
// boundary so the strangler doesn't leave a WS-path bypass (the [behavior-change]
// the route table declares). One impl: these wrap the very guards the route
// table names, fed the live GuardDeps.
interface VisibleRoomProjection {
  rooms: RoomWire[];
  // global room index → dense visible index, or -1 if not visible for this
  // session. Post-cut this is purely a per-recipient VISIBILITY predicate
  // (>= 0 ⟺ visible); the dense value is no longer rewritten onto the wire.
  globalToVisible: number[];
  // Phase 3c: stable roomId → GLOBAL room index (covers every room, not just the
  // visible ones). Lets roomId-authority callers map an id to its global index
  // for corrupt-id detection and, via globalToVisible, test visibility. A roomId
  // absent here is corrupt (loud); present-but-globalToVisible<0 is normal
  // projection filtering.
  globalRoomIdToIndex: Map<string, number>;
}

function visibleRoomProjection(session: SessionLookup): VisibleRoomProjection {
  const all = agentManager.getRooms();
  // Phase 3c: built once, shared by both projection paths. roomId → global index
  // for callers that derive the dense index from the authoritative roomId.
  const globalRoomIdToIndex = new Map(all.map((r, i) => [r.id, i] as const));
  const user = getUserById(session.userId);
  // Fast path: a full-access user with NO hidden rooms and NO custom order sees
  // every room in office order — the identity projection (no per-room
  // allocations). Phase 3b migrates hidden/order to [], so this is the common
  // case and stays byte-identical to the pre-3b full-access fast path.
  if (
    user &&
    sessionHasFullRoomAccess(session) &&
    user.hidden.length === 0 &&
    user.order.length === 0
  ) {
    const identity: number[] = all.map((_, i) => i);
    return {
      rooms: all,
      globalToVisible: identity,
      globalRoomIdToIndex,
    };
  }
  // General path. ACCESS is the security gate (roomAllowedForSession today;
  // canAccess after the 3b.3 flip). `hidden` is an additive VIEW filter ON TOP
  // (effective shown = accessible \ hidden) and is NEVER a security gate — an
  // owner who hides a room still has access; a re-show consults only access.
  // `order` is a SPARSE per-user preference: rooms listed there come first in
  // that order, then the remaining visible rooms in office order. With the
  // migrated defaults (hidden=[], order=[]) this reduces to "accessible rooms
  // in office order", i.e. today's projection — verified by projection.test.
  const hidden = new Set(user?.hidden ?? []);
  const orderRank = new Map<string, number>();
  // First-write-wins on duplicate order ids (applyViewChange dedupes on write;
  // this guards a hand-edited persisted order array too).
  if (user) {
    user.order.forEach((id, i) => {
      if (!orderRank.has(id)) orderRank.set(id, i);
    });
  }
  const visibleGlobal: number[] = [];
  for (let i = 0; i < all.length; i++) {
    if (!roomAllowedForSession(session, all[i].id)) continue; // access gate
    if (hidden.has(all[i].id)) continue; // view filter (not security)
    visibleGlobal.push(i);
  }
  // Stable sort: explicit-order rank first (listed rooms, in listed order),
  // office order (the original global index) as the tiebreak for everything
  // unlisted. Rank +Infinity for unlisted rooms keeps them in office order.
  visibleGlobal.sort((a, b) => {
    const ra = orderRank.has(all[a].id) ? orderRank.get(all[a].id)! : Infinity;
    const rb = orderRank.has(all[b].id) ? orderRank.get(all[b].id)! : Infinity;
    return ra !== rb ? ra - rb : a - b;
  });
  const rooms: RoomWire[] = [];
  const globalToVisible: number[] = new Array(all.length).fill(-1);
  for (const i of visibleGlobal) {
    globalToVisible[i] = rooms.length;
    rooms.push(all[i]);
  }
  return { rooms, globalToVisible, globalRoomIdToIndex };
}

// Returns the agent UNCHANGED (the shared AgentManager reference) if its room is
// visible to this session, or null if not. Post-cut there is no dense `room` to
// rewrite — agents carry a stable roomId — so this is purely a per-recipient
// visibility filter. Callers treat the result as read-only (serialize, never
// mutate).
function projectAgentForSession(
  session: SessionLookup,
  agent: AgentInfo,
  projection?: VisibleRoomProjection,
): AgentInfo | null {
  const proj = projection ?? visibleRoomProjection(session);
  // Phase 3c: derive the global index from the authoritative roomId. Absent from
  // the map = corrupt roomId (loud + suppress); present but globalToVisible < 0 =
  // legitimately not visible to this session (silent, normal filtering).
  const globalIdx = proj.globalRoomIdToIndex.get(agent.roomId);
  if (globalIdx === undefined) {
    console.error(
      `[3c] projectAgentForSession: unknown roomId "${agent.roomId}" for agent ${agent.id}; suppressing`,
    );
    return null;
  }
  if (proj.globalToVisible[globalIdx] < 0) return null;
  return agent;
}

// True if a given agentId currently lives in a room visible to this
// session. Looks up the agent's room from AgentManager — caller doesn't
// need to know it. Used by per-agent event routing (log_entry,
// slash_commands, terminal_*) and write-side enforcement.
function agentVisibleForSession(
  session: SessionLookup,
  agentId: string,
): boolean {
  if (sessionHasFullRoomAccess(session)) return true;
  const agent = agentManager.getAllAgents().find((a) => a.id === agentId);
  if (!agent) return false;
  // Phase 3c: the agent carries its authoritative roomId directly.
  if (!agent.roomId) return false;
  return roomAllowedForSession(session, agent.roomId);
}

// Build and send the full_state payload for a given WS using the session's
// projected room/agent view. Used at connect time and as the targeted
// refresh after any change that could shift this session's visible set
// (allowedRooms changes, agent moves across rooms, room close/rename/
// reorder when explicit-list members are connected). Mid-session callers
// pass replayLogsForVisible=true to also resend cached log entries for
// agents the session can now see; without that flag, newly visible agents
// would render in the UI with no history until the next reload.
// Project office settings for a recipient: envFile is owner-only (Phase 3b
// slice 5 / Isomuxer3 Q1b), so it is stripped for non-owner recipients and
// never reaches a member's full_state.office. Owners keep the full triple.
function projectOfficeFor(session: SessionLookup): OfficeWire {
  const office = agentManager.getOfficeSettings();
  const isOwner = getUserById(session.userId)?.role === "owner";
  return isOwner
    ? { prompt: office.prompt, name: office.name, envFile: office.envFile }
    : { prompt: office.prompt, name: office.name };
}

function sendProjectedFullState(
  ws: ServerWebSocket<WsData>,
  options?: { replayLogsForVisible?: boolean },
) {
  const session = ws.data.session;
  const proj = visibleRoomProjection(session);
  const agents: AgentInfo[] = [];
  for (const a of agentManager.getAllAgents()) {
    const projected = projectAgentForSession(session, a, proj);
    if (projected) agents.push(projected);
  }
  // ACL-filtered list of currently-killed agents for the spawn menu's
  // revive chips. Drop entries whose lastRoomId isn't visible to this
  // session — a member shouldn't be able to revive an agent from a
  // private room they can't enter. Cap AFTER filtering so the user
  // sees up to KILLED_AGENT_CHIP_CAP entries they can actually act on,
  // not a smaller number trimmed by entries outside their room set.
  const killedAgents = agentManager
    .getKilledAgentSummaries()
    .filter((k) => roomAllowedForSession(session, k.lastRoomId))
    .slice(0, KILLED_AGENT_CHIP_CAP);
  ws.send(
    JSON.stringify({
      type: "full_state",
      agents,
      recentCwds: loadRecentCwds(),
      office: projectOfficeFor(session),
      rooms: proj.rooms,
      killedAgents,
    }),
  );
  if (options?.replayLogsForVisible) {
    for (const a of agents) {
      const logs = agentManager.getAgentLogs(a.id);
      for (const entry of logs) {
        ws.send(JSON.stringify({ type: "log_entry", entry }));
      }
      const cmds = agentManager.getAgentCommands(a.id);
      if (cmds.commands.length > 0 || cmds.skills.length > 0) {
        ws.send(
          JSON.stringify({
            type: "slash_commands",
            agentId: a.id,
            commands: cmds.commands,
            skills: cmds.skills,
          }),
        );
      }
    }
  }
}

// Push a fresh projected full_state to every WS owned by a specific
// userId. Called after a successful update_user that changed allowedRooms
// — every device that user is connected from gets the new view applied
// without a reconnect. Users whose allowedRooms already covers every
// room get the identity projection, so the call is cheap; we don't
// need to branch on role.
function pushProjectedFullStateForUserId(userId: string) {
  for (const ws of browsers) {
    if (ws.data.session.userId === userId) {
      sendProjectedFullState(ws, { replayLogsForVisible: true });
    }
  }
}

// Push the presence_list to just ONE user's sockets (each per-recipient
// projected). Used after a per-user view change alters which rooms that user
// sees (hidden/order): buildPresenceListFor re-filters their ghosts, but no
// other user's projection changed — so this stays tighter than
// pushPresenceListToEachWs.
function pushPresenceListForUserId(userId: string) {
  for (const ws of browsers) {
    if (ws.data.session.userId === userId) sendPresenceListTo(ws);
  }
}

// Dedupe preserving FIRST occurrence (used for the sparse `order` list, so a
// hand-edited or client-sent order with duplicates resolves deterministically).
function dedupeFirstWins(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Phase 3b slice 4 — the SINGLE core that owns every per-user VIEW-preference
// write. TARGET-USER based (owners edit a member's view via admin surfaces, and
// a role-change/demotion hook re-clamps the target the same way), so the change
// applies to targetUserId, never the actor's session. It is the ONE place that
// computes: the rule-based ACCESSIBLE set, effective shown (accessible \
// hidden), the sparse-order filter+dedupe, and the notifRooms / defaultRoomId
// clamps — then persists once and fans out.
//
// NO-ORACLE on write (Isomuxer3 Q2): unknown / inaccessible / accessible-but-
// hidden room ids are SILENTLY filtered/clamped, never rejected (a reject is an
// existence oracle). Callers reject malformed body SHAPES before reaching here.
//
// `change` is a partial: any subset of {order, shown, notifRooms, defaultRoomId}.
// An EMPTY change is the re-clamp pass (call after an access mutation / demotion
// to re-establish hidden ⊆ accessible, notifRooms ⊆ effective shown, default ∈
// effective shown). `shown` is the desired VISIBLE set (route input); it is
// converted at the boundary to hidden = accessible \ shown (only accessible ids
// are ever persisted in hidden). Returns false if the target user is missing.
interface ViewChange {
  order?: readonly string[];
  shown?: readonly string[];
  notifRooms?: readonly string[];
  defaultRoomId?: string | null;
}

// PURE clamp — the single source of truth for the view invariants. Given the
// accessible set, the user's CURRENT view fields, and a partial change, compute
// the next fields: order deduped (first wins) + filtered to accessible (hidden-
// but-accessible ids KEPT, so hide/show is non-destructive); hidden = the
// accessible rooms NOT in the desired shown set (or the stored hidden re-
// filtered to accessible); notifRooms within effective shown; defaultRoomId
// within effective shown else null (inaccessible and accessible-but-hidden both
// miss effective shown -> null, so no existence oracle). applyViewChange (view.*)
// and the users.setAccess prune-clamp (3d.9b) both clamp through this, so the
// invariant lives in exactly one place.
function clampViewFields(
  accessible: ReadonlySet<string>,
  current: {
    order: readonly string[];
    hidden: readonly string[];
    notifRooms: readonly string[];
    defaultRoomId: string | null;
  },
  change: ViewChange,
): {
  order: string[];
  hidden: string[];
  notifRooms: string[];
  defaultRoomId: string | null;
} {
  const order = dedupeFirstWins([...(change.order ?? current.order)]).filter(
    (id) => accessible.has(id),
  );
  let hidden: string[];
  if (change.shown !== undefined) {
    const shownSet = new Set(change.shown.filter((id) => accessible.has(id)));
    hidden = [...accessible].filter((id) => !shownSet.has(id));
  } else {
    hidden = current.hidden.filter((id) => accessible.has(id));
  }
  const hiddenSet = new Set(hidden);
  const effectiveShown = new Set(
    [...accessible].filter((id) => !hiddenSet.has(id)),
  );
  const notifRooms = dedupeFirstWins([
    ...(change.notifRooms ?? current.notifRooms),
  ]).filter((id) => effectiveShown.has(id));
  const candidateDefault =
    change.defaultRoomId !== undefined
      ? change.defaultRoomId
      : current.defaultRoomId;
  const defaultRoomId =
    candidateDefault && effectiveShown.has(candidateDefault)
      ? candidateDefault
      : null;
  return { order, hidden, notifRooms, defaultRoomId };
}

function applyViewChange(targetUserId: string, change: ViewChange): boolean {
  const user = getUserById(targetUserId);
  if (!user) return false;
  const accessible = accessibleRoomIdsFor(user);

  // Snapshot prior values (as keys) BEFORE the write so the post-write fanout
  // can tell what actually changed (sets compared order-insensitively; `order`
  // is order-sensitive).
  const prevOrderKey = user.order.join("\u0000");
  const prevHiddenKey = [...user.hidden].sort().join("\u0000");
  const prevNotifKey = [...user.notifRooms].sort().join("\u0000");
  const prevDefault = user.defaultRoomId;

  const next = clampViewFields(accessible, user, change);

  const r = updateUserById(targetUserId, {
    order: next.order,
    hidden: next.hidden,
    notifRooms: next.notifRooms,
    defaultRoomId: next.defaultRoomId,
  });
  if (!r.ok) {
    console.error(
      `[view] applyViewChange failed for ${targetUserId}: ${r.error}`,
    );
    return false;
  }

  // Fanout, scoped to what actually changed. order/hidden change the PROJECTION
  // (which rooms the target sees and in what order) → projected full_state to the
  // target's own sockets. notifRooms/defaultRoomId are scalar record fields not
  // carried in full_state → emitUserUpdated (public wire to all, full record to
  // owners via the admin channel and to the subject via the self channel) +
  // emitUsersList.
  const projectionChanged =
    next.order.join("\u0000") !== prevOrderKey ||
    [...next.hidden].sort().join("\u0000") !== prevHiddenKey;
  const recordChanged =
    [...next.notifRooms].sort().join("\u0000") !== prevNotifKey ||
    next.defaultRoomId !== prevDefault;
  if (projectionChanged) {
    pushProjectedFullStateForUserId(targetUserId);
    // Re-push the target's OWN presence list: hiding/reordering changes which
    // rooms are visible to them, so buildPresenceListFor re-filters their ghosts
    // (full_state carries no presence; only this user's sockets are affected).
    pushPresenceListForUserId(targetUserId);
  }
  if (recordChanged) {
    emitUserUpdated(r.user);
    emitUsersList();
  }
  return true;
}

// Push the unfiltered global rooms list to every owner WS. Used after
// any change to the global rooms array so the owner-only admin view
// (currently: the Allowed Rooms editor in UserManagementModal) keeps
// in sync. Owners with an explicit allowedRooms still see only their
// subset in the main UI; this channel is purely for the admin surface
// where they grant/revoke other users' room access. Members never
// receive this — leaking the full room list across visibility lines
// would defeat the per-user ACL.
function pushAllRoomsListToOwners() {
  const data = JSON.stringify({
    type: "all_rooms_list",
    rooms: agentManager.getRooms(),
  });
  for (const ws of browsers) {
    if (ws.data.session.role === "owner") {
      ws.send(data);
    }
  }
}

// Per-WS dispatch for events that touch a specific room or agent.
// Sessions whose allowedRooms covers every current room id take the
// fast path and receive the event verbatim. Sessions with partial
// coverage get either:
//   - the event verbatim if its room/agent is visible (post-cut there's no
//     dense index to rewrite — agents carry stable room ids), or
//   - a suppressed event (the room/agent isn't visible), or
//   - a fresh projected full_state when a move could change which agents are
//     visible to a restricted recipient (agent move across rooms).
//
// The full_state-on-shift approach is heavy-handed but keeps the UI's
// existing positional contract intact. log entries are replayed for
// agents that become newly visible inside the same call.
function routeAgentEvent(event: AgentEvent) {
  for (const ws of browsers) {
    routeAgentEventToWs(ws, event);
  }
}

// Slice 3b.1: route the room-ACL agent/room event fanout through the emit()
// helper (registry audience) + the projection-aware deliver(), replacing the
// implicit per-WS routeAgentEvent for every event whose registry audience maps
// 1:1 to today's access decision (verified byte-identical; projection.test
// stays green). The two events that need pre-mutation context the domain event
// drops stay on the routeAgentEvent bridge until slice 3b.3 carries the ids and
// tightens the ACL:
//   - agent_removed: domain {agentId} lacks the pre-removal roomId the room-ACL
//     audience needs (and the agent is already gone from state here).
//   - agent_updated MOVE (changes.roomId set): carries the NEW roomId but drops
//     the OLD room the old∪new move audience needs.
function emitAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "log_entry":
      liveEmit("log_entry", { entry: event.entry });
      break;
    case "clear_logs":
      liveEmit("clear_logs", { agentId: event.agentId });
      break;
    case "slash_commands":
      liveEmit("slash_commands", {
        agentId: event.agentId,
        commands: event.commands,
        skills: event.skills,
      });
      break;
    case "terminal_output":
      liveEmit("terminal_output", {
        agentId: event.agentId,
        data: event.data,
      });
      break;
    case "terminal_exit":
      liveEmit("terminal_exit", {
        agentId: event.agentId,
        exitCode: event.exitCode,
      });
      break;
    case "agent_added":
      liveEmit("agent_added", { agent: event.agent });
      break;
    case "killed_agent_added":
      liveEmit("killed_agent_added", { agent: event.agent });
      break;
    case "killed_agent_removed":
      liveEmit("killed_agent_removed", {
        agentId: event.agentId,
        lastRoomId: event.lastRoomId,
      });
      break;
    case "room_created":
      liveEmit("room_created", { room: event.room });
      break;
    case "room_renamed":
      liveEmit("room_renamed", { roomId: event.roomId, name: event.name });
      break;
    case "room_settings_updated":
      liveEmit("room_settings_updated", {
        roomId: event.roomId,
        prompt: event.prompt,
      });
      break;
    case "room_closed":
      liveEmit("room_closed", { roomId: event.roomId });
      break;
    case "agent_updated":
      // NON-move updates project via agentLookup on the agent's CURRENT room.
      // A MOVE is discriminated by a present `roomId` in changes; it needs the
      // old∪new audience the domain event can't supply yet, so it rides the
      // bridge (full_state refresh for restricted recipients) until oldRoomId is
      // carried in the carried-context slice.
      if (event.changes.roomId === undefined) {
        liveEmit("agent_updated", {
          agentId: event.agentId,
          changes: event.changes,
        });
      } else {
        routeAgentEvent(event);
      }
      break;
    default:
      // TODO(3b.3): the routeAgentEvent bridge is BOUNDED — after this slice
      // routeAgentEvent is allowed ONLY for agent_removed and agent_updated with
      // changes.roomId set (handled in the case above), plus any explicitly
      // documented bridge case. Nothing else may be added here. agent_removed
      // keeps today's
      // broadcast-all (a minor id leak) until 3b.3 tightens it to room-ACL with a
      // characterization flip; the bounded-bridge + behavioral raw-send invariant
      // (no un-projected fanout outside the projection dispatcher) is enforced by
      // the contract-test slice.
      routeAgentEvent(event);
      break;
  }
}

function routeAgentEventToWs(ws: ServerWebSocket<WsData>, event: AgentEvent) {
  const session = ws.data.session;

  if (sessionHasFullRoomAccess(session)) {
    ws.send(JSON.stringify(event));
    return;
  }

  switch (event.type) {
    case "agent_added": {
      const projected = projectAgentForSession(session, event.agent);
      if (projected) {
        ws.send(JSON.stringify({ type: "agent_added", agent: projected }));
      }
      break;
    }
    case "agent_removed": {
      // Idempotent on the receiver — fine to deliver even if they never
      // saw the agent.
      ws.send(JSON.stringify(event));
      break;
    }
    case "killed_agent_added": {
      // ACL: only deliver if the session can see the lastRoomId. A
      // member shouldn't learn a private room's agent died.
      if (roomAllowedForSession(session, event.agent.lastRoomId)) {
        ws.send(JSON.stringify(event));
      }
      break;
    }
    case "killed_agent_removed": {
      // Symmetric ACL with the added variant: a session that never
      // saw the chip shouldn't learn the id became alive again.
      if (roomAllowedForSession(session, event.lastRoomId)) {
        ws.send(JSON.stringify(event));
      }
      break;
    }
    case "agent_updated": {
      if (event.changes.roomId !== undefined) {
        // Room move (discriminated by a present roomId): for a restricted
        // recipient the agent could be entering, leaving, or staying in their
        // visible set, so a targeted full_state refresh is the cheapest correct
        // play — but the UI's full_state reducer clears logs/slashCommands, so
        // we replay them for every currently-visible agent or the member loses
        // transcripts.
        sendProjectedFullState(ws, { replayLogsForVisible: true });
      } else if (agentVisibleForSession(session, event.agentId)) {
        // No room change — non-room fields are safe to forward verbatim.
        ws.send(JSON.stringify(event));
      }
      break;
    }
    case "room_created": {
      if (roomAllowedForSession(session, event.room.id)) {
        // New room is at the end of the global rooms array → also at
        // the end of this session's visible array. No index shift.
        ws.send(JSON.stringify(event));
      }
      // If the room is not allowed, the member's visible list is
      // unchanged.
      break;
    }
    case "room_closed":
    case "room_renamed":
    case "room_settings_updated": {
      // Defensive/legacy branch: these room events are delivered via the emit()
      // registry + deliver() path, not this bridge, so this case is not normally
      // reached. Post-cut none of them shift any dense index (room ids are
      // stable), so a visible recipient takes the verbatim delta and a
      // non-visible one drops it.
      if (roomAllowedForSession(session, event.roomId)) {
        ws.send(JSON.stringify(event));
      }
      break;
    }
    case "log_entry": {
      if (agentVisibleForSession(session, event.entry.agentId)) {
        ws.send(JSON.stringify(event));
      }
      break;
    }
    case "clear_logs":
    case "slash_commands":
    case "terminal_output":
    case "terminal_exit": {
      if (agentVisibleForSession(session, event.agentId)) {
        ws.send(JSON.stringify(event));
      }
      break;
    }
    case "office_settings_updated":
    case "tasks_changed": {
      // No room scope — everyone sees these.
      ws.send(JSON.stringify(event));
      break;
    }
  }
}

// wireEventSinks: route AgentManager + CronjobManager domain events onto the
// WS broadcast / per-recipient fanout. Extracted so startServer() wires the
// active instances. Body left at prior indentation; prettier normalizes.
function wireEventSinks(): void {
  // Wire AgentManager events to WebSocket broadcasts
  agentManager.onEvent((event) => {
    // Task mutations carry the full list as a domain event; the wire still
    // uses the legacy `{type:"tasks", tasks}` shape so the UI doesn't change.
    if (event.type === "tasks_changed") {
      // Routed through the emit() helper (audience `all`) rather than a raw
      // broadcast, so the migrated tasks core ops share one wire path. emit()
      // resolves `all` -> every session, so the wire stays byte-identical.
      liveEmit("tasks", { tasks: event.tasks });
      return;
    }
    // Office settings: envFile is owner-only and NEVER rides this all-audience
    // event (3b.5 Q1b). Members read {prompt,name}; owners learn envFile via
    // their full_state (owner office projection) / office.getSettings on reload.
    if (event.type === "office_settings_updated") {
      broadcast({
        type: "office_settings_updated",
        prompt: event.prompt,
        name: event.name,
      });
      return;
    }
    // All remaining events touch a specific room or agent. Slice 3b.1 routes the
    // clean room-ACL events through the emit() helper (registry audience) +
    // projection-aware deliver(); agent_removed and agent_updated-MOVE stay on
    // the routeAgentEvent bridge inside emitAgentEvent until slice 3b.3.
    emitAgentEvent(event);
    // Any mutation of the global rooms list also refreshes the owner-only
    // admin view of all rooms (used by UserManagementModal). Done here
    // (rather than inside routeAgentEvent) so the all_rooms_list message
    // doesn't fan out per-event-type; one shot per mutation.
    if (
      event.type === "room_created" ||
      event.type === "room_closed" ||
      event.type === "room_renamed" ||
      event.type === "room_settings_updated"
    ) {
      pushAllRoomsListToOwners();
    }
  });

  // Wire CronjobManager events to WebSocket broadcasts
  cronjobManager.onCronjobEvent((event) => {
    switch (event.type) {
      // The clean `all`-audience cron events route through the emit() helper
      // (byte-identical broadcast); matching registry ids + payload shapes.
      case "cronjob_added":
        liveEmit("cronjob_added", { cronjob: event.cronjob });
        break;
      case "cronjob_updated":
        liveEmit("cronjob_updated", { cronjob: event.cronjob });
        break;
      case "cronjob_deleted":
        liveEmit("cronjob_deleted", { id: event.id });
        break;
      case "cronjobs_prompt_updated":
        liveEmit("cronjobs_prompt_updated", { value: event.value });
        break;
      case "cronjob_run_updated":
        liveEmit("cronjob_run_updated", { run: event.run });
        break;
      // COMPATIBILITY BRIDGE (Phase 3a, deliberate — flagged to Nil): cron-run
      // transcript entries stream as `log_entry` with a synthetic
      // cronrun-<runId> agentId. The TARGET registry event is the office-wide
      // `cron_run_log_entry`, but the UI/demo still key cron transcripts on
      // `log_entry` (ui/store.tsx), and the target `log_entry` registry entry is
      // room-ACL (it would fail-closed on the non-existent synthetic agent). So
      // these stay on the raw broadcast until the UI-coordinated
      // cron_run_log_entry wire migration (a later contract step, same bucket as
      // retiring the *_response messages). Do NOT route through liveEmit until
      // shared ServerMessage + ui/store + demo-server switch together.
      case "log_entry":
        broadcast({ type: "log_entry", entry: event.entry });
        break;
    }
  });
} // end wireEventSinks

// Inbound WS messages. Phase 3 moved every durable command to REST, so the WS is
// no longer a command bus: the only inbound messages are the three permanent
// exceptions — interactive terminal IO, presence_update (ephemeral cursor
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
  ws: ServerWebSocket<WsData>,
) {
  const session = ws.data.session;
  try {
    switch (cmd.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      case "presence_update": {
        // Live-avatars: the sender tells us where its ghost should appear, as a
        // stable global room id. Validate it DIRECTLY — it must name a LIVE room
        // the sender can access — and clamp to null otherwise (sanitize, don't
        // reject; the common cause is a race with an allowedRooms change). No
        // room-index projection on the inbound path post-cut. Access (not
        // visible/shown) is the gate: hiding a room is a view preference, not an
        // access restriction, and buildPresenceListFor still filters each
        // recipient by their own visibility so this can't leak a ghost into a
        // room a recipient can't see. Self user record supplies avatarColor +
        // avatarVariant so the wire payload is self-contained.
        const user = getUserById(session.userId);
        if (!user) break;
        // Liveness is a SILENT membership check, not roomById(): a stale inbound id
        // (the client raced a room close) is an EXPECTED sanitize-to-null case, not
        // server-state corruption, so it must not trip roomById's loud [3c] log the
        // way a dangling AGENT roomId on the emit side does. canAccess first as the
        // cheap short-circuit (a member without the grant never scans the rooms).
        const roomId =
          cmd.currentRoomId !== null &&
          canAccess(user, cmd.currentRoomId) &&
          agentManager.getRooms().some((r) => r.id === cmd.currentRoomId)
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
          // Phase 3c: read the agent's authoritative roomId directly.
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
          lastSeenAt: Date.now(),
        });
        if (changed) {
          pushPresenceListToEachWs();
        }
        break;
      }
      case "terminal_open": {
        if (!agentVisibleForSession(session, cmd.agentId)) break;
        const opened = agentManager.openTerminal(cmd.agentId);
        if (opened) {
          // Seed ONLY the requester that just opened the terminal. The live
          // terminal_output stream is ACL-gated on the live emit path (it is a
          // room-ACL event), so other visible sockets stay current without this
          // replay; broadcasting the backlog to every socket leaked it to
          // sockets without access to the agent's room (task 39ce6225) and could
          // duplicate the backlog into another already-open terminal panel for
          // the same agent.
          const buffer = agentManager.getTerminalBuffer(cmd.agentId);
          if (buffer) {
            ws.send(
              JSON.stringify({
                type: "terminal_output",
                agentId: cmd.agentId,
                data: buffer,
              }),
            );
          }
        }
        break;
      }
      case "terminal_input":
        if (!agentVisibleForSession(session, cmd.agentId)) break;
        agentManager.terminalInput(cmd.agentId, cmd.data);
        break;
      case "terminal_resize":
        if (!agentVisibleForSession(session, cmd.agentId)) break;
        agentManager.terminalResize(cmd.agentId, cmd.cols, cmd.rows);
        break;
      case "terminal_close":
        if (!agentVisibleForSession(session, cmd.agentId)) break;
        agentManager.closeTerminal(cmd.agentId);
        break;
    }
  } catch (err) {
    console.error(`[inbound] ${cmd.type} failed:`, err);
  }
}

// Resolve UI dist path
const UI_DIST = join(import.meta.dir, "..", "ui", "dist");

// Escape a string for safe inclusion as text inside an HTML element (e.g. <title>).
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Serve index.html with the office name substituted into the <title>. The UI
// has `<title>__OFFICE_TITLE__</title>`; we replace that placeholder per-request
// so the tab title is correct before the WS connects (and on the auth page).
async function serveIndexHtml(): Promise<Response> {
  const raw = await Bun.file(join(UI_DIST, "index.html")).text();
  const officeName = agentManager.getOfficeSettings().name;
  const title = officeName ? `${escapeHtml(officeName)} | Isomux` : "Isomux";
  const html = raw.replace("__OFFICE_TITLE__", title);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      ...securityHeaders(),
    },
  });
}

const PORT = parseInt(process.env.PORT || "4000");

// buildServer: construct the HTTP+WS listener. Extracted from module top-level
// so startServer() controls when the bind happens (production via
// import.meta.main; tests via the in-process harness on an ephemeral port).
// Body left at its prior indentation; prettier normalizes post-review.
function buildServer(startOpts: StartServerOpts): Server<WsData> {
  // Pre-claim OR post-claim-with-external-access-off, bind loopback only.
  // External clients can't reach the server at all in either case; the
  // Access pane's external-access toggle, paired with a restart, opens the
  // bind to all interfaces.
  const BIND_LOOPBACK_ONLY = isProcessBoundLoopback();

  return Bun.serve<WsData>({
    port: startOpts.port ?? PORT,
    // Default is ~128MB, below our 200MB per-file / 400MB per-upload limits, so a
    // large upload would 413 before reaching the handler. Keep this above MAX_TOTAL.
    maxRequestBodySize: 512 * 1024 * 1024, // 512MB
    ...(BIND_LOOPBACK_ONLY ? { hostname: "127.0.0.1" } : {}),
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade — authenticated and origin-checked. The upgrade
      // carries the session into ws.data so per-message handlers can attribute
      // writes without trusting client-supplied username fields.
      if (url.pathname === "/ws") {
        const wsCookie = readSessionCookie(req);
        const wsSession = validateSession(wsCookie);
        if (!wsSession) {
          return new Response("unauthenticated", { status: 401 });
        }
        if (!checkOrigin(req)) {
          return new Response("bad origin", { status: 403 });
        }
        const upgraded = server.upgrade(req, {
          data: { session: wsSession, connectionId: nextConnectionId() },
        });
        if (upgraded) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // /auth/* and /i/<token> routes. These must run before the gating check
      // because unauthenticated visitors transition to authenticated through
      // them. Pass the office name so pre-auth pages render the same tab
      // title format (`<name> | Isomux — ...`) the SPA shell uses.
      const officeName = agentManager.getOfficeSettings().name;
      const authResponse = await tryHandleAuthRoute(
        req,
        url,
        officeName,
        server,
      );
      if (authResponse) return authResponse;

      // PWA manifest + app icons: iOS Safari fetches these out-of-band when
      // "Add to Home Screen" runs, and the apple-touch-icon fetch in particular
      // can happen without the page's cookies. If 401'd here the PWA tile
      // shows a generic icon and the manifest's name/colors don't apply.
      // Whitelisted unauthenticated; they're public marketing-grade assets
      // baked at build time and contain no deployment state. URL.pathname is
      // normalized by the parser so path-traversal via .. can't escape /icons/.
      if (
        req.method === "GET" &&
        (url.pathname === "/manifest.json" ||
          url.pathname.startsWith("/icons/"))
      ) {
        const f = Bun.file(join(UI_DIST, url.pathname));
        if (await f.exists()) {
          return new Response(f, {
            headers: {
              "Content-Type": mimeTypeForFilename(url.pathname),
              "Cache-Control": "public, max-age=31536000, immutable",
            },
          });
        }
        // fall through to the 404 path below if the asset isn't on disk
      }

      // Unified REST surface (Phase 3a). Routes declared in the typed table are
      // dispatched through the executor: identity -> authorize -> preconditions
      // -> idempotency -> handler -> emit. Identity is REQUIRED (cookie or
      // bearer); there is NO loopback bypass for /api (allowLoopback:false), so
      // the new surface cannot reintroduce the bypass the legacy paths still
      // carry. An unmatched or not-yet-migrated /api path falls through to the
      // legacy handlers (/api/upload, /api/files, /api/images) and the static
      // serve below.
      if (url.pathname.startsWith("/api/")) {
        const apiMatch = matchRoute(API_ROUTES, req.method, url.pathname);
        if (apiMatch && executorDeps.handlers.has(apiMatch.route.opId)) {
          const apiAuth = authenticate(req, server, {
            allowLoopback: false,
            officeName,
          });
          if (apiAuth.kind !== "ok") {
            // Marshal the auth rejection (or the impossible loopback case, since
            // allowLoopback:false) into the /api envelope {error:{code,message}}
            // — the new contract, NOT the legacy auth-middleware shape. Every
            // migrated /api route inherits this entrypoint, so the envelope must
            // be uniform here. authenticate() rejects with only two statuses:
            // 403 (bad origin / CSRF) and 401 (no / invalid identity).
            const badOrigin =
              apiAuth.kind === "rejected" && apiAuth.response.status === 403;
            return badOrigin
              ? errorResponse(403, "bad_origin", "bad origin")
              : errorResponse(401, "unauthenticated", "unauthenticated");
          }
          try {
            return await executeRoute(
              apiMatch,
              req,
              apiAuth.identity,
              executorDeps,
              // Thread the caller's own session hash (cookie path only) so
              // sessions.logout + the logout lockout precondition act on the
              // caller's session WITHOUT re-validating the cookie in the seam.
              { callerSessionIdHash: apiAuth.session?.sessionIdHash },
            );
          } catch (err) {
            console.error("[/api] uncaught executor error:", err);
            return errorResponse(500, "internal", "internal");
          }
        }
      }

      // Loopback bypass is intentionally narrow: it only applies to API paths
      // agents legitimately hit from the same box (POST /tasks, /cronjobs read
      // routes, /backup/status). The SPA shell still requires an authenticated
      // cookie even from localhost, so a same-host browser is pushed through the
      // bootstrap-invite flow instead of getting a half-functional page where
      // HTTP works but WS rejects.
      //
      // /agents/ is deliberately NOT in this list: the loopback-bypass removal
      // milestone made the agent surface bearer-required. The self-affordance
      // routes moved to /api (token-required), and POST /agents/:id/message now
      // derives the sender from the AGENT bearer — a no/invalid-bearer request
      // is no longer loopback-trusted, so it falls through to the cookie wall
      // below and 401s. (/tasks, /cronjobs, /backup/status loopback removal is a
      // separate later milestone.)
      const isAgentApiPath =
        url.pathname.startsWith("/tasks") ||
        url.pathname.startsWith("/cronjobs") ||
        url.pathname === "/backup/status";
      const auth = authenticate(req, server, {
        allowLoopback: isAgentApiPath,
        officeName,
      });
      if (auth.kind === "rejected") return auth.response;

      // CORS preflight for task API
      if (req.method === "OPTIONS" && url.pathname.startsWith("/tasks")) {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      // CORS preflight for cronjobs API (read-only over loopback now — the
      // in-flight run read-file/diff affordances moved to the token-required
      // /api surface, so POST is no longer accepted here).
      if (req.method === "OPTIONS" && url.pathname.startsWith("/cronjobs")) {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      // Cronjobs HTTP API — read-only over loopback. Mutations and the in-flight
      // run read-file/diff affordances are token-required under /api now (the
      // legacy loopback POST affordances were removed in the loopback-bypass
      // removal milestone); a POST here falls through to the 405 method gate.
      if (url.pathname.startsWith("/cronjobs")) {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };
        const parts = url.pathname.split("/").filter(Boolean); // ["cronjobs"] or ["cronjobs", id] or ["cronjobs", id, "runs"] or ["cronjobs", id, "runs", runId, ...]
        if (req.method !== "GET") {
          return new Response(JSON.stringify({ error: "method not allowed" }), {
            status: 405,
            headers: corsHeaders,
          });
        }
        const cronjobs = cronjobManager.listCronjobs();
        // GET /cronjobs
        if (parts.length === 1) {
          return new Response(JSON.stringify(cronjobs), {
            headers: corsHeaders,
          });
        }
        const jobId = parts[1];
        const cronjob = cronjobs.find((c) => c.id === jobId);
        if (!cronjob)
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: corsHeaders,
          });
        // GET /cronjobs/:id
        if (parts.length === 2) {
          return new Response(JSON.stringify(cronjob), {
            headers: corsHeaders,
          });
        }
        // GET /cronjobs/:id/runs
        if (parts[2] === "runs" && parts.length === 3) {
          const runs = cronjobManager.getRunsForCronjob(jobId);
          return new Response(JSON.stringify(runs), { headers: corsHeaders });
        }
        // GET /cronjobs/:id/runs/:runId
        if (parts[2] === "runs" && parts.length === 4) {
          const { run, entries } = cronjobManager.getRunTranscript(
            jobId,
            parts[3],
          );
          if (!run)
            return new Response(JSON.stringify({ error: "not found" }), {
              status: 404,
              headers: corsHeaders,
            });
          return new Response(JSON.stringify({ run, entries }), {
            headers: corsHeaders,
          });
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      // Task HTTP API
      if (url.pathname.startsWith("/tasks")) {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        };
        const parts = url.pathname.split("/").filter(Boolean); // ["tasks"] or ["tasks", id] or ["tasks", id, action]
        const taskId = parts[1];
        const action = parts[2]; // "claim" or "done"

        // DELETE blocked at HTTP level
        if (req.method === "DELETE") {
          return new Response(
            JSON.stringify({ error: "DELETE not allowed via HTTP" }),
            { status: 405, headers: corsHeaders },
          );
        }

        // GET /tasks — list (excludes done and backlog by default)
        if (req.method === "GET" && !taskId) {
          const status = url.searchParams.get("status");
          const assignee = url.searchParams.get("assignee");
          const titleFilter = url.searchParams.get("title");
          let filtered = agentManager.getTasks();
          if (!status) {
            filtered = filtered.filter(
              (t) => t.status !== "done" && t.status !== "backlog",
            );
          } else if (status !== "all") {
            filtered = filtered.filter((t) => t.status === status);
          }
          if (assignee) {
            filtered = filtered.filter((t) => t.assignee === assignee);
          }
          if (titleFilter) {
            const q = titleFilter.toLowerCase();
            filtered = filtered.filter((t) =>
              t.title.toLowerCase().includes(q),
            );
          }
          return new Response(JSON.stringify(filtered), {
            headers: corsHeaders,
          });
        }

        // GET /tasks/:id — detail
        if (req.method === "GET" && taskId && !action) {
          const task = agentManager.getTasks().find((t) => t.id === taskId);
          if (!task)
            return new Response(JSON.stringify({ error: "not found" }), {
              status: 404,
              headers: corsHeaders,
            });
          return new Response(JSON.stringify(task), { headers: corsHeaders });
        }

        // POST /tasks — create
        if (req.method === "POST" && !taskId) {
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return new Response(JSON.stringify({ error: "invalid JSON" }), {
              status: 400,
              headers: corsHeaders,
            });
          }
          if (
            typeof body.title !== "string" ||
            typeof body.createdBy !== "string"
          ) {
            return new Response(
              JSON.stringify({ error: "title and createdBy required" }),
              { status: 400, headers: corsHeaders },
            );
          }
          if (body.priority !== undefined && !isValidPriority(body.priority)) {
            return new Response(
              JSON.stringify({ error: "invalid priority, must be P0-P3" }),
              { status: 400, headers: corsHeaders },
            );
          }
          const task = agentManager.addTask(body.title, body.createdBy, {
            description:
              typeof body.description === "string"
                ? body.description
                : undefined,
            priority: body.priority,
            assignee:
              typeof body.assignee === "string" ? body.assignee : undefined,
            username:
              typeof body.username === "string" ? body.username : undefined,
          });
          return new Response(JSON.stringify(task), {
            status: 201,
            headers: corsHeaders,
          });
        }

        // PATCH /tasks/:id — update
        if (req.method === "PATCH" && taskId && !action) {
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return new Response(JSON.stringify({ error: "invalid JSON" }), {
              status: 400,
              headers: corsHeaders,
            });
          }
          if (body.status !== undefined && !isValidStatus(body.status)) {
            return new Response(
              JSON.stringify({
                error: "invalid status, must be open|in_progress|backlog|done",
              }),
              { status: 400, headers: corsHeaders },
            );
          }
          if (body.priority !== undefined && !isValidPriority(body.priority)) {
            return new Response(
              JSON.stringify({ error: "invalid priority, must be P0-P3" }),
              { status: 400, headers: corsHeaders },
            );
          }
          const changes: Partial<
            Pick<
              TaskItem,
              "title" | "description" | "priority" | "status" | "assignee"
            >
          > = {};
          if (typeof body.title === "string") changes.title = body.title;
          if (body.description !== undefined)
            changes.description =
              typeof body.description === "string"
                ? body.description
                : undefined;
          if (body.status !== undefined) changes.status = body.status;
          if (body.priority !== undefined)
            changes.priority = body.priority ? body.priority : undefined;
          if (body.assignee !== undefined)
            changes.assignee =
              typeof body.assignee === "string" ? body.assignee : undefined;
          const task = agentManager.updateTask(taskId, changes);
          if (!task)
            return new Response(JSON.stringify({ error: "not found" }), {
              status: 404,
              headers: corsHeaders,
            });
          return new Response(JSON.stringify(task), { headers: corsHeaders });
        }

        // POST /tasks/:id/claim
        if (req.method === "POST" && taskId && action === "claim") {
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return new Response(JSON.stringify({ error: "invalid JSON" }), {
              status: 400,
              headers: corsHeaders,
            });
          }
          const changes: Partial<Pick<TaskItem, "status" | "assignee">> = {
            status: "in_progress",
          };
          if (typeof body.assignee === "string")
            changes.assignee = body.assignee;
          const task = agentManager.updateTask(taskId, changes);
          if (!task)
            return new Response(JSON.stringify({ error: "not found" }), {
              status: 404,
              headers: corsHeaders,
            });
          return new Response(JSON.stringify(task), { headers: corsHeaders });
        }

        // POST /tasks/:id/done
        if (req.method === "POST" && taskId && action === "done") {
          // Agents send `curl -d '{}'` — consume the body so Bun doesn't warn
          try {
            await req.json();
          } catch {}
          const task = agentManager.updateTask(taskId, { status: "done" });
          if (!task)
            return new Response(JSON.stringify({ error: "not found" }), {
              status: 404,
              headers: corsHeaders,
            });
          return new Response(JSON.stringify(task), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      // GET /backup/status — last-run timestamp, ok/error, retention, dest dir.
      if (url.pathname === "/backup/status" && req.method === "GET") {
        return new Response(JSON.stringify(getBackupStatus()), {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json",
          },
        });
      }

      // POST /agents/:id/* — the legacy non-/api agent surface is fully retired
      // (Phase 3d slice 6a). The inter-agent message endpoint moved to POST
      // /api/agents/:id/messages (the unified agents.sendMessage route: the AGENT
      // bearer IS the sender, the structured sender is server-derived, and a
      // mismatched body.senderAgentId -> 403 via the messageSend guard). The
      // self-affordance POSTs (diff / edit-file / read-file / terminal-command)
      // moved to /api/agents/:id/* in the loopback-bypass removal milestone. So
      // any POST under /agents/ is now a stale/unknown path: fail closed with a
      // JSON 404 rather than fall through to the SPA shell (which would return
      // 200 text/html and mask the caller). No-bearer requests never reach here —
      // they 401 at the cookie wall above, since /agents/ is off isAgentApiPath.
      if (url.pathname.startsWith("/agents/") && req.method === "POST") {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json",
          },
        });
      }

      // File upload endpoint: POST /api/upload/{agentId}
      if (url.pathname.startsWith("/api/upload/") && req.method === "POST") {
        const agentId = url.pathname.split("/")[3];
        if (!agentId || !agentManager.getAgent(agentId)) {
          return new Response(JSON.stringify({ error: "agent not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const formData = await req.formData();
          const attachments: Attachment[] = [];
          const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
          const MAX_FILES = 5;
          const MAX_TOTAL = 400 * 1024 * 1024; // 400MB
          let totalSize = 0;
          let fileCount = 0;

          for (const [, value] of formData) {
            if (!(value instanceof File)) continue;
            fileCount++;
            if (fileCount > MAX_FILES) {
              return new Response(
                JSON.stringify({
                  error: `Maximum ${MAX_FILES} files per upload`,
                }),
                {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
            if (value.size > MAX_FILE_SIZE) {
              return new Response(
                JSON.stringify({
                  error: `File "${value.name}" exceeds 200MB limit`,
                }),
                {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
            totalSize += value.size;
            if (totalSize > MAX_TOTAL) {
              return new Response(
                JSON.stringify({ error: "Total upload exceeds 400MB limit" }),
                {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
            const buffer = Buffer.from(await value.arrayBuffer());
            const att = saveFile(
              agentId,
              buffer,
              value.type || "application/octet-stream",
              value.name,
            );
            if (att) attachments.push(att);
          }
          return new Response(JSON.stringify({ attachments }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(
            JSON.stringify({ error: errMessage(err, "Upload failed") }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      // File serving endpoint (also handles legacy /api/images/ URLs)
      if (
        url.pathname.startsWith("/api/files/") ||
        url.pathname.startsWith("/api/images/")
      ) {
        const parts = url.pathname.split("/").filter(Boolean); // ["api", "files"|"images", agentId, filename]
        const agentId = parts[2];
        const filename = parts[3];
        if (!agentId || !filename) {
          return new Response("Not found", { status: 404 });
        }
        const filePath = getFilePath(agentId, filename);
        if (!filePath) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(Bun.file(filePath), {
          headers: {
            "Content-Type": mimeTypeForFilename(filename),
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      }

      // Static file serving
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      if (filePath === "/index.html") {
        return serveIndexHtml();
      }
      const file = Bun.file(join(UI_DIST, filePath));
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Cache-Control": "no-cache" },
        });
      }
      // SPA fallback
      return serveIndexHtml();
    },
    websocket: {
      open(ws) {
        browsers.add(ws);
        registerSocket(ws.data.session.sessionIdHash, ws);
        // Send session context FIRST so the client knows the authenticated
        // identity and role before any reducer touches state. connectionId
        // is per-WS (live-avatars) so the client can identify its OWN
        // ghost in presence_list — same auth session can be running in
        // multiple tabs and each tab has a distinct connectionId.
        ws.send(
          JSON.stringify({
            type: "session_context",
            context: sessionContextFor(ws.data.session, ws.data.connectionId),
          }),
        );
        // Roster hydration (3b.5): every socket gets the PUBLIC roster; owners
        // additionally get the full admin roster; and the caller gets their OWN
        // full record (user_self_updated) — the now-public users_list can no
        // longer carry the caller's grants/notif/default/view, which the UI
        // needs for the current user.
        ws.send(
          JSON.stringify({
            type: "users_list",
            users: listUsers().map(toPublicWire),
          }),
        );
        if (ws.data.session.role === "owner") {
          ws.send(
            JSON.stringify({
              type: "users_admin_list",
              users: listUsers(),
            }),
          );
        }
        const selfUserForHydration = getUserById(ws.data.session.userId);
        if (selfUserForHydration) {
          ws.send(
            JSON.stringify({
              type: "user_self_updated",
              user: selfUserForHydration,
            }),
          );
        }
        // Send projected full_state (rooms + agents filtered to the
        // session's allowedRooms; sessions whose allowedRooms covers
        // every current room get the identity projection).
        sendProjectedFullState(ws);
        // Owners also receive the unfiltered global rooms list so the
        // admin surface (UserManagementModal's Allowed Rooms editor) can
        // grant access to rooms the owner has hidden from their own view.
        if (ws.data.session.role === "owner") {
          ws.send(
            JSON.stringify({
              type: "all_rooms_list",
              rooms: agentManager.getRooms(),
            }),
          );
        }
        // Send tasks
        ws.send(
          JSON.stringify({
            type: "tasks",
            tasks: agentManager.getTasks(),
          }),
        );
        // Send cronjobs + cronjobsPrompt
        ws.send(
          JSON.stringify({
            type: "cronjobs_state",
            cronjobs: cronjobManager.listCronjobs(),
            cronjobsPrompt: cronjobManager.getCronjobsPrompt(),
          }),
        );
        // Send update status
        const update = getUpdateStatus();
        if (update.updateAvailable) {
          ws.send(
            JSON.stringify({
              type: "update_status",
              updateAvailable: true,
              current: update.current,
              latest: update.latest,
            }),
          );
        }
        // Send cached log history and slash commands for each agent the
        // session can see. agentVisibleForSession short-circuits to true
        // for full-access sessions so the gate is free on the fast path.
        const session = ws.data.session;
        for (const agent of agentManager.getAllAgents()) {
          if (!agentVisibleForSession(session, agent.id)) continue;
          const logs = agentManager.getAgentLogs(agent.id);
          for (const entry of logs) {
            ws.send(JSON.stringify({ type: "log_entry", entry }));
          }
          const cmds = agentManager.getAgentCommands(agent.id);
          if (cmds.commands.length > 0 || cmds.skills.length > 0) {
            ws.send(
              JSON.stringify({
                type: "slash_commands",
                agentId: agent.id,
                commands: cmds.commands,
                skills: cmds.skills,
              }),
            );
          }
        }
        // Live-avatars: send the current presence snapshot (filtered to
        // rooms this session can see) so the new client renders existing
        // ghosts immediately rather than waiting for the next
        // presence_update from someone else.
        sendPresenceListTo(ws);
      },
      message(ws, data) {
        // Per-message session recheck. Revoke kicks in here without a reconnect:
        // revalidateByHash hits the same in-memory map and returns null if the
        // session has been deleted (revoke), expired, or its user removed.
        const fresh = revalidateByHash(ws.data.session.sessionIdHash);
        if (!fresh) {
          ws.send(JSON.stringify({ type: "session_expired" }));
          ws.close();
          return;
        }
        ws.data.session = fresh;
        try {
          const cmd = JSON.parse(data as string) as ClientCommand;
          void handleInboundMessage(cmd, ws);
        } catch (e) {
          console.error("Invalid command:", e);
        }
      },
      close(ws) {
        browsers.delete(ws);
        unregisterSocket(ws.data.session.sessionIdHash, ws);
        // Drop this connection's editor watchers on disconnect (keyed by
        // connectionId now that the editor is REST — a leaked watch leaks an
        // inotify slot for the life of the tab).
        const watchMap = editorWatchers.get(ws.data.connectionId);
        if (watchMap) {
          for (const w of watchMap.values()) stopWatch(w);
          editorWatchers.delete(ws.data.connectionId);
        }
        // Live-avatars cleanup. Idempotent: removePresence returns true
        // only if an entry existed. Key is the per-WS connectionId, NOT
        // the auth session hash — that distinction is what makes
        // reconnects and same-cookie multi-tab work: when a tab reconnects
        // it gets a NEW connectionId, and the OLD close handler here
        // removes only the OLD id, never racing with the new tab's entry.
        if (removePresence(ws.data.connectionId)) {
          pushPresenceListToEachWs();
        }
      },
    },
  });
} // end buildServer

// logBootBanners: the two boot-time console banners (resolved public-origin
// note + the pre-claim SSH/claim instructions). Pure logging; startServer()
// calls it only when not quiet. Body left at prior indentation.
function logBootBanners(): void {
  // The public origin is the canonical URL the server expects browsers to hit.
  // We compare it against the Origin header on WS upgrades and unsafe HTTP
  // requests, and bake it into invite URLs. Resolution precedence is env >
  // office-config.json `publicOrigin` > localhost fallback. Pre-claim we
  // force the localhost fallback so the cookie attributes match the bind;
  // any configured value re-engages once an owner exists.
  {
    const resolved = buildPublicOrigin();
    // Pre-claim: the banner below covers everything, no need for a separate
    // log line. Env-var source: the ISOMUX_PUBLIC_ORIGIN deprecation warning
    // (emitted earlier when the env is set) is the only signal needed; no
    // additional log here, since the var itself is deprecated.
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
  // by a tokenless name-picker form at http://localhost:PORT/. The form is
  // served only over the loopback bind, so it's reachable only from the same
  // machine (or via SSH port-forward from another). Print a banner that spells
  // out both paths so an operator who's never used `ssh -L` can copy-paste.
  //
  // The SSH target is printed as a template (<user>@<host>) rather than auto-
  // detecting via os.userInfo()/os.hostname(): the local username on the
  // server box is often not the SSH login name (think `nil` vs `root`, or
  // hosting-provider-assigned users), and os.hostname() returns the box's
  // internal hostname rather than a network-routable address. We do show the
  // detected values as a hint, but the operator is supposed to replace them
  // with whatever SSH target they normally use for this machine.
  if (isProcessPreClaim()) {
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
    console.log("");
    console.log(
      "================================================================",
    );
    console.log("  Isomux: no owner has been set up for this office yet.");
    console.log("");
    console.log("  TO CLAIM OWNERSHIP from THIS machine:");
    console.log(`    Open http://localhost:${PORT} in your browser.`);
    console.log("");
    console.log("  TO CLAIM OWNERSHIP from another machine:");
    console.log(
      `    1. On that machine, open a tunnel to this box${detectedHint}:`,
    );
    console.log(`         ssh -L ${PORT}:localhost:${PORT} <user>@<host>`);
    console.log(`    2. Open http://localhost:${PORT} in that browser.`);
    console.log("");
    console.log(
      "  After you claim, the Access pane (User Settings) lets you enable",
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

// runBackgroundBoot: post-listen boot work (update checker, plugin-hooks deps,
// plugin load + agent restore, schedulers, backup, admin socket). Each
// background job is individually skippable so the in-process test harness boots
// with no timers / no network / no LLM. Returns the plugin-load+restore promise
// so the harness can await a fully-restored office; production fires and forgets
// (listener already up). Body left at prior indentation; prettier normalizes.
function runBackgroundBoot(
  startOpts: StartServerOpts,
  server: Server<WsData>,
): Promise<void> {
  if (!startOpts.skipUpdateChecker) {
    // Start update checker
    onUpdateChange((status) => {
      broadcast({
        type: "update_status",
        updateAvailable: status.updateAvailable,
        current: status.current,
        latest: status.latest,
      });
    });
    startUpdateChecker();
  }

  // Wire plugin-hooks to agent-manager internals (beginTurn / createTurnDeferred /
  // logCache / room lookup) BEFORE loading plugins, so the loader has a usable
  // runtime when discovery completes. Plugins themselves are discovered + imported
  // in loadPlugins below. See server/plugin-hooks.ts for the contract.
  agentManager.configurePluginHooksDeps();

  // Plugin load + agent restore are sequenced inside the same async boot so
  // RESTORED agents come up with the full plugin set already in place. A
  // fire-and-forget plugin load would race with restoreAgents — a slow
  // plugin import could let restored-agent turns dispatch with
  // getEnabledPlugins() empty.
  //
  // Caveat: `Bun.serve` above already bound the HTTP listener BEFORE this
  // IIFE started. A user who spawns a brand-new agent during the small
  // plugin-load window (typically <100ms; longer if a plugin's transitive
  // deps need fetching) and immediately sends them a message will see that
  // agent's first turn run without plugin hooks. We accept this for v0:
  // gating HTTP on plugin load would let a single broken local plugin
  // stall the whole UI, which is a worse failure mode than one
  // plugin-less first turn. If it bites, the right fix is a `pluginsReady`
  // flag checked at turn-dispatch time, not at HTTP-accept time.
  //
  // Plugin load failures land in ~/.isomux/logs/plugins.jsonl + stderr and
  // don't block startup; we still proceed to restoreAgents on the catch path
  // so a broken plugin doesn't kill the server.
  const restorePromise = (async () => {
    try {
      // import.meta.dir points at server/, so go up one to get the repo root.
      const isomuxRoot = join(import.meta.dir, "..");
      const enabledPlugins = loadEnabledPlugins();
      await loadPlugins({ isomuxRoot, enabledPlugins });
    } catch (err) {
      console.error("[plugins] unexpected error during plugin load:", err);
    }

    const restored = await agentManager.restoreAgents();
    if (restored.length > 0) {
      console.log(
        `Restored ${restored.length} agent(s): ${restored.map((a) => a.name).join(", ")}`,
      );
    }
    // One-time hygiene pass: remove any stale roomIds from users'
    // allowedRooms / notifRooms that don't match a currently-existing
    // room. Catches references left behind by close_room calls from
    // earlier versions that didn't prune user records inline. Cheap
    // no-op once a deployment has converged.
    const validIds = agentManager.getRooms().map((r) => r.id);
    const pruned = pruneStaleRoomRefs(validIds);
    if (pruned > 0) {
      console.log(
        `[startup] pruned stale room refs from ${pruned} user record(s)`,
      );
      emitUsersList();
    }
  })();

  // Boot cronjob scheduler (loads configs, reconciles stale "running" rows, starts tick).
  if (!startOpts.skipSchedulers) cronjobManager.startCronjobScheduler();

  // Daily ~/.isomux/ backup tarball with N=7 retention. See server/backup.ts.
  if (!startOpts.skipBackups) startBackupScheduler();

  if (!startOpts.quiet)
    console.log(`Isomux running at http://localhost:${server.port}`);

  // Admin Unix socket — lets the `owner-login` CLI mint a recovery URL for
  // an existing owner. Starts after the HTTP listener so the CLI's printed
  // URL is immediately openable. Optional surface; a startup failure logs
  // but doesn't block the server.
  if (!startOpts.skipAdminSocket) startAdminSocket();

  return restorePromise;
} // end runBackgroundBoot

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

export interface StartServerOpts {
  // Listen port. Omit → process.env.PORT || 4000 (production). Tests pass 0 for
  // an ephemeral port.
  port?: number;
  // Inject pre-built managers (tests). Omit → production factories.
  agentManager?: AgentManager;
  cronjobManager?: CronjobManager;
  // Override the backend resolver for both factories (tests pass a FakeBackend
  // resolver). Ignored when agentManager/cronjobManager are supplied directly.
  resolveBackend?: typeof getBackend;
  // Background-job skips. Tests set these so `bun test` does no timers, no
  // network (update checker), no daily backup, and no admin socket.
  skipSchedulers?: boolean;
  skipBackups?: boolean;
  skipAdminSocket?: boolean;
  skipUpdateChecker?: boolean;
  // Await plugin-load + agent restore before resolving (tests that assert on a
  // fully-restored office). Production leaves this false: fire-and-forget so the
  // listener is up immediately, matching today's behavior.
  awaitRestore?: boolean;
  // Suppress the boot banners / "running at" log (tests).
  quiet?: boolean;
}

export interface ServerHandle {
  server: Server<WsData>;
  port: number;
  agentManager: AgentManager;
  cronjobManager: CronjobManager;
  // Production GuardDeps adapter (Phase 2.3). Dormant: exposed for the contract
  // T1 to assert agreement with the live ACL; nothing consumes it until Phase 3
  // wires it into authorize().
  guardDeps: GuardDeps;
  // Stop the listener (force-closing live sockets) and return the in-process
  // module singletons to a known-idle state so the next startServer() in the
  // same process is clean. See stopServer.
  stop: () => Promise<void>;
}

// Reset index.ts's own module-level collections so a repeated in-process boot
// doesn't inherit a prior server's sockets / id counter.
function resetServerModuleState(): void {
  browsers.clear();
  connectionIdCounter = 0;
  idempotencyCache._reset();
}

async function stopServer(server: Server<WsData>): Promise<void> {
  // Force-close active sockets and stop accepting, freeing the (ephemeral) port
  // before the next harness boot.
  await server.stop(true);
  // Editor file-watches are keyed by connectionId in editorWatchers; the WS
  // close handlers that server.stop(true) triggers unregister them. There is no
  // global watch registry, and 0.3 opens no editor files, so a stopAllWatches()
  // is intentionally out of 0.3 scope — add a real registry only if a later
  // harness opens editor files (don't add speculative plumbing now).
  //
  // Agent backend sessions are likewise not closed here: AgentManager exposes no
  // stopAll() today, and the next createManagers() drops this manager instance
  // entirely, so its parked (timer-free) sessions become GC-eligible. Fine for
  // the serial T1 tier; a longer-lived/concurrent harness would want an
  // agentManager.stop() that closes live sessions first (out of 0.3 scope).
  browsers.clear();
  _testClearPresence();
  // Neutralize the auth.ts boot hooks so a stale closure from this boot can't
  // fire into a torn-down broadcast set between stop() and the next start();
  // the next startServer() re-registers them against the new instance.
  setRoomsSnapshotProvider(() => []);
  setOnInviteConsumed(() => {});
  setOnSessionsChanged(() => {});
  setOnOwnerCreated(async () => {});
  // Clear the cron module-read bridge so command-handlers/usage-report don't
  // read a dead manager between boots, and the loopback origin port.
  registerProductionCronjobManagerForModuleReads(null);
  setLoopbackOriginPort(null);
}

export async function startServer(
  opts: StartServerOpts = {},
): Promise<ServerHandle> {
  resetServerModuleState();
  bootPrelude();
  createManagers(opts);
  registerBootHooks();
  wireEventSinks();
  // Phase 3b slice 3: migrate any PERSISTED owner from the old materialized-
  // grants model to rule-based access (seed hidden from old grants, then clear
  // grants). Idempotent; needs rooms (createManagers, synchronous) + users
  // (lazy load) ready. Fresh-install owners are created later via /auth/claim
  // and seeded grants=[] directly (auth.ts), so this is a no-op for them.
  migrateOwnersToRuleBasedAccess();
  executorDeps = buildExecutorDeps();
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
    guardDeps: buildLiveGuardDeps(),
    stop: () => stopServer(server),
  };
}

if (import.meta.main) {
  // CLI sub-command fast-path. `bun run server/index.ts owner-login --name X`
  // dynamic-imports the CLI (no auth-state side effects of its own) and exits
  // before the heavy boot below. Guarded by import.meta.main so importing this
  // module (the in-process test harness) can never process-exit on a stray
  // argv token.
  if (process.argv[2] === "owner-login") {
    const { runAdminCli } = await import("./admin-cli.ts");
    await runAdminCli(process.argv.slice(2));
    process.exit(0);
  }
  const handle = await startServer();
  // Idle-eviction sweep: every minute, demote agents idle past the threshold to
  // lazy so they release their ~165MB subprocess. (Boot already lazy-restores
  // everyone; this re-demotes agents that woke and then went quiet again.) Lives
  // in the import.meta.main guard, NOT startServer — the in-process test harness
  // calls startServer() directly and must not inherit a background timer. unref
  // so it never keeps the process alive on its own.
  const idleSweep = setInterval(() => {
    void handle.agentManager
      .sweepIdleAgents()
      .catch((err) => console.error("[idle-evict] sweep failed:", err));
  }, 60_000);
  idleSweep.unref?.();
}
