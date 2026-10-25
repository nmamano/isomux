// Asks: a prompt from an agent to one member, answered when the member
// has time (internal-docs/asks-design.md). The store holds open entries
// only, in ~/.isomux/asks.json; a reply, a dismiss or the agent's delete
// removes the entry.
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
// LEAF: imports only shared types and the atomic writer.

import { readFileSync, renameSync } from "fs";
import { atomicWriteFileSync } from "./persistence.ts";
import { errMessage } from "../shared/errors.ts";
import {
  generateAskId,
  type AskEntry,
  type AskMemberWire,
  type AskRef,
  type Attachment,
  type FilePayload,
  type SecretAskRequest,
} from "../shared/types.ts";

// Sanity bounds only.
export const ASK_PROMPT_MAX = 4000;
export const ASK_MAX_OPEN_PER_AGENT = 50;
export const ASK_OPTIONS_MIN = 2;
export const ASK_OPTIONS_MAX = 4;
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
    typeof r.reason === "string"
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

// Three shapes: a plain ask and a personal secret request are for one
// member; an office secret request is for every office owner and names no
// member. A secret request has no link and no options.
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
  // Chat affordances: the shape only, as for options.
  if (
    (r.commands !== undefined &&
      !isListOf(r.commands, (c) => typeof c === "string" && c !== "")) ||
    (r.editFiles !== undefined && !isListOf(r.editFiles, isFilePayload)) ||
    (r.readFiles !== undefined && !isListOf(r.readFiles, isAttachment))
  )
    return false;
  if (r.secret === undefined) return hasMember;
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

// Whether a member sees an ask and may answer it, decided live: the member
// it names, or any office owner for an office secret request, and in both
// cases only while the member can reach the agent's room. Every list, push
// and answer check goes through here.
export function askVisibleTo(
  entry: AskEntry,
  userId: string | null,
  deps: AskAudienceDeps,
): boolean {
  if (!userId) return false;
  const roomId = deps.agentRoomId(entry.agentId);
  if (roomId === null || !deps.canSeeRoom(userId, roomId)) return false;
  if (entry.secret?.scope === "office") return deps.isOfficeOwner(userId);
  return entry.memberUserId !== undefined && entry.memberUserId === userId;
}

// The prompt as the agent sent it, or the reason it is refused.
export function checkPrompt(
  text: unknown,
): { ok: true; prompt: string } | { ok: false; message: string } {
  if (typeof text !== "string")
    return { ok: false, message: "text is required" };
  if (text.trim().length === 0)
    return { ok: false, message: "text must not be empty" };
  if (text.length > ASK_PROMPT_MAX)
    return {
      ok: false,
      message: `text must be at most ${ASK_PROMPT_MAX} characters`,
    };
  return { ok: true, prompt: text };
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
  readFiles?: Attachment[];
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
}

export interface AskStore {
  get(id: string): AskEntry | null;
  // Every open entry, for a scan across agents (secret requests).
  listAll(): AskEntry[];
  listForAgent(agentId: string): AskEntry[];
  // Throws on an entry that is none of the three shapes.
  create(input: {
    agentId: string;
    memberUserId?: string;
    prompt: string;
    secret?: SecretAskRequest;
    link?: string;
    options?: string[];
    recommended?: string;
    affordances?: AskAffordances;
    sessionId?: string;
  }): { ok: true; entry: AskEntry } | { ok: false; code: "too_many" };
  // link, options, recommended and each affordance list: undefined keeps the
  // ask's value, null removes it. Removing the options removes the mark.
  edit(
    id: string,
    prompt: string,
    link?: string | null,
    options?: string[] | null,
    affordances?: AskAffordanceEdit,
    recommended?: string | null,
  ): AskEntry | null;
  remove(id: string): AskEntry | null;
  // Every entry of a removed agent. Returns how many went.
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
      link,
      options,
      recommended,
      affordances,
      sessionId,
    }) {
      check();
      const open = entries.filter((e) => e.agentId === agentId).length;
      if (open >= ASK_MAX_OPEN_PER_AGENT)
        return { ok: false, code: "too_many" };
      const at = now();
      const entry: AskEntry = {
        id: generateAskId(entries.map((e) => e.id)),
        agentId,
        ...(memberUserId !== undefined ? { memberUserId } : {}),
        prompt,
        createdAt: at,
        updatedAt: at,
        ...(secret ? { secret } : {}),
        ...(link !== undefined ? { link } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(recommended !== undefined ? { recommended } : {}),
        ...affordances,
        ...(sessionId ? { sessionId } : {}),
      };
      if (!isAskEntry(entry)) throw new Error("not a valid ask");
      commit([...entries, entry], [{ kind: "upserted", entry }]);
      return { ok: true, entry: { ...entry } };
    },
    edit(id, prompt, link, options, affordances = {}, recommended) {
      check();
      const prev = entries.find((e) => e.id === id);
      if (!prev) return null;
      const entry: AskEntry = { ...prev, prompt, updatedAt: now() };
      if (link === null) delete entry.link;
      else if (link !== undefined) entry.link = link;
      if (options === null) delete entry.options;
      else if (options !== undefined) entry.options = options;
      if (recommended === null || options === null) delete entry.recommended;
      else if (recommended !== undefined) entry.recommended = recommended;
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
      return { ...entry };
    },
    remove(id) {
      check();
      const prev = entries.find((e) => e.id === id);
      if (!prev) return null;
      commit(
        entries.filter((e) => e.id !== id),
        [{ kind: "removed", entry: prev }],
      );
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
    ...(entry.readFiles ?? []).map((f) => f.originalName),
  ];
  if (files.length > 0)
    parts.push(`Files:\n${files.map((f) => `- ${f}`).join("\n")}`);
  if (note !== undefined && note.trim() !== "")
    parts.push(`Note: ${note.trim()}`);
  parts.push(`From ${agentName}'s ask ${entry.id}.`);
  return { title, description: parts.join("\n\n") };
}

// The bracket the agent reads before the member's words. The reply can reach a
// later session (after a clear, a handoff or /wrap-session) that never saw the
// question, so the note quotes the whole prompt and, when the session that
// opened the ask is not the current one, names it for a log search.
export function askReplyNote(
  ref: AskRef,
  currentSessionId: string | null = null,
): string {
  const from =
    ref.sessionId && ref.sessionId !== currentSessionId
      ? ` (opened in session ${ref.sessionId})`
      : "";
  const quoted = JSON.stringify(ref.prompt.trim());
  if (ref.taskId)
    return `[Your ask ${ref.id}${from} is now task ${ref.taskId}: ${quoted}] `;
  const verb = ref.dismissed ? "Dismissed your ask" : "Reply to your ask";
  return `[${verb} ${ref.id}${from}: ${quoted}] `;
}
