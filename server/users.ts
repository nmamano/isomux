// Per-user records persisted to ~/.isomux/users.json. Keyed in the file
// by stable `id` (random hex) since the userid migration; display name
// lives in the record's `name` field. The id stays put across renames
// so sessions/agents/cronjobs that reference the user by id never break.
//
// On-disk format (post-migration):
//   { "<id1>": { id: "<id1>", name: "Marc", ... },
//     "<id2>": { id: "<id2>", name: "Pau",  ... } }
//
// Legacy (pre-migration) format was keyed by lowercase(name). load()
// detects this shape and migrates: each legacy record gets a fresh id,
// the storage map is rebuilt id-keyed, and the new file is persisted
// immediately (so the on-disk format is upgraded the first time the
// process touches users.json). The pre-userid backup helper in
// migrations.ts captures the original file before this rewrite.

import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import { existsSync, readFileSync } from "fs";
import type {
  UserRecord,
  UserRole,
  NotifRoomsSetting,
} from "../shared/types.ts";
import { generateUserId } from "../shared/types.ts";
import { lowercaseKey } from "../shared/identity.ts";
import {
  isSupportedLanguage,
  type SupportedLanguageCode,
} from "../shared/languages.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import {
  defaultGhostColorForUserId,
  isGhostVariant,
  isHexColor,
  normalizeHexColor,
  type GhostVariant,
} from "../shared/avatar.ts";

const USERS_FILE = join(STATE_ROOT, "users.json");

// Internal storage: id → record. Lookup-by-name iterates and compares
// lowercaseKey(record.name) === lowercaseKey(query). Display-case is
// preserved on the record; the key is opaque.
let users: Record<string, UserRecord> = {};
let loaded = false;

// Test-only: drop the in-memory user cache so the next access reloads from the
// (freshly wiped) STATE_ROOT. The in-process harness calls this between boots;
// mirrors auth._testResetState. Not a production path.
export function _testResetUsers(): void {
  users = {};
  loaded = false;
}

function normalizeRole(value: unknown): UserRole {
  return value === "owner" ? "owner" : "member";
}

function normalizeNotifRooms(value: unknown): NotifRoomsSetting {
  if (Array.isArray(value) && value.every((x) => typeof x === "string")) {
    return value;
  }
  // Legacy "all" sentinel or any other bad shape → []. The auto-prune
  // on the next update_user (or the claim_user default for a brand-new
  // user) is what bakes the intended explicit list onto disk.
  return [];
}

// Strict string[] normalization for the ACL allow-list. Legacy "all"
// sentinel values are expanded to an explicit snapshot of current
// rooms by migrateAllowedRoomsArrayIfNeeded at boot, so by the time
// this loader runs the on-disk value is either a string[] or
// absent/garbage. Bad values normalize to [] (member-style "no rooms
// visible"); the boot migration preserves the prior "see everything"
// intent for any user that was on "all".
function normalizeAllowedRooms(value: unknown): string[] {
  if (Array.isArray(value) && value.every((x) => typeof x === "string")) {
    return value;
  }
  return [];
}

// Generic "string[] or []" normalizer for the per-user view-preference room-id
// lists (hidden / order) - Phase 3b. Same shape as normalizeAllowedRooms; named
// for the view fields so call sites read clearly.
function normalizeRoomIdList(value: unknown): string[] {
  if (Array.isArray(value) && value.every((x) => typeof x === "string")) {
    return value;
  }
  return [];
}

// memberPrompt is self-described user context auto-injected into the
// system prompt of every agent owned by this user. Trim whitespace and
// treat empty strings as absent (null) so the system-prompt builder
// can use a simple truthiness check.
function normalizeMemberPrompt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// Personal preferences (task 49d4e2f6). Both are read-time normalized, like
// the avatar fields: a legacy record without them reads as "never chosen"
// (null) and "off" (false), and the real field lands on the next save.
// An unrecognized language code (hand-edited file, or a code we dropped from
// SUPPORTED_LANGUAGES) degrades to null rather than being preserved, so the
// system-prompt clause can never be built from a language we don't know.
function normalizeLanguage(value: unknown): SupportedLanguageCode | null {
  return isSupportedLanguage(value) ? value : null;
}

function normalizeSlideMode(value: unknown): boolean {
  return value === true;
}

// Avatar color (live-avatars feature). Stored as a normalized lowercase
// "#rrggbb" string. Legacy records without the field - or any record
// where the value isn't a valid hex color - fall back to a stable
// hash-of-userId pick from the curated palette. Read-time only; no
// file rewrite on boot (the new field lands on the next user-edit save).
function normalizeAvatarColor(value: unknown, userId: string): string {
  if (isHexColor(value)) return normalizeHexColor(value);
  return defaultGhostColorForUserId(userId);
}

// Avatar variant (live-avatars feature). One of the 8 GHOST_VARIANTS.
// Default for legacy records is "classic" - same body as the original
// PoC and the lowest-disruption fallback for anyone whose stored value
// drifts out of the supported set.
function normalizeAvatarVariant(value: unknown): GhostVariant {
  return isGhostVariant(value) ? value : "classic";
}

// Treat a raw object as a user record. Used both for the post-migration
// format (id-keyed) and the legacy name-keyed format - the id field is
// optional here; load() assigns one if it's missing.
type RawUserRecord = Partial<UserRecord> & { name?: unknown };

function load(): Record<string, UserRecord> {
  if (loaded) return users;
  loaded = true;
  // Parse + normalize happens inside a try/catch so a corrupt or
  // unreadable users.json falls back to an empty map (current behavior:
  // surface the error in the log, then let the server continue with no
  // users). The migration persist is OUTSIDE that catch so a write
  // failure during the one-shot upgrade does NOT silently empty the
  // in-memory map - it propagates to the caller (server boot) and
  // halts the process. Operator restores from the pre-userid backup
  // bundle or fixes filesystem perms before retrying.
  let migratedAny = false;
  try {
    if (!existsSync(USERS_FILE)) {
      users = {};
      return users;
    }
    const parsed = JSON.parse(readFileSync(USERS_FILE, "utf-8")) as Record<
      string,
      RawUserRecord
    >;
    const result: Record<string, UserRecord> = {};
    const existingIds: string[] = [];
    // First pass: collect any ids that are already present, so the id
    // generator doesn't collide with them on the second pass.
    for (const value of Object.values(parsed)) {
      if (value && typeof value.id === "string" && value.id) {
        existingIds.push(value.id);
      }
    }
    for (const [storageKey, value] of Object.entries(parsed)) {
      if (!value || typeof value.name !== "string") continue;
      let id: string;
      if (typeof value.id === "string" && value.id) {
        id = value.id;
      } else {
        // Legacy record without an id - mint a fresh one. Existing
        // legacy sessions/agents/cronjobs that referenced this user by
        // name resolve to this new id at their own load time.
        id = generateUserId(existingIds);
        existingIds.push(id);
        migratedAny = true;
        console.log(
          `[migration] minted id=${id} for legacy user "${value.name}" (was keyed by "${storageKey}")`,
        );
      }
      result[id] = {
        id,
        name: value.name,
        // Default Room was removed (superseded by reload view-restore). A
        // legacy `defaultRoomId` field in an existing users.json is tolerated
        // and simply ignored here - reads never break, the field is dropped on
        // the next rewrite.
        notifRooms: normalizeNotifRooms(value.notifRooms),
        envFile:
          typeof value.envFile === "string" && value.envFile
            ? value.envFile
            : null,
        createdAt:
          typeof value.createdAt === "number" ? value.createdAt : Date.now(),
        role: normalizeRole(value.role),
        allowedRooms: normalizeAllowedRooms(value.allowedRooms),
        // View prefs (Phase 3b): backfill [] for legacy records lacking them.
        hidden: normalizeRoomIdList(value.hidden),
        order: normalizeRoomIdList(value.order),
        memberPrompt: normalizeMemberPrompt(value.memberPrompt),
        avatarColor: normalizeAvatarColor(value.avatarColor, id),
        avatarVariant: normalizeAvatarVariant(value.avatarVariant),
        language: normalizeLanguage(value.language),
        slideMode: normalizeSlideMode(value.slideMode),
      };
    }
    users = result;
  } catch (err) {
    console.error("Failed to load users.json:", err);
    users = {};
    return users;
  }
  if (migratedAny) {
    // Outside the parse-catch on purpose: if this write fails, propagate
    // so server boot aborts. Continuing with the migration applied in
    // memory but absent from disk would let acceptInvite issue sessions
    // for owners whose id-keyed shape vanishes on the next restart.
    persist();
  }
  return users;
}

// users.json is auth state: roles ride here, and acceptInvite calls
// claimUser/setUserRole before persisting the session. A swallowed write
// failure would let us issue a session for an in-memory owner whose role
// vanishes on restart. Persist must throw so callers can roll back.
function persist() {
  atomicWriteFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ---------------------------------------------------------------------------
// Lookups

export function listUsers(): UserRecord[] {
  load();
  return Object.values(users).sort((a, b) => a.name.localeCompare(b.name));
}

// Resolve by stable identity id. Hot path: session validation, env
// selection, agent ownership. O(1) since users is id-keyed.
export function getUserById(
  id: string | null | undefined,
): UserRecord | undefined {
  if (!id) return undefined;
  load();
  return users[id];
}

// Resolve by case-insensitive display name. Used by invite minting
// (existing-user check) and invite acceptance. O(n) iteration over users;
// n is small (single-digit to low-hundreds) and the operation is rare.
export function getUserByName(
  name: string | null | undefined,
): UserRecord | undefined {
  if (!name) return undefined;
  load();
  const key = lowercaseKey(name);
  for (const u of Object.values(users)) {
    if (lowercaseKey(u.name) === key) return u;
  }
  return undefined;
}

// Compatibility wrapper. `getUser(name)` is the name-only lookup that
// existed pre-migration; kept here so a handful of call sites don't need
// updating in lockstep. Prefer getUserById for identity-bearing reads,
// getUserByName for invite/UI flows.
export function getUser(name: string): UserRecord | undefined {
  return getUserByName(name);
}

export function getUserEnvFileById(
  id: string | null | undefined,
): string | null {
  return getUserById(id)?.envFile ?? null;
}

// Compatibility wrapper. Prefer getUserEnvFileById.
export function getUserEnvFile(name: string): string | null {
  return getUserByName(name)?.envFile ?? null;
}

// True if any user has role "owner". Used by the bootstrap-on-empty-state
// path to decide whether to mint a bootstrap invite on server start.
export function hasOwner(): boolean {
  load();
  for (const u of Object.values(users)) if (u.role === "owner") return true;
  return false;
}

// Count of users with role "owner". Used by the lockout-prevention check
// in delete_user: refusing the delete when removing the target would
// leave zero owners on disk.
export function countOwners(): number {
  load();
  let n = 0;
  for (const u of Object.values(users)) if (u.role === "owner") n++;
  return n;
}

// True if deleting `userId` would leave the office with zero owners on
// the user records. Returns false when the target doesn't exist or
// isn't an owner (the delete can't reduce the owner count).
export function wouldDeleteLeaveNoOwner(userId: string): boolean {
  load();
  const target = users[userId];
  if (!target || target.role !== "owner") return false;
  let remaining = 0;
  for (const u of Object.values(users)) {
    if (u.id !== userId && u.role === "owner") remaining++;
  }
  return remaining === 0;
}

// ---------------------------------------------------------------------------
// Mutations

// Idempotent: if a record with this display name (case-insensitive)
// already exists, return it unchanged. Otherwise mint a fresh id and
// create the record. New records default to role "member"; pass
// role: "owner" only from the bootstrap flow.
export function claimUser(
  name: string,
  initial?: {
    notifRooms?: NotifRoomsSetting;
    role?: UserRole;
    allowedRooms?: string[];
  },
): UserRecord {
  load();
  const existing = getUserByName(name);
  if (existing) return existing;
  const id = generateUserId(Object.keys(users));
  const role: UserRole = initial?.role === "owner" ? "owner" : "member";
  // Resolved allowedRooms is the basis for the default notifRooms - a
  // new user gets notified for every room they can see by default
  // (parallels the prior "notifRooms: all" semantics but now stored
  // as an explicit list).
  const resolvedAllowed = initial?.allowedRooms ?? [];
  const record: UserRecord = {
    id,
    name: name.trim(),
    notifRooms: initial?.notifRooms ?? [...resolvedAllowed],
    envFile: null,
    createdAt: Date.now(),
    role,
    // ACL allow-list. Strict string[] - no sentinel. New members
    // default to [] (no rooms visible until an owner grants access or
    // the member creates their own room). New owners need a snapshot
    // of current room ids passed in by the caller (invite acceptance
    // in auth.ts) to preserve "owners see everything" semantics; they
    // default to [] here if the caller omits the snapshot.
    allowedRooms: resolvedAllowed,
    // View prefs (Phase 3b): new users start with nothing hidden and the
    // default office-order room order.
    hidden: [],
    order: [],
    memberPrompt: null,
    // Live-avatars defaults. Color is deterministic per user-id so the
    // same user gets a consistent hue across restarts; variant is the
    // baseline ghost shape. Both are user-editable post-creation.
    avatarColor: defaultGhostColorForUserId(id),
    avatarVariant: "classic",
    // Personal preferences start unset: no language picked (so no agent
    // clause and no behavior change) and Slide Mode off.
    language: null,
    slideMode: false,
  };
  users[id] = record;
  try {
    persist();
  } catch (err) {
    delete users[id];
    throw err;
  }
  return record;
}

// Fired after a role actually changes (promote or demote) via
// setUserRoleById - the single role mutator. isomux-office.ts wires this at boot to
// refresh the cached `ws.data.session` on the user's connected sockets, so
// role-keyed audience selection (e.g. the owners-audience fan-out in
// liveEmitDeps) reflects the change immediately instead of after the next
// inbound message's revalidateByHash (task edac170a: a just-demoted ex-owner
// could otherwise receive one more owner-only event). Defaults to no-op so
// users.ts stays standalone; mirrors auth.ts's setOnSessionsChanged.
let onUserRoleChangedHook: (userId: string) => void = () => {};

export function setOnUserRoleChanged(cb: (userId: string) => void): void {
  onUserRoleChangedHook = cb;
}

// Promote/demote an existing user by id. No-op if the user doesn't exist
// or already has the target role.
export function setUserRoleById(id: string, role: UserRole): boolean {
  load();
  const existing = users[id];
  if (!existing) return false;
  if (existing.role === role) return true;
  users[id] = { ...existing, role };
  try {
    persist();
  } catch (err) {
    users[id] = existing;
    throw err;
  }
  // Post-persist: the on-disk role is authoritative, notify the transport
  // layer. A hook exception must not fail the (already-persisted) mutation.
  try {
    onUserRoleChangedHook(id);
  } catch (err) {
    console.error("[users] onUserRoleChangedHook threw:", err);
  }
  return true;
}

// Compatibility wrapper. `setUserRole(name, role)` resolves by name and
// delegates to setUserRoleById. Used by the bootstrap-promote-existing
// path which only has the display name to work with.
export function setUserRole(name: string, role: UserRole): boolean {
  const u = getUserByName(name);
  if (!u) return false;
  return setUserRoleById(u.id, role);
}

// Delete by id. No-op if the user doesn't exist (idempotent). Sessions
// for this user are not evicted here - that's auth.ts's responsibility
// via the validate-then-evict path. Agents/cronjobs that referenced this
// user keep their userId; subsequent buildEnvFor calls resolve to no env.
export function deleteUserById(id: string): boolean {
  load();
  const existing = users[id];
  if (!existing) return false;
  delete users[id];
  try {
    persist();
  } catch (err) {
    users[id] = existing;
    throw err;
  }
  return true;
}

// Compatibility wrapper: delete by display name.
export function deleteUser(name: string): boolean {
  const u = getUserByName(name);
  if (!u) return false;
  return deleteUserById(u.id);
}

// Update an existing user's mutable fields. `name` change is allowed
// post-migration: the storage key is `id`, so a rename is purely a
// display-string change and sessions/agents/cronjobs referencing this
// user by id are unaffected. Case-insensitive uniqueness is still
// enforced on rename to avoid two users with the same effective name.
export function updateUserById(
  id: string,
  changes: Partial<
    Pick<
      UserRecord,
      | "name"
      | "notifRooms"
      | "envFile"
      | "allowedRooms"
      | "hidden"
      | "order"
      | "memberPrompt"
      | "avatarColor"
      | "avatarVariant"
      | "language"
      | "slideMode"
    >
  > & { allowedRooms?: string[] },
): { ok: true; user: UserRecord } | { ok: false; error: string } {
  load();
  const existing = users[id];
  if (!existing) return { ok: false, error: `User id=${id} not found` };

  let nextName = existing.name;
  if (changes.name !== undefined) {
    const trimmed = String(changes.name).trim();
    if (!trimmed) return { ok: false, error: "Name cannot be empty" };
    // Case-insensitive collision check against OTHER users (case-only
    // changes to the same user pass through; the existing record is
    // skipped in the comparison).
    const newKey = lowercaseKey(trimmed);
    for (const u of Object.values(users)) {
      if (u.id === id) continue;
      if (lowercaseKey(u.name) === newKey) {
        return { ok: false, error: `User "${trimmed}" already exists` };
      }
    }
    nextName = trimmed;
  }

  const next: UserRecord = {
    id: existing.id,
    name: nextName,
    notifRooms:
      changes.notifRooms !== undefined
        ? normalizeNotifRooms(changes.notifRooms)
        : existing.notifRooms,
    envFile:
      changes.envFile !== undefined
        ? changes.envFile && String(changes.envFile).trim()
          ? String(changes.envFile).trim()
          : null
        : existing.envFile,
    createdAt: existing.createdAt,
    // Role is not in the editable-via-update_user surface - it's set by
    // setUserRoleById (CLI/admin path) or by claimUser on creation.
    // Preserve existing role here so updating preferences doesn't
    // silently downgrade an owner to member.
    role: existing.role,
    allowedRooms:
      changes.allowedRooms !== undefined
        ? normalizeAllowedRooms(changes.allowedRooms)
        : existing.allowedRooms,
    // View prefs (Phase 3b): writable by SERVER-SIDE callers via updateUserById
    // (the slice-3 owner-access migration; the slice-4 view.* routes), but NOT
    // exposed on the client update_user wire (that command omits hidden/order),
    // so a client cannot set them through here. Preserve when absent.
    hidden:
      changes.hidden !== undefined
        ? normalizeRoomIdList(changes.hidden)
        : existing.hidden,
    order:
      changes.order !== undefined
        ? normalizeRoomIdList(changes.order)
        : existing.order,
    memberPrompt:
      changes.memberPrompt !== undefined
        ? normalizeMemberPrompt(changes.memberPrompt)
        : existing.memberPrompt,
    avatarColor:
      changes.avatarColor !== undefined
        ? normalizeAvatarColor(changes.avatarColor, existing.id)
        : existing.avatarColor,
    avatarVariant:
      changes.avatarVariant !== undefined
        ? normalizeAvatarVariant(changes.avatarVariant)
        : existing.avatarVariant,
    // Personal preferences: writable only by the self-scoped
    // PUT /api/me/preferences path (the client update_user wire omits them),
    // same posture as the view prefs above. Preserve when absent.
    language:
      changes.language !== undefined
        ? normalizeLanguage(changes.language)
        : existing.language,
    slideMode:
      changes.slideMode !== undefined
        ? normalizeSlideMode(changes.slideMode)
        : existing.slideMode,
  };

  users[id] = next;
  try {
    persist();
  } catch (err) {
    users[id] = existing;
    throw err;
  }
  return { ok: true, user: next };
}

// Walk every user record and remove any roomIds from allowedRooms /
// notifRooms that aren't in the supplied set of currently-valid room
// ids. Persisted in one write if anything was touched. Used at boot
// to clean up references to rooms that were closed in an earlier
// process before the close_room handler began pruning user records
// inline. Returns the count of users whose records changed.
export function pruneStaleRoomRefs(validRoomIds: string[]): number {
  load();
  const validSet = new Set(validRoomIds);
  let touched = 0;
  for (const key of Object.keys(users)) {
    const u = users[key];
    const newAllowed = u.allowedRooms.filter((id) => validSet.has(id));
    const newNotif = u.notifRooms.filter((id) => validSet.has(id));
    if (
      newAllowed.length !== u.allowedRooms.length ||
      newNotif.length !== u.notifRooms.length
    ) {
      users[key] = {
        ...u,
        allowedRooms: newAllowed,
        notifRooms: newNotif,
      };
      touched++;
    }
  }
  if (touched > 0) {
    persist();
  }
  return touched;
}

// Compatibility wrapper for the WS dispatch path which still passes
// display name. Resolves to id via case-insensitive lookup, then
// delegates.
export function updateUser(
  name: string,
  changes: Partial<
    Pick<
      UserRecord,
      | "name"
      | "notifRooms"
      | "envFile"
      | "allowedRooms"
      | "memberPrompt"
      | "avatarColor"
      | "avatarVariant"
    >
  > & { allowedRooms?: string[] },
): { ok: true; user: UserRecord } | { ok: false; error: string } {
  const existing = getUserByName(name);
  if (!existing) return { ok: false, error: `User ${name} not found` };
  return updateUserById(existing.id, changes);
}
