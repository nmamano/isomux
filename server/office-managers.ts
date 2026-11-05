// The office's managers and stores, and the test seams startServer sets: the
// module state that createManagers assigns on each server start. Moved out of
// server/isomux-office.ts, which reads these bindings and calls createManagers.
// An ES live binding can be assigned only by its own module, so the state and
// its one writer live here together.
import { join } from "path";
import type {
  AgentInfo,
  BackendModelWire,
  PagerEntry,
  ServerMessage,
  UserRecord,
} from "../shared/types.ts";
import { STATE_ROOT } from "./config.ts";
import {
  createProductionAgentManager,
  type AgentManager,
} from "./agent-manager.ts";
import {
  createProductionCronjobManager,
  registerProductionCronjobManagerForModuleReads,
  type CronjobManagerDeps,
} from "./cronjob-manager.ts";
import type { CronjobManager } from "./cronjob-manager.ts";
import {
  createScheduledMessageManager,
  type ScheduledMessageManager,
} from "./scheduled-messages.ts";
import {
  createPagerArchiveFile,
  createPagerFilePersistence,
  createPagerStore,
  type PagerStore,
} from "./pager-store.ts";
import {
  createAskFilePersistence,
  createAskStore,
  type AskChange,
  type AskStore,
} from "./asks.ts";
import { officeAskHistory } from "./ask-history.ts";
import {
  createPagerSettingsFilePersistence,
  createPagerSettingsStore,
  type PagerSettingsStore,
} from "./pager-settings.ts";
import {
  createPagerDelivery,
  type PagerDeliveryService,
} from "./pager-delivery.ts";
import {
  createWebPushFilePersistence,
  createWebPushStore,
  type WebPushStore,
} from "./web-push-store.ts";
import {
  createWebPushDelivery,
  type WebPushDeliveryService,
} from "./web-push-delivery.ts";
import {
  createGithubLinkStore,
  createGithubSync,
  type GithubLinkStore,
  type GithubSync,
} from "./github-sync.ts";
import { officeAuditStore } from "./audit-store.ts";
import { trackUiBuild, type UiBuildTracker } from "./ui-build.ts";
import { createTurnEndWatch } from "./turn-end-watch.ts";
import { ProviderAccountManager } from "./provider-account-manager.ts";
import {
  appSupervisor as productionAppSupervisor,
  type AppSupervisor,
} from "./app-supervisor.ts";
import { createContainerAppSupervisor } from "./container-app-supervisor.ts";
import {
  appHostingUnsupportedReason,
  createUnavailableAppSupervisor,
} from "./app-hosting.ts";
import { openCodeUnsupportedReason } from "./backends/opencode/runtime.ts";
import { codexSandboxProbe } from "./backends/codex/sandbox-probe.ts";
import { setProcessIsolationSwitch } from "./process-isolation-state.ts";
import {
  loadProcessIsolation,
  loadScheduledMessagesRaw,
  saveScheduledMessages,
} from "./persistence.ts";
import {
  createMembersChatStore,
  type MembersChatStore,
} from "./members-chat.ts";
import { createFloorsStore, type FloorsStore } from "./floors-store.ts";
import { BrowserExtensionStore } from "./browser-extension-store";
import { BrowserExtensionService } from "./browser-extension-service";
import { ExtensionBrowserSessions } from "./browser-extension-session";
import { translatorForUserId } from "./i18n.ts";
import { getUserById, listUsers } from "./users.ts";
import { buildPublicOrigin } from "./auth.ts";
import type { StorageRoots } from "./storage-usage.ts";
import { productionStorageRoots } from "./storage-roots.ts";
import {
  scheduleLimitBreach,
  scheduleRunRefusal,
} from "./cron-agent-limits.ts";
import type { SecretStore } from "./secret-store.ts";
import { renderSVG } from "uqr";
import {
  createWhatsAppSupervisor,
  type WhatsAppSupervisor,
} from "./whatsapp/supervisor.ts";
import { createBridgeInstaller } from "./whatsapp/installer.ts";
import {
  WHATSAPP_RUNTIME_DIR,
  readLink,
  whatsappRoot,
} from "./whatsapp/store.ts";
import {
  createWhatsAppRoutes,
  type WhatsAppRoutes,
} from "./whatsapp/routes.ts";
import { createWhatsAppInbound } from "./whatsapp/inbound.ts";
import {
  createWhatsAppReplies,
  type WhatsAppReplies,
} from "./whatsapp/replies.ts";
import { openIdRing } from "./whatsapp/routes-store.ts";
import { WHATSAPP_APP } from "../shared/whatsapp.ts";
import { agentAccessOf } from "../shared/agent-access.ts";
import { randomBytes } from "crypto";
import {
  WHATSAPP_BRIDGE_ENTRY,
  WHATSAPP_PACKAGE_DIR,
  readProcRss,
  runBridgeInstall,
  spawnBridge,
} from "./whatsapp/process.ts";
import type { EmitContext } from "./events/emit.ts";
import type { EventId, EventPayloads } from "./events/registry.ts";
import type { StartServerOpts } from "./isomux-office.ts";
import { msg } from "../shared/i18n/log-message.ts";

// What createManagers calls back into server/isomux-office.ts for.
// Functions and consts only: createManagers destructures these once, so a let
// here would be read once, not live.
export interface ManagersDeps {
  liveEmit: <K extends EventId>(
    id: K,
    payload: EventPayloads[K],
    ctx?: EmitContext,
  ) => void;
  stepsChanged: () => void;
  mayUseExtension: (member: string, agentId: string) => boolean;
  mayReachExtension: (member: string, agentId: string) => boolean;
  deliverCronjobToAgent: NonNullable<CronjobManagerDeps["deliverToAgent"]>;
  ordinaryScheduleMaker: (agentId: string) => AgentInfo | null;
  pushAskChange: (change: AskChange) => void;
  pushPagerEntryToEachWs: (entry: PagerEntry) => void;
  secretStore: SecretStore;
  broadcast: (msg: ServerMessage) => void;
  canAccess: (user: UserRecord, roomId: string) => boolean;
  isLobbyRoom: (roomId: string) => boolean;
  UI_DIST: string;
}

// AgentManager / CronjobManager instances. Module-level `let` (not top-level
// `const`) so startServer() can inject test doubles or a FakeBackend resolver;
// production passes none and gets the real factories. The many handler closures
// in server/isomux-office.ts read these after startServer() has assigned them
// (never before).
export let agentManager: AgentManager;
export let cronjobManager: CronjobManager;

export let scheduledMessageManager: ScheduledMessageManager;
export let pagerStore: PagerStore;
export let askStore: AskStore | undefined;
// Members chat: the humans-only stream on the Lobby tab. The store is
// month-file JSONL under <STATE_ROOT>/members-chat (server/members-chat.ts).
export let membersChat: MembersChatStore;
// The lobby elevator's floors: <STATE_ROOT>/floors.json (server/floors-store.ts).
export let floors: FloorsStore;
export let pagerSettings: PagerSettingsStore;
export let pagerDelivery: PagerDeliveryService;
export let webPushStore: WebPushStore;
export let webPushDelivery: WebPushDeliveryService;
// One WhatsApp bridge per linked member (server/whatsapp/, task d03a61d8),
// the members' contact rows, and the path from a routed chat to its agent.
export let whatsappSupervisor: WhatsAppSupervisor;
export let whatsappRoutes: WhatsAppRoutes;
export let whatsappReplies: WhatsAppReplies;
// GitHub issues into the board (task 7fc83592), in office.sqlite.
export let githubLinks: GithubLinkStore;
export let githubSync: GithubSync;
export let uiBuildTracker: UiBuildTracker | undefined;
// Turn ends that sound the browser's turn-end sound also feed the turn-end
// push (task 1eda8af8). Made per server start, so its last-state memory
// starts empty each time.
export let turnEndWatch: ReturnType<typeof createTurnEndWatch> | undefined;
export let providerAccountManager: ProviderAccountManager;
// The app supervisor is injectable for one specific reason: systemd is
// MACHINE-GLOBAL. Every other collaborator a test injects is about determinism
// or cost; this one is about a test run being unable to write a unit file, stop
// a service, or reach the office's own apps on the box it happens to run on.
// `bun test` boots the real server through the harness, and the harness passes
// a fake here - that default is what makes "the test suite never touches
// systemd" a property of the wiring rather than a promise.
export let appSupervisor: AppSupervisor;
export let discoverWelcomeOpenCodeModels:
  | ((userId: string) => Promise<BackendModelWire[]>)
  | undefined;
// How long a Codex spawn with no model waits for the login's model list
// before it takes CODEX_MODELS[0].
export const CODEX_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

export let listCodexModelsSeam: StartServerOpts["listCodexModels"];
// The storage roots GET /api/storage/usage and /isomux-storage measure. One
// function for both, resolved in createManagers.
export let storageRoots: () => StorageRoots = () => productionStorageRoots();
export let codexModelDiscoveryTimeoutMs = CODEX_MODEL_DISCOVERY_TIMEOUT_MS;
export let hostPlatform: NodeJS.Platform = process.platform;

export function openCodeRunsOnHost(): boolean {
  return openCodeUnsupportedReason(hostPlatform) === null;
}

// The container supervisor runs apps without systemd; every other supervisor
// needs a Linux host.
export function appHostingUnsupported(): string | null {
  if (process.env.ISOMUX_APP_SUPERVISOR === "container") return null;
  return appHostingUnsupportedReason(hostPlatform);
}

export let extensionService: BrowserExtensionService | undefined;
export let extensionSessions: ExtensionBrowserSessions | undefined;

export function createManagers(
  startOpts: StartServerOpts,
  deps: ManagersDeps,
): void {
  const {
    liveEmit,
    stepsChanged,
    mayUseExtension,
    mayReachExtension,
    deliverCronjobToAgent,
    ordinaryScheduleMaker,
    pushAskChange,
    pushPagerEntryToEachWs,
    secretStore,
    broadcast,
    canAccess,
    isLobbyRoom,
    UI_DIST,
  } = deps;
  // createProductionAgentManager() loads the persisted office/agents snapshot
  // synchronously (getRooms() valid before the async restore) and registers the
  // office env-file provider. createProductionCronjobManager() wires the real
  // backend/env/user/persistence + clock/timers. Tests pass a pre-built manager
  // (or just a resolveBackend override) so a FakeBackend drives the same wiring.
  hostPlatform = startOpts.hostPlatform ?? process.platform;
  appSupervisor =
    startOpts.appSupervisor ??
    (process.env.ISOMUX_APP_SUPERVISOR === "container"
      ? createContainerAppSupervisor()
      : appHostingUnsupported() !== null
        ? createUnavailableAppSupervisor()
        : productionAppSupervisor);
  // Containers only: learn at boot whether Codex's sandbox can run here.
  void codexSandboxProbe();
  // The owner's switch for one PID namespace per agent, read at each session
  // start (process-isolation-state.ts).
  setProcessIsolationSwitch(loadProcessIsolation);
  discoverWelcomeOpenCodeModels = startOpts.discoverWelcomeOpenCodeModels;
  listCodexModelsSeam = startOpts.listCodexModels;
  codexModelDiscoveryTimeoutMs =
    startOpts.codexModelDiscoveryTimeoutMs ?? CODEX_MODEL_DISCOVERY_TIMEOUT_MS;
  storageRoots =
    startOpts.storageRoots ??
    (() => productionStorageRoots(startOpts.getBackupStatus));
  providerAccountManager = new ProviderAccountManager(
    (userId, accounts) => {
      liveEmit("provider_accounts_updated", { accounts }, { userId });
      stepsChanged();
    },
    startOpts.createCodexAccountClient,
    undefined,
    undefined,
    undefined,
    startOpts.createClaudeAccountClient,
  );
  // agentManager is created just below.
  providerAccountManager.onAccountChanged = (provider, dir) =>
    agentManager?.providerAccountChanged(provider, dir);
  agentManager = createProductionAgentManager({
    runBrowserAction: (agent, body) => extensionSessions!.run(agent, body),
    // An action ask closes when its agent reaches the grant (task e3d1bc63).
    // A throw here would end the access change halfway.
    onAccessChanged: () => {
      try {
        stepsChanged();
      } catch (err) {
        console.error("[step-asks] access change reconcile threw", err);
      }
    },
    resolveBackend: startOpts.resolveBackend,
    storageRoots: () => storageRoots(),
    listProviderAccounts: async (userId, options) => {
      const accounts = await providerAccountManager.list(
        userId,
        options?.refresh,
        options,
      );
      if (options && !options.signal.aborted) {
        // Never start an unrelated provider just to publish a full snapshot.
        const snapshot = await providerAccountManager.cachedList(
          userId,
          accounts,
        );
        if (snapshot && !options.signal.aborted) {
          liveEmit(
            "provider_accounts_updated",
            { accounts: snapshot },
            { userId },
          );
          stepsChanged();
        }
      }
      return accounts;
    },
    effectiveProviderAccountTarget: (userId, provider) =>
      providerAccountManager.effectiveTarget(userId, provider),
  });
  extensionService = new BrowserExtensionService(
    new BrowserExtensionStore(join(STATE_ROOT, "browser-connections.json")),
    {
      memberExists: (member) => !!getUserById(member),
      paired: stepsChanged,
      mayUse: mayUseExtension,
      mayReach: mayReachExtension,
      managerOf: (agent) => agentManager.getAgent(agent)?.userId ?? undefined,
      agents: () => agentManager.getAllAgents().map((agent) => agent.id),
      memberName: (member) => getUserById(member)?.name ?? "",
      agentName: (agent) => agentManager.getAgent(agent)?.name ?? "",
      officeOrigins: () => [buildPublicOrigin().origin],
    },
  );
  extensionSessions = new ExtensionBrowserSessions(
    extensionService,
    (agent) => agentManager.getAgent(agent)?.userId ?? undefined,
    mayUseExtension,
    startOpts.browserExtensionActionDeadline,
  );
  cronjobManager = createProductionCronjobManager({
    resolveBackend: startOpts.resolveBackend,
    resolveOpenCodeSkillPaths: (userId) =>
      agentManager.openCodeSkillPathsForUserId(userId),
    resolveSkillFolder: (agentType, userId) =>
      agentManager.skillFolderForUserId(agentType, userId),
    resolveOpenCodeLaunch: (userId) => ({
      env: agentManager.buildOpenCodeLaunchEnvironmentForUserId(userId),
      environmentRevision:
        agentManager.openCodeEnvironmentRevisionForUserId(userId),
    }),
    limitRefusal: (job) => {
      // A schedule with no target agent runs at Standard, above every agent
      // ceiling of a member permission pack (task 134b8f77).
      const owner = job.userId ? getUserById(job.userId) : undefined;
      if (!job.target && owner?.role === "member" && owner.pack)
        return msg("systemEntries.scheduleRun.aboveMemberCeiling", {
          member: owner.name,
        });
      const maker = job.createdByAgentId
        ? ordinaryScheduleMaker(job.createdByAgentId)
        : null;
      const breach = maker ? scheduleLimitBreach(job, maker) : null;
      return maker && breach ? scheduleRunRefusal(breach, maker, job) : null;
    },
    deliverToAgent: deliverCronjobToAgent,
  });
  // Register the production instance for the module-read bridge that
  // command-handlers/usage-report use (they don't hold the instance).
  registerProductionCronjobManagerForModuleReads(cronjobManager);
  // Scheduled messages: durable deliver-later entries feeding
  // enqueueMessage at fire time. Constructed AFTER agentManager so its dep
  // closures capture the live instance; the tick loop starts later, gated on
  // skipSchedulers next to the cron scheduler. Firing/validation edge cases
  // are unit-tested against createScheduledMessageManager with fakes.
  scheduledMessageManager = createScheduledMessageManager({
    enqueue: (receiverId, msg) => agentManager.enqueueMessage(receiverId, msg),
    getAgentDisplay: (agentId) => agentManager.getAgentDisplay(agentId),
    notifySender: (senderAgentId, text) => {
      if (!agentManager.addSystemNote(senderAgentId, text)) {
        console.error(
          `Scheduled-message notice undeliverable (sender ${senderAgentId} gone): ${text}`,
        );
      }
    },
    recordSent: (entry, messageId) =>
      agentManager.addAgentOutbound(
        entry.senderAgentId,
        entry.receiverAgentId,
        entry.text,
        {
          messageId,
          scheduledMessageId: entry.id,
          scheduledFor: entry.deliverAt,
        },
      ),
    persistence: {
      load: loadScheduledMessagesRaw,
      save: saveScheduledMessages,
    },
    clock: { now: () => Date.now() },
    scheduler: { setTimeout, clearTimeout, setInterval, clearInterval },
  });
  // The pager: the store, the member settings (the Discord webhook URL is a
  // credential and lives in its own file, never in the env injected into
  // agents), and delivery. The store and delivery call each other through
  // these closures.
  membersChat = createMembersChatStore(join(STATE_ROOT, "members-chat"));
  floors = createFloorsStore();
  const askHistory = officeAskHistory();
  askStore = createAskStore({
    persistence: createAskFilePersistence(join(STATE_ROOT, "asks.json")),
    onChange: (change) => pushAskChange(change),
    history: askHistory,
  });
  pagerSettings = createPagerSettingsStore(
    createPagerSettingsFilePersistence(join(STATE_ROOT, "pager-settings.json")),
  );
  pagerStore = createPagerStore({
    persistence: createPagerFilePersistence(join(STATE_ROOT, "pager.json")),
    archive: createPagerArchiveFile(join(STATE_ROOT, "pager-resolved.jsonl")),
    onChange: (entry) => pushPagerEntryToEachWs(entry),
    onRaised: (entry, kind) => {
      pagerDelivery.onRaised(entry, kind);
      webPushDelivery.onRaised(entry, kind);
    },
    onTransitioned: (entry, to) => {
      pagerDelivery.onTransitioned(entry, to);
      webPushDelivery.onTransitioned(entry, to);
    },
  });
  agentManager.attachPagerStore(pagerStore);
  pagerDelivery = createPagerDelivery({
    store: pagerStore,
    settings: (userId) => pagerSettings.get(userId),
    setHoldUntil: (userId, at) => pagerSettings.setHoldUntil(userId, at),
    translator: (userId) => translatorForUserId(userId).t,
    fetch: startOpts.pagerFetch ?? ((url, init) => fetch(url, init)),
    now: () => Date.now(),
    scheduler: { setTimeout, clearTimeout },
    officeOrigin: () => buildPublicOrigin().origin,
    roomName: (roomId) => agentManager.roomById(roomId)?.name ?? null,
  });
  githubLinks = createGithubLinkStore(officeAuditStore().db);
  githubSync = createGithubSync({
    db: officeAuditStore().db,
    links: githubLinks,
    tasks: {
      list: () => agentManager.getTasks(),
      add: (title, createdBy, opts) =>
        agentManager.addTask(title, createdBy, opts),
      update: (id, changes) => agentManager.updateTask(id, changes),
    },
    fetch: (startOpts.githubSyncFetch ??
      ((url, init) => fetch(url, init))) as typeof fetch,
    scheduler: { setTimeout, clearTimeout },
    now: () => Date.now(),
    readSecret: (name) => {
      const secret = secretStore
        .readForProxy({ kind: "office" })
        .find((s) => s.name === name);
      return secret
        ? {
            value: secret.value,
            hosts: [...secret.hosts],
            updatedAt: secret.updatedAt,
          }
        : null;
    },
    roomExists: (roomId) => !!agentManager.roomById(roomId),
  });
  // Web Push: the second pager channel, to the devices where members turned
  // on notifications. Keys and devices live in web-push.json.
  webPushStore = createWebPushStore(
    createWebPushFilePersistence(join(STATE_ROOT, "web-push.json")),
  );
  uiBuildTracker = trackUiBuild(UI_DIST, broadcast);
  webPushDelivery = createWebPushDelivery({
    store: webPushStore,
    pages: pagerStore,
    repeatMinutes: (userId) => pagerSettings.get(userId).repeatMinutes,
    pushRooms: (userId) => getUserById(userId)?.pushRooms ?? null,
    roomAudience: (roomId) =>
      listUsers()
        .filter((u) => canAccess(u, roomId))
        .map((u) => u.id),
    notifRooms: (userId) => getUserById(userId)?.notifRooms ?? null,
    translator: (userId) => translatorForUserId(userId).t,
    fetch: startOpts.webPushFetch ?? ((url, init) => fetch(url, init)),
    now: () => Date.now(),
    scheduler: { setTimeout, clearTimeout },
    officeOrigin: () => buildPublicOrigin().origin,
    roomName: (roomId) => agentManager.roomById(roomId)?.name ?? null,
    isLobby: (roomId) => isLobbyRoom(roomId),
  });
  whatsappRoutes = createWhatsAppRoutes({
    stateRoot: STATE_ROOT,
    now: () => Date.now(),
    newId: () => `r_${randomBytes(4).toString("hex")}`,
    agent: (agentId) => {
      const info = agentManager.getAgent(agentId);
      return info
        ? { userId: info.userId, access: agentAccessOf(info), name: info.name }
        : null;
    },
    linkedPhone: (userId) => readLink(STATE_ROOT, userId)?.phone ?? null,
    onChange: (userId) => whatsappSupervisor.setRoutes(userId),
  });
  const routes = whatsappRoutes;
  const whatsappInbound = createWhatsAppInbound({
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    route: (userId, chat) => routes.forChat(userId, chat),
    linkedAt: (userId) => readLink(STATE_ROOT, userId)?.linkedAt ?? null,
    seen: (userId) => openIdRing(STATE_ROOT, userId, "seen"),
    sent: (userId) => openIdRing(STATE_ROOT, userId, "sent"),
    check: (userId, route) => routes.check(userId, route),
    memberName: (userId) => getUserById(userId)?.name ?? "the member",
    deliver: (_userId, route, text) =>
      agentManager.enqueueMessage(route.agentId, {
        sender: {
          kind: "messaging",
          app: WHATSAPP_APP,
          routeId: route.id,
          routeName: route.name,
        },
        text,
      }).ok,
  });
  whatsappSupervisor = createWhatsAppSupervisor({
    stateRoot: STATE_ROOT,
    bridgeEntry: WHATSAPP_BRIDGE_ENTRY,
    bunPath: process.execPath,
    baseEnv: process.env,
    spawner: spawnBridge,
    installer: createBridgeInstaller({
      runtimeDir: join(whatsappRoot(STATE_ROOT), WHATSAPP_RUNTIME_DIR),
      packageDir: WHATSAPP_PACKAGE_DIR,
      runInstall: (dir) => runBridgeInstall(dir, process.env),
    }),
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    readRss: readProcRss,
    pager: {
      raise: (userId, key, title, body) => {
        pagerStore.raise({
          source: {
            kind: "office",
            feature: "whatsapp",
            name: "WhatsApp",
            roomId: null,
          },
          targetUserId: userId,
          fields: { title, body, key },
        });
      },
    },
    renderQr: (code) => renderSVG(code),
    emitStatus: (userId, status) =>
      liveEmit("whatsapp_status", { status }, { userId }),
    hooks: {
      allowlist: (userId) => routes.allowlist(userId),
      onMessage: (userId, msg) => whatsappInbound.onMessage(userId, msg),
      onLinked: (userId, phone) => routes.onLinked(userId, phone),
      onUnlinked: (userId) => whatsappInbound.dropMember(userId),
      onShutdown: () => whatsappInbound.flushAll(),
    },
  });
  whatsappReplies = createWhatsAppReplies({
    routes,
    agent: (agentId) => {
      const info = agentManager.getAgent(agentId);
      return info ? { userId: info.userId, name: info.name } : null;
    },
    asks: askStore,
    supervisor: whatsappSupervisor,
    sent: (userId) => openIdRing(STATE_ROOT, userId, "sent"),
  });
  turnEndWatch = createTurnEndWatch({
    agent: (agentId) => {
      const a = agentManager.getAgent(agentId);
      return a
        ? {
            id: a.id,
            name: a.name,
            roomId: a.roomId ?? null,
            turnMemberIds: a.turnMemberIds,
          }
        : null;
    },
    onTurnEnd: (agent) => webPushDelivery.onTurnEnd(agent),
  });
}
