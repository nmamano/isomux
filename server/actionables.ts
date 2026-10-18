// Actionables: a prompt from an agent to one member, answered when the member
// has time (internal-docs/actionables-design.md). The store holds open entries
// only, in ~/.isomux/actionables.json; a reply, a dismiss or the agent's delete
// removes the entry.
//
// Load posture (the pager store's):
//   - no file                 → no actionables (a new or older install)
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
import { generateActionableId, type ActionableEntry } from "../shared/types.ts";

// Sanity bounds only.
export const ACTIONABLE_PROMPT_MAX = 4000;
export const ACTIONABLE_MAX_OPEN_PER_AGENT = 50;

export type ActionableLoadResult =
  | { kind: "missing" }
  | { kind: "data"; value: unknown }
  | { kind: "corrupt" }
  | { kind: "unreadable" };

export interface ActionablePersistence {
  load(): ActionableLoadResult;
  // Durable write. MUST THROW on failure.
  save(entries: ActionableEntry[]): void;
  // Move a corrupt file aside. False when it could not be moved.
  quarantine(): boolean;
}

export function createActionableFilePersistence(
  path: string,
): ActionablePersistence {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT")
          return { kind: "missing" };
        console.error(`[actionables] cannot read ${path}: ${errMessage(err)}`);
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
        console.error(`[actionables] ${path} is corrupt; moved it to ${aside}`);
        return true;
      } catch (err) {
        console.error(
          `[actionables] ${path} is corrupt and could not be moved aside: ${errMessage(err)}`,
        );
        return false;
      }
    },
  };
}

export class ActionablesUnavailableError extends Error {
  constructor() {
    super("The actionables store is unavailable.");
  }
}

function isActionableEntry(v: unknown): v is ActionableEntry {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.agentId === "string" &&
    typeof r.memberUserId === "string" &&
    typeof r.prompt === "string" &&
    typeof r.createdAt === "number" &&
    typeof r.updatedAt === "number"
  );
}

// The prompt as the agent sent it, or the reason it is refused.
export function checkPrompt(
  text: unknown,
): { ok: true; prompt: string } | { ok: false; message: string } {
  if (typeof text !== "string")
    return { ok: false, message: "text is required" };
  if (text.trim().length === 0)
    return { ok: false, message: "text must not be empty" };
  if (text.length > ACTIONABLE_PROMPT_MAX)
    return {
      ok: false,
      message: `text must be at most ${ACTIONABLE_PROMPT_MAX} characters`,
    };
  return { ok: true, prompt: text };
}

export type ActionableChange =
  | { kind: "upserted"; entry: ActionableEntry }
  | { kind: "removed"; entry: ActionableEntry };

export interface ActionableStoreDeps {
  persistence: ActionablePersistence;
  now?: () => number;
  // After a committed change. A throw is logged and swallowed.
  onChange?(change: ActionableChange): void;
}

export interface ActionableStore {
  get(id: string): ActionableEntry | null;
  listForAgent(agentId: string): ActionableEntry[];
  listForMember(memberUserId: string): ActionableEntry[];
  create(input: {
    agentId: string;
    memberUserId: string;
    prompt: string;
  }): { ok: true; entry: ActionableEntry } | { ok: false; code: "too_many" };
  edit(id: string, prompt: string): ActionableEntry | null;
  remove(id: string): ActionableEntry | null;
  // Every entry of a removed agent. Returns how many went.
  removeAgent(agentId: string): number;
}

export function createActionableStore(
  deps: ActionableStoreDeps,
): ActionableStore {
  const now = deps.now ?? Date.now;
  let entries: ActionableEntry[] = [];
  let available = true;

  const loaded = deps.persistence.load();
  if (loaded.kind === "unreadable") {
    available = false;
  } else if (loaded.kind === "corrupt") {
    available = deps.persistence.quarantine();
  } else if (loaded.kind === "data") {
    if (
      Array.isArray(loaded.value) &&
      loaded.value.every((v) => isActionableEntry(v))
    ) {
      entries = loaded.value;
    } else {
      available = deps.persistence.quarantine();
    }
  }

  function check(): void {
    if (!available) throw new ActionablesUnavailableError();
  }

  function commit(next: ActionableEntry[], changes: ActionableChange[]): void {
    deps.persistence.save(next);
    entries = next;
    for (const change of changes) {
      try {
        deps.onChange?.({ ...change, entry: { ...change.entry } });
      } catch (err) {
        console.error(
          `[actionables] a change listener threw: ${errMessage(err)}`,
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
    listForAgent(agentId) {
      check();
      return entries
        .filter((e) => e.agentId === agentId)
        .map((e) => ({ ...e }));
    },
    listForMember(memberUserId) {
      check();
      return entries
        .filter((e) => e.memberUserId === memberUserId)
        .map((e) => ({ ...e }));
    },
    create({ agentId, memberUserId, prompt }) {
      check();
      const open = entries.filter((e) => e.agentId === agentId).length;
      if (open >= ACTIONABLE_MAX_OPEN_PER_AGENT)
        return { ok: false, code: "too_many" };
      const at = now();
      const entry: ActionableEntry = {
        id: generateActionableId(entries.map((e) => e.id)),
        agentId,
        memberUserId,
        prompt,
        createdAt: at,
        updatedAt: at,
      };
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
export const ACTIONABLE_PROMPT_EXCERPT = 80;
export function actionableReplyNote(ref: {
  id: string;
  prompt: string;
  dismissed?: boolean;
}): string {
  const flat = ref.prompt.replace(/\s+/g, " ").trim();
  const excerpt =
    flat.length > ACTIONABLE_PROMPT_EXCERPT
      ? `${flat.slice(0, ACTIONABLE_PROMPT_EXCERPT - 1)}…`
      : flat;
  const verb = ref.dismissed
    ? "Dismissed your actionable"
    : "Reply to your actionable";
  return `[${verb} ${ref.id}: ${JSON.stringify(excerpt)}] `;
}
