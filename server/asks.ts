// Asks: a prompt from an agent to one member, for what the agent needs
// from them to get unblocked (internal-docs/asks-design.md). The store
// holds open entries only, in ~/.isomux/asks.json; a reply, a dismiss or
// the agent's delete removes the entry, and the store records the closed ask
// in office.sqlite (server/ask-history.ts), with each create and edit before
// it.
//
// Load posture (the pager store's):
//   - no file                 → no asks (a new or older install)
//   - unparsable / bad shape  → the file is moved aside and the store starts
//                               empty; if it cannot be moved aside, the store
//                               refuses every operation
//   - unreadable (EACCES...)  → the store refuses every operation
//
// Every mutation writes the file first and changes memory after, so a failed
// write leaves both as they were.
//
// LEAF: imports only shared types, the atomic writer and the history's type.

import { readFileSync, renameSync } from "fs";
import { isAbsolute } from "path";
import { atomicWriteFileSync } from "./persistence.ts";
import { askSubject } from "../ui/members-chat/one-line-text.ts";
import { errMessage } from "../shared/errors.ts";
import {
  tokenRooms,
  withinTokenRooms,
  type Identity,
} from "./identity/index.ts";
import type { AskHistory } from "./ask-history.ts";
import {
  ASK_EDITABLE_KEYS,
  generateAskId,
  generatePagerId,
  isValidPriority,
  type AskCloseInput,
  type AskCommandRun,
  type AskEditableKey,
  type AskEntry,
  type AskEvent,
  type AskMemberWire,
  type AskRef,
  type AskReadFile,
  type FilePayload,
  type SecretAskRequest,
  type SudoAskRequest,
  type AskOfficeSource,
  type AskPage,
  type AskPageWire,
  type AskStep,
  type PagerDelivery,
  type TaskPriority,
} from "../shared/types.ts";
import type { AskAgentWire } from "../shared/contract-shapes.ts";

// Sanity bounds only.
export const ASK_PROMPT_MAX = 4000;
export const ASK_MAX_OPEN_PER_AGENT = 500;
// Open paged asks one source (an agent, or an app) may hold, apart from
// ASK_MAX_OPEN_PER_AGENT (task 74e8fc07).
export const ASK_PAGES_MAX_OPEN_PER_SOURCE = 50;
export const ASK_OPTIONS_MIN = 1;
export const ASK_OPTIONS_MAX = 10;
export const ASK_OPTION_MAX_CHARS = 80;
// Commands, editor files and read files together.
export const ASK_AFFORDANCES_MAX = 10;

export type AskLoadResult =
  | { kind: "missing" }
  | { kind: "data"; value: unknown }
  | { kind: "corrupt" }
  | { kind: "unreadable" };

export interface AskPersistence {
  load(): AskLoadResult;
  // Durable write. MUST THROW on failure.
  save(entries: AskEntry[]): void;
  // Move a corrupt file aside. False when it could not be moved.
  quarantine(): boolean;
}

export function createAskFilePersistence(path: string): AskPersistence {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT")
          return { kind: "missing" };
        console.error(`[asks] cannot read ${path}: ${errMessage(err)}`);
        return { kind: "unreadable" };
      }
      try {
        return { kind: "data", value: JSON.parse(text) };
      } catch {
        return { kind: "corrupt" };
      }
    },
    save(entries) {
      atomicWriteFileSync(path, JSON.stringify(entries, null, 2));
    },
    quarantine() {
      const aside = `${path}.corrupt-${Date.now()}`;
      try {
        renameSync(path, aside);
        console.error(`[asks] ${path} is corrupt; moved it to ${aside}`);
        return true;
      } catch (err) {
        console.error(
          `[asks] ${path} is corrupt and could not be moved aside: ${errMessage(err)}`,
        );
        return false;
      }
    },
  };
}

export class AsksUnavailableError extends Error {
  constructor() {
    super("The asks store is unavailable.");
  }
}

function isSudoAskRequest(v: unknown): v is SudoAskRequest {
  return (
    isObject(v) &&
    typeof v.requestId === "string" &&
    v.requestId !== "" &&
    typeof v.command === "string" &&
    v.command !== "" &&
    typeof v.cwd === "string"
  );
}

function isSecretAskRequest(v: unknown): v is SecretAskRequest {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const form = r.form as Record<string, unknown> | null;
  return (
    typeof r.requestId === "string" &&
    r.requestId.length > 0 &&
    (r.scope === "personal" || r.scope === "office") &&
    typeof r.name === "string" &&
    Array.isArray(r.hosts) &&
    r.hosts.every((h) => typeof h === "string") &&
    typeof form === "object" &&
    form !== null &&
    typeof form.kind === "string" &&
    typeof r.reason === "string" &&
    (r.app === undefined ||
      (isObject(r.app) &&
        typeof r.app.name === "string" &&
        typeof r.app.createdAt === "number")) &&
    (r.ownerUserId === undefined || typeof r.ownerUserId === "string") &&
    (r.answerUserId === undefined || typeof r.answerUserId === "string") &&
    // Any non-empty string, as an ask's link: checked on write only.
    (r.link === undefined || (typeof r.link === "string" && r.link !== "")) &&
    // A Discord bot request's application (task f242899f): any string,
    // checked on write only.
    (r.applicationId === undefined || typeof r.applicationId === "string") &&
    // The kind (task c71cb60f; discord-bot, task c92d60f4): absent for a
    // secret. Only a secret names an app; only an MCP server request
    // proposes a URL and a sign-in. Any other
    // non-empty kind loads, as a link does: a kind from a later release
    // cannot fail the file after a rollback (the request cannot be saved
    // here, only declined).
    (r.kind === undefined
      ? r.url === undefined && r.secret === undefined
      : r.kind === "variable" || r.kind === "discord-bot"
        ? r.app === undefined && r.url === undefined && r.secret === undefined
        : r.kind === "mcp-server"
          ? r.app === undefined &&
            (r.url === undefined || typeof r.url === "string") &&
            (r.secret === undefined || typeof r.secret === "string") &&
            (r.oauth === undefined || r.oauth === true)
          : typeof r.kind === "string" && r.kind !== "")
  );
}

// A non-empty list whose every element passes `item`.
function isListOf<T>(v: unknown, item: (x: unknown) => boolean): v is T[] {
  return Array.isArray(v) && v.length > 0 && v.every(item);
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const isFilePayload = (v: unknown) =>
  isObject(v) && typeof v.cwd === "string" && typeof v.path === "string";
const isAttachment = (v: unknown) =>
  isObject(v) &&
  typeof v.filename === "string" &&
  v.filename !== "" &&
  typeof v.originalName === "string" &&
  typeof v.mediaType === "string" &&
  typeof v.size === "number";
// A copy, or a reference: the route serves whatever `path` names, so only an
// absolute path loads.
const RUN_STATES: readonly string[] = ["running", "done", "lost"];
const isAskCommandRun = (v: unknown) =>
  isObject(v) &&
  typeof v.command === "string" &&
  typeof v.by === "string" &&
  typeof v.startedAt === "number" &&
  typeof v.state === "string" &&
  RUN_STATES.includes(v.state) &&
  (v.exitCode === undefined ||
    v.exitCode === null ||
    typeof v.exitCode === "number") &&
  (v.signal === undefined ||
    v.signal === null ||
    typeof v.signal === "string") &&
  (v.timedOut === undefined || v.timedOut === true) &&
  (v.durationMs === undefined || typeof v.durationMs === "number") &&
  (v.output === undefined || typeof v.output === "string");

const isAskReadFile = (v: unknown) =>
  isAttachment(v) &&
  isObject(v) &&
  (v.path === undefined || (typeof v.path === "string" && isAbsolute(v.path)));

// Four shapes: a plain ask, a personal secret request and a sudo request are
// for one member; an office secret request is for every office owner and
// names no member. A secret or sudo request has no link and no options.
const PAGE_DELIVERY_STATES: readonly string[] = [
  "not_delivered",
  "delivered",
  "failed",
];
// One recipient's send record: the pager's PagerDelivery shape.
const isPageDelivery = (v: unknown) =>
  isObject(v) &&
  typeof v.state === "string" &&
  PAGE_DELIVERY_STATES.includes(v.state) &&
  typeof v.sends === "number" &&
  (v.lastAttemptAt === undefined || typeof v.lastAttemptAt === "number") &&
  (v.lastFailure === undefined || typeof v.lastFailure === "string") &&
  (v.resolvedNotice === undefined ||
    v.resolvedNotice === "pending" ||
    v.resolvedNotice === "done");
// Who acked and when, only on an acked page.
function isAskPage(v: unknown): boolean {
  if (!isObject(v) || !isObject(v.delivery)) return false;
  if (v.key !== undefined && typeof v.key !== "string") return false;
  if (
    v.pageId !== undefined &&
    (typeof v.pageId !== "string" || v.pageId.length === 0)
  )
    return false;
  if (v.raiseCount !== undefined && typeof v.raiseCount !== "number")
    return false;
  if (v.lastRaisedAt !== undefined && typeof v.lastRaisedAt !== "number")
    return false;
  if (!Object.values(v.delivery).every(isPageDelivery)) return false;
  if (v.state === "ringing")
    return v.ackedByUserId === undefined && v.ackedAt === undefined;
  return (
    v.state === "acked" &&
    typeof v.ackedByUserId === "string" &&
    typeof v.ackedAt === "number"
  );
}

function isAskEntry(v: unknown): v is AskEntry {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (
    !(
      typeof r.id === "string" &&
      r.id.length > 0 &&
      typeof r.agentId === "string" &&
      typeof r.prompt === "string" &&
      typeof r.createdAt === "number" &&
      typeof r.updatedAt === "number"
    )
  )
    return false;
  const hasMember =
    typeof r.memberUserId === "string" && r.memberUserId.length > 0;
  if (
    r.office !== undefined &&
    !(
      isObject(r.office) &&
      typeof r.office.feature === "string" &&
      r.office.feature !== "" &&
      typeof r.office.name === "string"
    )
  )
    return false;
  // An ask with no agent (task 74e8fc07): a page from the office or an app,
  // for one member, with nothing that needs an agent to read an answer. An
  // agent's ask never has the office source.
  if (r.agentId === "") {
    if (
      !hasMember ||
      r.page === undefined ||
      (r.office === undefined) === (r.app === undefined) ||
      r.room !== undefined ||
      r.otherMemberUserIds !== undefined ||
      r.options !== undefined ||
      r.recommended !== undefined ||
      r.link !== undefined ||
      r.commands !== undefined ||
      r.editFiles !== undefined ||
      r.readFiles !== undefined ||
      r.step !== undefined ||
      r.secret !== undefined ||
      r.sudo !== undefined ||
      r.messaging !== undefined
    )
      return false;
  } else if (r.office !== undefined) return false;
  // A shared ask (task 9461c464): named members or the room, never both, on
  // a plain ask only, and always with memberUserId for an older server.
  if (r.otherMemberUserIds !== undefined || r.room !== undefined) {
    if (
      !hasMember ||
      (r.otherMemberUserIds !== undefined && r.room !== undefined) ||
      (r.room !== undefined && r.room !== true) ||
      (r.otherMemberUserIds !== undefined &&
        !isListOf(
          r.otherMemberUserIds,
          (u) => typeof u === "string" && u !== "",
        )) ||
      r.secret !== undefined ||
      r.sudo !== undefined ||
      r.step !== undefined ||
      r.messaging !== undefined
    )
      return false;
  }
  // Any non-empty string: the handlers check a link against the office pages on write,
  // and the card draws only one it knows, so a page a later release drops
  // cannot fail the file.
  if (r.link !== undefined && (typeof r.link !== "string" || r.link === ""))
    return false;
  if (r.sessionId !== undefined && typeof r.sessionId !== "string")
    return false;
  if (
    r.app !== undefined &&
    !(
      isObject(r.app) &&
      typeof r.app.name === "string" &&
      r.app.name !== "" &&
      typeof r.app.createdAt === "number"
    )
  )
    return false;
  // A step (task c71cb60f): any non-empty kind, as for a link, so a step a
  // later release adds cannot fail the file; this release never closes it.
  if (
    r.step !== undefined &&
    !(isObject(r.step) && typeof r.step.kind === "string" && r.step.kind !== "")
  )
    return false;
  // The bounds are checked on write only, as for a link.
  if (
    r.options !== undefined &&
    !(
      Array.isArray(r.options) &&
      r.options.length > 0 &&
      r.options.every((o) => typeof o === "string" && o !== "")
    )
  )
    return false;
  // A mark needs options; that it names one of them is a write check only.
  if (
    r.recommended !== undefined &&
    !(
      typeof r.recommended === "string" &&
      r.recommended !== "" &&
      r.options !== undefined
    )
  )
    return false;
  if (r.priority !== undefined && !isValidPriority(r.priority)) return false;
  // Chat affordances: the shape only, as for options.
  if (
    (r.commands !== undefined &&
      !isListOf(r.commands, (c) => typeof c === "string" && c !== "")) ||
    (r.editFiles !== undefined && !isListOf(r.editFiles, isFilePayload)) ||
    (r.readFiles !== undefined && !isListOf(r.readFiles, isAskReadFile))
  )
    return false;
  if (r.runs !== undefined && !isListOf(r.runs, isAskCommandRun)) return false;
  if (
    (r.simplifyRequestedAt !== undefined &&
      typeof r.simplifyRequestedAt !== "number") ||
    (r.originalPrompt !== undefined && typeof r.originalPrompt !== "string")
  )
    return false;
  // A reply draft to a messaging contact (task d03a61d8): on a plain ask
  // only. Any app id loads, as an unknown link does: a file that a later
  // release wrote with another app must not move the asks file aside on a
  // downgrade. Sending serves only the apps this release knows.
  if (
    r.messaging !== undefined &&
    !(
      isObject(r.messaging) &&
      typeof r.messaging.app === "string" &&
      r.messaging.app !== "" &&
      typeof r.messaging.routeId === "string" &&
      r.messaging.routeId !== "" &&
      typeof r.messaging.text === "string"
    )
  )
    return false;
  // A paged ask (task 74e8fc07): never a secret or sudo request or a reply
  // draft.
  if (
    r.page !== undefined &&
    !(
      isAskPage(r.page) &&
      r.secret === undefined &&
      r.sudo === undefined &&
      r.messaging === undefined
    )
  )
    return false;
  // A sudo request (task 43a28eed) is for one office owner and has only its
  // prompt (the reason) and its request.
  if (r.sudo !== undefined)
    return (
      hasMember &&
      r.secret === undefined &&
      r.link === undefined &&
      r.options === undefined &&
      r.priority === undefined &&
      r.commands === undefined &&
      r.editFiles === undefined &&
      r.readFiles === undefined &&
      r.step === undefined &&
      r.app === undefined &&
      r.messaging === undefined &&
      isSudoAskRequest(r.sudo)
    );
  if (r.secret === undefined) return hasMember;
  if (r.messaging !== undefined) return false;
  if (
    r.link !== undefined ||
    r.options !== undefined ||
    r.commands !== undefined ||
    r.editFiles !== undefined ||
    r.readFiles !== undefined
  )
    return false;
  if (!isSecretAskRequest(r.secret)) return false;
  return r.secret.scope === "office" ? r.memberUserId === undefined : hasMember;
}

export interface AskAudienceDeps {
  isOfficeOwner: (userId: string) => boolean;
  // The agent's room, or null when the agent is gone.
  agentRoomId: (agentId: string) => string | null;
  canSeeRoom: (userId: string, roomId: string) => boolean;
  // Whether the member hides the room from their view (room view level
  // "hidden"). Only a room ask reads it.
  roomHidden: (userId: string, roomId: string) => boolean;
  // Every member who reaches the room, hidden or not.
  roomMemberIds: (roomId: string) => string[];
}

// The audience as one caller reaches it: a room-limited API token sees only
// its rooms and has no office-owner reach. Every other caller gets `base`.
export function askAudienceFor(
  base: AskAudienceDeps,
  identity: Identity,
): AskAudienceDeps {
  if (tokenRooms(identity) === null) return base;
  return {
    isOfficeOwner: () => false,
    agentRoomId: base.agentRoomId,
    canSeeRoom: (userId, roomId) =>
      withinTokenRooms(identity, roomId) && base.canSeeRoom(userId, roomId),
    roomHidden: base.roomHidden,
    roomMemberIds: (roomId) =>
      withinTokenRooms(identity, roomId) ? base.roomMemberIds(roomId) : [],
  };
}

// The members a plain ask is for now (task 9461c464): for a room ask,
// every member who reaches the agent's room and does not hide it; else the
// named members, memberUserId first. Every read of a plain ask's audience
// goes through here.
export function askMemberIds(entry: AskEntry, deps: AskAudienceDeps): string[] {
  if (entry.room) {
    const roomId = deps.agentRoomId(entry.agentId);
    return roomId === null ? [] : askRoomAudience(roomId, deps);
  }
  if (entry.memberUserId === undefined) return [];
  return [entry.memberUserId, ...(entry.otherMemberUserIds ?? [])];
}

// Everyone a room ask in this room is for now: who reaches the room and does
// not hide it.
export function askRoomAudience(
  roomId: string,
  deps: AskAudienceDeps,
): string[] {
  return deps
    .roomMemberIds(roomId)
    .filter(
      (userId) =>
        deps.canSeeRoom(userId, roomId) && !deps.roomHidden(userId, roomId),
    );
}

// Most members one ask names (task 9461c464). A sanity bound.
export const ASK_MEMBERS_MAX = 20;

// Whether a member sees an ask and may answer it, decided live: the member
// it names, or for an office secret request any office owner (or the one
// owner the request names), and in both
// cases only while the member can reach the agent's room. Every list and push
// of the member's own asks, and every answer check, goes through here; an
// office owner's view of other members' asks is askShownToOwnerAsOther.
export function askVisibleTo(
  entry: AskEntry,
  userId: string | null,
  deps: AskAudienceDeps,
): boolean {
  if (!userId) return false;
  // An ask with no agent has no room: its member only.
  if (askAgentId(entry) === null) return userId === entry.memberUserId;
  const roomId = deps.agentRoomId(entry.agentId);
  if (roomId === null || !deps.canSeeRoom(userId, roomId)) return false;
  // The answerer must still be allowed to write the secrets the value goes
  // to (task 315a62c0): their own, or any as an office owner.
  if (entry.secret?.scope === "office")
    return (
      deps.isOfficeOwner(userId) &&
      (entry.secret.answerUserId === undefined ||
        entry.secret.answerUserId === userId)
    );
  if (entry.room) return !deps.roomHidden(userId, roomId);
  if (!askMemberIds(entry, deps).includes(userId)) return false;
  const owner = entry.secret?.ownerUserId;
  return owner === undefined || owner === userId || deps.isOfficeOwner(userId);
}

// Whether an office owner sees and may answer an ask as another member's: an
// ask askVisibleTo does not admit for them, not a secret or sudo request, whose agent is
// in a room they can reach.
export function askShownToOwnerAsOther(
  entry: AskEntry,
  userId: string | null,
  deps: AskAudienceDeps,
): boolean {
  // A room ask is for every member who shows the room: an owner who hides it
  // does not get it back here.
  if (
    !userId ||
    !deps.isOfficeOwner(userId) ||
    entry.secret ||
    entry.sudo ||
    entry.room
  )
    return false;
  if (askVisibleTo(entry, userId, deps)) return false;
  // An app's page with no agent shows to every owner, as an app page with no
  // room did; the office's page about a member's feature to nobody else.
  if (askAgentId(entry) === null) return entry.app !== undefined;
  const roomId = deps.agentRoomId(entry.agentId);
  return roomId !== null && deps.canSeeRoom(userId, roomId);
}

// The prompt as the agent sent it, or the reason it is refused. `field` is
// the body field it came from, for the message.
function checkPrompt(
  text: unknown,
  field: "text" | "prompt" = "text",
): { ok: true; prompt: string } | { ok: false; message: string } {
  if (typeof text !== "string")
    return { ok: false, message: `${field} is required` };
  if (text.trim().length === 0)
    return { ok: false, message: `${field} must not be empty` };
  if (text.length > ASK_PROMPT_MAX)
    return {
      ok: false,
      message: `${field} must be at most ${ASK_PROMPT_MAX} characters`,
    };
  return { ok: true, prompt: text };
}

// The prompt of a JSON or plain-text body: `text`, or its alias `prompt`.
// Both sent is refused, whatever the values.
export function checkPromptField(
  body: Record<string, unknown>,
): { ok: true; prompt: string } | { ok: false; message: string } {
  if (body.text !== undefined && body.prompt !== undefined)
    return { ok: false, message: "send text or prompt, not both" };
  return body.prompt !== undefined
    ? checkPrompt(body.prompt, "prompt")
    : checkPrompt(body.text);
}

// The options as they are stored (each trimmed), or the reason they are
// refused.
export function checkOptions(
  value: unknown,
): { ok: true; options: string[] } | { ok: false; message: string } {
  if (!Array.isArray(value) || !value.every((o) => typeof o === "string"))
    return { ok: false, message: "options must be a list of strings" };
  const options = value.map((o: string) => o.trim());
  if (options.length < ASK_OPTIONS_MIN || options.length > ASK_OPTIONS_MAX)
    return {
      ok: false,
      message: `give ${ASK_OPTIONS_MIN} to ${ASK_OPTIONS_MAX} options`,
    };
  if (options.some((o) => o === ""))
    return { ok: false, message: "an option must not be empty" };
  if (options.some((o) => o.length > ASK_OPTION_MAX_CHARS))
    return {
      ok: false,
      message: `an option must be at most ${ASK_OPTION_MAX_CHARS} characters`,
    };
  if (new Set(options).size !== options.length)
    return { ok: false, message: "options must not repeat" };
  return { ok: true, options };
}

// The recommended option as it is stored (trimmed like an option), or the
// reason it is refused: it must be one of the ask's options.
export function checkRecommended(
  value: unknown,
  options: string[] | undefined,
): { ok: true; recommended: string } | { ok: false; message: string } {
  const recommended = typeof value === "string" ? value.trim() : null;
  if (recommended === null || !options?.includes(recommended))
    return { ok: false, message: "recommended must be one of the options" };
  return { ok: true, recommended };
}

// An ask's chat affordances as they are stored. On an edit, an absent list
// keeps the ask's list and null removes it.
export interface AskAffordances {
  commands?: string[];
  editFiles?: FilePayload[];
  readFiles?: AskReadFile[];
}
export type AskAffordanceEdit = {
  [K in keyof AskAffordances]?: AskAffordances[K] | null;
};
export const ASK_AFFORDANCE_KEYS = [
  "commands",
  "editFiles",
  "readFiles",
] as const satisfies readonly (keyof AskAffordances)[];

export type AskChange =
  | { kind: "upserted"; entry: AskEntry }
  // byUserId: the member whose answer closed it, when one did.
  | { kind: "removed"; entry: AskEntry; byUserId?: string };

export interface AskStoreDeps {
  persistence: AskPersistence;
  now?: () => number;
  // After a committed change. A throw is logged and swallowed.
  onChange?(change: AskChange): void;
  // Where each removed entry is recorded, with how it closed, after the
  // removal is committed (server/ask-history.ts), and each create and edit
  // as an event, after it is committed. A throw is logged and swallowed: the
  // change stands either way. Absent in leaf tests.
  history?: AskHistory;
  // The members an entry is for at its close, for the history.
  audienceIds?: (entry: AskEntry) => string[];
  // A paged ask was created, acked or closed (a remove or removeAgent), after
  // the commit, for the pager delivery engines. A throw is logged and
  // swallowed.
  onPage?(entry: AskEntry, event: "created" | "acked" | "closed"): void;
}

export interface AskStore {
  get(id: string): AskEntry | null;
  // Every open entry, for a scan across agents (secret requests).
  listAll(): AskEntry[];
  listForAgent(agentId: string): AskEntry[];
  // Throws on an entry that is none of the four shapes.
  create(input: {
    agentId: string;
    memberUserId?: string;
    otherMemberUserIds?: string[];
    room?: true;
    prompt: string;
    secret?: SecretAskRequest;
    sudo?: SudoAskRequest;
    link?: string;
    options?: string[];
    recommended?: string;
    priority?: TaskPriority;
    affordances?: AskAffordances;
    sessionId?: string;
    step?: AskStep;
    app?: { name: string; createdAt: number };
    // A reply draft to a messaging contact (task d03a61d8).
    messaging?: { app: string; routeId: string; text: string };
    // A paged ask (task 74e8fc07): it rings for these members. `key` is the
    // source's dedupe key (openPaged).
    page?: { recipients: string[]; key?: string };
    // The office feature that opens an ask with no agent (agentId "").
    office?: AskOfficeSource;
    // For the pager migration only (server/pager-migration.ts), with page:
    // the old page's own id, times, raise count, send record and ack. The
    // caps do not apply.
    migrated?: {
      pageId: string;
      createdAt: number;
      raiseCount: number;
      lastRaisedAt: number;
      delivery: PagerDelivery;
      acked?: { byUserId: string; at: number };
    };
  }):
    | { ok: true; entry: AskEntry }
    | { ok: false; code: "too_many" | "too_many_pages" };
  // link, options, recommended, each affordance list and priority: undefined
  // keeps the ask's value, null removes it. Removing the options removes the
  // mark.
  edit(
    id: string,
    prompt: string,
    link?: string | null,
    options?: string[] | null,
    affordances?: AskAffordanceEdit,
    recommended?: string | null,
    priority?: TaskPriority | null,
    // Who edited, for the edit's event: an app by name; absent = the agent.
    actor?: { app: string },
  ): AskEntry | null;
  // Marks the open entry as waiting for a simpler rewrite and records the
  // member who asked; null when the entry is gone.
  requestSimplify(id: string, byUserId?: string): AskEntry | null;
  // Clears the simplify mark of the open entry and records the member who
  // withdrew it. Null, with nothing written, when the entry is gone or has no
  // mark (the agent's rewrite cleared it first).
  cancelSimplify(id: string, byUserId?: string): AskEntry | null;
  // Writes the run of `command` (task c3b91695), in place of the command's
  // earlier run; null removes it. Null, with nothing written, when the entry
  // is gone or no longer lists the command.
  setRun(
    id: string,
    command: string,
    run: AskCommandRun | null,
  ): AskEntry | null;
  // At boot: every run still "running" becomes "lost" (the server's restart
  // ended it). Returns each entry it changed, with the run.
  markLostRuns(): { entry: AskEntry; run: AskCommandRun }[];
  // The open paged ask of this source with this key, or null. With
  // `memberUserId`, only an ask for that member (the compat agent raise: its
  // manager now).
  openPaged(
    source: AskPageSource,
    key: string,
    memberUserId?: string,
  ): AskEntry | null;
  // The open paged ask with this page id, or null.
  findPaged(pageId: string): AskEntry | null;
  // A re-raise of an open paged ask: its prompt becomes `prompt`, its raise
  // count goes up by one and lastRaisedAt is now, and it is saved. When the
  // prompt changes, also one "edited" event naming the actor (absent = the
  // agent) and "changed"; else "unchanged", with no event. Never re-rings
  // it. Null when the entry is gone or not paged.
  reraise(
    id: string,
    prompt: string,
    actor?: { office: string } | { app: string },
  ): { outcome: "changed" | "unchanged"; entry: AskEntry } | null;
  // At boot, before any create: gives a page id to each open paged ask that
  // has none (one save), and writes the page index row of each open paged
  // ask that has none. A row write failure is logged.
  backfillPages(): void;
  // Acks a ringing paged ask: its alarm stops, the ask stays open.
  // "unchanged" when it was acked already; null when the entry is gone or not
  // paged.
  ack(
    id: string,
    byUserId: string,
  ): { outcome: "changed" | "unchanged"; entry: AskEntry } | null;
  // Replaces one recipient's send record of a paged ask. Null when the entry
  // is gone, not paged, or does not ring for that member.
  recordPageDelivery(
    id: string,
    userId: string,
    delivery: PagerDelivery,
  ): AskEntry | null;
  // Closes the entry and records how (`close`).
  remove(id: string, close: AskCloseInput): AskEntry | null;
  // Every entry of a removed agent, each recorded as agent_removed, except
  // an app's paged ask: it stays open with no agent. Returns how many went.
  removeAgent(agentId: string): number;
}

// Who opened a paged ask, for its dedupe key and its cap: an agent on its
// own, an app by registration, or an office feature for one member.
export type AskPageSource =
  | { kind: "agent"; agentId: string }
  | { kind: "app"; name: string; createdAt: number }
  | { kind: "office"; feature: string; memberUserId: string };

// The source of an ask, as a paged ask counts it: an app's asks by its
// registration, whatever its target agent; an agent's own asks without an
// app; an office feature's asks per member.
function askPageSource(
  entry: Pick<AskEntry, "agentId" | "app" | "office" | "memberUserId">,
): AskPageSource {
  if (entry.app)
    return {
      kind: "app",
      name: entry.app.name,
      createdAt: entry.app.createdAt,
    };
  if (entry.office)
    return {
      kind: "office",
      feature: entry.office.feature,
      memberUserId: entry.memberUserId ?? "",
    };
  return { kind: "agent", agentId: entry.agentId };
}

function samePageSource(a: AskPageSource, b: AskPageSource): boolean {
  switch (a.kind) {
    case "agent":
      return b.kind === "agent" && a.agentId === b.agentId;
    case "app":
      return (
        b.kind === "app" && a.name === b.name && a.createdAt === b.createdAt
      );
    case "office":
      return (
        b.kind === "office" &&
        a.feature === b.feature &&
        a.memberUserId === b.memberUserId
      );
  }
}

// The ask's agent, or null for an ask with no agent (agentId "").
export function askAgentId(entry: Pick<AskEntry, "agentId">): string | null {
  return entry.agentId === "" ? null : entry.agentId;
}

export function createAskStore(deps: AskStoreDeps): AskStore {
  const now = deps.now ?? Date.now;
  let entries: AskEntry[] = [];
  let available = true;

  const loaded = deps.persistence.load();
  if (loaded.kind === "unreadable") {
    available = false;
  } else if (loaded.kind === "corrupt") {
    available = deps.persistence.quarantine();
  } else if (loaded.kind === "data") {
    if (
      Array.isArray(loaded.value) &&
      loaded.value.every((v) => isAskEntry(v))
    ) {
      entries = loaded.value;
    } else {
      available = deps.persistence.quarantine();
    }
  }

  function check(): void {
    if (!available) throw new AsksUnavailableError();
  }

  // Records closed entries, after their removal is committed. A failure is
  // logged: the ask is closed, and a throw would make the caller retry a
  // close whose answer the agent already has.
  function recordClosed(closed: AskEntry[], close: AskCloseInput): void {
    if (!deps.history) return;
    const closure = { ...close, at: now() };
    for (const entry of closed) {
      try {
        deps.history.record(entry, closure, deps.audienceIds?.(entry));
      } catch (err) {
        console.error(
          `[asks] ${entry.id} closed but could not be recorded: ${errMessage(err)}`,
        );
      }
    }
  }

  // Records an event of an open entry, after its change is committed. A
  // failure is logged, as in recordClosed: the change stands.
  function recordEvent(entry: AskEntry, event: AskEvent): void {
    if (!deps.history) return;
    try {
      deps.history.recordEvent(entry.agentId, entry.id, event);
    } catch (err) {
      console.error(
        `[asks] ${entry.id} changed but its ${event.kind} event could not be recorded: ${errMessage(err)}`,
      );
    }
  }

  // An id no open entry has and the history does not hold, so an id names
  // one ask forever. A history that cannot answer is logged and passed over.
  function freshId(): string {
    const open = entries.map((e) => e.id);
    for (;;) {
      const id = generateAskId(open);
      try {
        if (!deps.history?.has(id)) return id;
      } catch (err) {
        console.error(
          `[asks] could not check ${id} against the history: ${errMessage(err)}`,
        );
        return id;
      }
    }
  }

  // A page id no open ask holds and the history's page index does not hold.
  // A history that cannot answer is logged and passed over, as in freshId.
  function freshPageId(held: AskEntry[] = entries): string {
    const open = held.flatMap((e) =>
      e.page?.pageId !== undefined ? [e.page.pageId] : [],
    );
    for (;;) {
      const id = generatePagerId(open);
      try {
        if (!deps.history || deps.history.pageAskId(id) === null) return id;
      } catch (err) {
        console.error(
          `[asks] could not check page id ${id} against the history: ${errMessage(err)}`,
        );
        return id;
      }
    }
  }

  // Writes the page index row of a paged ask, after its commit. A failure is
  // logged: the boot backfill writes it later.
  function recordPageRow(entry: AskEntry): void {
    const pageId = entry.page?.pageId;
    if (!deps.history || pageId === undefined) return;
    try {
      deps.history.recordPage(pageId, entry.id);
    } catch (err) {
      console.error(
        `[asks] ${entry.id} could not be indexed by its page id: ${errMessage(err)}`,
      );
    }
  }

  // Tells the delivery engines of a paged ask's create, ack or close, after
  // the commit. A throw is logged: the change stands.
  function tellPage(
    entry: AskEntry,
    event: "created" | "acked" | "closed",
  ): void {
    try {
      deps.onPage?.({ ...entry }, event);
    } catch (err) {
      console.error(`[asks] a page listener threw: ${errMessage(err)}`);
    }
  }

  function commit(next: AskEntry[], changes: AskChange[]): void {
    deps.persistence.save(next);
    entries = next;
    for (const change of changes) {
      try {
        deps.onChange?.({ ...change, entry: { ...change.entry } });
      } catch (err) {
        console.error(`[asks] a change listener threw: ${errMessage(err)}`);
      }
    }
  }

  return {
    get(id) {
      check();
      const entry = entries.find((e) => e.id === id);
      return entry ? { ...entry } : null;
    },
    listAll() {
      check();
      return entries.map((e) => ({ ...e }));
    },
    listForAgent(agentId) {
      check();
      return entries
        .filter((e) => e.agentId === agentId)
        .map((e) => ({ ...e }));
    },
    create({
      agentId,
      memberUserId,
      otherMemberUserIds,
      room,
      prompt,
      secret,
      sudo,
      link,
      options,
      recommended,
      priority,
      affordances,
      sessionId,
      step,
      app,
      messaging,
      page,
      office,
      migrated,
    }) {
      check();
      // An ask with no agent counts toward no agent's cap. A migrated page
      // counts toward none.
      const open = entries.filter(
        (e) => agentId !== "" && e.agentId === agentId,
      ).length;
      if (!migrated && open >= ASK_MAX_OPEN_PER_AGENT)
        return { ok: false, code: "too_many" };
      const source = askPageSource({ agentId, app, office, memberUserId });
      if (
        page &&
        !migrated &&
        entries.filter(
          (e) => e.page && samePageSource(askPageSource(e), source),
        ).length >= ASK_PAGES_MAX_OPEN_PER_SOURCE
      )
        return { ok: false, code: "too_many_pages" };
      const at = migrated?.createdAt ?? now();
      const entry: AskEntry = {
        id: freshId(),
        agentId,
        ...(memberUserId !== undefined ? { memberUserId } : {}),
        ...(otherMemberUserIds?.length ? { otherMemberUserIds } : {}),
        ...(room ? { room } : {}),
        prompt,
        createdAt: at,
        updatedAt: at,
        ...(secret ? { secret } : {}),
        ...(sudo ? { sudo } : {}),
        ...(link !== undefined ? { link } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(recommended !== undefined ? { recommended } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...affordances,
        ...(sessionId ? { sessionId } : {}),
        ...(step ? { step } : {}),
        ...(app ? { app } : {}),
        ...(messaging ? { messaging } : {}),
        ...(office ? { office } : {}),
        ...(page
          ? {
              page: {
                ...(migrated?.acked
                  ? {
                      state: "acked" as const,
                      ackedByUserId: migrated.acked.byUserId,
                      ackedAt: migrated.acked.at,
                    }
                  : { state: "ringing" as const }),
                pageId: migrated?.pageId ?? freshPageId(),
                ...(page.key !== undefined ? { key: page.key } : {}),
                ...(migrated
                  ? {
                      raiseCount: migrated.raiseCount,
                      lastRaisedAt: migrated.lastRaisedAt,
                    }
                  : {}),
                delivery: Object.fromEntries(
                  page.recipients.map((userId) => [
                    userId,
                    migrated
                      ? { ...migrated.delivery }
                      : { state: "not_delivered" as const, sends: 0 },
                  ]),
                ),
              },
            }
          : {}),
      };
      if (!isAskEntry(entry)) throw new Error("not a valid ask");
      commit([...entries, entry], [{ kind: "upserted", entry }]);
      recordPageRow(entry);
      // A migrated page keeps its send schedule: the delivery engines arm it
      // from its send record when they start.
      if (entry.page && !migrated) tellPage(entry, "created");
      const ask: Partial<Pick<AskEntry, AskEditableKey>> = {};
      for (const key of ASK_EDITABLE_KEYS)
        if (entry[key] !== undefined) Object.assign(ask, { [key]: entry[key] });
      recordEvent(entry, {
        kind: "created",
        at,
        ask: ask as Pick<AskEntry, AskEditableKey>,
      });
      return { ok: true, entry: { ...entry } };
    },
    edit(
      id,
      prompt,
      link,
      options,
      affordances = {},
      recommended,
      priority,
      actor,
    ) {
      check();
      const prev = entries.find((e) => e.id === id);
      if (!prev) return null;
      const entry: AskEntry = { ...prev, prompt, updatedAt: now() };
      // The rewrite a simplify request asked for: the card keeps the prompt
      // as it was before the first one.
      if (prev.simplifyRequestedAt !== undefined && prompt !== prev.prompt) {
        delete entry.simplifyRequestedAt;
        entry.originalPrompt ??= prev.prompt;
      }
      if (link === null) delete entry.link;
      else if (link !== undefined) entry.link = link;
      if (options === null) delete entry.options;
      else if (options !== undefined) entry.options = options;
      if (recommended === null || options === null) delete entry.recommended;
      else if (recommended !== undefined) entry.recommended = recommended;
      if (priority === null) delete entry.priority;
      else if (priority !== undefined) entry.priority = priority;
      const { commands, editFiles, readFiles } = affordances;
      if (commands === null) delete entry.commands;
      else if (commands !== undefined) entry.commands = commands;
      // A run goes with its command.
      if (entry.runs) {
        const runs = entry.runs.filter((r) =>
          entry.commands?.includes(r.command),
        );
        if (runs.length > 0) entry.runs = runs;
        else delete entry.runs;
      }
      if (editFiles === null) delete entry.editFiles;
      else if (editFiles !== undefined) entry.editFiles = editFiles;
      if (readFiles === null) delete entry.readFiles;
      else if (readFiles !== undefined) entry.readFiles = readFiles;
      if (!isAskEntry(entry)) throw new Error("not a valid ask");
      commit(
        entries.map((e) => (e.id === id ? entry : e)),
        [{ kind: "upserted", entry }],
      );
      // Each changed field as it was; an edit that changed none is no event.
      const before: Extract<AskEvent, { kind: "edited" }>["before"] = {};
      for (const key of ASK_EDITABLE_KEYS)
        if (JSON.stringify(prev[key]) !== JSON.stringify(entry[key]))
          Object.assign(before, { [key]: prev[key] ?? null });
      if (Object.keys(before).length > 0)
        recordEvent(entry, {
          kind: "edited",
          at: entry.updatedAt,
          ...(actor ? { app: actor.app } : {}),
          before,
        });
      return { ...entry };
    },
    requestSimplify(id, byUserId) {
      check();
      const prev = entries.find((e) => e.id === id);
      if (!prev) return null;
      const at = now();
      const entry: AskEntry = {
        ...prev,
        simplifyRequestedAt: at,
        updatedAt: at,
      };
      commit(
        entries.map((e) => (e.id === id ? entry : e)),
        [{ kind: "upserted", entry }],
      );
      recordEvent(entry, {
        kind: "simplify_requested",
        at,
        ...(byUserId !== undefined ? { byUserId } : {}),
      });
      return { ...entry };
    },
    cancelSimplify(id, byUserId) {
      check();
      const prev = entries.find((e) => e.id === id);
      if (!prev || prev.simplifyRequestedAt === undefined) return null;
      const at = now();
      const entry: AskEntry = { ...prev, updatedAt: at };
      delete entry.simplifyRequestedAt;
      commit(
        entries.map((e) => (e.id === id ? entry : e)),
        [{ kind: "upserted", entry }],
      );
      recordEvent(entry, {
        kind: "simplify_withdrawn",
        at,
        ...(byUserId !== undefined ? { byUserId } : {}),
      });
      return { ...entry };
    },
    setRun(id, command, run) {
      check();
      const prev = entries.find((e) => e.id === id);
      if (!prev?.commands?.includes(command)) return null;
      const runs = (prev.runs ?? []).filter((r) => r.command !== command);
      if (run) runs.push({ ...run, command });
      const entry: AskEntry = { ...prev };
      if (runs.length > 0) entry.runs = runs;
      else delete entry.runs;
      if (!isAskEntry(entry)) throw new Error("not a valid ask");
      commit(
        entries.map((e) => (e.id === id ? entry : e)),
        [{ kind: "upserted", entry }],
      );
      return { ...entry };
    },
    markLostRuns() {
      check();
      const marked: { entry: AskEntry; run: AskCommandRun }[] = [];
      const next = entries.map((prev) => {
        if (!prev.runs?.some((r) => r.state === "running")) return prev;
        const lost: AskCommandRun[] = [];
        const entry: AskEntry = {
          ...prev,
          runs: prev.runs.map((r) => {
            if (r.state !== "running") return r;
            const run = { ...r, state: "lost" as const };
            lost.push(run);
            return run;
          }),
        };
        for (const run of lost) marked.push({ entry, run });
        return entry;
      });
      if (marked.length === 0) return [];
      commit(
        next,
        [...new Set(marked.map((m) => m.entry))].map((entry) => ({
          kind: "upserted" as const,
          entry,
        })),
      );
      return marked.map(({ entry, run }) => ({
        entry: { ...entry },
        run: { ...run },
      }));
    },
    remove(id, close) {
      check();
      const prev = entries.find((e) => e.id === id);
      if (!prev) return null;
      commit(
        entries.filter((e) => e.id !== id),
        [
          {
            kind: "removed",
            entry: prev,
            ...(close.byUserId ? { byUserId: close.byUserId } : {}),
          },
        ],
      );
      recordClosed([prev], close);
      if (prev.page) tellPage(prev, "closed");
      return { ...prev };
    },

    // Neither an ack nor a send record is an edit: updatedAt stays.
    openPaged(source, key, memberUserId) {
      check();
      const entry = entries.find(
        (e) =>
          e.page?.key === key &&
          samePageSource(askPageSource(e), source) &&
          (memberUserId === undefined || e.memberUserId === memberUserId),
      );
      return entry ? { ...entry } : null;
    },

    findPaged(pageId) {
      check();
      const entry = entries.find((e) => e.page?.pageId === pageId);
      return entry ? { ...entry } : null;
    },

    backfillPages() {
      check();
      // A paged ask from a build before page ids (slice 1 or 2) gets one;
      // each id drawn is held before the next is drawn.
      if (entries.some((e) => e.page && e.page.pageId === undefined)) {
        const next = [...entries];
        next.forEach((e, i) => {
          if (e.page && e.page.pageId === undefined)
            next[i] = { ...e, page: { ...e.page, pageId: freshPageId(next) } };
        });
        deps.persistence.save(next);
        entries = next;
      }
      if (!deps.history) return;
      for (const e of entries) {
        const pageId = e.page?.pageId;
        if (pageId === undefined) continue;
        try {
          if (deps.history.pageAskId(pageId) === null) recordPageRow(e);
        } catch (err) {
          console.error(
            `[asks] could not check page id ${pageId} against the history: ${errMessage(err)}`,
          );
        }
      }
    },

    // The new text only: the alarm, its state and its send records stay.
    reraise(id, prompt, actor) {
      check();
      const prev = entries.find((e) => e.id === id);
      if (!prev?.page) return null;
      const at = now();
      const page = {
        ...prev.page,
        raiseCount: (prev.page.raiseCount ?? 1) + 1,
        lastRaisedAt: at,
      };
      // The same text: only the raise is counted. The count is on no wire,
      // so nobody is told.
      if (prev.prompt === prompt) {
        const entry: AskEntry = { ...prev, page };
        const next = entries.map((e) => (e.id === id ? entry : e));
        deps.persistence.save(next);
        entries = next;
        return { outcome: "unchanged", entry: { ...entry } };
      }
      const entry: AskEntry = { ...prev, prompt, updatedAt: at, page };
      commit(
        entries.map((e) => (e.id === id ? entry : e)),
        [{ kind: "upserted", entry }],
      );
      recordEvent(entry, {
        kind: "edited",
        at: entry.updatedAt,
        ...actor,
        before: { prompt: prev.prompt },
      });
      return { outcome: "changed", entry: { ...entry } };
    },

    ack(id, byUserId) {
      check();
      const prev = entries.find((e) => e.id === id);
      if (!prev?.page) return null;
      if (prev.page.state === "acked")
        return { outcome: "unchanged", entry: { ...prev } };
      const at = now();
      const entry: AskEntry = {
        ...prev,
        page: {
          ...prev.page,
          state: "acked",
          ackedByUserId: byUserId,
          ackedAt: at,
        },
      };
      commit(
        entries.map((e) => (e.id === id ? entry : e)),
        [{ kind: "upserted", entry }],
      );
      recordEvent(entry, { kind: "acked", at, byUserId });
      tellPage(entry, "acked");
      return { outcome: "changed", entry: { ...entry } };
    },

    // No listener hears it: no wire carries the send records.
    recordPageDelivery(id, userId, delivery) {
      check();
      const prev = entries.find((e) => e.id === id);
      if (!prev?.page || !Object.hasOwn(prev.page.delivery, userId))
        return null;
      const entry: AskEntry = {
        ...prev,
        page: {
          ...prev.page,
          delivery: { ...prev.page.delivery, [userId]: delivery },
        },
      };
      const next = entries.map((e) => (e.id === id ? entry : e));
      deps.persistence.save(next);
      entries = next;
      return { ...entry };
    },

    removeAgent(agentId) {
      check();
      const theirs = entries.filter((e) => e.agentId === agentId);
      if (theirs.length === 0) return 0;
      // An app's page outlives the agent its answers went to: it stays open
      // with no agent, for the app's owner, when that is a valid ask.
      const kept = new Map<string, AskEntry>();
      for (const entry of theirs) {
        if (!entry.app || !entry.page) continue;
        const { sessionId: _session, ...rest } = entry;
        const orphan: AskEntry = { ...rest, agentId: "" };
        if (isAskEntry(orphan)) kept.set(entry.id, orphan);
      }
      const gone = theirs.filter((e) => !kept.has(e.id));
      commit(
        entries.flatMap((e) =>
          e.agentId !== agentId ? [e] : (kept.get(e.id) ?? []),
        ),
        [
          ...gone.map((entry) => ({ kind: "removed" as const, entry })),
          ...[...kept.values()].map((entry) => ({
            kind: "upserted" as const,
            entry,
          })),
        ],
      );
      recordClosed(gone, { outcome: "agent_removed" });
      for (const entry of gone) if (entry.page) tellPage(entry, "closed");
      return gone.length;
    },
  };
}

// The entry without its opening session, which is for the reply note only,
// with everyone it is for now by name (task 9461c464).
export function askMemberWire(
  { sessionId: _session, page, ...entry }: AskEntry,
  memberName: (userId: string) => string | null,
  audience: AskAudienceDeps,
): AskMemberWire {
  return {
    ...entry,
    members: askMemberIds(entry, audience).map(
      (userId) => memberName(userId) ?? userId,
    ),
    ...(page ? { page: askPageWire(page, memberName) } : {}),
  };
}

// A paged ask's alarm on the wire: who acked by name, never the send records.
function askPageWire(
  page: AskPage,
  memberName: (userId: string) => string | null,
): AskPageWire {
  return {
    state: page.state,
    ...(page.pageId !== undefined ? { pageId: page.pageId } : {}),
    // "" is a migrated ack by no member: no name.
    ...(page.ackedByUserId !== undefined
      ? {
          ackedBy:
            page.ackedByUserId === "" ? null : memberName(page.ackedByUserId),
        }
      : {}),
    ...(page.ackedAt !== undefined ? { ackedAt: page.ackedAt } : {}),
  };
}

// The member wire with the member it is for, by name as they are now (their
// id when the record is gone): the first of `members`, else the stored one
// (a room ask open for nobody now). An office secret request names its one
// owner on the request, or no member when it is for every owner.
export function askAgentWire(
  entry: AskEntry,
  memberName: (userId: string) => string | null,
  audience: AskAudienceDeps,
): AskAgentWire {
  const wire = askMemberWire(entry, memberName, audience);
  const userId = entry.memberUserId ?? entry.secret?.answerUserId;
  return {
    ...wire,
    member:
      wire.members?.[0] ??
      (userId === undefined ? null : (memberName(userId) ?? userId)),
  };
}

// The task a member files an ask as: the title is the ask's subject line in
// plain text (askSubject), or the ask's id and source for a prompt with no
// text, cut to ASK_TASK_TITLE_MAX code points; the description
// holds the whole prompt, the options (the recommended one marked), the link,
// the commands and files, the member's note when they typed one, and the
// agent and ask it came from.
export const ASK_TASK_TITLE_MAX = 120;
export function askTaskFields(
  entry: AskEntry,
  agentName: string,
  note?: string,
): { title: string; description: string } {
  const line = Array.from(
    askSubject(entry.prompt) ||
      (entry.app
        ? `Ask ${entry.id} from app ${entry.app.name}`
        : `Ask ${entry.id} from ${agentName}`),
  );
  const title =
    line.length > ASK_TASK_TITLE_MAX
      ? `${line.slice(0, ASK_TASK_TITLE_MAX - 1).join("")}…`
      : line.join("");
  const parts = [entry.prompt.trim()];
  if (entry.options)
    parts.push(
      `Options:\n${entry.options
        .map((o) => `- ${o}${o === entry.recommended ? " (recommended)" : ""}`)
        .join("\n")}`,
    );
  if (entry.link) parts.push(`Link: ${entry.link}`);
  if (entry.commands)
    parts.push(`Commands:\n${entry.commands.map((c) => `- ${c}`).join("\n")}`);
  const files = [
    ...(entry.editFiles ?? []).map((f) => f.path),
    // A reference by its path: the task outlives the ask, and the path is
    // the way back to the file.
    ...(entry.readFiles ?? []).map((f) => f.path ?? f.originalName),
  ];
  if (files.length > 0)
    parts.push(`Files:\n${files.map((f) => `- ${f}`).join("\n")}`);
  if (note !== undefined && note.trim() !== "")
    parts.push(`Note: ${note.trim()}`);
  parts.push(
    entry.app
      ? `From app ${entry.app.name}'s ask ${entry.id} to ${agentName}.`
      : `From ${agentName}'s ask ${entry.id}.`,
  );
  return { title, description: parts.join("\n\n") };
}

// The bracket the agent reads before the member's words. The reply can reach a
// later session (after a clear, a handoff or /wrap-session) that never saw the
// question, so the note quotes the whole prompt and, when the session that
// opened the ask is not the current one, names it for a log search. An ask an
// app opened names the app, so the agent knows it did not ask it. A simplify
// request keeps the ask open: the agent rewrites it in place.
export function askReplyNote(
  ref: AskRef,
  currentSessionId: string | null = null,
): string {
  const from =
    ref.sessionId && ref.sessionId !== currentSessionId
      ? ` (opened in session ${ref.sessionId})`
      : "";
  const quoted = JSON.stringify(ref.prompt.trim());
  const whose = ref.app ? `app ${ref.app.name}'s` : "your";
  if (ref.taskId) {
    const subject = ref.app ? `App ${ref.app.name}'s` : "Your";
    return `[${subject} ask ${ref.id}${from} is now task ${ref.taskId}: ${quoted}] `;
  }
  if (ref.simplify)
    return `[Simplify ${whose} ask ${ref.id}${from}: ${quoted}] `;
  if (ref.simplifyUndone)
    return `[Simplify request withdrawn for ${whose} ask ${ref.id}${from}: ${quoted}] `;
  const verb = ref.dismissed ? "Dismissed" : "Reply to";
  return `[${verb} ${whose} ask ${ref.id}${from}: ${quoted}] `;
}
