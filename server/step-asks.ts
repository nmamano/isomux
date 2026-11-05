// Step asks (task c71cb60f): an agent asks the member to do a step on the
// Integrations page that is not a typed value (a provider sign-in, an MCP
// OAuth sign-in, a browser pairing, a room's GitHub link). The ask is a
// plain ask with a `step` and a link the server sets, so the member can
// still reply, dismiss or file it. It closes itself when the step is done.
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

import {
  parseAgentAccessGrant,
  sameAccessGrant,
  type AgentAccessGrant,
} from "../shared/agent-access.ts";
import {
  LOBBY_ROOM_ID,
  isActionStep,
  type ActionStepRequest,
  type AskEntry,
  type AskStep,
  type MemberViewList,
  type ProviderAccountProvider,
  type ProviderAccountScope,
  type StepAskRequest,
} from "../shared/types.ts";
import {
  PREFERENCE_KEYS,
  type OfficeSettingsRes,
} from "../shared/contract-shapes.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import {
  parseMemberPack,
  samePack,
  type MemberPack,
} from "../shared/pack-fit.ts";
import type { SupportedLanguageCode } from "../shared/languages.ts";
import {
  DEFAULT_VOICE_NAME,
  type VoiceInput,
  type VoiceName,
  type VoiceOutput,
} from "../shared/voice.ts";
import type { AskStore } from "./asks.ts";
import { backupSettingsShapeError } from "./backup.ts";
import {
  OFFICE_NAME_MAX,
  OFFICE_SETTINGS_SWITCHES,
  officeSettingsFieldError,
} from "./routes/handlers/office-settings.ts";
import { parsePreferenceChange } from "./routes/handlers/preferences.ts";
import type { SecretScope } from "./secret-store.ts";

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
  // The room's name, or null when there is no such room.
  roomName(roomId: string): string | null;
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
  | { ok: true; step: AskStep; link?: string }
  | StepFailure;

// The route an action step runs now, or why it cannot run (its target is
// gone).
export type StepRun = { ok: true; route: StepRoute } | StepFailure;

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
};

const PROVIDER_LABELS = { claude: "Claude", codex: "Codex" } as const;

const invalid = (message: string): StepFailure => ({
  ok: false,
  status: 400,
  code: "invalid_request",
  message,
});

const notAllowed = (message: string): StepFailure => ({
  ok: false,
  status: 403,
  code: "member_not_allowed",
  message,
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isKnownKind = (kind: unknown): kind is AskStep["kind"] =>
  typeof kind === "string" && Object.hasOwn(STEP_KEYS, kind);

type StepEntry = AskEntry & { step: AskStep };

// The secrets scope of an MCP sign-in step.
function mcpScope(
  step: Extract<AskStep, { kind: "mcp-sign-in" }>,
): SecretScope | null {
  if (step.scope === "office") return { kind: "office" };
  return step.ownerUserId ? { kind: "user", userId: step.ownerUserId } : null;
}

// What the agent reads when the step is done. `target` names the agent or
// member an action step changes.
function doneLine(step: AskStep, target: string): LogMessage {
  switch (step.kind) {
    case "provider-sign-in":
      return step.scope === "office"
        ? msg("systemEntries.stepAsk.providerSignedInOffice", {
            provider: PROVIDER_LABELS[step.provider],
          })
        : msg("systemEntries.stepAsk.providerSignedIn", {
            provider: PROVIDER_LABELS[step.provider],
          });
    case "mcp-sign-in":
      return msg("systemEntries.stepAsk.mcpSignedIn", { name: step.name });
    case "browser-pairing":
      return msg("systemEntries.stepAsk.browserPaired");
    case "github-link":
      return msg("systemEntries.stepAsk.githubLinked");
    case "agent-access":
      return msg("systemEntries.stepAsk.agentAccessSet", { agent: target });
    case "member-room":
      return msg("systemEntries.stepAsk.memberRoomSet", { member: target });
    case "member-role":
      return msg("systemEntries.stepAsk.memberRoleSet", { member: target });
    case "member-pack":
      return msg("systemEntries.stepAsk.memberPackSet", { member: target });
    case "member-preferences":
      return msg("systemEntries.stepAsk.preferencesSet");
    case "member-view":
      return msg("systemEntries.stepAsk.roomViewSet", { room: target });
    case "office-settings":
      return msg("systemEntries.stepAsk.officeSettingsSet");
    case "backup-settings":
      return msg("systemEntries.stepAsk.backupSettingsSet");
  }
}

// The keys a settings step may set.
const OFFICE_SET_KEYS: readonly string[] = [
  "name",
  "memberUsageShare",
  ...OFFICE_SETTINGS_SWITCHES,
];
const BACKUP_SET_KEYS: readonly string[] = [
  "intervalHours",
  "retention",
  "dir",
];
const VIEW_LISTS: readonly string[] = ["shown", "tucked", "notif", "push"];

// The preferences as they apply: a record with no voice value has the
// default, and no language is null.
function effectivePreferences(m: MemberSettings): Record<string, unknown> {
  return {
    language: m.language ?? null,
    voiceInput: m.voiceInput ?? "browser",
    voiceOutput: m.voiceOutput ?? "browser",
    voiceName: m.voiceName ?? DEFAULT_VOICE_NAME,
  };
}

// Whether the room is on the member's list now. A hidden room is not shown.
function onList(
  m: MemberSettings,
  list: MemberViewList,
  roomId: string,
): boolean {
  switch (list) {
    case "shown":
      return m.accessible.includes(roomId) && !m.hidden.includes(roomId);
    case "tucked":
      return m.tucked.includes(roomId);
    case "notif":
      return m.notifRooms.includes(roomId);
    case "push":
      return m.pushRooms.includes(roomId);
  }
}

// Each key of `set` has its value in `now`.
const allSet = (set: object, now: Record<string, unknown>): boolean =>
  Object.entries(set).every(([key, value]) => now[key] === value);

export function createStepAsks(deps: StepAskDeps) {
  // Whether the step is done now, for the member the ask is for. A kind
  // from a later release is never done here.
  async function isDone(step: AskStep, memberUserId: string): Promise<boolean> {
    if (!isKnownKind(step.kind)) return false;
    switch (step.kind) {
      case "provider-sign-in":
        return deps.providerConnected(memberUserId, step.provider, step.scope);
      case "mcp-sign-in": {
        const scope = mcpScope(step);
        return !!scope && !!deps.mcpServer(scope, step.name)?.signedIn;
      }
      case "browser-pairing":
        return deps.browserPaired(memberUserId);
      case "github-link":
        return deps.roomLinked(step.roomId);
      case "agent-access": {
        const agent = deps.runs?.agent(step.agentId);
        return !!agent && sameAccessGrant(agent.grant, step);
      }
      case "member-room": {
        const member = deps.runs?.member(step.userId);
        if (!member) return false;
        // An owner reaches every room by rule.
        if (step.grant && member.role === "owner") return true;
        return member.allowedRooms.includes(step.roomId) === step.grant;
      }
      case "member-role":
        return deps.runs?.member(step.userId)?.role === step.role;
      case "member-pack": {
        const member = deps.runs?.memberSettings(step.userId);
        return !!member && samePack(member.pack, step.pack);
      }
      case "member-preferences": {
        const member = deps.runs?.memberSettings(memberUserId);
        return !!member && allSet(step.set, effectivePreferences(member));
      }
      case "member-view": {
        const member = deps.runs?.memberSettings(memberUserId);
        return !!member && onList(member, step.list, step.roomId) === step.on;
      }
      case "office-settings": {
        const now = deps.runs?.officeSettings();
        return !!now && allSet(step.set, now);
      }
      case "backup-settings": {
        const now = deps.runs?.backupSettings();
        return !!now && allSet(step.set, now);
      }
    }
  }

  const unknownMember = (): StepFailure => ({
    ok: false,
    status: 422,
    code: "unknown_member",
    message: "no member with this username",
  });
  const unknownRoom = (): StepFailure => ({
    ok: false,
    status: 422,
    code: "unknown_room",
    message: "no room with this id that you can reach",
  });

  const ownerHasAllRooms = (): StepFailure => ({
    ok: false,
    status: 422,
    code: "owner_has_all_rooms",
    message: "an office owner reaches every room",
  });
  const ownerHasNoPack = (): StepFailure => ({
    ok: false,
    status: 422,
    code: "owner_has_no_pack",
    message: "an office owner cannot have a permission pack",
  });

  // Why a member-view step cannot run on the member's lists now, or null.
  // The view core drops notifications and pushes for a hidden or tucked room
  // without an error, so the step is refused before it runs.
  function viewRefusal(
    m: MemberSettings,
    step: Extract<AskStep, { kind: "member-view" }>,
  ): StepFailure | null {
    if (!m.accessible.includes(step.roomId)) return unknownRoom();
    if (!step.on || (step.list !== "notif" && step.list !== "push"))
      return null;
    if (m.hidden.includes(step.roomId))
      return {
        ok: false,
        status: 409,
        code: "room_hidden",
        message: "the member hides this room: show it first",
      };
    if (m.tucked.includes(step.roomId))
      return {
        ok: false,
        status: 409,
        code: "room_tucked",
        message: "the member tucked this room away: untuck it first",
      };
    return null;
  }

  // The member's list with the room on or off.
  function viewList(
    m: MemberSettings,
    list: MemberViewList,
    roomId: string,
    on: boolean,
  ): string[] {
    const now =
      list === "shown"
        ? m.accessible.filter((id) => !m.hidden.includes(id))
        : list === "tucked"
          ? m.tucked
          : list === "notif"
            ? m.notifRooms
            : m.pushRooms;
    const rest = now.filter((id) => id !== roomId);
    return on ? [...rest, roomId] : rest;
  }

  // The route an action step runs now, or null for a step with a link. A
  // member step reads the member when it runs: their name for the path, their
  // rooms for the new room list. A removal on a room closed since the create
  // never gets here in practice: the close takes the room from the member and
  // reconcile closes the ask as done.
  // A step on the member's own record (their preferences, their room lists)
  // runs on the record of `memberUserId`, the member the ask is for.
  function routeOf(step: AskStep, memberUserId: string): StepRun | null {
    switch (step.kind) {
      case "agent-access":
        return {
          ok: true,
          route: {
            method: "PUT",
            path: `/api/agents/${encodeURIComponent(step.agentId)}/access`,
            body: {
              access: step.access,
              ...(step.pack ? { pack: step.pack } : {}),
            },
          },
        };
      case "member-room": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        // A member made an owner since the create reaches every room: a
        // removal would write a list that changes nothing they reach.
        if (member.role === "owner") return ownerHasAllRooms();
        if (step.grant && !deps.runs!.roomOpen(step.roomId))
          return unknownRoom();
        const rooms = member.allowedRooms.filter((id) => id !== step.roomId);
        return {
          ok: true,
          route: {
            method: "PUT",
            path: `/api/users/${encodeURIComponent(member.name)}/access`,
            body: {
              allowedRooms: step.grant ? [...rooms, step.roomId] : rooms,
            },
          },
        };
      }
      case "member-role": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        return {
          ok: true,
          route: {
            method: "PATCH",
            path: `/api/users/${encodeURIComponent(member.name)}`,
            body: { role: step.role },
          },
        };
      }
      case "member-pack": {
        const member = deps.runs?.member(step.userId);
        if (!member) return unknownMember();
        if (member.role === "owner") return ownerHasNoPack();
        return {
          ok: true,
          route: {
            method: "PUT",
            path: `/api/users/${encodeURIComponent(member.name)}/access`,
            // The rooms now, so a room given since the create stays; null
            // clears the pack (an absent one would keep it).
            body: { allowedRooms: [...member.allowedRooms], pack: step.pack },
          },
        };
      }
      case "office-settings": {
        const now = deps.runs?.officeSettings();
        if (!now) return invalid("this office runs no action steps");
        return {
          ok: true,
          route: {
            method: "PUT",
            path: "/api/office/settings",
            // The version now: an omitted setting keeps its value.
            body: { version: now.version, ...step.set },
          },
        };
      }
      case "backup-settings":
        return {
          ok: true,
          route: {
            method: "PUT",
            path: "/api/backup/settings",
            body: step.set,
          },
        };
      case "member-preferences":
        return {
          ok: true,
          route: {
            method: "PATCH",
            path: "/api/me/preferences",
            body: step.set,
          },
        };
      case "member-view": {
        const member = deps.runs?.memberSettings(memberUserId);
        if (!member) return unknownMember();
        const refused = viewRefusal(member, step);
        if (refused) return refused;
        const rooms = viewList(member, step.list, step.roomId, step.on);
        const [path, field] = {
          shown: ["shown", "shown"],
          tucked: ["tucked", "tucked"],
          notif: ["notif-rooms", "notifRooms"],
          push: ["push-rooms", "pushRooms"],
        }[step.list];
        return {
          ok: true,
          route: {
            method: "PUT",
            path: `/api/me/view/${path}`,
            body: { [field]: rooms },
          },
        };
      }
      default:
        return null;
    }
  }

  // The step as the agent sent it, completed, or why it is refused.
  function complete(input: {
    step: unknown;
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
    if (kind !== "browser-pairing" && kind !== "github-link")
      if (scope !== "personal" && scope !== "office")
        return invalid("step.scope is personal or office");
    const owner = deps.isOfficeOwner(memberUserId);
    switch (kind) {
      case "provider-sign-in": {
        const provider = body.provider;
        if (provider !== "claude" && provider !== "codex")
          return invalid("step.provider is claude or codex");
        if (scope === "personal") {
          // The agent runs on its manager's own sign-in.
          if (memberUserId !== managerUserId)
            return invalid(
              "a personal sign-in is the manager's own: ask your manager",
            );
        } else if (!owner)
          return notAllowed("only an office owner can sign in the office");
        return {
          ok: true,
          step: { kind, provider, scope: scope as "personal" | "office" },
        };
      }
      case "mcp-sign-in": {
        if (typeof body.name !== "string" || body.name === "")
          return invalid("step.name is an MCP server name");
        if (scope === "office") {
          if (!owner)
            return notAllowed(
              "only an office owner can sign in to an office MCP server",
            );
          return {
            ok: true,
            step: { kind, name: body.name, scope: "office" },
          };
        }
        if (!managerUserId)
          return {
            ok: false,
            status: 409,
            code: "no_manager",
            message:
              "this agent has no manager, so it has no personal MCP servers",
          };
        if (memberUserId !== managerUserId && !owner)
          return notAllowed(
            "only the manager or an office owner can sign in to the manager's MCP server",
          );
        return {
          ok: true,
          step: {
            kind,
            name: body.name,
            scope: "personal",
            ownerUserId: managerUserId,
          },
        };
      }
      case "browser-pairing":
        // The agent uses its manager's paired Chrome.
        if (memberUserId !== managerUserId)
          return invalid("the browser is the manager's: ask your manager");
        return { ok: true, step: { kind } };
      case "github-link":
        if (!owner)
          return notAllowed("only an office owner can link a room to GitHub");
        return { ok: true, step: { kind, roomId: input.roomId } };
      case "agent-access": {
        if (typeof body.agentId !== "string" || body.agentId === "")
          return invalid("step.agentId is an agent id");
        // The stored grant is the parsed one, so the done predicate
        // compares like with like.
        const grant = parseAgentAccessGrant({
          access: body.access,
          ...("pack" in body ? { pack: body.pack } : {}),
        });
        if (!grant)
          return invalid(
            "step.access is a stop (chat, office, folder, web, standard, privileged), with step.pack (token limits with areas) only at office, folder and web",
          );
        return {
          ok: true,
          step: {
            kind,
            agentId: body.agentId,
            access: grant.access,
            ...(grant.pack ? { pack: grant.pack } : {}),
          },
        };
      }
      case "member-pack": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        // The stored pack is the parsed one, so the done predicate compares
        // like with like.
        const pack = body.pack === null ? null : parseMemberPack(body.pack);
        if (!("pack" in body) || (pack === null && body.pack !== null))
          return invalid(
            "step.pack is {areas, agentCeiling}: known areas at read or write, and a ceiling of chat, office, folder or web; or null for no pack",
          );
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        return { ok: true, step: { kind, userId, pack } };
      }
      case "member-preferences":
      case "member-view": {
        // The member's own record: their agent acts for them already, and
        // another member's preferences and lists are private.
        if (!managerUserId || memberUserId !== managerUserId)
          return invalid(
            "a member's preferences and room lists are their own: ask your manager",
          );
        if (kind === "member-preferences") {
          if (!isObject(body.set))
            return invalid("step.set is an object of preferences");
          const parsed = parsePreferenceChange(body.set, PREFERENCE_KEYS);
          if (!parsed.ok) return invalid(`step.set: ${parsed.message}`);
          return { ok: true, step: { kind, set: parsed.change } };
        }
        if (typeof body.list !== "string" || !VIEW_LISTS.includes(body.list))
          return invalid(`step.list is one of ${VIEW_LISTS.join(", ")}`);
        if (typeof body.roomId !== "string" || body.roomId === "")
          return invalid("step.roomId is one room id");
        if (typeof body.on !== "boolean")
          return invalid("step.on is true (on the list) or false (off it)");
        return {
          ok: true,
          step: {
            kind,
            list: body.list as MemberViewList,
            roomId: body.roomId,
            on: body.on,
          },
        };
      }
      case "office-settings":
      case "backup-settings": {
        const keys =
          kind === "office-settings" ? OFFICE_SET_KEYS : BACKUP_SET_KEYS;
        const set = body.set;
        if (!isObject(set) || Object.keys(set).length === 0)
          return invalid(
            `step.set is an object of one or more of ${keys.join(", ")}`,
          );
        const unknown = Object.keys(set).filter((key) => !keys.includes(key));
        if (unknown.length > 0)
          return invalid(`step.set takes only ${keys.join(", ")}`);
        if (kind === "backup-settings") {
          const bad = backupSettingsShapeError(set);
          if (bad) return invalid(`step.set: ${bad}`);
          return { ok: true, step: { kind, set } };
        }
        if ("name" in set && set.name !== null && typeof set.name !== "string")
          return invalid("step.set: name is a string, or null for none");
        const bad = officeSettingsFieldError(set);
        if (bad) return invalid(`step.set: ${bad}`);
        if (!deps.runs) return invalid("this office runs no action steps");
        // The name as the save stores it: trimmed, and none when empty.
        if (typeof set.name === "string") {
          const name = set.name.trim();
          if (name.length > OFFICE_NAME_MAX)
            return invalid(
              `step.set: the office name is ${OFFICE_NAME_MAX} characters or fewer`,
            );
          return {
            ok: true,
            step: { kind, set: { ...set, name: name || null } },
          };
        }
        return { ok: true, step: { kind, set } };
      }
      case "member-room":
      case "member-role": {
        if (typeof body.username !== "string" || body.username === "")
          return invalid("step.username is a member's username");
        if (kind === "member-room") {
          if (typeof body.roomId !== "string" || body.roomId === "")
            return invalid("step.roomId is one room id");
          if (typeof body.grant !== "boolean")
            return invalid(
              "step.grant is true (give the room) or false (take it)",
            );
        } else if (body.role !== "owner" && body.role !== "member")
          return invalid("step.role is owner or member");
        if (!deps.runs) return invalid("this office runs no action steps");
        const userId = deps.runs.memberIdByName(body.username);
        if (!userId) return unknownMember();
        return {
          ok: true,
          step:
            kind === "member-room"
              ? {
                  kind,
                  userId,
                  roomId: body.roomId as string,
                  grant: body.grant as boolean,
                }
              : { kind, userId, role: body.role as "owner" | "member" },
        };
      }
    }
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
    if (!removed || !removed.memberUserId) return;
    deps.settled(
      entry.agentId,
      entry.id,
      doneLine(entry.step, targetName(entry.step)),
      removed.memberUserId,
    );
  }

  // The name of the agent or member an action step changes, else "".
  function targetName(step: AskStep): string {
    switch (step.kind) {
      case "agent-access":
        return deps.runs?.agent(step.agentId)?.name ?? step.agentId;
      case "member-room":
      case "member-role":
      case "member-pack":
        return deps.runs?.member(step.userId)?.name ?? step.userId;
      case "member-view":
        return deps.runs?.roomName(step.roomId) ?? step.roomId;
      default:
        return "";
    }
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
    switch (step.kind) {
      case "agent-access": {
        if (
          !askingAgentId ||
          !runs.agent(step.agentId) ||
          !runs.agentReaches(askingAgentId, step.agentId)
        )
          return {
            ok: false,
            status: 422,
            code: "unknown_agent",
            message: "no agent with this id in a room you can reach",
          };
        if (runs.authorizeAs(memberUserId, runRoute(step, memberUserId)))
          return notAllowed("this member cannot change that agent's access");
        const refusal = runs.accessRefusal(step.agentId, step);
        return refusal
          ? {
              ok: false,
              status: 422,
              code: refusal.code,
              message: refusal.message,
            }
          : null;
      }
      case "member-room": {
        if (
          !askingAgentId ||
          !runs.roomOpen(step.roomId) ||
          !runs.agentReachesRoom(askingAgentId, step.roomId)
        )
          return unknownRoom();
        if (step.roomId === LOBBY_ROOM_ID)
          return {
            ok: false,
            status: 422,
            code: "lobby_open_to_all",
            message: "every member reaches the lobby",
          };
        if (runs.member(step.userId)?.role === "owner")
          return ownerHasAllRooms();
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot change a member's room access")
          : null;
      }
      case "member-role": {
        // The page lets a member edit their own record, and its handler
        // refuses the role: only an owner changes one.
        if (
          !deps.isOfficeOwner(memberUserId) ||
          runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
        )
          return notAllowed("only an office owner can change a member's role");
        return step.role === "member" && runs.lastOwner(step.userId)
          ? {
              ok: false,
              status: 409,
              code: "last_owner",
              message: "the office must have at least one office owner",
            }
          : null;
      }
      case "member-pack": {
        if (runs.member(step.userId)?.role === "owner") return ownerHasNoPack();
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot change a member's permission pack")
          : null;
      }
      case "member-preferences":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot change their preferences")
          : null;
      case "member-view": {
        if (
          !askingAgentId ||
          !runs.roomOpen(step.roomId) ||
          !runs.agentReachesRoom(askingAgentId, step.roomId)
        )
          return unknownRoom();
        const member = runs.memberSettings(memberUserId);
        if (!member) return unknownMember();
        const refused = viewRefusal(member, step);
        if (refused) return refused;
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("this member cannot change their room lists")
          : null;
      }
      case "office-settings":
        return runs.authorizeAs(memberUserId, runRoute(step, memberUserId))
          ? notAllowed("only an office owner can change the office settings")
          : null;
      case "backup-settings": {
        if (runs.authorizeAs(memberUserId, runRoute(step, memberUserId)))
          return notAllowed(
            "only an office owner can change the backup settings",
          );
        const dir = step.set.dir;
        return dir !== undefined &&
          dir !== runs.backupSettings().dir &&
          runs.backupDirFromEnv()
          ? {
              ok: false,
              status: 409,
              code: "backup_dir_from_env",
              message: "ISOMUX_BACKUP_DIR sets the backup folder",
            }
          : null;
      }
    }
  }

  // The route of an action step whose target the create found.
  function runRoute(step: ActionStepRequest, memberUserId: string): StepRoute {
    const run = routeOf(step, memberUserId);
    if (!run?.ok) throw new Error(`step ${step.kind}: no route`);
    return run.route;
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
      if (step.kind === "mcp-sign-in") {
        const scope = mcpScope(step);
        const server = scope ? deps.mcpServer(scope, step.name) : null;
        if (!server)
          return {
            ok: false,
            status: 422,
            code: "unknown_mcp_server",
            message: "no MCP server of this name in that scope",
          };
        if (!server.oauth)
          return {
            ok: false,
            status: 409,
            code: "not_oauth",
            message: "this MCP server does not sign in with OAuth",
          };
      }
      if (isActionStep(step)) {
        const refused = actionRefusal(step, input.agentId, input.memberUserId);
        if (refused) return refused;
      }
      if (await isDone(step, input.memberUserId))
        return {
          ok: false,
          status: 409,
          code: "step_done",
          message: "this step is done",
        };
      return { ok: true, step, link: stepLink(step) };
    },

    // The route the member runs for a step now, or why it cannot run; null
    // for a step with a link.
    routeOf,

    // Whether the step of an open ask is done now.
    isStepDone(entry: StepEntry): Promise<boolean> {
      return entry.memberUserId
        ? isDone(entry.step, entry.memberUserId)
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
            if (await isDone(entry.step, entry.memberUserId)) close(entry);
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
