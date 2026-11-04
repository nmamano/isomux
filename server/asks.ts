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
  isValidPriority,
  type AskCloseInput,
  type AskEditableKey,
  type AskEntry,
  type AskEvent,
  type AskMemberWire,
  type AskRef,
  type AskReadFile,
  type FilePayload,
  type SecretAskRequest,
  type SudoAskRequest,
  type StepAskRequest,
  type TaskPriority,
} from "../shared/types.ts";
import type { AskAgentWire } from "../shared/contract-shapes.ts";

// Sanity bounds only.
export const ASK_PROMPT_MAX = 4000;
export const ASK_MAX_OPEN_PER_AGENT = 500;
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
    // The kind (task c71cb60f): absent for a secret. Only a secret names an
    // app; only an MCP server request proposes a URL and a sign-in. Any other
    // non-empty kind loads, as a link does: a kind from a later release
    // cannot fail the file after a rollback (the request cannot be saved
    // here, only declined).
    (r.kind === undefined
      ? r.url === undefined && r.secret === undefined
      : r.kind === "variable"
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
const isAskReadFile = (v: unknown) =>
  isAttachment(v) &&
  isObject(v) &&
  (v.path === undefined || (typeof v.path === "string" && isAbsolute(v.path)));

// Four shapes: a plain ask, a personal secret request and a sudo request are
// for one member; an office secret request is for every office owner and
// names no member. A secret or sudo request has no link and no options.
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
  };
}

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
  if (entry.memberUserId === undefined || entry.memberUserId !== userId)
    return false;
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
  if (!userId || !deps.isOfficeOwner(userId) || entry.secret || entry.sudo)
    return false;
  if (askVisibleTo(entry, userId, deps)) return false;
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
  | { kind: "removed"; entry: AskEntry };

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
    prompt: string;
    secret?: SecretAskRequest;
    sudo?: SudoAskRequest;
    link?: string;
    options?: string[];
    recommended?: string;
    priority?: TaskPriority;
    affordances?: AskAffordances;
    sessionId?: string;
    step?: StepAskRequest;
    app?: { name: string; createdAt: number };
    // A reply draft to a messaging contact (task d03a61d8).
    messaging?: { app: string; routeId: string; text: string };
  }): { ok: true; entry: AskEntry } | { ok: false; code: "too_many" };
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
  // Closes the entry and records how (`close`).
  remove(id: string, close: AskCloseInput): AskEntry | null;
  // Every entry of a removed agent, each recorded as agent_removed. Returns
  // how many went.
  removeAgent(agentId: string): number;
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
        deps.history.record(entry, closure);
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
    }) {
      check();
      const open = entries.filter((e) => e.agentId === agentId).length;
      if (open >= ASK_MAX_OPEN_PER_AGENT)
        return { ok: false, code: "too_many" };
      const at = now();
      const entry: AskEntry = {
        id: freshId(),
        agentId,
        ...(memberUserId !== undefined ? { memberUserId } : {}),
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
      };
      if (!isAskEntry(entry)) throw new Error("not a valid ask");
      commit([...entries, entry], [{ kind: "upserted", entry }]);
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
    remove(id, close) {
      check();
      const prev = entries.find((e) => e.id === id);
      if (!prev) return null;
      commit(
        entries.filter((e) => e.id !== id),
        [{ kind: "removed", entry: prev }],
      );
      recordClosed([prev], close);
      return { ...prev };
    },
    removeAgent(agentId) {
      check();
      const gone = entries.filter((e) => e.agentId === agentId);
      if (gone.length === 0) return 0;
      commit(
        entries.filter((e) => e.agentId !== agentId),
        gone.map((entry) => ({ kind: "removed", entry })),
      );
      recordClosed(gone, { outcome: "agent_removed" });
      return gone.length;
    },
  };
}

// The entry without its opening session, which is for the reply note only.
export function askMemberWire({
  sessionId: _session,
  ...entry
}: AskEntry): AskMemberWire {
  return entry;
}

// The member wire with the member it is for, by name as they are now (their
// id when the record is gone). An office secret request names its one owner
// on the request, or no member when it is for every owner.
export function askAgentWire(
  entry: AskEntry,
  memberName: (userId: string) => string | null,
): AskAgentWire {
  const userId = entry.memberUserId ?? entry.secret?.answerUserId;
  return {
    ...askMemberWire(entry),
    member: userId === undefined ? null : (memberName(userId) ?? userId),
  };
}

// The task a member files an ask as: the title is the prompt's first
// non-blank line, cut to ASK_TASK_TITLE_MAX code points; the description
// holds the whole prompt, the options (the recommended one marked), the link,
// the commands and files, the member's note when they typed one, and the
// agent and ask it came from.
export const ASK_TASK_TITLE_MAX = 120;
export function askTaskFields(
  entry: AskEntry,
  agentName: string,
  note?: string,
): { title: string; description: string } {
  const firstLine = entry.prompt.split("\n").find((l) => l.trim() !== "");
  const line = Array.from((firstLine ?? "").trim().replace(/\s+/g, " "));
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
