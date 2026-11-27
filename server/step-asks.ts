// Step asks (task c71cb60f): an agent asks the member to do a step on the
// Integrations page that is not a typed value (a provider sign-in, an MCP
// OAuth sign-in, a browser pairing, a room's GitHub link). The ask is a
// plain ask with a `step` and a link the server sets (for older clients: the
// card draws the step's control), so the member can still reply, dismiss or
// file it. It closes itself when the step is done.
//
// An action step (task e3d1bc63) is a human-only action the member runs from
// the card: it has a route (routeOf) and no link. The create refuses one the
// member could not run (the route's own authorization, verdict only), and
// the run (asks.runAction) dispatches that route as the member. The route is
// built from the state when it runs: a member's rooms and name now.
//
// One predicate per kind (isStepDone) reads the current state. The create
// refuses a step that is done (409 step_done), and every hook that may have
// done one calls reconcile, which closes each open step ask whose predicate
// holds. A hook says only that something changed.
//
// Each kind's checks are in its family's module (STEP_FAMILY in
// server/step-asks-common.ts): step-asks-links.ts, step-asks-members.ts,
// step-asks-credentials.ts, step-asks-office.ts and
// step-asks-messaging.ts. This module checks the shape, dispatches by
// kind, and runs the create and reconcile.

import type { AgentAccessGrant } from "../shared/agent-access.ts";
import {
  isActionStep,
  type ActionStepRequest,
  type AskEntry,
  type AskStep,
  type InstructionsScope,
  type ProviderAccountProvider,
  type ProviderAccountScope,
  type StepAskRequest,
} from "../shared/types.ts";
import type { OfficeSettingsRes } from "../shared/contract-shapes.ts";
import type { LogMessage } from "../shared/i18n/log-message.ts";
import type { GhostVariant } from "../shared/avatar.ts";
import type { MemberPack } from "../shared/pack-fit.ts";
import type { SupportedLanguageCode } from "../shared/languages.ts";
import type { VoiceInput, VoiceName, VoiceOutput } from "../shared/voice.ts";
import type { AskStore } from "./asks.ts";
import type { SecretScope } from "./secret-store.ts";
import type { StorageApplied } from "./office-storage-routes.ts";
import type {
  WhatsAppChatSeen,
  WhatsAppRoute,
  WhatsAppRouteDead,
} from "../shared/whatsapp.ts";
import type {
  DiscordGuildSeen,
  DiscordRoute,
  DiscordRouteDead,
} from "../shared/discord.ts";
import type { UpdateStatusWire } from "../shared/types.ts";
import type {
  MemberOsUserWire,
  PruneTarget,
} from "../shared/contract-shapes.ts";
import {
  STEP_FAMILY,
  invalid,
  isObject,
  type StepFamily,
} from "./step-asks-common.ts";
import { createLinkSteps } from "./step-asks-links.ts";
import { createMemberSteps } from "./step-asks-members.ts";
import { createCredentialSteps } from "./step-asks-credentials.ts";
import { createOfficeSteps } from "./step-asks-office.ts";
import { createMessagingSteps } from "./step-asks-messaging.ts";

export interface StepAskDeps {
  asks: AskStore;
  isOfficeOwner: (userId: string) => boolean;
  // The current state each predicate reads.
  providerConnected: (
    userId: string,
    provider: ProviderAccountProvider,
    scope: ProviderAccountScope,
  ) => Promise<boolean>;
  // An MCP server of the scope: whether it signs in with OAuth, and whether
  // it holds a sign-in. Null when the scope has no server of this name.
  mcpServer: (
    scope: SecretScope,
    name: string,
  ) => { oauth: boolean; signedIn: boolean } | null;
  browserPaired: (userId: string) => boolean;
  roomLinked: (roomId: string) => boolean;
  // The step is done: a system line in the agent's chat, and the same line
  // to the agent as an office notice from the member the ask is for.
  settled: (
    agentId: string,
    askId: string,
    line: LogMessage,
    memberUserId: string,
  ) => void;
  // The reads of the steps the member runs from the card (task e3d1bc63).
  // Absent in leaf tests: every such step is then refused at create.
  runs?: StepRunDeps;
}

// The office route a step's action runs, as the card's Apply sends it.
export interface StepRoute {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

export interface StepRunDeps {
  // The agent's name and grant now, or null when it is gone.
  agent(agentId: string): { name: string; grant: AgentAccessGrant } | null;
  // Whether the asking agent reaches the target agent's room.
  agentReaches(askingAgentId: string, targetAgentId: string): boolean;
  // The member's name, role and rooms now, or null when they are gone.
  member(userId: string): {
    name: string;
    role: "owner" | "member";
    allowedRooms: readonly string[];
    avatarColor: string;
    avatarVariant: GhostVariant;
  } | null;
  // The member's pack, preferences and room lists now, or null when they
  // are gone (task e3d1bc63, part 3).
  memberSettings(userId: string): MemberSettings | null;
  // The office settings now, with the version a write must carry.
  officeSettings(): OfficeSettingsRes;
  // The stored backup settings (dir null: the default folder).
  backupSettings(): {
    intervalHours: number;
    retention: number;
    dir: string | null;
  };
  // Whether ISOMUX_BACKUP_DIR sets the backup folder.
  backupDirFromEnv(): boolean;
  // The ages of the daily automatic log cleanup now (deleteAfterDays null:
  // off).
  logRetention(): { compressAfterDays: number; deleteAfterDays: number | null };
  // The room's name, or null when there is no such room.
  roomName(roomId: string): string | null;
  // The instructions of an agent, a room or a member now (task 33891b5b),
  // with the version a write must carry; null when the target is gone.
  instructions(
    scope: InstructionsScope,
    targetId: string,
  ): { text: string | null; version: string } | null;
  // The id of the member with this username, or null.
  memberIdByName(username: string): string | null;
  // Whether the room is open now: the lobby or a live room.
  roomOpen(roomId: string): boolean;
  // Whether the asking agent reaches the room, as its token does.
  agentReachesRoom(askingAgentId: string, roomId: string): boolean;
  // Whether this member is the only office owner.
  lastOwner(userId: string): boolean;
  // The refusal agents.setAccess gives past its guards (the folder rule, the
  // engine), or null.
  accessRefusal(
    agentId: string,
    grant: AgentAccessGrant,
  ): { code: string; message: string } | null;
  // Part 4: the member's live sessions and pending sign-in links, each with
  // its prefix (the path a revoke takes) and when it was made, and whether
  // the session is the one of `sessionIdHash`.
  memberSessions(
    userId: string,
    callerSessionIdHash?: string,
  ): { prefix: string; createdAt: number; current: boolean }[];
  // The links are the ones an office owner sees: unused, live or expired but
  // still extendable (task 8852553c), with the expiry and whether an owner
  // can extend the link.
  memberInvites(userId: string): {
    prefix: string;
    createdAt: number;
    expiresAt: number;
    extendable: boolean;
  }[];
  // The member's live API tokens.
  memberApiTokens(
    userId: string,
  ): { id: string; name: string; createdAt: number }[];
  // A live API token's owner, or null.
  apiToken(tokenId: string): { userId: string } | null;
  // The rooms the member may limit a token to, as the mint reads them.
  tokenLimitableRoomIds(userId: string): ReadonlySet<string>;
  // The saved access settings, and whether Hosted Isomux manages them.
  officeAccess(): {
    hosted: boolean;
    externalAccess: boolean;
    publicOrigin: string | null;
  };
  // Whether ending every live session of this member leaves the office with
  // no live owner session.
  signOutStrandsOffice(userId: string): boolean;
  // Whether ending the member's one live session with this prefix leaves the
  // office with no live owner session.
  sessionRevokeStrandsOffice(userId: string, sessionPrefix: string): boolean;
  // Part 5: a removed member's name, or null when no removed member has this
  // id; and the id of the removed member with this username (a removed
  // member's name stays reserved, so there is at most one).
  removedMember(userId: string): { name: string } | null;
  removedMemberIdByName(username: string): string | null;
  // The update checker's status now.
  updateStatus(): UpdateStatusWire;
  // How many files a prune or compress would take now (a dry plan).
  pruneCandidates(
    target: PruneTarget,
    olderThanDays: number,
    keepPerAgent: number,
  ): number;
  compressCandidates(olderThanDays: number): number;
  // The last prune applied to the target and the last compress, or null.
  lastPrune(target: PruneTarget): StorageApplied | null;
  lastCompress(): StorageApplied | null;
  // The member's WhatsApp (task 0b53ff37): whether they linked it, the chats
  // their bridge saw since it started (groups come at each connect), their
  // rows as stored (a read that never writes), and why an agent cannot be a
  // row's agent for them.
  whatsapp: {
    linked(userId: string): boolean;
    chatsSeen(userId: string): WhatsAppChatSeen[];
    rows(userId: string): WhatsAppRoute[];
    agentProblem(userId: string, agentId: string): WhatsAppRouteDead | null;
  };
  // The member's Discord (task 386ec4d6): their stored bots, the servers a
  // bot is in now (null when it has not connected yet), their routes as
  // stored (a read that never writes), and why an agent cannot be a route's
  // agent for them.
  discord: {
    bots(userId: string): { id: string; name: string }[];
    guilds(userId: string, botId: string): DiscordGuildSeen[] | null;
    routes(userId: string): DiscordRoute[];
    agentProblem(userId: string, agentId: string): DiscordRouteDead | null;
  };
  // Task 4088f164. The member's OS user as the owner's Members page reads it
  // (memberOsUserView, without the candidates), or null when the member is
  // gone.
  memberOsUser(userId: string): MemberOsUserWire | null;
  // How the office can run the member's root command itself (the GET's run
  // field): null where it cannot.
  osUserRunMode(): Promise<MemberOsUserWire["run"]>;
  // The existing OS users an owner can give a member, and the names a new
  // user cannot take. Each null when it could not be read in full: the
  // create then accepts the name, and the root command checks it at run.
  osUserNames(): Promise<{ existing: string[] | null; taken: string[] | null }>;
  // Whether the member passes the route's own authorization, as from the
  // page: the refusal, or null. Runs nothing.
  authorizeAs(
    memberUserId: string,
    route: StepRoute,
  ): { status: 403 | 404 | 422; code: string; message: string } | null;
}

// `accessible` is every room the member reaches, hidden ones included.
export interface MemberSettings {
  pack: MemberPack | null;
  language: SupportedLanguageCode | null;
  voiceInput?: VoiceInput;
  voiceOutput?: VoiceOutput;
  voiceName?: VoiceName;
  showToolCalls?: true;
  showAgentMessages?: true;
  accessible: readonly string[];
  hidden: readonly string[];
  tucked: readonly string[];
  notifRooms: readonly string[];
  pushRooms: readonly string[];
}

// A step refused at create or at run.
export interface StepFailure {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422;
  code: string;
  message: string;
}

// A step with a link opens an Integrations tab; a step with a route has none:
// the member runs it from the card.
export type StepCheck =
  { ok: true; step: AskStep; link?: string } | StepFailure;

// The routes an action step runs now, in order, or why it cannot run (its
// target is gone). The run stops at the first refusal; the routes are read
// from the state when it runs, so a retry does the rest.
export type StepRun = { ok: true; routes: StepRoute[] } | StepFailure;

const STEP_LINKS: Record<StepAskRequest["kind"], string> = {
  "provider-sign-in": "/integrations/providers",
  "mcp-sign-in": "/integrations/mcp",
  "browser-pairing": "/integrations/browser",
  "github-link": "/integrations/github",
};

// The Integrations tab a step's link opens (one of OFFICE_LINK_PATHS), or
// undefined for a step the member runs from the card.
export function stepLink(step: AskStep): string | undefined {
  return Object.hasOwn(STEP_LINKS, step.kind)
    ? STEP_LINKS[step.kind as StepAskRequest["kind"]]
    : undefined;
}

// The fields an agent may send, per kind. The server fills ownerUserId,
// roomId, and the userId of a member step from its username.
const STEP_KEYS: Record<AskStep["kind"], readonly string[]> = {
  "provider-sign-in": ["kind", "provider", "scope"],
  "mcp-sign-in": ["kind", "name", "scope"],
  "browser-pairing": ["kind"],
  "github-link": ["kind"],
  "agent-access": ["kind", "agentId", "access", "pack"],
  "member-room": ["kind", "username", "roomId", "grant"],
  "member-role": ["kind", "username", "role"],
  "member-pack": ["kind", "username", "pack"],
  "member-preferences": ["kind", "set"],
  "member-view": ["kind", "list", "roomId", "on"],
  "office-settings": ["kind", "set"],
  "backup-settings": ["kind", "set"],
  "sign-in-link": ["kind", "username"],
  "member-sessions": ["kind", "username"],
  "sign-in-links-revoke": ["kind", "username"],
  "sign-in-link-extend": ["kind", "username"],
  "member-avatar": ["kind", "username", "avatarColor", "avatarVariant"],
  "session-revoke": ["kind", "username", "sessionPrefix"],
  "api-token": ["kind", "name", "expiresInDays", "limits"],
  "api-token-revoke": ["kind", "tokenId"],
  "office-access": ["kind", "externalAccess", "publicOrigin"],
  "member-remove": ["kind", "username"],
  "member-restore": ["kind", "username", "agents"],
  "member-purge": ["kind", "username"],
  "office-update": ["kind"],
  "storage-prune": ["kind", "target", "olderThanDays", "keepPerAgent"],
  "storage-compress": ["kind", "olderThanDays"],
  "discord-route": [
    "kind",
    "placeName",
    "agentId",
    "scope",
    "trigger",
    "replyMode",
    "prefix",
    "includeBots",
    "react",
  ],
  "whatsapp-route": [
    "kind",
    "chatName",
    "phone",
    "agentId",
    "trigger",
    "sendDirect",
    "prefix",
    "ownMessages",
  ],
  "messaging-route": ["kind", "routeId", "set"],
  "storage-retention": ["kind", "set"],
  // The server fills targetId (task 33891b5b).
  "instructions-line": ["kind", "scope", "line"],
  "member-os-user": ["kind", "username", "on", "osUser", "existing"],
};

// The longest a create waits for the clock to pass a stored stamp.
const MAX_CLOCK_WAIT_MS = 5;

const isKnownKind = (kind: unknown): kind is AskStep["kind"] =>
  typeof kind === "string" && Object.hasOwn(STEP_KEYS, kind);

type StepEntry = AskEntry & { step: AskStep };

export function createStepAsks(deps: StepAskDeps) {
  const families = {
    links: createLinkSteps(deps),
    members: createMemberSteps(deps),
    credentials: createCredentialSteps(deps),
    office: createOfficeSteps(deps),
    messaging: createMessagingSteps(deps),
  };

  // The family of a kind this server knows: STEP_FAMILY names the family
  // that takes the kind's steps.
  function family(kind: AskStep["kind"]): StepFamily<AskStep> {
    return families[STEP_FAMILY[kind]] as StepFamily<AskStep>;
  }
  // The family of a stored step's kind, or null for a kind from a later
  // release: the store loads any kind.
  function familyOf(kind: string): StepFamily<AskStep> | null {
    return isKnownKind(kind) ? family(kind) : null;
  }

  // Whether the step is done now, for the member the ask is for. `since` is
  // when the ask opened, null at the create: nothing is made since an ask
  // that is not open, and every live session or link is from before it. A
  // kind from a later release is never done here.
  async function isDone(
    step: AskStep,
    memberUserId: string,
    since: number | null,
  ): Promise<boolean> {
    const fam = familyOf(step.kind);
    if (!fam) return false;
    return fam.isDone(step, memberUserId, since);
  }

  // The route an action step runs now, or null for a step with a link. A
  // member step reads the member when it runs: their name for the path, their
  // rooms for the new room list. A removal on a room closed since the create
  // never gets here in practice: the close takes the room from the member and
  // reconcile closes the ask as done.
  // A step on the member's own record (their preferences, their room lists)
  // runs on the record of `memberUserId`, the member the ask is for.
  // A sign-out ends the session of `callerSessionIdHash` (the member's own)
  // last.
  // A whatsapp-route step runs on the chat the member picked: `pick` is the
  // body of the Apply, {chat}.
  function routeOf(
    step: AskStep,
    memberUserId: string,
    callerSessionIdHash?: string,
    pick?: unknown,
  ): StepRun | null {
    return (
      familyOf(step.kind)?.routeOf?.(
        step,
        memberUserId,
        callerSessionIdHash,
        pick,
      ) ?? null
    );
  }

  // The step as the agent sent it, completed, or why it is refused.
  function complete(input: {
    step: unknown;
    agentId?: string;
    roomId: string;
    managerUserId: string | null;
    memberUserId: string;
  }): { ok: true; step: AskStep } | StepFailure {
    const { step: body, memberUserId, managerUserId } = input;
    if (!isObject(body)) return invalid("step must be an object");
    if (!isKnownKind(body.kind))
      return invalid(
        `step.kind is one of ${Object.keys(STEP_KEYS).join(", ")}`,
      );
    const kind = body.kind;
    const allowed = STEP_KEYS[kind];
    if (!Object.keys(body).every((key) => allowed.includes(key)))
      return invalid(`a ${kind} step takes only ${allowed.join(", ")}`);
    const scope = body.scope ?? "personal";
    // A discord-route step's scope is its place's kind, checked in its case.
    if (
      kind !== "browser-pairing" &&
      kind !== "github-link" &&
      kind !== "discord-route" &&
      kind !== "instructions-line"
    )
      if (scope !== "personal" && scope !== "office")
        return invalid("step.scope is personal or office");
    const owner = deps.isOfficeOwner(memberUserId);
    return family(kind).complete(body, kind, {
      agentId: input.agentId,
      roomId: input.roomId,
      managerUserId,
      memberUserId,
      scope,
      owner,
    });
  }

  // Closes one ask whose step is done: the first close settles it, and an
  // ask that went meanwhile (an answer, the agent's delete, another
  // reconcile) is not settled again.
  function close(entry: StepEntry): void {
    let removed: AskEntry | null;
    try {
      removed = deps.asks.remove(entry.id, { outcome: "done" });
    } catch {
      console.error(`[step-asks] ask ${entry.id} could not be closed`);
      return;
    }
    const fam = familyOf(entry.step.kind);
    if (!removed || !removed.memberUserId || !fam) return;
    deps.settled(
      entry.agentId,
      entry.id,
      fam.doneLine(entry.step, targetName(entry.step)),
      removed.memberUserId,
    );
  }

  // The name of the agent or member an action step changes, else "".
  function targetName(step: AskStep): string {
    return familyOf(step.kind)?.targetName?.(step) ?? "";
  }

  // Why the member could not run an action step, or null. A target the
  // asking agent cannot reach answers as a missing one, before any other
  // check, so the answer tells the agent nothing about it. A member is not
  // hidden: every agent reads the member list.
  function actionRefusal(
    step: ActionStepRequest,
    askingAgentId: string | undefined,
    memberUserId: string,
  ): StepFailure | null {
    const runs = deps.runs;
    if (!runs) return invalid("this office runs no action steps");
    return (
      family(step.kind).actionRefusal?.(
        step,
        askingAgentId,
        memberUserId,
        runs,
      ) ?? null
    );
  }

  // When each link, session or token a step's predicate reads by the ask's
  // age was made; none for the other kinds.
  function stateTimes(step: AskStep, memberUserId: string): number[] {
    const runs = deps.runs;
    if (!runs) return [];
    return family(step.kind).stateTimes?.(step, memberUserId, runs) ?? [];
  }

  return {
    // The `step` of an ask create, checked and completed. `memberUserId` is
    // the member the ask is for (the one named, else the manager);
    // `memberNamed` whether the agent named one. Naming the manager is the
    // same as naming no one, so only memberUserId is read.
    async check(input: {
      step: unknown;
      // The asking agent; a step the member runs needs it.
      agentId?: string;
      roomId: string;
      managerUserId: string | null;
      memberUserId: string;
      memberNamed: boolean;
    }): Promise<StepCheck> {
      const completed = complete(input);
      if (!completed.ok) return completed;
      const { step } = completed;
      const fam = family(step.kind);
      const unfit = fam.afterComplete?.(step);
      if (unfit) return unfit;
      if (isActionStep(step)) {
        const refused = actionRefusal(step, input.agentId, input.memberUserId);
        if (refused) return refused;
      }
      if (await isDone(step, input.memberUserId, null))
        return {
          ok: false,
          status: 409,
          code: "step_done",
          message: "this step is done",
        };
      const refused = await fam.afterDone?.(step);
      if (refused) return refused;
      // The ask's age splits the links, sessions and tokens into those from
      // before it and those made since, by the millisecond: so none from
      // before shares the ask's, the create waits past the newest. A stamp
      // more than a few ms ahead comes from a clock set back: no wait.
      const newest = Math.max(0, ...stateTimes(step, input.memberUserId));
      if (newest - Date.now() < MAX_CLOCK_WAIT_MS)
        while (Date.now() <= newest)
          await new Promise((resolve) => setTimeout(resolve, 1));
      return { ok: true, step, link: stepLink(step) };
    },

    // The route the member runs for a step now, or why it cannot run; null
    // for a step with a link.
    routeOf,

    // Whether the step of an open ask is done now.
    isStepDone(entry: StepEntry): Promise<boolean> {
      return entry.memberUserId
        ? isDone(entry.step, entry.memberUserId, entry.createdAt)
        : Promise.resolve(false);
    },

    // Closes every open step ask whose step is done. Never throws: a
    // predicate that fails leaves its ask open.
    async reconcile(): Promise<void> {
      let open: StepEntry[];
      try {
        open = deps.asks
          .listAll()
          .filter((e): e is StepEntry => e.step !== undefined);
      } catch {
        return;
      }
      await Promise.all(
        open.map(async (entry) => {
          try {
            if (!entry.memberUserId) return;
            if (await isDone(entry.step, entry.memberUserId, entry.createdAt))
              close(entry);
          } catch {
            console.error(
              `[step-asks] ask ${entry.id}: the step could not be read`,
            );
          }
        }),
      );
    },
  };
}

export type StepAsks = ReturnType<typeof createStepAsks>;
