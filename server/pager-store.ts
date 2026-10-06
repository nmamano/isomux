// The pager store: durable page records (internal-docs/pager-design.md).
//
// A page is durable state, not a chat message. Agents and apps raise pages,
// members (and agents in the same rooms) ack and resolve them, and the
// delivery module (server/pager-delivery.ts) sends them to the member's
// Discord through the onRaised and onTransitioned seams below.
//
// Persistence is one JSON array in STATE_ROOT/pager.json. Every write saves
// the NEXT array first and changes memory only after the save returned, so a
// failed save leaves memory and disk in agreement and the caller gets an
// error instead of a page that dies on restart.
//
// Load posture:
//   - no file                 → no pages (a new or older install)
//   - unparsable / bad shape  → the file is moved aside and the store starts
//                               empty; if it cannot be moved aside, the store
//                               refuses every operation so nothing overwrites
//                               a file a human may still want
//   - unreadable (EACCES...)  → the store refuses every operation; an
//                               unreadable file is not an empty file
//
// Retention: pruneResolved() deletes resolved pages older than
// PAGER_RESOLVED_RETENTION_MS. The store runs it once at load; the office runs
// it again on a timer. A prune pushes no event, so an open pager view keeps a
// pruned page until its next load.
//
// LEAF: imports only shared types and the atomic writer, so the state machine
// is unit-testable with an in-memory persistence.

import { readFileSync, renameSync } from "fs";
import { atomicWriteFileSync } from "./persistence.ts";
import { errMessage } from "../shared/errors.ts";
import {
  generatePagerId,
  type PagerDelivery,
  type PagerEntry,
  type PagerSource,
  type PagerTransition,
} from "../shared/types.ts";

// Sanity bounds only. BODY_MAX is not the whole outbound message budget: the
// delivery slice adds the room, the source and a link around it.
export const PAGER_TITLE_MAX = 200;
export const PAGER_BODY_MAX = 2000;
export const PAGER_KEY_MAX = 200;
// Open plus acked pages one source may hold, so a looping agent cannot fill
// the store. A raise that dedupes into an existing page does not count.
export const PAGER_MAX_ACTIVE_PER_SOURCE = 50;
// The store deletes a resolved page this long after it was resolved (Nil,
// 2026-10-06). Open and acked pages stay until they resolve.
export const PAGER_RESOLVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const PAGER_STATES: ReadonlySet<string> = new Set([
  "open",
  "acked",
  "resolved",
]);
const PAGER_DELIVERY_STATES: ReadonlySet<string> = new Set([
  "not_delivered",
  "delivered",
  "failed",
]);

export type PagerLoadResult =
  | { kind: "missing" }
  | { kind: "data"; value: unknown }
  | { kind: "corrupt" }
  | { kind: "unreadable" };

export interface PagerPersistence {
  load(): PagerLoadResult;
  // Durable write. MUST THROW on failure.
  save(entries: PagerEntry[]): void;
  // Move a corrupt file aside. False when it could not be moved.
  quarantine(): boolean;
}

export function createPagerFilePersistence(path: string): PagerPersistence {
  return {
    load() {
      // Read first and classify the error: existsSync also answers false
      // when a parent directory is not searchable, and that is not "no file".
      let text: string;
      try {
        text = readFileSync(path, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "missing" };
        }
        console.error(`[pager] cannot read ${path}: ${errMessage(err)}`);
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
        console.error(`[pager] ${path} is corrupt; moved it to ${aside}`);
        return true;
      } catch (err) {
        console.error(
          `[pager] ${path} is corrupt and could not be moved aside: ${errMessage(err)}`,
        );
        return false;
      }
    },
  };
}

// The raise body, after validation. Title is trimmed; an omitted body or key
// stays absent.
export interface PagerRaiseFields {
  title: string;
  body?: string;
  key?: string;
}

// Validate a raise body. Returns the fields, or the message for a 400.
export function parseRaiseFields(
  raw: unknown,
): { ok: true; fields: PagerRaiseFields } | { ok: false; message: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "body must be a JSON object" };
  }
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return { ok: false, message: "title is required" };
  }
  const title = body.title.trim();
  if (/[\r\n\u2028\u2029]/.test(title)) {
    return { ok: false, message: "title must be one line" };
  }
  if (title.length > PAGER_TITLE_MAX) {
    return {
      ok: false,
      message: `title is longer than ${PAGER_TITLE_MAX} characters`,
    };
  }
  const fields: PagerRaiseFields = { title };
  if (body.body !== undefined) {
    if (typeof body.body !== "string") {
      return { ok: false, message: "body must be a string" };
    }
    if (body.body.length > PAGER_BODY_MAX) {
      return {
        ok: false,
        message: `body is longer than ${PAGER_BODY_MAX} characters`,
      };
    }
    if (body.body.length > 0) fields.body = body.body;
  }
  if (body.key !== undefined) {
    if (typeof body.key !== "string" || body.key.length === 0) {
      return { ok: false, message: "key must be a non-empty string" };
    }
    if (body.key.length > PAGER_KEY_MAX) {
      return {
        ok: false,
        message: `key is longer than ${PAGER_KEY_MAX} characters`,
      };
    }
    fields.key = body.key;
  }
  return { ok: true, fields };
}

// One identity per source, so an agent and an app with the same id string
// never share pages, and neither do two registrations of one app name.
export function pagerSourceKey(source: PagerSource): string {
  return source.kind === "agent"
    ? `agent:${source.agentId}`
    : `app:${source.appName}:${source.registrationGen}`;
}

function isPagerSource(v: unknown): v is PagerSource {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.name !== "string") return false;
  if (s.kind === "agent") {
    return typeof s.agentId === "string" && typeof s.roomId === "string";
  }
  return (
    s.kind === "app" &&
    typeof s.appName === "string" &&
    typeof s.registrationGen === "number" &&
    (s.roomId === null || typeof s.roomId === "string")
  );
}

// Who is looking at a page: the rooms they can access, their user, and
// whether that user is an office owner.
export interface PagerViewer {
  accessibleRoomIds: ReadonlySet<string>;
  userId: string | null;
  isOfficeOwner: boolean;
}

// The one visibility rule, for the routes and the per-socket event. A viewer
// sees a page when they can access its stored room (the room at the first
// raise; never looked up again). An app page is also visible to the app owner
// (its target) and to office owners, and with a null room only to them.
export function pagerEntryVisible(
  entry: PagerEntry,
  viewer: PagerViewer,
): boolean {
  const roomId = entry.source.roomId;
  if (roomId !== null && viewer.accessibleRoomIds.has(roomId)) return true;
  return (
    entry.source.kind === "app" &&
    (viewer.isOfficeOwner ||
      (viewer.userId !== null && viewer.userId === entry.targetUserId))
  );
}

function isTransition(v: unknown): v is PagerTransition {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return typeof t.by === "string" && typeof t.at === "number";
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

// Shape check for one persisted record. Field types only: the store does not
// re-run the raise bounds on load, so a constant lowered later does not
// destroy old pages.
export function isPagerEntry(v: unknown): v is PagerEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  const delivery = e.delivery as Record<string, unknown> | null | undefined;
  return (
    typeof e.id === "string" &&
    typeof e.createdAt === "number" &&
    typeof e.lastRaisedAt === "number" &&
    typeof e.raiseCount === "number" &&
    isPagerSource(e.source) &&
    typeof e.targetUserId === "string" &&
    typeof e.title === "string" &&
    isOptionalString(e.body) &&
    isOptionalString(e.key) &&
    typeof e.state === "string" &&
    PAGER_STATES.has(e.state) &&
    (e.acked === undefined || isTransition(e.acked)) &&
    (e.resolved === undefined || isTransition(e.resolved)) &&
    typeof delivery === "object" &&
    delivery !== null &&
    typeof delivery.state === "string" &&
    PAGER_DELIVERY_STATES.has(delivery.state) &&
    typeof delivery.sends === "number" &&
    (delivery.lastAttemptAt === undefined ||
      typeof delivery.lastAttemptAt === "number") &&
    isOptionalString(delivery.lastFailure) &&
    (delivery.resolvedNotice === undefined ||
      delivery.resolvedNotice === "pending" ||
      delivery.resolvedNotice === "done")
  );
}

// The store refuses every operation (see the load posture above).
export class PagerUnavailableError extends Error {
  constructor() {
    super("the pager store is unavailable");
    this.name = "PagerUnavailableError";
  }
}

export type PagerRaiseResult =
  | { outcome: "created" | "updated"; entry: PagerEntry }
  | { outcome: "too_many" };

export type PagerActResult =
  | { outcome: "changed" | "unchanged"; entry: PagerEntry }
  | { outcome: "already_resolved"; entry: PagerEntry }
  | { outcome: "not_found" };

export interface PagerStoreDeps {
  persistence: PagerPersistence;
  now?: () => number;
  // Every committed change, for the per-recipient event push.
  onChange?: (entry: PagerEntry) => void;
  // The ONE hand-off to delivery: a new page, or a raise that deduped into
  // an open or acked page. Runs after the commit; a throw or a rejected
  // promise is logged and never undoes or fails the raise.
  onRaised?: (
    entry: PagerEntry,
    kind: "created" | "reraised",
  ) => void | Promise<void>;
  // An ack or a resolve that changed the state, after the commit. Same
  // never-throw rule as onRaised.
  onTransitioned?: (
    entry: PagerEntry,
    to: "acked" | "resolved",
  ) => void | Promise<void>;
}

export interface PagerStore {
  list(): PagerEntry[];
  get(id: string): PagerEntry | null;
  raise(input: {
    source: PagerSource;
    targetUserId: string;
    fields: PagerRaiseFields;
  }): PagerRaiseResult;
  ack(id: string, by: string): PagerActResult;
  resolve(id: string, by: string): PagerActResult;
  // Replace the delivery block of one page. Null when the page is gone.
  recordDelivery(id: string, delivery: PagerDelivery): PagerEntry | null;
  // Delete the resolved pages past retention. Returns how many it deleted.
  pruneResolved(): number;
}

const copy = (e: PagerEntry): PagerEntry => structuredClone(e);

export function createPagerStore(deps: PagerStoreDeps): PagerStore {
  const now = deps.now ?? (() => Date.now());
  let entries: PagerEntry[] = [];
  let available = true;

  const loaded = deps.persistence.load();
  if (loaded.kind === "unreadable") {
    available = false;
  } else if (loaded.kind === "corrupt") {
    available = deps.persistence.quarantine();
  } else if (loaded.kind === "data") {
    const value = loaded.value;
    if (Array.isArray(value) && value.every(isPagerEntry)) {
      entries = value;
    } else {
      available = deps.persistence.quarantine();
    }
  }

  const ensureAvailable = () => {
    if (!available) throw new PagerUnavailableError();
  };

  // Save first, then commit, as every other write. A failed save throws and
  // keeps the pages. A resolved record with no resolved time (only a
  // malformed one) is kept: the store does not know when it resolved.
  const pruneResolved = (): number => {
    ensureAvailable();
    const cutoff = now() - PAGER_RESOLVED_RETENTION_MS;
    const next = entries.filter(
      (e) =>
        e.state !== "resolved" ||
        e.resolved === undefined ||
        e.resolved.at > cutoff,
    );
    const pruned = entries.length - next.length;
    if (pruned === 0) return 0;
    deps.persistence.save(next);
    entries = next;
    return pruned;
  };

  if (available && entries.length > 0) {
    try {
      pruneResolved();
    } catch (err) {
      console.error(`[pager] cannot prune resolved pages: ${errMessage(err)}`);
    }
  }

  // Save first, then commit, then notify.
  const commit = (next: PagerEntry[], changed: PagerEntry) => {
    deps.persistence.save(next);
    entries = next;
    try {
      deps.onChange?.(copy(changed));
    } catch (err) {
      console.error(`[pager] change listener failed: ${errMessage(err)}`);
    }
  };

  // A listener's throw or rejected promise is logged and never undoes or
  // fails the operation that committed.
  const notify = (entry: PagerEntry, call: () => void | Promise<void>) => {
    const fail = (err: unknown) =>
      console.error(
        `[pager] delivery hand-off failed for ${entry.id}: ${errMessage(err)}`,
      );
    try {
      const r = call();
      if (r instanceof Promise) r.catch(fail);
    } catch (err) {
      fail(err);
    }
  };

  const handOff = (entry: PagerEntry, kind: "created" | "reraised") => {
    const onRaised = deps.onRaised;
    if (onRaised) notify(entry, () => onRaised(copy(entry), kind));
  };

  const replace = (updated: PagerEntry): PagerEntry[] =>
    entries.map((e) => (e.id === updated.id ? updated : e));

  const transition = (
    id: string,
    by: string,
    to: "acked" | "resolved",
  ): PagerActResult => {
    ensureAvailable();
    const current = entries.find((e) => e.id === id);
    if (!current) return { outcome: "not_found" };
    if (current.state === to) {
      return { outcome: "unchanged", entry: copy(current) };
    }
    if (current.state === "resolved") {
      return { outcome: "already_resolved", entry: copy(current) };
    }
    const updated: PagerEntry = {
      ...copy(current),
      state: to,
      [to]: { by, at: now() },
    };
    // Recorded in the same commit as the resolve, so a restart right after it
    // still owes the member the "resolved" message.
    if (to === "resolved") updated.delivery.resolvedNotice = "pending";
    commit(replace(updated), updated);
    const onTransitioned = deps.onTransitioned;
    if (onTransitioned) {
      notify(updated, () => onTransitioned(copy(updated), to));
    }
    return { outcome: "changed", entry: copy(updated) };
  };

  return {
    list() {
      ensureAvailable();
      return entries.map(copy);
    },

    get(id) {
      ensureAvailable();
      const e = entries.find((x) => x.id === id);
      return e ? copy(e) : null;
    },

    raise({ source, targetUserId, fields }) {
      ensureAvailable();
      const sourceKey = pagerSourceKey(source);
      const t = now();
      // At most one open or acked page per (source, key): a raise with the
      // same key updates it. A raise on an acked page does not re-open it.
      const existing =
        fields.key === undefined
          ? undefined
          : entries.find(
              (e) =>
                e.state !== "resolved" &&
                e.key === fields.key &&
                pagerSourceKey(e.source) === sourceKey,
            );
      if (existing) {
        // Room, source name and target stay as at the first raise. An omitted
        // body clears the old one: the newest raise describes the incident.
        const updated: PagerEntry = {
          ...copy(existing),
          title: fields.title,
          lastRaisedAt: t,
          raiseCount: existing.raiseCount + 1,
        };
        if (fields.body === undefined) delete updated.body;
        else updated.body = fields.body;
        commit(replace(updated), updated);
        handOff(updated, "reraised");
        return { outcome: "updated", entry: copy(updated) };
      }
      const active = entries.filter(
        (e) => e.state !== "resolved" && pagerSourceKey(e.source) === sourceKey,
      ).length;
      if (active >= PAGER_MAX_ACTIVE_PER_SOURCE) return { outcome: "too_many" };
      const entry: PagerEntry = {
        id: generatePagerId(entries.map((e) => e.id)),
        createdAt: t,
        lastRaisedAt: t,
        raiseCount: 1,
        source: { ...source },
        targetUserId,
        title: fields.title,
        ...(fields.body !== undefined ? { body: fields.body } : {}),
        ...(fields.key !== undefined ? { key: fields.key } : {}),
        state: "open",
        delivery: { state: "not_delivered", sends: 0 },
      };
      commit([...entries, entry], entry);
      handOff(entry, "created");
      return { outcome: "created", entry: copy(entry) };
    },

    ack(id, by) {
      return transition(id, by, "acked");
    },

    resolve(id, by) {
      return transition(id, by, "resolved");
    },

    recordDelivery(id, delivery) {
      ensureAvailable();
      const current = entries.find((e) => e.id === id);
      if (!current) return null;
      const updated: PagerEntry = {
        ...copy(current),
        delivery: { ...delivery },
      };
      commit(replace(updated), updated);
      return copy(updated);
    },

    pruneResolved,
  };
}
