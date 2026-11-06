// Refresh persistence: client-side (localStorage) memory of where the user
// was in the UI, so a page reload reopens the same spot, plus unsent chat
// drafts so an accidental reload doesn't eat typed-but-unsent text.
//
// localStorage over sessionStorage deliberately:
// - On phones (esp. iOS PWA) the webview is killed and relaunched constantly;
//   sessionStorage does not reliably survive that, and the relaunch is exactly
//   the "reload lost my place / my draft" pain being fixed.
// - Every existing client-side pref (theme, mobile view, username) is already
//   localStorage; there is no sessionStorage precedent in this codebase.
//
// OWNERSHIP: everything is namespaced by the (lowercased) authoritative
// session username. The same browser origin can host different users over
// time (user switch, session handoff), and a draft typed by user A must
// never be restored into user B's composer - nor should B inherit A's view
// spot instead of their own lobby default.
//
// LAYOUT:
// - View spot: one key, "isomux-view", holding {user, roomId, agentId,
//   panel}. Loads reject an owner mismatch. Multi-tab is last-writer-wins,
//   which for a view SELECTION is cosmetic: the worst case is a reload
//   landing on the spot another same-user tab was viewing.
// - Drafts: one key PER composer, "isomux-draft:<encoded user>:<agentId>",
//   holding the raw draft text. Per-composer keys are what makes multi-tab
//   safe for drafts - a whole-map mirror would let tab B (which never saw
//   tab A's draft) clobber it away on tab B's next keystroke. With one key
//   per composer, concurrent tabs only contend when editing the SAME
//   agent's draft, where last-writer-wins is the right semantics anyway
//   (there is no live cross-tab draft sync; each tab's composer is local).
//   The username is encodeURIComponent-encoded so the ":"-delimited key
//   can't be confused by any character the server might allow in names.
// - Ask-stack folds: one key per member and agent, built as the draft keys
//   are, "isomux-asks-folded:<encoded user>:<agentId>", holding the JSON
//   array of the ask ids that were open when the member folded the stack
//   above the chat input. A new ask ends the fold (ui/log-view/AsksStack.tsx).
// - Draft attachments: one key per composer, built as the draft keys are,
//   "isomux-draft-attachments:<encoded user>:<agentId>", holding the JSON
//   array of the draft's uploaded attachments (references, never bytes).
//
// Staleness is handled by validation at restore time (App.tsx checks every
// saved id against the first full_state and prunes/falls back), not by TTL.
//
// The view parser is STRICT: a payload with a wrong-typed or unknown-valued
// field is rejected wholesale (null), not field-sanitized - the only
// tolerated absence is a missing/null id, which means "office view". All
// reads/writes go through an injectable StorageLike so tests can cover
// mismatch and storage-exception paths without a DOM.

import type { Attachment } from "../shared/types.ts";
import {
  type DraftAttachment,
  uploadedOnly,
} from "./log-view/draft-attachments.ts";

const VIEW_KEY = "isomux-view";
const DRAFT_KEY_PREFIX = "isomux-draft:";
const DRAFT_ATTACHMENTS_KEY_PREFIX = "isomux-draft-attachments:";
const FOLD_KEY_PREFIX = "isomux-asks-folded:";

// The Storage operations we use, injectable for tests. `keys` exists because
// per-composer draft keys need enumeration (restore + prune); the default
// adapter backs it with Object.keys(localStorage).
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

function defaultStorage(): StorageLike | null {
  if (typeof localStorage === "undefined") return null;
  return {
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v) => localStorage.setItem(k, v),
    removeItem: (k) => localStorage.removeItem(k),
    keys: () => Object.keys(localStorage),
  };
}

// Which full-screen panel was open. null = office or agent chat (which of the
// two is determined by `agentId`).
// "users" is the settings page's old name. It stays accepted FOREVER, mapping
// to the same page: the parser rejects a whole payload on an unknown panel
// value, so dropping it would make an older saved spot lose its room and agent
// too, not just its panel. New writes use "settings".
export type SavedPanel =
  | "tasks"
  | "cronjobs"
  | "apps"
  | "skills"
  | "integrations"
  | "settings"
  | "users"
  | "asks";

export interface SavedView {
  user: string; // lowercased owner username; loads reject on mismatch
  roomId: string | null;
  agentId: string | null;
  panel: SavedPanel | null;
  // The Lobby tab was open. Absent in payloads written before the lobby
  // existed, which reads as false.
  lobby: boolean;
}

// Strict field readers: `undefined` return means "malformed, reject the
// whole payload". A missing or null field is a legitimate null.
function readId(x: unknown): string | null | undefined {
  if (x === null || x === undefined) return null;
  return typeof x === "string" && x.length > 0 ? x : undefined;
}

function readPanel(x: unknown): SavedPanel | null | undefined {
  if (x === null || x === undefined) return null;
  return x === "tasks" ||
    x === "cronjobs" ||
    x === "apps" ||
    x === "skills" ||
    x === "integrations" ||
    x === "settings" ||
    x === "users" ||
    x === "asks"
    ? x
    : // The Inbox's Pages tab until pages became asks (task 74e8fc07).
      x === "pager"
      ? "asks"
      : undefined;
}

/** Strict parser for the saved-view JSON: returns null for any malformed
 * payload (bad JSON, wrong shape, missing owner, wrong-typed field, unknown
 * panel value) rather than sanitizing fields. */
export function parseSavedView(raw: string | null): SavedView | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const user =
      typeof o.user === "string" && o.user.length > 0 ? o.user : undefined;
    const roomId = readId(o.roomId);
    const agentId = readId(o.agentId);
    const panel = readPanel(o.panel);
    const lobby =
      o.lobby === undefined || o.lobby === null
        ? false
        : typeof o.lobby === "boolean"
          ? o.lobby
          : undefined;
    if (
      user === undefined ||
      roomId === undefined ||
      agentId === undefined ||
      panel === undefined ||
      lobby === undefined
    ) {
      return null;
    }
    return { user, roomId, agentId, panel, lobby };
  } catch {
    return null;
  }
}

// Case-insensitive owner check: the store keys users by lowercase(name), so
// the same normalization applies here. save* always writes the normalized
// form, but the comparison normalizes BOTH sides so a payload carrying a
// mixed-case owner (hand-edited, or a future writer that forgets to
// normalize) still matches its own user rather than being silently dropped.
function normUser(user: string): string {
  return user.toLowerCase();
}

export function loadSavedView(
  user: string,
  storage: StorageLike | null = defaultStorage(),
): SavedView | null {
  if (!storage) return null;
  try {
    const v = parseSavedView(storage.getItem(VIEW_KEY));
    if (!v || normUser(v.user) !== normUser(user)) return null;
    return v;
  } catch {
    return null;
  }
}

// The saved view of whoever saved last in this browser, with no owner check:
// the only guess at the view before the session names the member.
export function loadLastSavedView(
  storage: StorageLike | null = defaultStorage(),
): SavedView | null {
  if (!storage) return null;
  try {
    return parseSavedView(storage.getItem(VIEW_KEY));
  } catch {
    return null;
  }
}

export function saveView(
  user: string,
  view: Omit<SavedView, "user">,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      VIEW_KEY,
      JSON.stringify({ user: normUser(user), ...view }),
    );
  } catch {
    // Quota / privacy-mode failures: persistence is best-effort.
  }
}

function draftKey(user: string, agentId: string): string {
  return `${DRAFT_KEY_PREFIX}${encodeURIComponent(normUser(user))}:${agentId}`;
}

function userDraftPrefix(user: string): string {
  return `${DRAFT_KEY_PREFIX}${encodeURIComponent(normUser(user))}:`;
}

/** All of `user`'s saved drafts, keyed by agentId. Other users' keys are
 * never touched or returned. */
export function loadUserDrafts(
  user: string,
  storage: StorageLike | null = defaultStorage(),
): Record<string, string> {
  if (!storage) return {};
  const out: Record<string, string> = {};
  try {
    const prefix = userDraftPrefix(user);
    for (const key of storage.keys()) {
      if (!key.startsWith(prefix)) continue;
      const agentId = key.slice(prefix.length);
      if (!agentId) continue;
      const text = storage.getItem(key);
      if (typeof text === "string" && text.length > 0) out[agentId] = text;
    }
  } catch {
    return {};
  }
  return out;
}

/** Write-through for one composer. Empty text deletes the key (the draft
 * was sent or cleared). */
export function saveDraft(
  user: string,
  agentId: string,
  text: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    if (text.length > 0) storage.setItem(draftKey(user, agentId), text);
    else storage.removeItem(draftKey(user, agentId));
  } catch {
    // Best-effort: an oversized draft (quota) keeps the previous saved copy.
  }
}

function draftAttachmentsKey(user: string, agentId: string): string {
  return `${userDraftAttachmentsPrefix(user)}${agentId}`;
}

function userDraftAttachmentsPrefix(user: string): string {
  return `${DRAFT_ATTACHMENTS_KEY_PREFIX}${encodeURIComponent(normUser(user))}:`;
}

function isAttachment(v: unknown): v is Attachment {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.filename === "string" &&
    a.filename.length > 0 &&
    typeof a.originalName === "string" &&
    typeof a.mediaType === "string" &&
    typeof a.size === "number"
  );
}

/** Write-through for one composer's attachments: only the uploaded
 * references are kept (in-flight and errored items are dropped), and a
 * draft with none left deletes the key. */
export function saveDraftAttachments(
  user: string,
  agentId: string,
  items: readonly DraftAttachment[],
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  const references = uploadedOnly(items);
  try {
    const key = draftAttachmentsKey(user, agentId);
    if (references.length > 0) storage.setItem(key, JSON.stringify(references));
    else storage.removeItem(key);
  } catch {
    // Best-effort, as saveDraft.
  }
}

/** All of `user`'s saved draft attachments, keyed by agentId. A key whose
 * value is not a list of attachments is skipped. */
export function loadUserDraftAttachments(
  user: string,
  storage: StorageLike | null = defaultStorage(),
): Record<string, Attachment[]> {
  if (!storage) return {};
  const out: Record<string, Attachment[]> = {};
  try {
    const prefix = userDraftAttachmentsPrefix(user);
    for (const key of storage.keys()) {
      if (!key.startsWith(prefix)) continue;
      const agentId = key.slice(prefix.length);
      if (!agentId) continue;
      let value: unknown;
      try {
        value = JSON.parse(storage.getItem(key) ?? "null");
      } catch {
        continue;
      }
      if (Array.isArray(value) && value.length > 0 && value.every(isAttachment))
        out[agentId] = value.map(
          ({ filename, originalName, mediaType, size }: Attachment) => ({
            filename,
            originalName,
            mediaType,
            size,
          }),
        );
    }
  } catch {
    return {};
  }
  return out;
}

/** pruneUserDrafts for the attachment keys. */
export function pruneUserDraftAttachments(
  user: string,
  keepAgentIds: ReadonlySet<string>,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    const prefix = userDraftAttachmentsPrefix(user);
    for (const key of storage.keys()) {
      if (!key.startsWith(prefix)) continue;
      const agentId = key.slice(prefix.length);
      if (!keepAgentIds.has(agentId)) storage.removeItem(key);
    }
  } catch {
    // Best-effort.
  }
}

/** Drop `user`'s draft keys for agents that no longer exist (or are no
 * longer visible to them). Only the caller's own namespace is pruned -
 * another user's agents can't be validated against this session's
 * ACL-filtered agent list. */
export function pruneUserDrafts(
  user: string,
  keepAgentIds: ReadonlySet<string>,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    const prefix = userDraftPrefix(user);
    for (const key of storage.keys()) {
      if (!key.startsWith(prefix)) continue;
      const agentId = key.slice(prefix.length);
      if (!keepAgentIds.has(agentId)) storage.removeItem(key);
    }
  } catch {
    // Best-effort.
  }
}

function userFoldPrefix(user: string): string {
  return `${FOLD_KEY_PREFIX}${encodeURIComponent(normUser(user))}:`;
}

function foldKey(user: string, agentId: string): string {
  return `${userFoldPrefix(user)}${agentId}`;
}

/** The ask ids that were open when `user` folded `agentId`'s ask stack, or
 * null when no fold is kept. Strict: anything but an array of strings is no
 * fold. */
export function loadFoldedAsks(
  user: string,
  agentId: string,
  storage: StorageLike | null = defaultStorage(),
): string[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(foldKey(user, agentId));
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((id) => typeof id === "string")
      ? v
      : null;
  } catch {
    return null;
  }
}

/** Keep the fold of `agentId`'s ask stack; null removes it. */
export function saveFoldedAsks(
  user: string,
  agentId: string,
  askIds: readonly string[] | null,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    if (askIds) storage.setItem(foldKey(user, agentId), JSON.stringify(askIds));
    else storage.removeItem(foldKey(user, agentId));
  } catch {
    // Best-effort.
  }
}

/** Drop `user`'s ask-stack folds for agents that no longer exist, as
 * pruneUserDrafts does for drafts. */
export function pruneUserFoldedAsks(
  user: string,
  keepAgentIds: ReadonlySet<string>,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    const prefix = userFoldPrefix(user);
    for (const key of storage.keys()) {
      if (!key.startsWith(prefix)) continue;
      if (!keepAgentIds.has(key.slice(prefix.length))) storage.removeItem(key);
    }
  } catch {
    // Best-effort.
  }
}
