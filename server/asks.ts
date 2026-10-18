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
  type SecretAskRequest,
} from "../shared/types.ts";

// Sanity bounds only.
export const ASK_PROMPT_MAX = 4000;
export const ASK_MAX_OPEN_PER_AGENT = 50;

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

export function createAskFilePersistence(
  path: string,
): AskPersistence {
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

// Three shapes: a plain ask and a personal secret request are for one
// member; an office secret request is for every office owner and names no
// member.
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
  if (r.secret === undefined) return hasMember;
  if (!isSecretAskRequest(r.secret)) return false;
  return r.secret.scope === "office"
    ? r.memberUserId === undefined
    : hasMember;
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
  }): { ok: true; entry: AskEntry } | { ok: false; code: "too_many" };
  edit(id: string, prompt: string): AskEntry | null;
  remove(id: string): AskEntry | null;
  // Every entry of a removed agent. Returns how many went.
  removeAgent(agentId: string): number;
}

export function createAskStore(
  deps: AskStoreDeps,
): AskStore {
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
        console.error(
          `[asks] a change listener threw: ${errMessage(err)}`,
        );
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
    create({ agentId, memberUserId, prompt, secret }) {
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
      };
      if (!isAskEntry(entry)) throw new Error("not a valid ask");
      commit([...entries, entry], [{ kind: "upserted", entry }]);
      return { ok: true, entry: { ...entry } };
    },
    edit(id, prompt) {
      check();
      const prev = entries.find((e) => e.id === id);
      if (!prev) return null;
      const entry = { ...prev, prompt, updatedAt: now() };
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

// The bracket the agent reads before the member's words, with the prompt cut
// to 80 characters so a long prompt does not crowd out the answer.
export const ASK_PROMPT_EXCERPT = 80;
export function askReplyNote(ref: {
  id: string;
  prompt: string;
  dismissed?: boolean;
}): string {
  const flat = ref.prompt.replace(/\s+/g, " ").trim();
  const excerpt =
    flat.length > ASK_PROMPT_EXCERPT
      ? `${flat.slice(0, ASK_PROMPT_EXCERPT - 1)}…`
      : flat;
  const verb = ref.dismissed
    ? "Dismissed your ask"
    : "Reply to your ask";
  return `[${verb} ${ref.id}: ${JSON.stringify(excerpt)}] `;
}
