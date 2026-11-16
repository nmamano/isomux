// The reach of a member with their own OS user (internal-docs/member-os-user-design.md
// section 3.1). Such a member, their API tokens, agents, schedules and apps
// cannot make an office-user process or the office's files act on their
// input: no terminal, editor, command run, folder, instructions, engine or
// prompt answer on an agent that is not theirs, no room folder or room
// instructions, and no agent made for another manager. Their skills page
// reaches only their own skills, through their runner. Messages, logs and
// the rest stay open (the soft boundary of
// docs/isolation-model.md).
//
// Every route of API_ROUTES has a row, and every client WS frame type: a new
// route or frame without one fails the completeness tests. For an actor
// without their own OS user, every row passes: an office with no isolated
// member is unchanged.

import type { ClientCommand } from "../../shared/types.ts";
import type { Identity } from "./index.ts";
import type { GuardDeps } from "./guards.ts";
import type { AgentWriteRefusal } from "./agent-fit.ts";

export const MEMBER_REACH = "member_reach";

export type ReachRule =
  // Refused for every isolated actor. The route is an office owner's, and an
  // owner cannot have their own OS user, so this is a no-op today; it keeps
  // an isolated member out if a guard ever widens.
  | { kind: "owners" }
  // Refused unless the agent in this route param is the actor's own.
  | { kind: "agent"; param: string }
  // agents.update: on an agent that is not the actor's own, only the `open`
  // body keys pass, so a field added later is refused by default.
  | { kind: "agentFields"; param: string; open: readonly string[] }
  // The agent the write makes or revives must have the actor as its manager.
  | { kind: "result" }
  // A body with a `cwd` key (a room's folder) is refused.
  | { kind: "roomCwd" }
  // Refused for every isolated actor, with this message.
  | { kind: "refuse"; reason: string; message: string }
  | { kind: "open"; reason: string };

const NOT_YOURS =
  "This agent runs as another OS user than yours, so you cannot do this.";
const NO_ROOM_SETTING =
  "You have your own OS user, so you cannot set a room's folder or instructions.";
const NOT_YOUR_RESULT =
  "You have your own OS user, so you can spawn or revive only agents that you manage.";
const AGENT_GONE = "The agent that sent this request no longer exists.";
const NOT_OWNER = "This needs an office owner.";

// The Run of an ask's command or of a refused command (commandRunRefusal).
export const RUN_NOT_YOURS =
  "This agent runs as another OS user than yours, so you cannot run its commands.";

const OWNERS: ReachRule = { kind: "owners" };
const AGENT_ID: ReachRule = { kind: "agent", param: "id" };
const open = (reason: string): ReachRule => ({ kind: "open", reason });

const SELF_CALL = open(
  "the agent's (or the run's) own call: it acts on itself, through its own host",
);
const MESSAGE = open(
  "a message or a conversation step: the agent reads it as data (3.1); a message never answers a prompt of an agent that is not the actor's own (promptAnswerRefused)",
);
const MOVE = open(
  "changes no folder (moveAgent); the moved agent takes the target room's instructions",
);
const READ = open("a read of what the room already shows");
const UPLOAD = open(
  "the server writes the bytes under its own name in its state folder; the agent reads them as data",
);
const ASKS = open(
  "an answer to an ask, delivered as data, never a prompt answer",
);
const ASK_ACTION = open(
  "dispatches an office route as the member through executeRoute, which applies this table to that route",
);
const OWN_SCOPE = open(
  "the member's own settings, which reach only agents they manage",
);
const OWN_HOST = open(
  "checked or run through the caller's own host (agent-folder.ts)",
);
const DATA = open(
  "data that agents read as data, not as instructions, and no process acts on",
);
const MEMORY = open(
  "the prompt frames memory as notes to weigh, which is the message boundary; room instructions are framed as instructions and are refused",
);
const SKILL_READ = open(
  "an isolated member's catalog comes from their runner and lists only their own skills, their agents' and the built-ins; their files are read through their host (member-skill-catalog.ts)",
);
const SKILL_WRITE = open(
  "an isolated member writes only their own skill files, through their runner (member-skill-catalog.ts)",
);
const OWN_RESOURCE = open(
  "the actor's own app or schedule (its owner guard); until slice 3 it still runs as the office user, which is safe only because the enable answers not ready until slice 4",
);
const ROLE = open("the users core refuses to make an isolated member an owner");
const TERMINAL: ReachRule = { kind: "agent", param: "agentId" };

// By route opId: every route of API_ROUTES.
export const REACH_TABLE: Readonly<Record<string, ReachRule>> = {
  // Agents: management.
  "agents.spawn": { kind: "result" },
  "agents.revive": { kind: "result" },
  "agents.update": {
    kind: "agentFields",
    param: "id",
    open: ["name", "outfit"],
  },
  "agents.setInstructions": AGENT_ID,
  "agents.setAccess": AGENT_ID,
  "agents.setPrivileged": AGENT_ID,
  "agents.setManager": OWNERS,
  "agents.kill": MESSAGE,
  "agents.abort": MESSAGE,
  "agents.move": MOVE,
  "agents.setTopic": MESSAGE,
  "agents.regenerateTopic": MESSAGE,
  "rooms.swapDesks": MOVE,
  // Agents: conversation.
  "agents.sendMessage": MESSAGE,
  "agents.editMessage": open(
    "an edit never answers a prompt: the fork sends a new turn, and the ephemeral re-send refuses while a prompt is pending",
  ),
  "agents.respondInteraction": AGENT_ID,
  "agents.listScheduledMessages": MESSAGE,
  "agents.cancelScheduledMessage": MESSAGE,
  "agents.cancelQueued": MESSAGE,
  "agents.sendNow": MESSAGE,
  "agents.newConversation": MESSAGE,
  "agents.handoff": MESSAGE,
  "agents.resume": MESSAGE,
  // Agents: the panel of another agent.
  "agents.openFile": AGENT_ID,
  "agents.saveFile": AGENT_ID,
  "agents.closeFile": AGENT_ID,
  "agents.runDeniedCommand": AGENT_ID,
  "asks.runCommand": open(
    "commandRunRefusal checks the ask's agent with agentReachRefusal",
  ),
  "asks.runAction": ASK_ACTION,
  // Agents: reads.
  "agents.discovery": READ,
  "agents.avatar": READ,
  "agents.readInstructions": READ,
  "agents.readSystemPrompt": READ,
  "agents.previewSystemPrompt": open(
    "builds the prompt text; reads no path that the body names",
  ),
  "agents.readQueue": READ,
  "agents.listSessions": READ,
  "agents.terminal": READ,
  "agents.logs": READ,
  "agents.contextUsage": READ,
  "agents.subscriptionUsage": READ,
  "agents.askHistory": READ,
  "agents.askEvents": READ,
  "agents.getFile": READ,
  "chatFiles.get": READ,
  "chatFiles.getImage": READ,
  "agents.upload": UPLOAD,
  "chatFiles.upload": UPLOAD,
  // Agents: an agent's own calls.
  "agents.readFile": SELF_CALL,
  "agents.diff": SELF_CALL,
  "agents.editFile": SELF_CALL,
  "agents.terminalCommand": SELF_CALL,
  "agents.secretRequest": SELF_CALL,
  "agents.sudoRequest": SELF_CALL,
  "agents.createAsk": SELF_CALL,
  "agents.listAsks": SELF_CALL,
  "agents.getAsk": SELF_CALL,
  "agents.getAskFile": SELF_CALL,
  "agents.editAsk": SELF_CALL,
  "agents.deleteAsk": SELF_CALL,
  "agents.previewUrl": SELF_CALL,
  "agents.browser": SELF_CALL,
  "cron.runReadFile": SELF_CALL,
  "cron.runDiff": SELF_CALL,
  "messaging.reply": SELF_CALL,
  "agentConnections.list": SELF_CALL,
  "secretRequests.save": OWN_SCOPE,
  "secretRequests.decline": OWN_SCOPE,
  // Asks.
  "asks.list": ASKS,
  "asks.listOthers": ASKS,
  "asks.get": ASKS,
  "asks.reply": ASKS,
  "asks.dismiss": ASKS,
  "asks.simplify": ASKS,
  "asks.ack": ASKS,
  "asks.simplifyUndo": ASKS,
  "asks.getFile": ASKS,
  "asks.fileTask": ASKS,
  "asks.appCreate": ASKS,
  "asks.appList": ASKS,
  "asks.appGet": ASKS,
  "asks.appEdit": ASKS,
  "asks.appDelete": ASKS,
  // Rooms and floors.
  "rooms.create": open("its body has no folder field (RoomCreateReq)"),
  "rooms.close": open("closes an empty room; no process acts on it"),
  "rooms.rename": { kind: "roomCwd" },
  "rooms.getSettings": READ,
  "rooms.readInstructions": READ,
  "rooms.setInstructions": {
    kind: "refuse",
    message: NO_ROOM_SETTING,
    reason:
      "room instructions sit in the system prompt of every agent in the room as instructions, office agents included, also ones that join later",
  },
  "floors.list": DATA,
  "floors.add": DATA,
  "floors.name": DATA,
  "floors.remove": DATA,
  // Skills.
  "skills.usageCounts": DATA,
  "skills.catalog": SKILL_READ,
  "skills.readFile": SKILL_READ,
  "skills.saveFile": SKILL_WRITE,
  "skills.create": SKILL_WRITE,
  "skills.deleteFile": SKILL_WRITE,
  // The member's own scope.
  ...Object.fromEntries(
    [
      "view.setOrder",
      "view.setShown",
      "view.setNotifRooms",
      "view.setTucked",
      "view.setPinned",
      "view.markInboxSeen",
      "view.setPushRooms",
      "view.listRooms",
      "browser.download",
      "browser.get",
      "browser.pair",
      "browser.revoke",
      "browser.revokeOne",
      "browser.reload",
      "prefs.update",
      "memberVoice.get",
      "memberRecordingWords.get",
      "memberVoice.update",
      "memberChat.update",
      "userEnv.get",
      "userEnv.replace",
      "userEnv.set",
      "userEnv.remove",
      "secrets.list",
      "secrets.create",
      "secrets.rotate",
      "secrets.reveal",
      "secrets.update",
      "secrets.delete",
      "secrets.reissue",
      "secrets.test",
      "mcpServers.list",
      "mcpServers.create",
      "mcpServers.update",
      "mcpServers.delete",
      "mcpServers.test",
      "mcpServers.signIn",
      "mcpOAuth.callback",
      "pagerSettings.get",
      "pagerSettings.update",
      "pagerSettings.test",
      "pushDevices.list",
      "pushDevices.add",
      "pushDevices.remove",
      "pushDevices.test",
      "integrationChanges.list",
      "apiTokens.list",
      "apiTokens.mint",
      "apiTokens.revoke",
      "apiTokenInbox.drain",
      "providerAccounts.list",
      "providerAccounts.start",
      "providerAccounts.callback",
      "providerAccounts.refresh",
      "providerAccounts.cancel",
      "providerAccounts.disconnect",
      "openCode.status",
      "connections.list",
      "users.readInstructions",
      "users.setInstructions",
      "users.readPinned",
      "users.setPinned",
      "users.delete",
      "invites.mintSelf",
      "invites.list",
      "invites.revoke",
      "sessions.list",
      "sessions.listForMember",
      "sessions.revoke",
      "sessions.logout",
      "whatsapp.status",
      "whatsapp.link",
      "whatsapp.unlink",
      "whatsapp.chats",
      "discord.list",
      "discord.connect",
      "discord.disconnect",
      "discord.guilds",
    ].map((opId) => [opId, OWN_SCOPE]),
  ),
  "users.update": ROLE,
  // Message routes of chat bridges: they deliver messages.
  ...Object.fromEntries(
    [
      "whatsappRoutes.list",
      "whatsappRoutes.create",
      "whatsappRoutes.update",
      "whatsappRoutes.delete",
      "discordRoutes.list",
      "discordRoutes.create",
      "discordRoutes.update",
      "discordRoutes.delete",
      "apiTokenInbox.send",
      "apps.sendMessage",
    ].map((opId) => [opId, MESSAGE]),
  ),
  // Through the caller's own host.
  "validate.cwd": OWN_HOST,
  "backends.listModels": OWN_HOST,
  "validate.env": DATA,
  // Data.
  ...Object.fromEntries(
    [
      "tasks.history",
      "tasks.list",
      "tasks.get",
      "tasks.create",
      "tasks.update",
      "tasks.claim",
      "tasks.done",
      "tasks.delete",
      "pager.raise",
      "pager.list",
      "pager.get",
      "pager.ack",
      "pager.resolve",
      "pager.appRaise",
      "pager.appResolve",
      "membersChat.page",
      "membersChat.post",
      "membersChat.pin",
      "membersChat.thumbsUp",
      "membersChat.edit",
      "membersChat.delete",
      "membersChat.markRead",
      "membersChat.upload",
      "membersChat.getFile",
      "memberDms.list",
      "memberDms.page",
      "memberDms.post",
      "memberDms.thumbsUp",
      "memberDms.edit",
      "memberDms.delete",
      "memberDms.markRead",
      "memberDms.upload",
      "memberDms.getFile",
      "webhooks.list",
      "webhooks.get",
      "webhooks.create",
      "webhooks.update",
      "webhooks.delete",
      "webhooks.deliveries",
      "webhooks.dryRun",
      "webhooks.readSecret",
      "webhooks.rotateSecret",
      "voice.status",
      "voice.transcribe",
      "voice.speak",
      "agentReference.list",
      "agentReference.get",
      "system.backupStatus",
      "system.version",
      "storage.usage",
      "usage.read",
      "storage.retention",
      "officeEnv.names",
      "officeSecrets.list",
      "officeMcpServers.list",
    ].map((opId) => [opId, DATA]),
  ),
  "memory.read": DATA,
  "memory.append": MEMORY,
  "memory.replace": MEMORY,
  // The actor's own apps and schedules.
  ...Object.fromEntries(
    [
      "apps.mintSignIn",
      "apps.list",
      "apps.widget",
      "apps.manifest",
      "apps.get",
      "apps.getThumbnail",
      "apps.setThumbnail",
      "apps.register",
      "apps.update",
      "apps.delete",
      "apps.logs",
      "apps.start",
      "apps.stop",
      "apps.restart",
      "apps.reload",
      "apps.archive",
      "apps.unarchive",
      "cron.list",
      "cron.get",
      "cron.readSystemPrompt",
      "cron.create",
      "cron.update",
      "cron.delete",
      "cron.runNow",
      "cron.listRuns",
      "cron.listAllRuns",
      "cron.getRun",
      "cron.runMessage",
      "cron.editRunMessage",
    ].map((opId) => [opId, OWN_RESOURCE]),
  ),
  // An office owner's routes.
  ...Object.fromEntries(
    [
      "users.create",
      "audit.list",
      "terminalRecordings.list",
      "terminalRecordings.get",
      "tasks.restore",
      "sudoRequests.run",
      "sudoRequests.decline",
      "githubSync.get",
      "githubSync.set",
      "githubSync.delete",
      "userEnv.names",
      "officeEnv.get",
      "officeEnv.replace",
      "officeEnv.set",
      "officeEnv.remove",
      "officeSecrets.create",
      "officeSecrets.rotate",
      "officeSecrets.reveal",
      "officeSecrets.update",
      "officeSecrets.delete",
      "officeSecrets.reissue",
      "officeSecrets.test",
      "officeMcpServers.create",
      "officeMcpServers.update",
      "officeMcpServers.delete",
      "officeMcpServers.test",
      "officeMcpServers.signIn",
      "memberConnections.list",
      "memberProviderAccounts.list",
      "memberProviderAccounts.refresh",
      "memberProviderAccounts.start",
      "memberProviderAccounts.callback",
      "memberProviderAccounts.cancel",
      "memberProviderAccounts.disconnect",
      "users.setAccess",
      "users.removedList",
      "users.restore",
      "users.purge",
      "apiTokens.adminList",
      "apiTokens.adminRevoke",
      "invites.mint",
      "invites.mintRecovery",
      "office.getAccess",
      "office.setAccess",
      "office.updateInfo",
      "office.triggerUpdate",
      "office.lockdown",
      "office.startExport",
      "office.exportStatus",
      "office.downloadExport",
      "office.mintMoveCode",
      "office.getMove",
      "office.cancelMove",
      "office.getSettings",
      "office.getMemberUsageStatus",
      "office.setSettings",
      "office.enterprise.get",
      "office.enterprise.setEnabled",
      "office.enterprise.setSecret",
      "office.enterprise.check",
      "office.memberToken.get",
      "office.memberToken.set",
      "office.memberToken.clear",
      "office.readInstructions",
      "office.setInstructions",
      "cron.readInstructions",
      "cron.setInstructions",
      "system.setBackupSettings",
      "storage.prune",
      "storage.compress",
      "storage.setRetention",
    ].map((opId) => [opId, OWNERS]),
  ),
};

// By client WS frame type. All six terminal frames go through one gate
// (terminalAllowed), so they share one rule.
export const WS_REACH = {
  open_log: READ,
  close_log: READ,
  log_ack: READ,
  terminal_open: TERMINAL,
  terminal_status_request: TERMINAL,
  terminal_input: TERMINAL,
  terminal_resize: TERMINAL,
  terminal_close: TERMINAL,
  terminal_restart: TERMINAL,
  presence_update: open("no agent and no process"),
  lobby_move: open("no agent and no process"),
  ping: open("no agent and no process"),
} as const satisfies Record<ClientCommand["type"], ReachRule>;

// Who a request acts for: the member whose OS user its effects belong to.
// "unresolved" when the identity names an agent that is gone (or is in no
// live room).
export type ReachActor =
  { kind: "member"; userId: string | null } | { kind: "unresolved" };

export function reachActor(identity: Identity, deps: GuardDeps): ReachActor {
  switch (identity.scope) {
    case "user":
    case "api":
    case "cron-run":
    case "app":
      // The human, the token's member, the job's owner (null: an office
      // job), the app's owner (null: an office app).
      return { kind: "member", userId: identity.userId };
    case "agent": {
      // The agent runs as its CURRENT manager, which a manager change moves;
      // identity.userId is the user who spawned it.
      const agentId = identity.agentId ?? "";
      if (deps.roomIdForAgent(agentId) === null) return { kind: "unresolved" };
      return { kind: "member", userId: deps.agentManagerUserId(agentId) };
    }
    default: {
      const never: never = identity.scope;
      void never;
      return { kind: "unresolved" };
    }
  }
}

// The member an isolated actor acts for, null when the actor is not isolated
// (every rule then passes), or UNRESOLVED (every gated rule refuses).
const UNRESOLVED = Symbol("unresolved");

function isolatedActor(
  identity: Identity,
  deps: GuardDeps,
): string | null | typeof UNRESOLVED {
  const isolated = (userId: string | null): userId is string =>
    userId !== null && deps.memberIsolated?.(userId) === true;
  const actor = reachActor(identity, deps);
  // A gone agent's token: refused only when the member who spawned it has
  // their own OS user, so an office with no isolated member is unchanged.
  if (actor.kind === "unresolved")
    return isolated(identity.userId) ? UNRESOLVED : null;
  return isolated(actor.userId) ? actor.userId : null;
}

function refusal(message: string): AgentWriteRefusal {
  return { status: 403, code: MEMBER_REACH, message };
}

// Whether `agentId` is managed by `member`. While the member's own host is
// not ready, their own agent passes: the write runs nowhere until the host is
// ready.
function ownsAgent(member: string, agentId: string, deps: GuardDeps): boolean {
  return (
    deps.roomIdForAgent(agentId) !== null &&
    deps.agentManagerUserId(agentId) === member
  );
}

// The refusal of one rule for this identity, else null.
export function reachRuleRefusal(
  rule: ReachRule | undefined,
  identity: Identity,
  params: Readonly<Record<string, string | undefined>>,
  body: unknown,
  deps: GuardDeps,
  opId?: string,
): AgentWriteRefusal | null {
  const member = isolatedActor(identity, deps);
  // Not isolated: the office is unchanged. This exit comes first.
  if (member === null) return null;
  if (rule?.kind === "open") return null;
  // No row: a route this table does not know is refused (the completeness
  // test keeps this from happening).
  if (!rule) return refusal(NOT_OWNER);
  if (member === UNRESOLVED) return refusal(AGENT_GONE);
  switch (rule.kind) {
    case "owners":
      return refusal(NOT_OWNER);
    case "agent":
      return ownsAgent(member, params[rule.param] ?? "", deps)
        ? null
        : refusal(NOT_YOURS);
    case "agentFields": {
      if (ownsAgent(member, params[rule.param] ?? "", deps)) return null;
      const keys =
        typeof body === "object" && body !== null ? Object.keys(body) : [];
      return keys.every((key) => rule.open.includes(key))
        ? null
        : refusal(NOT_YOURS);
    }
    case "result": {
      const manager =
        opId === "agents.revive"
          ? deps.killedAgentManagerUserId(params.id ?? "")
          : identity.userId;
      return manager === member ? null : refusal(NOT_YOUR_RESULT);
    }
    case "roomCwd":
      return typeof body === "object" && body !== null && "cwd" in body
        ? refusal(NO_ROOM_SETTING)
        : null;
    case "refuse":
      return refusal(rule.message);
  }
}

// The executor's check for one route call.
export function memberReachRefusal(
  identity: Identity,
  route: { opId: string },
  params: Readonly<Record<string, string | undefined>>,
  body: unknown,
  deps: GuardDeps,
): AgentWriteRefusal | null {
  return reachRuleRefusal(
    REACH_TABLE[route.opId],
    identity,
    params,
    body,
    deps,
    route.opId,
  );
}

// Whether `identity` may open a terminal on, run a command in, or answer a
// prompt of `agentId`: null when it may.
export function agentReachRefusal(
  identity: Identity,
  agentId: string,
  deps: GuardDeps,
): AgentWriteRefusal | null {
  return reachRuleRefusal(
    { kind: "agent", param: "id" },
    identity,
    { id: agentId },
    undefined,
    deps,
  );
}

// Whether a message from `identity` to `agentId` must not be read as the
// answer to the agent's pending prompt: an isolated member's message to an
// agent that is not theirs. The answer would let the agent run a command as
// its own user with no check by its manager.
export function promptAnswerRefused(
  identity: Identity,
  agentId: string,
  deps: GuardDeps,
): boolean {
  return agentReachRefusal(identity, agentId, deps) !== null;
}
