// The office's identity and visibility policy: token attribution, the room
// access of an identity, spawn and folder refusals, and the cronjob, webhook
// and app visibility facts with their audience-change announcements. Moved
// out of server/isomux-office.ts, which creates it once at module load.
import type { ServerWebSocket } from "bun";
import { homedir } from "os";
import {
  type AgentAccess,
  agentAccessOf,
  FOLDER_NOT_ALLOWED,
  stopHasFolder,
} from "../shared/agent-access.ts";
import type { UserPublicWire } from "../shared/contract-shapes.ts";
import type {
  AgentInfo,
  AppListWire,
  AppRecord,
  AppWire,
  Cronjob,
  CronjobListWire,
  UserRecord,
  WebhookRecord,
  WebhookTarget,
  WebhookWire,
} from "../shared/types.ts";
import {
  confinedFolderRefusal,
  folderOverlapRefusal,
  type FolderRuleState,
  providerHomesOf,
} from "./agent-folder-rules.ts";
import type { SpawnAccessRefusal } from "./agent-manager.ts";
import { resolveAgentEngineSettings } from "./agent-validators.ts";
import { appHostDomain, appPublicUrl } from "./app-domain.ts";
import { appRegistry } from "./app-registry.ts";
import { appShortUrl } from "./app-short-url.ts";
import { type AppRuntime, UNKNOWN_RUNTIME } from "./app-supervisor.ts";
import {
  type AppViewerFacts,
  type AppVisibilityFacts,
  appVisibleTo,
  viewerUserId,
} from "./app-visibility.ts";
import { recheckOpenAppSockets } from "./app-ws-relay.ts";
import { buildPublicOrigin, type SessionLookup } from "./auth.ts";
import { engineRunsAccessHere } from "./backends/access-here.ts";
import { STATE_ROOT } from "./config.ts";
import type { ScheduleLimitAgent } from "./cron-agent-limits.ts";
import {
  type CronjobViewer,
  cronjobViewerForIdentity,
  type CronjobVisibilityFacts,
  projectCronjob,
} from "./cronjob-visibility.ts";
import { limitedClaudeFamiliesForUserId } from "./env-loader.ts";
import { webhookDeltaFor } from "./events/webhook-delta.ts";
import {
  actsForAgent,
  type Identity,
  limitToTokenRooms,
  reachAgentId,
  tokenRooms,
} from "./identity/index.ts";
import type { EmitContext } from "./events/emit.ts";
import type { EventId, EventPayloads } from "./events/registry.ts";
import type { AppChange } from "./events/app-delta.ts";
import type { GuardDeps } from "./identity/guards.ts";
import type { OfficeWsData } from "./isomux-office.ts";
import {
  agentManager,
  appSupervisor,
  cronjobManager,
  extensionService,
} from "./office-managers.ts";
import { webhookToWire } from "./routes/handlers/webhooks.ts";
import {
  SPAWN_EXCEEDS_AGENT,
  SPAWN_LIMIT,
  SPAWN_TREE_LIMIT,
  spawnExceedsAgent,
  type SpawnLimitAgent,
} from "./spawn-agent-limits.ts";
import type { TaskViewer } from "./task-visibility.ts";
import { getUserById, listUsers } from "./users.ts";
import {
  type WebhookViewer,
  webhookViewerForIdentity,
  type WebhookVisibilityFacts,
  webhookVisibleTo,
} from "./webhook-visibility.ts";
import type { WebhookIngress } from "./webhooks/ingress.ts";
import { webhookRegistry } from "./webhooks/registry.ts";
import { type WsPushKind } from "./ws-push-area.ts";

// What the identity and visibility policy reads from server/isomux-office.ts.
export interface AccessPolicyDeps {
  accessibleRoomIdsFor: (
    user: UserRecord,
    allowedRoomsOverride?: readonly string[],
  ) => Set<string>;
  browsers: Set<ServerWebSocket<OfficeWsData>>;
  buildLiveGuardDeps: () => GuardDeps;
  canAccess: (user: UserRecord, roomId: string) => boolean;
  currentWebhookIngress: () => WebhookIngress;
  liveEmit: <K extends EventId>(
    id: K,
    payload: EventPayloads[K],
    ctx?: EmitContext,
  ) => void;
  officeSend: (
    ws: ServerWebSocket<OfficeWsData>,
    kind: WsPushKind,
    data: string,
  ) => void;
  pushAppDeltaToEachWs: (change: AppChange) => void;
  toPublicWire: (user: UserRecord) => UserPublicWire;
}

export function createAccessPolicy(deps: AccessPolicyDeps) {
  const {
    accessibleRoomIdsFor,
    browsers,
    buildLiveGuardDeps,
    canAccess,
    currentWebhookIngress,
    liveEmit,
    officeSend,
    pushAppDeltaToEachWs,
    toPublicWire,
  } = deps;

  // Fan out the whole roster: PUBLIC list to all, FULL admin list to owners. The
  // per-user self record is NOT sent here - it rides emitUserUpdated on a change
  // and the connect hydration. A bulk op that changes self-visible fields for
  // specific users should also emitUserUpdated() each touched user.
  function emitUsersList(): void {
    const all = listUsers();
    liveEmit("users_list", { users: all.map(toPublicWire) });
    liveEmit("users_admin_list", { users: all });
  }

  // The refusal of an agent's spawn: its tree is full, or the child, with the
  // mode and sandbox the core will resolve, reaches more than its limited
  // spawner. Else null.
  function spawnRefusal(
    input: {
      agentType?: AgentInfo["agentType"];
      permissionMode?: AgentInfo["permissionMode"];
      codexSandbox?: AgentInfo["codexSandbox"];
      cwd: string;
      userId: string | null;
    },
    spawner: { spawnRootAgentId: string; limits?: SpawnLimitAgent },
    modelFamily: string | undefined,
  ): {
    ok: false;
    reason: "spawn_limit" | "spawn_exceeds_agent";
    message: string;
  } | null {
    const inTree = agentManager
      .getAllAgents()
      .filter((a) => a.spawnRootAgentId === spawner.spawnRootAgentId).length;
    if (inTree >= SPAWN_TREE_LIMIT)
      return {
        ok: false,
        reason: SPAWN_LIMIT,
        message: `One spawn tree holds at most ${SPAWN_TREE_LIMIT} live agents. Kill the agents it no longer needs.`,
      };
    if (!spawner.limits) return null;
    const agentType = input.agentType ?? "claude";
    const resolved = resolveAgentEngineSettings(
      agentType,
      {
        permissionMode: input.permissionMode,
        modelFamily,
        codexSandbox: input.codexSandbox,
      },
      limitedClaudeFamiliesForUserId(input.userId),
    );
    const reason = spawnExceedsAgent(
      {
        agentType,
        permissionMode: resolved.permissionMode,
        codexSandbox: resolved.codexSandbox,
        cwd: input.cwd,
      },
      spawner.limits,
    );
    return reason
      ? { ok: false, reason: SPAWN_EXCEEDS_AGENT, message: reason }
      : null;
  }

  // Token-derived task/cron attribution. createdBy is the caller's
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
    // An app acts as itself, never as its owner agent or the owning member, whose
    // name stays in `username` (ownership).
    if (identity.scope === "app" && identity.appName)
      createdBy = appActorName(identity.appName);
    // A cron run acts as the JOB, not as the human who created the job: its
    // userId is there for `username` (ownership), but a task the run files should
    // read as the job's, the way it did when the run passed createdBy itself on
    // the retired loopback /tasks route.
    if (identity.scope === "cron-run" && identity.cronjobId) {
      const job = cronjobManager
        .listCronjobs()
        .find((c) => c.id === identity.cronjobId);
      if (job) createdBy = job.name;
    }
    return { createdBy, username };
  }

  // How an app is named where a record keeps a display name for its author
  // (task createdBy, memory author, settings-change notices).
  function appActorName(appName: string): string {
    return `App "${appName}"`;
  }

  // The room ACCESS set for a caller identity (the board, the pager, skills).
  // Resolves the acting user (a USER identity's own record, or an AGENT identity's
  // SPAWNING user - "agents are bounded by their manager's room access") and
  // returns accessibleRoomIdsFor(user): every live room for an owner (by rule),
  // the granted rooms for a member. This is room ACCESS, never the hidden/order
  // view filter - a hidden room is still accessible, so its tasks still show.
  //
  // A CRON-RUN identity gets the EMPTY set here, and so does a token whose user is
  // gone. A run's board rooms come from boardRoomIdsForIdentity instead. This set
  // is not the run's room access either: room-gated guards use hasRoomAccess,
  // which keys on the run's userId and so gives a run its creator's rooms.
  //
  // A room-limited API token keeps only its rooms (tokenRooms).
  function accessibleRoomIdsForIdentity(identity: Identity): Set<string> {
    const user = roomAccessUserFor(identity);
    if (!user) return new Set<string>();
    return limitToTokenRooms(identity, accessibleRoomIdsFor(user));
  }

  // The office-owner rule for an identity's user: false for a room-limited API
  // token, which has no office-owner reach (hasOfficeOwnerReach).
  function identityUserIsOfficeOwner(
    identity: Identity,
    user: UserRecord | null | undefined,
  ): boolean {
    return user?.role === "owner" && tokenRooms(identity) === null;
  }

  // The user whose rooms an identity reaches, or null for a scope that reaches
  // none (a cron run, an ownerless app) and for a token whose user is gone.
  function roomAccessUserFor(identity: Identity): UserRecord | null {
    // Humans, their agents, and their remote-member API tokens inherit the user's
    // rooms. Written as an allowlist
    // rather than "everything except cron-run": an APP identity also carries a
    // userId (the app's owner), so the fallthrough would have handed a registered
    // app every room its owner can reach - and with it every room-gated read.
    // A scope that should see no rooms must be the default, not an exception
    // somebody remembers to add.
    // An app with a live owner agent has that agent's rooms (its userId is the
    // agent's manager); an ownerless app has none.
    if (
      identity.scope !== "user" &&
      !actsForAgent(identity) &&
      identity.scope !== "api"
    ) {
      return null;
    }
    return identity.userId ? (getUserById(identity.userId) ?? null) : null;
  }

  // The board's visibility rule (server/task-visibility.ts) for one user. A
  // closed room's tasks reach office owners only.
  function taskViewerForUser(user: UserRecord | null): TaskViewer {
    return {
      accessibleRoomIds: user ? accessibleRoomIdsFor(user) : new Set<string>(),
      liveRoomIds: new Set(agentManager.getRooms().map((room) => room.id)),
      seesClosedRooms: user?.role === "owner",
    };
  }

  function taskViewerForIdentity(identity: Identity): TaskViewer {
    if (identity.scope !== "cron-run") {
      const user = roomAccessUserFor(identity);
      return {
        accessibleRoomIds: accessibleRoomIdsForIdentity(identity),
        liveRoomIds: new Set(agentManager.getRooms().map((room) => room.id)),
        seesClosedRooms: identityUserIsOfficeOwner(identity, user),
      };
    }
    return {
      accessibleRoomIds: boardRoomIdsForIdentity(identity),
      liveRoomIds: new Set(agentManager.getRooms().map((room) => room.id)),
      seesClosedRooms: false,
    };
  }

  // The rooms whose tasks a caller sees and files on the board. A CRON-RUN sees
  // its job's room only (task 033fcb89), never its creator's other rooms: an
  // owner-made job would otherwise reach every room. A job with no room, or one
  // whose room is closed or out of its creator's access, leaves the run the
  // office-global board. Every other scope: its room access.
  function boardRoomIdsForIdentity(identity: Identity): Set<string> {
    if (identity.scope !== "cron-run")
      return accessibleRoomIdsForIdentity(identity);
    const roomId = runBoardRoomId(identity);
    return roomId ? new Set([roomId]) : new Set<string>();
  }

  // A run's board room: its job's live room, while the run still acts for the
  // job's creator and the creator can access that room. Read on each request, so
  // a room change, a room close or a lost grant applies to the next call.
  function runBoardRoomId(identity: Identity): string | null {
    if (!identity.cronjobId || !identity.userId) return null;
    const facts = cronjobFactsById(identity.cronjobId);
    if (!facts.liveRoomId || facts.makerUserId !== identity.userId) return null;
    const creator = getUserById(identity.userId);
    return creator && accessibleRoomIdsFor(creator).has(facts.liveRoomId)
      ? facts.liveRoomId
      : null;
  }

  // The live agent whose settings limit a schedule it made: an ordinary agent.
  // Null when it is gone or privileged (cron:manage wins), so the job is then
  // limited only as any member's job is (task c4233bfd).
  // What the folder rules check against (agent-folder-rules.ts).
  function folderRuleState(): FolderRuleState {
    return {
      stateRoot: STATE_ROOT,
      home: homedir(),
      providerHomes: providerHomesOf(),
      agents: agentManager.getAllAgents(),
      schedules: cronjobManager
        .listCronjobs()
        .map((job) => ({ name: job.name, cwd: job.cwd })),
      apps: appRegistry.list().map((app) => ({ name: app.name, cwd: app.cwd })),
    };
  }

  // The refusal of an engine or model that does not confine a stop below
  // Standard (engineRunsAccessHere).
  const ENGINE_BELOW_STANDARD_MESSAGE =
    "This engine or model cannot run an agent at this access level yet.";

  // The refusal for a new agent `name` of engine `agentType` with `model` at
  // `access` in `cwd`: the engine and model, then the folder rules at folder
  // and web, else the overlap with the folder of an agent that keeps its files
  // there.
  function spawnAccessRefusal(
    name: string,
    agentType: string,
    model: string | null,
    access: AgentAccess,
    cwd: string,
  ): SpawnAccessRefusal | null {
    if (!engineRunsAccessHere(agentType, access, model))
      return {
        refused: "engine_below_standard",
        message: ENGINE_BELOW_STANDARD_MESSAGE,
      };
    const state = folderRuleState();
    const message = stopHasFolder(access)
      ? confinedFolderRefusal({ id: "", name }, cwd, state)
      : folderOverlapRefusal(cwd, null, state);
    return message ? { refused: FOLDER_NOT_ALLOWED, message } : null;
  }

  // The refusal agents.setAccess gives past its guards for moving `agent` to
  // `access`: the folder rules at a stop with the folder, then the engine and
  // model. An action ask checks it at create (server/step-asks.ts).
  function accessChangeRefusal(
    agent: AgentInfo,
    access: AgentAccess,
  ): SpawnAccessRefusal | null {
    if (stopHasFolder(access)) {
      const message = confinedFolderRefusal(
        agent,
        agent.cwd,
        folderRuleState(),
      );
      if (message) return { refused: FOLDER_NOT_ALLOWED, message };
    }
    return engineRunsAccessHere(
      agent.agentType,
      access,
      agent.modelFamily || null,
    )
      ? null
      : {
          refused: "engine_below_standard",
          message: ENGINE_BELOW_STANDARD_MESSAGE,
        };
  }

  // The refusal for `agent` to move to `cwd`: the folder rules when it keeps
  // its files in its folder, else the overlap with such an agent's folder.
  function cwdFolderRefusal(agent: AgentInfo, cwd: string): string | null {
    const state = folderRuleState();
    return stopHasFolder(agentAccessOf(agent))
      ? confinedFolderRefusal(agent, cwd, state)
      : folderOverlapRefusal(cwd, agent.id, state);
  }

  function ordinaryScheduleMaker(agentId: string): AgentInfo | null {
    const agent = agentManager.getAgent(agentId);
    return agent && !agent.privileged ? agent : null;
  }

  // The settings of the agent whose reach the caller has, for the limits on
  // its own schedules.
  function ownScheduleLimitsFor(
    identity: Identity,
  ): (ScheduleLimitAgent & { roomId: string }) | null {
    const agentId = reachAgentId(identity);
    const agent = agentId ? agentManager.getAgent(agentId) : undefined;
    if (!agent) return null;
    return {
      agentType: agent.agentType,
      permissionMode: agent.permissionMode,
      ...(agent.codexSandbox ? { codexSandbox: agent.codexSandbox } : {}),
      ...(agent.access ? { access: agent.access } : {}),
      cwd: agent.cwd,
      roomId: agent.roomId,
    };
  }

  // The room a create with NO roomId in the body defaults to: an AGENT caller's
  // OWN room (an app's: its owner agent's current room), a CRON-RUN's board room
  // (its job's room, see runBoardRoomId), else undefined (office-global) for a
  // user or unknown identity. cronHandlers share this default; a run holds no
  // cron capability, so the cron-run arm does not reach them. The agent's room is used verbatim even if its
  // spawning user can't currently access it - "agent create → the agent's room" is
  // the authoritative rule; an explicit cross-room target is what the access guard
  // in the handler checks.
  function defaultCreateRoomIdForIdentity(
    identity: Identity,
  ): string | undefined {
    if (identity.scope === "cron-run")
      return runBoardRoomId(identity) ?? undefined;
    const agentId = reachAgentId(identity);
    if (agentId) {
      const agent = agentManager.getAllAgents().find((a) => a.id === agentId);
      if (
        agent?.roomId &&
        agentManager.getOrdinaryRooms().some((room) => room.id === agent.roomId)
      )
        return agent.roomId;
    }
    return undefined;
  }

  function appVisibilityFacts(app: AppRecord): AppVisibilityFacts {
    if (!app.createdByAgentId) {
      return { ownerUserId: app.userId, creatorLive: false };
    }
    const creator = agentManager.getAgent(app.createdByAgentId);
    if (!creator) {
      return {
        ownerUserId: app.userId,
        createdByAgentId: app.createdByAgentId,
        creatorLive: false,
      };
    }
    const room = agentManager.liveAgentRoom(creator);
    return {
      ownerUserId: app.userId,
      createdByAgentId: app.createdByAgentId,
      creatorLive: room !== undefined,
      ...(room !== undefined ? { creatorRoomId: creator.roomId } : {}),
    };
  }

  function appViewerFacts(
    identity: Identity,
    visibility: AppVisibilityFacts,
  ): AppViewerFacts {
    const userId = viewerUserId(identity);
    const viewerUser = userId ? getUserById(userId) : null;
    const scopedIdentity = userId === null ? identity : { ...identity, userId };
    return {
      userId,
      isOfficeOwner: identityUserIsOfficeOwner(identity, viewerUser),
      ...(tokenRooms(identity) !== null ? { ownNeedsRoom: true } : {}),
      hasCreatorRoomAccess:
        userId !== null && visibility.creatorRoomId !== undefined
          ? buildLiveGuardDeps().hasRoomAccess(
              scopedIdentity,
              visibility.creatorRoomId,
            )
          : false,
    };
  }

  // Cronjob visibility: server/cronjob-visibility.ts holds the rule; these
  // helpers feed it live office state. A job's room counts only while it is a
  // live ordinary room, so a closed room leaves the job to its maker and office
  // owners (it keeps firing: the run never depended on the room).
  function cronjobFacts(
    job: Pick<Cronjob, "userId" | "roomId" | "createdByAgentId">,
  ): CronjobVisibilityFacts {
    const roomId = job.roomId;
    return {
      makerUserId: job.userId ?? null,
      makerAgentId: job.createdByAgentId ?? null,
      liveRoomId:
        roomId && agentManager.getOrdinaryRooms().some((r) => r.id === roomId)
          ? roomId
          : null,
    };
  }

  // A job that is gone has no maker record left: office owners only.
  const GONE_CRONJOB_FACTS: CronjobVisibilityFacts = {
    makerUserId: null,
    liveRoomId: null,
  };

  function cronjobFactsById(jobId: string): CronjobVisibilityFacts {
    const job = cronjobManager.listCronjobs().find((c) => c.id === jobId);
    return job ? cronjobFacts(job) : GONE_CRONJOB_FACTS;
  }

  function cronjobViewerFor(identity: Identity): CronjobViewer {
    const guardDeps = buildLiveGuardDeps();
    return cronjobViewerForIdentity(identity, (roomId) =>
      guardDeps.hasRoomAccess(identity, roomId),
    );
  }

  // A browser socket is a USER session. Role and room access are read live from
  // the user record, the way the task projection reads them; a socket whose user
  // is gone sees nothing.
  function cronjobViewerForSession(session: SessionLookup): CronjobViewer {
    const user = getUserById(session.userId);
    let accessible: Set<string> | null = null;
    return {
      userId: user ? user.id : null,
      isOfficeOwner: user?.role === "owner",
      canRead: user !== undefined,
      canManage: user !== undefined,
      hasRoomAccess: (roomId) => {
        if (!user) return false;
        accessible ??= accessibleRoomIdsFor(user);
        return accessible.has(roomId);
      },
    };
  }

  function projectCronjobFor(
    job: Cronjob,
    viewer: CronjobViewer,
  ): CronjobListWire | null {
    return projectCronjob(job, cronjobFacts(job), viewer);
  }

  function cronjobsFor(viewer: CronjobViewer): CronjobListWire[] {
    const out: CronjobListWire[] = [];
    for (const job of cronjobManager.listCronjobs()) {
      const projected = projectCronjobFor(job, viewer);
      if (projected) out.push(projected);
    }
    return out;
  }

  // Webhook visibility: server/webhook-visibility.ts holds the rule; these
  // helpers feed it live office state. A hook's room is its target's room, and
  // counts only while it is a live ordinary room: a killed target agent, a
  // deleted target cronjob or a closed room leaves the hook to its owner and
  // office owners.
  function webhookTargetRoomId(target: WebhookTarget): string | null {
    if (target.kind === "cronjob") {
      const job = cronjobManager
        .listCronjobs()
        .find((candidate) => candidate.id === target.cronjobId);
      return job ? cronjobFacts(job).liveRoomId : null;
    }
    const roomId = agentManager.getAgent(target.agentId)?.roomId;
    return roomId &&
      agentManager.getOrdinaryRooms().some((r) => r.id === roomId)
      ? roomId
      : null;
  }

  function webhookFacts(
    record: Pick<WebhookRecord, "userId" | "target">,
  ): WebhookVisibilityFacts {
    return {
      ownerUserId: record.userId,
      liveRoomId: webhookTargetRoomId(record.target),
    };
  }

  function webhookViewerFor(identity: Identity): WebhookViewer {
    const guardDeps = buildLiveGuardDeps();
    return webhookViewerForIdentity(
      identity,
      (userId) => getUserById(userId)?.role === "owner",
      (roomId) => guardDeps.hasRoomAccess(identity, roomId),
    );
  }

  // A browser socket is a USER session; role and room access are read live from
  // the user record, as for cronjobs.
  function webhookViewerForSession(session: SessionLookup): WebhookViewer {
    const user = getUserById(session.userId);
    return {
      userId: user ? user.id : null,
      participates: user !== undefined,
      officeWide: user?.role === "owner",
      hasRoomAccess: (roomId) => (user ? canAccess(user, roomId) : false),
    };
  }

  // The sockets that can see each hook a change may move, taken BEFORE the
  // change: closing a room also ends its members' access, so who saw a hook
  // cannot be judged afterwards. `factsBefore` overrides the live facts for a
  // change already applied whose viewers it cannot have moved (a cronjob
  // edit). Pair with announceWebhookAudienceChanges after the change commits.
  type WebhookAudience = Map<string, Set<ServerWebSocket<OfficeWsData>>>;

  function snapshotWebhookAudience(
    include: (record: WebhookRecord) => boolean,
    factsBefore?: (record: WebhookRecord) => WebhookVisibilityFacts,
  ): WebhookAudience {
    const audience: WebhookAudience = new Map();
    try {
      const records = webhookRegistry.list().filter(include);
      if (records.length === 0) return audience;
      const viewers = [...browsers].map(
        (ws) => [ws, webhookViewerForSession(ws.data.session)] as const,
      );
      for (const record of records) {
        const facts = factsBefore ? factsBefore(record) : webhookFacts(record);
        const seenBy = new Set<ServerWebSocket<OfficeWsData>>();
        for (const [ws, viewer] of viewers) {
          if (webhookVisibleTo(facts, viewer)) seenBy.add(ws);
        }
        audience.set(record.id, seenBy);
      }
    } catch (err) {
      console.error("[webhooks] could not snapshot an audience change:", err);
    }
    return audience;
  }

  function announceWebhookAudienceChanges(before: WebhookAudience): void {
    if (before.size === 0) return;
    try {
      for (const record of webhookRegistry.list()) {
        const seenBy = before.get(record.id);
        if (!seenBy) continue;
        const webhook = webhookWire(record);
        const facts = webhookFacts(record);
        for (const ws of browsers) {
          const delta = webhookDeltaFor(
            {
              kind: "audience_changed",
              webhook,
              facts,
              wasVisible: seenBy.has(ws),
            },
            webhookViewerForSession(ws.data.session),
          );
          if (delta) officeSend(ws, delta.type, JSON.stringify(delta));
        }
      }
    } catch (err) {
      console.error("[webhooks] could not announce an audience change:", err);
    }
  }

  const webhookTargetsAgent = (agentId: string) => (record: WebhookRecord) =>
    record.target.kind === "agent" && record.target.agentId === agentId;

  // A cronjob changed room or was deleted after the fact: its hooks were in
  // `roomBefore` and are now wherever the job's live state puts them.
  function announceCronjobHookAudience(
    cronjobId: string,
    roomBefore: string | null,
  ): void {
    const before = snapshotWebhookAudience(
      (record) =>
        record.target.kind === "cronjob" &&
        record.target.cronjobId === cronjobId,
      (record) => ({ ownerUserId: record.userId, liveRoomId: roomBefore }),
    );
    announceWebhookAudienceChanges(before);
  }

  const webhookWire = (record: WebhookRecord): WebhookWire =>
    webhookToWire(
      {
        registry: webhookRegistry,
        publicOrigin: () => buildPublicOrigin().origin,
        counters: (id) => currentWebhookIngress().counters(id),
      },
      record,
    );

  // The app routes' answer for this agent (projectForList), asked live, and only
  // while the agent is alive. Screenshot grants revalidate with it on every
  // request.
  function agentMayOpenApp(
    identity: Identity,
    agentId: string,
    app: AppRecord,
  ): boolean {
    if (!agentManager.getAgent(agentId)) return false;
    const visibility = appVisibilityFacts(app);
    return appVisibleTo(visibility, appViewerFacts(identity, visibility));
  }

  // `identity`: the caller, when a route asks. A room-limited API token sees an
  // app by its own rooms (appViewerFacts), not its member's.
  function canUserAccessApp(
    app: AppRecord,
    userId: string,
    identity?: Identity,
  ): boolean {
    const user = getUserById(userId);
    if (!user) return false;
    // A member whose permission pack has no apps area opens no app.
    if (user.pack && user.role === "member" && !user.pack.areas.apps)
      return false;
    const visibility = appVisibilityFacts(app);
    if (identity && tokenRooms(identity) !== null)
      return appVisibleTo(visibility, appViewerFacts(identity, visibility));
    return appVisibleTo(visibility, {
      userId,
      isOfficeOwner: user.role === "owner",
      hasCreatorRoomAccess:
        visibility.creatorRoomId !== undefined &&
        buildLiveGuardDeps().hasRoomAccess(
          {
            scope: "user",
            userId,
            role: user.role,
            capabilities: [],
          },
          visibility.creatorRoomId,
        ),
    });
  }

  function viewerAppWire(app: AppWire): AppListWire | null {
    if (!app.createdByAgentId) return null;
    const creator = agentManager.getAgent(app.createdByAgentId);
    if (!creator || !agentManager.liveAgentRoom(creator)) return null;
    return {
      name: app.name,
      port: app.port,
      ...(app.description !== undefined
        ? { description: app.description }
        : {}),
      userId: app.userId,
      username: app.username,
      createdByAgentId: app.createdByAgentId,
      createdAt: app.createdAt,
      // Do not expose messageTargetAgentId here. createdByAgentId is the creator
      // whose room grants this viewer access; the message target can be in a room
      // the viewer cannot see.
      state: app.state,
      restartCount: app.restartCount,
      // shortUrl before url, as in toWire (server/routes/handlers/apps.ts).
      ...(app.shortUrl !== undefined ? { shortUrl: app.shortUrl } : {}),
      ...(app.url !== undefined ? { url: app.url } : {}),
      ...(app.thumbnailUpdatedAt !== undefined
        ? { thumbnailUpdatedAt: app.thumbnailUpdatedAt }
        : {}),
      ...(app.archived === true ? { archived: true } : {}),
      ...(app.reloadRequestedAt !== undefined
        ? { reloadRequestedAt: app.reloadRequestedAt }
        : {}),
      canManage: false,
    };
  }

  function appWireForDependency(
    app: AppRecord,
    runtime: AppRuntime | undefined,
  ): AppWire {
    const current = runtime ?? UNKNOWN_RUNTIME;
    const url = appPublicUrl(app.hostLabel, appHostDomain());
    const shortUrl = appShortUrl(app, url, buildPublicOrigin().origin);
    return {
      ...app,
      state: current.state,
      restartCount: current.restartCount,
      ...(current.startError ? { startError: current.startError } : {}),
      // shortUrl before url, as in toWire (server/routes/handlers/apps.ts).
      ...(shortUrl !== null ? { shortUrl } : {}),
      ...(url !== null ? { url } : {}),
    };
  }

  function snapshotAppVisibility(
    include: (app: AppRecord) => boolean,
  ): Map<string, AppVisibilityFacts> {
    try {
      return new Map(
        appRegistry
          .list()
          .filter(include)
          .map((app) => [app.name, appVisibilityFacts(app)]),
      );
    } catch (err) {
      console.error("[apps] could not snapshot a dependency change:", err);
      return new Map();
    }
  }

  function announceAppAudienceChanges(
    before: ReadonlyMap<string, AppVisibilityFacts>,
  ): void {
    try {
      const records = appRegistry.list().filter((app) => before.has(app.name));
      const runtimes = appSupervisor.states(records.map((app) => app.name));
      for (const app of records) {
        const prior = before.get(app.name);
        if (!prior) continue;
        const after = appVisibilityFacts(app);
        const ownerWire = appWireForDependency(app, runtimes.get(app.name));
        pushAppDeltaToEachWs({
          kind: "audience_changed",
          name: app.name,
          ownerApp: { ...ownerWire, canManage: true },
          viewerApp: viewerAppWire(ownerWire),
          before: prior,
          after,
        });
      }
    } catch (err) {
      console.error("[apps] could not announce a dependency change:", err);
    }
    recheckOpenAppSockets();
    extensionService?.revalidate();
  }

  return {
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
    identityUserIsOfficeOwner,
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
  };
}
