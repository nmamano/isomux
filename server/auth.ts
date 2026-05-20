// Invite + cookie-session auth. State lives in two flat files alongside the
// rest of ~/.isomux/. Both are touched under a single in-process mutex so
// invite acceptance (mark-consumed + upsert-user + create-session) cannot
// interleave with concurrent acceptances of the same token.
//
// Threat model and the security stance for each primitive are documented at
// the relevant operation; if you change any of these comments, double-check
// the security checklist in the auth-core task before declaring done.

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import type {
  UserRole,
  UserRecord,
  InviteWire,
  SessionWire,
  SessionContext,
} from "../shared/types.ts";
import { atomicWriteFileSync } from "./persistence.ts";
import { normalizePublicOrigin } from "../shared/public-origin.ts";
import { lowercaseKey } from "../shared/identity.ts";
import {
  claimUser,
  deleteUserById,
  getUserById,
  getUserByName,
  hasOwner,
  setUserRoleById,
  updateUserById,
} from "./users.ts";

// Injected by server/index.ts at boot. New owners need a snapshot of
// every current room id as their initial allowedRooms (the strict
// string[] model has no "all" sentinel, so "owners see every room" has
// to be materialized at creation time). auth.ts is intentionally kept
// free of agent-manager dependencies; the provider sidesteps a cycle.
let roomsSnapshotProvider: (() => string[]) | null = null;
export function setRoomsSnapshotProvider(fn: () => string[]): void {
  roomsSnapshotProvider = fn;
}
function snapshotRoomIds(): string[] {
  return roomsSnapshotProvider ? roomsSnapshotProvider() : [];
}

// ---------------------------------------------------------------------------
// File layout

const ISOMUX_DIR = join(homedir(), ".isomux");
const INVITES_FILE = join(ISOMUX_DIR, "invites.json");
const SESSIONS_FILE = join(ISOMUX_DIR, "sessions.json");

// ---------------------------------------------------------------------------
// On-disk record shapes (hashed). Raw tokens never persist.

interface StoredInvite {
  tokenHash: string; // sha256(rawToken) hex; the map key duplicates this for convenience
  tokenPrefix: string; // first 8 chars of the raw base64url token, kept clear for UI
  username: string | null; // null only for bootstrap invites
  role: UserRole;
  createdBy: string | null; // null for bootstrap
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  consumedAt: number | null;
  bootstrap: boolean;
}

interface StoredSession {
  sessionIdHash: string; // sha256(rawSessionId) hex
  sessionPrefix: string; // first 8 chars of the raw base64url id, kept clear for UI
  // Stable user identity. `userId` is authoritative for who owns the
  // session; the display name is resolved from the user record at
  // validation time, so a rename flows through to all in-flight sessions
  // automatically. Legacy on-disk sessions carry `username` instead; the
  // loader resolves them to userId via getUserByName.
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  userAgent: string | null;
}

// ---------------------------------------------------------------------------
// In-process state. Loaded once on first call; mutated under `mutate()`.

let invites: Map<string, StoredInvite> | null = null;
let sessions: Map<string, StoredSession> | null = null;

// Mutex: a chain of promises. Each `mutate` awaits the previous link before
// running, so concurrent invite acceptances and revocations serialize. The
// chain lives at module scope so it survives across the call sites we care
// about (HTTP handlers, WS handlers, bootstrap).
let mutexTail: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = mutexTail.then(() => fn());
  // Swallow errors on the tail so a thrown caller doesn't poison the chain.
  mutexTail = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Load / persist

function loadInvitesFromDisk(): Map<string, StoredInvite> {
  const map = new Map<string, StoredInvite>();
  try {
    if (!existsSync(INVITES_FILE)) return map;
    const raw = readFileSync(INVITES_FILE, "utf-8");
    if (!raw.trim()) return map;
    const parsed = JSON.parse(raw) as Record<string, StoredInvite>;
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v.tokenHash !== "string") continue;
      map.set(k, v);
    }
  } catch (err) {
    console.error("Failed to load invites.json:", err);
  }
  return map;
}

// True once loadSessionsFromDisk has migrated at least one session out of
// the legacy `username` schema. ensureLoaded() observes this and forces a
// persist on the first call so the upgraded shape sticks on disk; without
// it the migration logic would run every boot (idempotent but noisy in
// logs and disk-traffic on busy servers).
let sessionsNeedsPersist = false;

function loadSessionsFromDisk(): Map<string, StoredSession> {
  const map = new Map<string, StoredSession>();
  try {
    if (!existsSync(SESSIONS_FILE)) return map;
    const raw = readFileSync(SESSIONS_FILE, "utf-8");
    if (!raw.trim()) return map;
    // Legacy sessions carried `username` as the identity field; new
    // sessions carry `userId`. The loader migrates the legacy shape by
    // resolving username → user.id via getUserByName, and evicts any
    // session whose username no longer matches a known user.
    type AnySession = Partial<StoredSession> & {
      username?: string;
    };
    const parsed = JSON.parse(raw) as Record<string, AnySession>;
    let migrated = 0;
    let evicted = 0;
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v.sessionIdHash !== "string") continue;
      if (typeof v.userId === "string" && v.userId) {
        // Already in new shape. Strip any stale username field defensively.
        map.set(k, {
          sessionIdHash: v.sessionIdHash,
          sessionPrefix: v.sessionPrefix ?? "",
          userId: v.userId,
          createdAt: v.createdAt ?? Date.now(),
          lastSeenAt: v.lastSeenAt ?? Date.now(),
          expiresAt: v.expiresAt ?? 0,
          absoluteExpiresAt: v.absoluteExpiresAt ?? 0,
          userAgent: v.userAgent ?? null,
        });
        continue;
      }
      if (typeof v.username !== "string") continue;
      const owner = getUserByName(v.username);
      if (!owner) {
        evicted++;
        console.log(
          `[migration] evicting session ${v.sessionPrefix ?? "?"}… (username="${v.username}" no longer maps to a user record)`,
        );
        continue;
      }
      map.set(k, {
        sessionIdHash: v.sessionIdHash,
        sessionPrefix: v.sessionPrefix ?? "",
        userId: owner.id,
        createdAt: v.createdAt ?? Date.now(),
        lastSeenAt: v.lastSeenAt ?? Date.now(),
        expiresAt: v.expiresAt ?? 0,
        absoluteExpiresAt: v.absoluteExpiresAt ?? 0,
        userAgent: v.userAgent ?? null,
      });
      migrated++;
    }
    if (migrated || evicted) {
      console.log(
        `[migration] sessions: migrated ${migrated} to userId, evicted ${evicted} orphans`,
      );
      sessionsNeedsPersist = true;
    }
  } catch (err) {
    console.error("Failed to load sessions.json:", err);
  }
  return map;
}

// Auth state mutations must surface persistence failures to the caller so
// the caller can roll back in-memory state. Swallowing here would let
// accept/mint/revoke report success while disk diverges from memory — on
// the next restart the user would be locked out (consumed invite + lost
// session) or able to reuse a "revoked" invite.
function persistInvites() {
  if (!invites) return;
  const obj: Record<string, StoredInvite> = {};
  for (const [k, v] of invites) obj[k] = v;
  atomicWriteFileSync(INVITES_FILE, JSON.stringify(obj, null, 2));
}

function persistSessions() {
  if (!sessions) return;
  const obj: Record<string, StoredSession> = {};
  for (const [k, v] of sessions) obj[k] = v;
  atomicWriteFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
}

function ensureLoaded() {
  if (invites === null) invites = loadInvitesFromDisk();
  if (sessions === null) {
    sessions = loadSessionsFromDisk();
    // If the loader migrated any sessions out of the legacy `username`
    // schema, force a persist now so disk picks up the upgraded shape
    // and the next boot doesn't re-run the same migration.
    if (sessionsNeedsPersist) {
      sessionsNeedsPersist = false;
      try {
        persistSessions();
      } catch (err) {
        console.error("[migration] post-load sessions persist failed:", err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Hooks for the dispatcher to be notified of acceptance events. Used so
// index.ts can broadcast updated invite/session lists to owner WSes when
// an invite is consumed via HTTP (which never touches the WS dispatch
// path and therefore wouldn't otherwise trigger a fan-out). Defaults to
// no-op so auth.ts stays standalone; index.ts overrides at boot.

let onInviteConsumedHook: () => void = () => {};

export function setOnInviteConsumed(cb: () => void): void {
  onInviteConsumedHook = cb;
}

// Fired whenever the active-sessions set changes via server-initiated
// invalidation: revoke, logout, evict-after-delete, hot-path expiry,
// hot-path orphan cleanup. The dispatcher wires this to broadcast a
// fresh sessions_active_list to owners so their AccessPane sessions
// table stays current without each call site having to remember.
// Mirrors setOnInviteConsumed; bare signal because the broadcast fans
// out the full filtered list via listActiveSessions().
let onSessionsChangedHook: () => void = () => {};

export function setOnSessionsChanged(cb: () => void): void {
  onSessionsChangedHook = cb;
}

// Wrap the broadcast call so a hook exception (network, serialization)
// cannot fail the auth mutation that triggered it. Logs and continues.
function fireSessionsChangedHook(): void {
  try {
    onSessionsChangedHook();
  } catch (err) {
    console.error("[auth] onSessionsChangedHook threw:", err);
  }
}

// ---------------------------------------------------------------------------
// Token / hashing primitives

const TOKEN_BYTES = 32; // 256 bits of entropy
const PREFIX_LEN = 8;

function randomToken(): { raw: string; hash: string; prefix: string } {
  const buf = randomBytes(TOKEN_BYTES);
  const raw = buf.toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash, prefix: raw.slice(0, PREFIX_LEN) };
}

function hashOf(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// Constant-time hex string compare. Inputs must be the same length, which
// they are here (sha256 hex = 64 chars). Guards against timing side channels
// during the Map.get → compare path.
function safeHashEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------------------------------------------------------------------
// WS registry: sessionIdHash → sockets currently authenticated with that
// session. Populated at upgrade; cleared at close. Used to force-close on
// revoke so the WS doesn't keep pumping messages until the next client send.

// `send` is optional so test doubles can register a minimal stub; the real
// caller (Bun's ServerWebSocket) provides both. The notify-before-close
// contract below relies on it when present.
type ClosableSocket = { send?: (data: string) => void; close: () => void };
const wsBySession = new Map<string, Set<ClosableSocket>>();

export function registerSocket(sessionIdHash: string, ws: ClosableSocket) {
  let set = wsBySession.get(sessionIdHash);
  if (!set) {
    set = new Set();
    wsBySession.set(sessionIdHash, set);
  }
  set.add(ws);
}

export function unregisterSocket(sessionIdHash: string, ws: ClosableSocket) {
  const set = wsBySession.get(sessionIdHash);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) wsBySession.delete(sessionIdHash);
}

// Notify-then-close contract for server-initiated session invalidation:
// revoke, logout, expiry, orphan-after-user-delete. The client's WS
// onclose handler (ui/ws.ts) blindly retries on close, so closing without
// `session_expired` first leaves the browser in a 2s reconnect loop
// against a 401-returning upgrade. Sending the message first lets the
// store's reload-to-login effect (ui/store.tsx) take over instead.
// Both operations are best-effort: a send on a closing socket may throw,
// a close on an already-closed socket is benign.
function forceExpireSocketsForSession(sessionIdHash: string) {
  const set = wsBySession.get(sessionIdHash);
  if (!set) return;
  for (const ws of set) {
    try {
      ws.send?.(JSON.stringify({ type: "session_expired" }));
    } catch {}
    try {
      ws.close();
    } catch {}
  }
  wsBySession.delete(sessionIdHash);
}

// ---------------------------------------------------------------------------
// Bootstrap: mint an owner-tagged invite on server start when no owner exists.

// Invite acceptance window. 24h, fixed for the standard invite paths
// (bootstrap, owner-issued via mint_invite). Invite URLs are bearer
// tokens; the shorter the acceptance window, the smaller the exposure
// in browser history, the delivery channel, and disk-restorable
// backups. 24h covers every realistic delivery-to-click scenario;
// longer windows trade real security for marginal convenience the
// per-username `replacePriorForUsername` flow already covers (the
// operator can mint a fresh invite if the first one expires).
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
// Member self-invite (mint_self_invite) is deliberately tighter than
// the standard 24h. The use case is "I'm at my laptop, I want to add
// my phone right now" — both devices are physically with the member
// and the link is intended to be clicked within seconds. A 1h window
// is more than enough for the legitimate flow and shrinks the
// bearer-URL exposure window by 24x compared to the standard TTL.
const SELF_INVITE_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Mint / accept / revoke invites

export interface MintOptions {
  username: string | null; // null only allowed for bootstrap path internally
  role: UserRole;
  createdBy: string | null;
  allowExisting: boolean;
  bootstrap?: boolean;
  // Member self-invite path: revoke any other outstanding (unconsumed,
  // unexpired) invite bound to the same username in the same mutation, so
  // each member only ever has one active self-invite. Atomic with the new
  // mint so a concurrent caller can't see both the old and new at once.
  replacePriorForUsername?: boolean;
  // Override the default TTL. Used by the admin-socket recovery handler
  // (shell access + immediate hand-off to a browser, so a 15min window is
  // both tight enough to be safe and loose enough for the device switch).
  // Not exposed on the WS wire; the WS paths stick to INVITE_TTL_MS /
  // SELF_INVITE_TTL_MS so a misbehaving client can't shorten or lengthen
  // tokens it issues to third parties.
  ttlMsOverride?: number;
}

export interface MintResult {
  ok: true;
  rawToken: string;
  invite: StoredInvite;
}
export interface MintErr {
  ok: false;
  error: string;
  code: "INVALID_USERNAME" | "USER_EXISTS" | "INVALID_ROLE" | "ROLE_MISMATCH";
}

// Invite TTL is the acceptance window: the URL stops being redeemable
// after this many ms. Standard invite paths (bootstrap, owner-issued
// via mint_invite) use INVITE_TTL_MS; member self-invite uses the
// tighter SELF_INVITE_TTL_MS. There is no per-invite knob in either
// path. Session lifetime (the cookie's rolling/absolute expiry) is
// governed separately at acceptance time — see acceptInvite — and is
// intentionally not coupled to invite TTL.

export async function mintInvite(
  opts: MintOptions,
): Promise<MintResult | MintErr> {
  return mutate(() => {
    ensureLoaded();
    const trimmedName = opts.username?.trim() ?? null;
    if (!opts.bootstrap) {
      if (!trimmedName)
        return {
          ok: false,
          error: "Username required",
          code: "INVALID_USERNAME",
        };
      if (opts.role !== "owner" && opts.role !== "member")
        return { ok: false, error: "Invalid role", code: "INVALID_ROLE" };
      const existing = getUserByName(trimmedName);
      if (existing && !opts.allowExisting)
        return {
          ok: false,
          error: `User "${existing.name}" already exists. Use allowExisting to issue an additional invite for them.`,
          code: "USER_EXISTS",
        };
      if (existing && existing.role !== opts.role)
        return {
          ok: false,
          error: `Invite role (${opts.role}) does not match existing user role (${existing.role}). Change the user's role first.`,
          code: "ROLE_MISMATCH",
        };
    }

    // Member self-invite path: remove any outstanding (unconsumed,
    // unexpired) invites bound to the same username before inserting the
    // new one, so the "1 active self-invite per member" rule is enforced
    // atomically with the mint.
    const removedKeys: string[] = [];
    const removedSnapshots: StoredInvite[] = [];
    if (opts.replacePriorForUsername && trimmedName) {
      const target = lowercaseKey(trimmedName);
      const now0 = Date.now();
      for (const [k, v] of invites!) {
        if (v.consumed) continue;
        if (v.expiresAt < now0) continue;
        if (!v.username || lowercaseKey(v.username) !== target) continue;
        removedKeys.push(k);
        removedSnapshots.push(v);
      }
      for (const k of removedKeys) invites!.delete(k);
    }

    const { raw, hash, prefix } = randomToken();
    const now = Date.now();
    const invite: StoredInvite = {
      tokenHash: hash,
      tokenPrefix: prefix,
      username: trimmedName,
      role: opts.role,
      createdBy: opts.createdBy,
      createdAt: now,
      // TTL selection. ttlMsOverride wins (admin-socket recovery path
      // uses this for a 15min window). Otherwise the self-invite marker
      // (replacePriorForUsername — set only by mint_self_invite, which
      // doesn't accept the override field on the wire) picks the
      // tighter 1h TTL; everything else uses the standard 24h.
      expiresAt:
        now +
        (opts.ttlMsOverride !== undefined
          ? opts.ttlMsOverride
          : opts.replacePriorForUsername
            ? SELF_INVITE_TTL_MS
            : INVITE_TTL_MS),
      consumed: false,
      consumedAt: null,
      bootstrap: !!opts.bootstrap,
    };
    invites!.set(hash, invite);
    try {
      persistInvites();
    } catch (err) {
      invites!.delete(hash);
      // Roll back the replace-prior deletions too, so a persist failure
      // leaves disk + memory in the pre-mint state.
      for (let i = 0; i < removedKeys.length; i++) {
        invites!.set(removedKeys[i], removedSnapshots[i]);
      }
      throw err;
    }
    return { ok: true, rawToken: raw, invite };
  });
}

// Look up an invite without consuming it. Used by GET /i/<token> so link
// previewers / chat unfurlers / browser prefetch don't burn the one-time
// invite — actual consumption happens on the subsequent POST.
export interface InvitePeek {
  needsName: boolean; // true for bootstrap or otherwise null-username invites
  username: string | null;
  role: UserRole;
  bootstrap: boolean;
}
export function peekInvite(
  rawToken: string,
):
  | InvitePeek
  | { error: "not_found" | "consumed" | "expired" | "owner_exists" } {
  ensureLoaded();
  if (!rawToken) return { error: "not_found" };
  const hash = hashOf(rawToken);
  const invite = invites!.get(hash);
  if (!invite) return { error: "not_found" };
  if (!safeHashEq(invite.tokenHash, hash)) return { error: "not_found" };
  if (invite.consumed) return { error: "consumed" };
  if (invite.expiresAt < Date.now()) return { error: "expired" };
  // Render the same stale-invite error the accept path would. peekInvite
  // doesn't take the mutex; acceptInvite is the authoritative gate. This
  // check is for UX, not safety.
  if (invite.bootstrap && hasOwner()) return { error: "owner_exists" };
  return {
    needsName: invite.username === null,
    username: invite.username,
    role: invite.role,
    bootstrap: invite.bootstrap,
  };
}

export interface AcceptOk {
  ok: true;
  rawSessionId: string;
  expiresAt: number;
  absoluteExpiresAt: number;
  username: string;
  role: UserRole;
  isBootstrap: boolean;
  inviteNeedsName: boolean;
}
export interface AcceptErr {
  ok: false;
  error:
    | "not_found"
    | "consumed"
    | "expired"
    | "needs_name"
    | "invalid_name"
    | "role_mismatch"
    | "owner_exists";
}

// Mark every still-unconsumed bootstrap invite as consumed. Called after a
// successful bootstrap accept (siblings are now stale) and when an accept is
// refused because an owner exists (the invite itself is stale). Best-effort:
// a persist failure is logged but doesn't abort the caller, since the
// hasOwner() recheck in acceptInvite still catches any survivor.
function markAllUnconsumedBootstrapInvitesConsumed(): void {
  const stale: StoredInvite[] = [];
  for (const inv of invites!.values()) {
    if (inv.bootstrap && !inv.consumed) stale.push(inv);
  }
  if (stale.length === 0) return;
  const now = Date.now();
  for (const inv of stale) {
    inv.consumed = true;
    inv.consumedAt = now;
  }
  try {
    persistInvites();
  } catch (err) {
    for (const inv of stale) {
      inv.consumed = false;
      inv.consumedAt = null;
    }
    console.error(
      `[auth] failed to sweep ${stale.length} stale bootstrap invite(s); they will be retried on the next owner-creating accept`,
      err,
    );
  }
}

// Owner-creation core used by both the tokenless claim form (claimOwnership)
// and the legacy bootstrap-invite acceptance path (acceptInvite bootstrap
// branch). Mutates user state so the named user becomes an owner with full
// allowedRooms, then returns the resulting user record alongside a
// `rollback` closure that restores the prior state.
//
// The caller MUST invoke rollback if any subsequent persistence step
// (invite-consumed write, session create+persist) throws. Without rollback,
// a partial failure can leave the office with an owner record but no
// session: hasOwner() returns true, the claim form disappears, and
// acceptInvite's mutex-held owner_exists guard refuses a retry. Rollback
// closes that stranded-office state.
//
// For a new user, rollback deletes the just-created record. For an
// existing user being promoted, rollback restores the prior role and
// allowedRooms. If rollback's own disk writes fail, the helper logs a
// catastrophic-state message and propagates nothing further (the original
// error is what the caller is already rethrowing).
function commitBootstrapOwnerUser(chosenName: string): {
  user: UserRecord;
  rollback: () => void;
} {
  const existing = getUserByName(chosenName);
  if (!existing) {
    const created = claimUser(chosenName, {
      role: "owner",
      allowedRooms: snapshotRoomIds(),
    });
    const createdId = created.id;
    return {
      user: created,
      rollback: () => {
        try {
          deleteUserById(createdId);
        } catch (err) {
          console.error(
            `[auth] catastrophic: bootstrap rollback could not delete just-created user ${createdId}; the office is now stranded with an owner record but no session. Once the underlying disk issue is fixed, try the owner-login recovery CLI ('bun run server/index.ts owner-login --name <chosen-name>') against the running server; if the partial record is malformed (e.g. missing fields after a half-write), remove ${createdId} from users.json by hand and re-open the claim form.`,
            err,
          );
        }
      },
    };
  }
  // Existing user — snapshot the prior state and build a single rollback
  // closure BEFORE any mutation. Every post-allowedRooms failure path
  // (setUserRoleById throws, the getUserById sanity check finds the row
  // gone, or the caller hits a downstream persist failure and invokes
  // rollback explicitly) reuses the same closure. Unconditional restore
  // is idempotent: setUserRoleById back to prevRole is a no-op if role
  // never changed; updateUserById allowedRooms back to prevAllowedRooms
  // is a no-op if the snapshot equals the prior. If a rollback's own
  // disk writes fail we log catastrophic and let the original error
  // propagate.
  const prevRole = existing.role;
  const prevAllowedRooms = [...existing.allowedRooms];
  const userId = existing.id;
  const restorePriorState = () => {
    try {
      setUserRoleById(userId, prevRole);
    } catch (err) {
      console.error(
        `[auth] bootstrap rollback: setUserRoleById restore to ${prevRole} threw for ${userId}`,
        err,
      );
    }
    try {
      const rr = updateUserById(userId, { allowedRooms: prevAllowedRooms });
      if (!rr.ok) {
        console.error(
          `[auth] bootstrap rollback: allowedRooms restore returned not-ok for ${userId}: ${rr.error}`,
        );
      }
    } catch (err) {
      console.error(
        `[auth] bootstrap rollback: allowedRooms restore threw for ${userId}`,
        err,
      );
    }
  };

  // allowedRooms first (idempotent on identical input), role second. If
  // the allowedRooms write returns not-ok or throws, the user is unchanged
  // on disk so we propagate without invoking rollback.
  const snapshot = snapshotRoomIds();
  const r = updateUserById(userId, { allowedRooms: snapshot });
  if (!r.ok) {
    throw new Error(
      `bootstrap owner promotion: allowedRooms write failed for ${existing.name}: ${r.error}`,
    );
  }
  if (existing.role !== "owner") {
    try {
      setUserRoleById(userId, "owner");
    } catch (err) {
      restorePriorState();
      throw err;
    }
  }
  const updated = getUserById(userId);
  if (!updated) {
    // Unreachable today (the auth mutex serializes everything that could
    // delete this record), but if the mutex contract ever loosens, this
    // is where a stranded role/allowedRooms write would land. Roll the
    // mutation back before throwing.
    restorePriorState();
    throw new Error(
      `bootstrap owner promotion: user ${userId} vanished mid-flow; rolled allowedRooms/role back to prior state`,
    );
  }
  return {
    user: updated,
    rollback: restorePriorState,
  };
}

// Accept an invite token. If the invite has a pre-set username, that username
// is bound to the new session. If the invite is a bootstrap invite, the
// caller must supply `chosenName` (the only path where invitees pick their
// own display name).
export async function acceptInvite(
  rawToken: string,
  ctx: { userAgent: string | null; chosenName?: string | null },
): Promise<AcceptOk | AcceptErr> {
  return mutate(() => {
    ensureLoaded();
    const hash = hashOf(rawToken);
    const invite = invites!.get(hash);
    if (!invite) return { ok: false, error: "not_found" };
    // Constant-time check to guard against any path where the Map.get had
    // accepted via prefix matching in the future.
    if (!safeHashEq(invite.tokenHash, hash))
      return { ok: false, error: "not_found" };
    if (invite.consumed) return { ok: false, error: "consumed" };
    if (invite.expiresAt < Date.now()) return { ok: false, error: "expired" };

    // Bootstrap invites are stale the moment an owner exists. Rechecked
    // under the mutex so concurrent acceptances serialize: if a sibling
    // bootstrap accept just minted an owner, this one fails closed. Sweep
    // all unconsumed bootstrap invites in the same mutation so the next
    // attempt sees them as `consumed` rather than retracing this check.
    if (invite.bootstrap && hasOwner()) {
      markAllUnconsumedBootstrapInvitesConsumed();
      return { ok: false, error: "owner_exists" };
    }

    // Bootstrap path: invitee picks the display name on this request.
    let chosenName: string | null = invite.username;
    if (invite.username === null) {
      const raw = (ctx.chosenName ?? "").trim();
      if (!raw) return { ok: false, error: "needs_name" };
      // Cheap shape check; mirrors the constraints implicit elsewhere in the
      // codebase (display names sent to other agents, used as map keys, etc).
      if (raw.length > 64) return { ok: false, error: "invalid_name" };
      if (!/^[\p{L}\p{N} ._'-]+$/u.test(raw))
        return { ok: false, error: "invalid_name" };
      chosenName = raw;
    } else {
      const existing = getUserByName(invite.username);
      if (existing && existing.role !== invite.role)
        return { ok: false, error: "role_mismatch" };
    }
    if (!chosenName) return { ok: false, error: "invalid_name" };

    // Idempotent upsert of user record. The role-preservation rule applies
    // to *member* invites: accepting one for an existing user must not flip
    // their role. Bootstrap is the one exception — it's the first-owner
    // recovery / pre-auth-migration path. If no owner exists and a
    // bootstrap invite is being accepted, promote the chosen user (creating
    // them if needed, or promoting an existing pre-auth member record).
    //
    // For the bootstrap branch we capture a rollback closure from
    // commitBootstrapOwnerUser. Without it, a downstream persist failure
    // (invite-consumed write or session create+persist) would leave the
    // office with an owner record but no session, and the Step-1
    // owner_exists guard would block recovery on retry.
    let userRecord = getUserByName(chosenName);
    let bootstrapRollback: (() => void) | null = null;
    if (invite.bootstrap) {
      const committed = commitBootstrapOwnerUser(chosenName);
      userRecord = committed.user;
      bootstrapRollback = committed.rollback;
    } else if (!userRecord) {
      // Owner invites seed the new owner with every current room id;
      // member invites land on the [] default, leaving the new member
      // with no rooms visible until an owner grants access or they
      // create their own.
      userRecord = claimUser(chosenName, {
        role: invite.role,
        ...(invite.role === "owner" ? { allowedRooms: snapshotRoomIds() } : {}),
      });
    }

    // Create the session. Identity is the stable user.id; the username
    // field on the wire is derived at validate time from the live user
    // record, so a later rename flows through automatically.
    const { raw: rawSessionId, hash: sessionHash, prefix } = randomToken();
    const now = Date.now();
    const rollingTtlMs = 30 * 24 * 60 * 60 * 1000;
    // Session absolute cap is 1 year. This is a deliberate
    // usability/security trade-off: the cookie carries HttpOnly,
    // SameSite=Lax, Secure-on-HTTPS, host-only scope, and a
    // per-message server-side recheck that propagates a revoke
    // within ~1s, so the residual risk of a long session is
    // dominated by shared-device scenarios where the user forgot to
    // sign out (covered in the security audit's external-access
    // analysis under "session lifetime on shared devices"). The
    // 30-day rolling refresh still evicts truly idle sessions long
    // before the absolute cap fires; the absolute cap exists as a
    // hard upper bound for sessions kept warm by continued use.
    const absoluteTtlMs = 365 * 24 * 60 * 60 * 1000;
    const session: StoredSession = {
      sessionIdHash: sessionHash,
      sessionPrefix: prefix,
      userId: userRecord.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + rollingTtlMs,
      absoluteExpiresAt: now + absoluteTtlMs,
      userAgent: ctx.userAgent,
    };

    // Fail-closed ordering: persist the invite-consumed flag BEFORE the
    // session. If we issued a cookie but the invite stayed live, the
    // bearer URL would still be redeemable for a second session — the
    // worse failure mode. The downside of this ordering is that on a rare
    // mid-flow disk failure the invite ends up consumed without a session
    // having been created (the user re-clicks and sees 410); we accept
    // that UX cost to preserve the one-time-bearer guarantee.
    const prevConsumed = invite.consumed;
    invite.consumed = true;
    invite.consumedAt = now;
    try {
      persistInvites();
    } catch (err) {
      invite.consumed = prevConsumed;
      invite.consumedAt = null;
      // Roll back the bootstrap user mutation too (created owner or
      // promoted member). Without this, a persist failure here would
      // strand the office with an owner on disk and no session.
      if (bootstrapRollback) bootstrapRollback();
      throw err;
    }
    sessions!.set(sessionHash, session);
    try {
      persistSessions();
    } catch (err) {
      // Session-persist failure: roll the session out of memory AND roll
      // the invite back to unconsumed so the user can retry. If the
      // invite-revert write also fails we have a permanently-consumed
      // invite with no usable session — catastrophic but isolated: log
      // loudly, propagate to the caller, the user sees 500 and the owner
      // mints a fresh invite.
      sessions!.delete(sessionHash);
      invite.consumed = prevConsumed;
      invite.consumedAt = null;
      try {
        persistInvites();
      } catch (revertErr) {
        console.error(
          "[auth] catastrophic: invite consumed on disk but session " +
            "persist + revert both failed; this invite is now permanently " +
            "unusable. Mint a replacement.",
          err,
          revertErr,
        );
      }
      // Bootstrap owner rollback fires regardless of the invite-revert
      // outcome — the office state on disk must not be left with an
      // owner record but no session.
      if (bootstrapRollback) bootstrapRollback();
      throw err;
    }

    // Fire the post-accept hook so the dispatcher in index.ts can fan an
    // updated invite/session list out to owner WSes. Without this, a
    // browser that minted the invite while a *separate* browser opens
    // /auth/accept would never see its Access pane refresh — that flow
    // doesn't touch the WS dispatch path and was the gap in the
    // earlier "real-time invites" fix (which only covered reconnect).
    try {
      onInviteConsumedHook();
    } catch (err) {
      console.error("[auth] onInviteConsumedHook threw:", err);
    }

    // Sweep any sibling bootstrap invites now that this office has an owner.
    if (invite.bootstrap) {
      markAllUnconsumedBootstrapInvitesConsumed();
    }

    return {
      ok: true,
      rawSessionId,
      expiresAt: session.expiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      username: userRecord.name,
      role: userRecord.role,
      isBootstrap: invite.bootstrap,
      inviteNeedsName: invite.username === null,
    };
  });
}

export interface ClaimOk {
  ok: true;
  rawSessionId: string;
  expiresAt: number;
  absoluteExpiresAt: number;
  username: string;
}
export interface ClaimErr {
  ok: false;
  error: "owner_exists" | "needs_name" | "invalid_name";
}

// Tokenless owner-claim used by the pre-claim form at GET /. The caller is
// responsible for the locality guarantee (the server binds 127.0.0.1
// pre-claim, plus a peer-IP loopback check and a strict same-origin check
// on the POST); this function is only the auth-state mutation under the
// mutex. hasOwner() is rechecked inside the mutex so concurrent claim
// attempts serialize and the second one fails closed with owner_exists.
export async function claimOwnership(
  rawChosenName: string,
  ctx: { userAgent: string | null },
): Promise<ClaimOk | ClaimErr> {
  return mutate(() => {
    ensureLoaded();
    if (hasOwner()) {
      // Clear any pre-redesign bootstrap invite rows that might still
      // sit in invites.json; the office is claimed so they're stale.
      markAllUnconsumedBootstrapInvitesConsumed();
      return { ok: false, error: "owner_exists" };
    }
    const chosenName = rawChosenName.trim();
    if (!chosenName) return { ok: false, error: "needs_name" };
    if (chosenName.length > 64) return { ok: false, error: "invalid_name" };
    if (!/^[\p{L}\p{N} ._'-]+$/u.test(chosenName))
      return { ok: false, error: "invalid_name" };

    // Owner-creation via the shared helper. Returns a rollback closure
    // that's invoked if the session create+persist below throws — without
    // it, a session-persist failure would leave the office with an owner
    // record but no session, and the mutex-held owner_exists guard would
    // block recovery on retry.
    const { user: userRecord, rollback } =
      commitBootstrapOwnerUser(chosenName);

    const { raw: rawSessionId, hash: sessionHash, prefix } = randomToken();
    const now = Date.now();
    const rollingTtlMs = 30 * 24 * 60 * 60 * 1000;
    const absoluteTtlMs = 365 * 24 * 60 * 60 * 1000;
    const session: StoredSession = {
      sessionIdHash: sessionHash,
      sessionPrefix: prefix,
      userId: userRecord.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + rollingTtlMs,
      absoluteExpiresAt: now + absoluteTtlMs,
      userAgent: ctx.userAgent,
    };
    sessions!.set(sessionHash, session);
    try {
      persistSessions();
    } catch (err) {
      sessions!.delete(sessionHash);
      rollback();
      throw err;
    }

    // Sweep any leftover unconsumed bootstrap invites from prior versions
    // now that this office has an owner. Best-effort.
    markAllUnconsumedBootstrapInvitesConsumed();

    return {
      ok: true,
      rawSessionId,
      expiresAt: session.expiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      username: userRecord.name,
    };
  });
}

export type RevokeResult = "ok" | "not_found" | "ambiguous";

// Find at most two matching rows; if more than one matches the same display
// prefix we refuse to revoke either, so an extremely unlikely 8-char prefix
// collision can't silently target the wrong record. The owner UI surfaces
// the ambiguous outcome so they can copy a longer identifier (not yet
// exposed in V1; for now they'd see "ambiguous" and need to mint a new one
// or wait for natural expiry).
export async function revokeInviteByPrefix(
  prefix: string,
): Promise<RevokeResult> {
  return mutate(() => {
    ensureLoaded();
    const matches: string[] = [];
    for (const [k, v] of invites!) {
      if (v.tokenPrefix === prefix) matches.push(k);
      if (matches.length > 1) break;
    }
    if (matches.length === 0) return "not_found";
    if (matches.length > 1) return "ambiguous";
    const k = matches[0];
    const prev = invites!.get(k)!;
    invites!.delete(k);
    try {
      persistInvites();
    } catch (err) {
      invites!.set(k, prev);
      throw err;
    }
    return "ok";
  });
}

export async function revokeSessionByPrefix(
  prefix: string,
): Promise<RevokeResult> {
  return mutate(() => {
    ensureLoaded();
    const matches: string[] = [];
    for (const [k, v] of sessions!) {
      if (v.sessionPrefix === prefix) matches.push(k);
      if (matches.length > 1) break;
    }
    if (matches.length === 0) return "not_found";
    if (matches.length > 1) return "ambiguous";
    const hash = matches[0];
    const prev = sessions!.get(hash)!;
    sessions!.delete(hash);
    try {
      persistSessions();
    } catch (err) {
      sessions!.set(hash, prev);
      throw err;
    }
    forceExpireSocketsForSession(hash);
    fireSessionsChangedHook();
    return "ok";
  });
}

export async function logoutBySessionHash(
  sessionIdHash: string,
): Promise<boolean> {
  return mutate(() => {
    ensureLoaded();
    const prev = sessions!.get(sessionIdHash);
    if (!prev) return false;
    sessions!.delete(sessionIdHash);
    try {
      persistSessions();
    } catch (err) {
      sessions!.set(sessionIdHash, prev);
      throw err;
    }
    forceExpireSocketsForSession(sessionIdHash);
    fireSessionsChangedHook();
    return true;
  });
}

// Evict all active sessions belonging to a user. Called by delete_user so
// the deleted user's open tabs land on the login wall instead of idling
// with an orphaned session that the per-message recheck would only catch
// on the next interaction. Each socket gets `session_expired` then close
// via forceExpireSocketsForSession.
//
// Persist-failure semantics differ from logoutBySessionHash/revokeSessionByPrefix
// on purpose: those are user-requested mutations on otherwise-valid sessions,
// so a disk write failure rolls them back and surfaces the error. Here the
// user record is already gone — leaving the in-memory sessions in place
// would preserve authority for a deleted user until next message-time
// orphan eviction. Log loudly and continue; the next validateSession on
// any reused cookie will re-evict the disk row.
export async function evictSessionsForUserId(userId: string): Promise<number> {
  return mutate(() => {
    ensureLoaded();
    const hashes: string[] = [];
    for (const [hash, s] of sessions!) {
      if (s.userId === userId) hashes.push(hash);
    }
    if (hashes.length === 0) return 0;
    for (const hash of hashes) sessions!.delete(hash);
    try {
      persistSessions();
    } catch (err) {
      console.error(
        `[auth] evictSessionsForUserId persist failed (userId=${userId}, count=${hashes.length}):`,
        err,
      );
    }
    for (const hash of hashes) forceExpireSocketsForSession(hash);
    // Fire once per batch — the broadcast replaces the whole list, so
    // per-hash firing would just be redundant fanout.
    fireSessionsChangedHook();
    return hashes.length;
  });
}

// ---------------------------------------------------------------------------
// Validation (per-request hot path: must be O(1), no IO).

export interface SessionLookup {
  sessionIdHash: string;
  // 8-char display prefix, copied from the stored session record. Sent
  // on the wire as `SessionContext.currentSessionPrefix` so the UI can
  // identify the user's own row in the Access pane sessions table.
  sessionPrefix: string;
  // Stable identity. Use this for env selection, agent ownership, and any
  // server-side authority check.
  userId: string;
  // Current display name, resolved from the user record at validation
  // time so a rename propagates without reconnect. Use for message
  // attribution, log stamping, and UI labels — anything where the value
  // is observed at the moment of the action.
  username: string;
  role: UserRole;
  needsRolling: boolean; // caller should persist a refreshed lastSeenAt+expiresAt
}

// Validate a raw session cookie value. Returns null if the cookie is missing,
// unknown, expired (rolling or absolute), or for a user whose record vanished.
// Updates lastSeenAt in memory on every hit; persistence is throttled by the
// caller (we'd hammer disk otherwise).
let lastPersist = 0;
const PERSIST_THROTTLE_MS = 30_000; // re-persist lastSeenAt at most every 30s

export function validateSession(
  rawCookie: string | null,
): SessionLookup | null {
  if (!rawCookie) return null;
  ensureLoaded();
  const hash = hashOf(rawCookie);
  return validateByHash(hash);
}

// Per-message recheck path. WS handlers cache the session hash at upgrade and
// re-validate by hash on every message; this avoids reconstructing the
// (now-discarded) raw cookie and is identical to validateSession otherwise.
export function revalidateByHash(sessionIdHash: string): SessionLookup | null {
  ensureLoaded();
  return validateByHash(sessionIdHash);
}

function validateByHash(hash: string): SessionLookup | null {
  const session = sessions!.get(hash);
  if (!session) return null;
  if (!safeHashEq(session.sessionIdHash, hash)) return null;
  const now = Date.now();
  if (session.expiresAt < now || session.absoluteExpiresAt < now) {
    sessions!.delete(hash);
    forceExpireSocketsForSession(hash);
    // Memory changed even though we don't persist here (hot-path: the
    // throttled-persist further down covers steady-state drift); the
    // owner UI still wants the row removed from its sessions table.
    fireSessionsChangedHook();
    return null;
  }
  // Resolve user by stable id. delete_user evicts active sessions
  // proactively via evictSessionsForUserId, so this branch is the
  // fallback that catches stale-cookie / stale-disk cases where the
  // user record vanished without the proactive path firing. A rename
  // flows the new display name through without disrupting the session.
  const user = getUserById(session.userId);
  if (!user) {
    // User record was removed; the session is orphaned and unsafe to honor.
    sessions!.delete(hash);
    forceExpireSocketsForSession(hash);
    fireSessionsChangedHook();
    return null;
  }
  const rollingTtlMs = 30 * 24 * 60 * 60 * 1000;
  const newExpires = Math.min(now + rollingTtlMs, session.absoluteExpiresAt);
  let needsRolling = false;
  if (newExpires > session.expiresAt + 60_000) {
    session.expiresAt = newExpires;
    needsRolling = true;
  }
  session.lastSeenAt = now;
  // Throttled rolling persist on the hot path. Failures here are non-fatal
  // (the in-memory state is the authoritative read source until restart),
  // and propagating would block validation on a disk hiccup. Log and move
  // on; the next successful write picks up the latest state.
  if (now - lastPersist > PERSIST_THROTTLE_MS) {
    lastPersist = now;
    try {
      persistSessions();
    } catch (err) {
      console.error("[auth] throttled sessions persist failed:", err);
    }
  }
  return {
    sessionIdHash: hash,
    sessionPrefix: session.sessionPrefix,
    userId: user.id,
    username: user.name,
    role: user.role,
    needsRolling,
  };
}

// ---------------------------------------------------------------------------
// Wire shapes for owner UI.

function toInviteWire(v: StoredInvite): InviteWire {
  return {
    tokenPrefix: v.tokenPrefix,
    username: v.username,
    role: v.role,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    ...(v.bootstrap ? { bootstrap: true as const } : {}),
  };
}

function toSessionWire(v: StoredSession): SessionWire {
  // Display name is derived from the user record at wire-formatting time.
  // If the user has been deleted, fall back to "(deleted)" so the row
  // still renders before the orphan-session sweeper evicts it on the
  // next request.
  const user = getUserById(v.userId);
  return {
    sessionPrefix: v.sessionPrefix,
    username: user?.name ?? "(deleted)",
    createdAt: v.createdAt,
    lastSeenAt: v.lastSeenAt,
    expiresAt: v.expiresAt,
    absoluteExpiresAt: v.absoluteExpiresAt,
    userAgent: v.userAgent,
  };
}

export function listInvites(): InviteWire[] {
  ensureLoaded();
  const now = Date.now();
  // Surface only outstanding (not consumed, not expired) invites; pruning
  // consumed rows from disk happens elsewhere if it becomes worth it.
  const result: InviteWire[] = [];
  for (const v of invites!.values()) {
    if (v.consumed) continue;
    if (v.expiresAt < now) continue;
    result.push(toInviteWire(v));
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}

// Self-scoped invite list for the member UI. Matches by lowercased
// display name (the same key the rest of the codebase uses for user
// identity in invite-binding); userId isn't stored on invites so a
// rename between mint and list will hide the row from the member's own
// view, but acceptance still binds to the recorded name. The 1-hour
// member TTL keeps that window narrow.
export function listInvitesForUsername(name: string): InviteWire[] {
  ensureLoaded();
  const now = Date.now();
  const target = lowercaseKey(name);
  const result: InviteWire[] = [];
  for (const v of invites!.values()) {
    if (v.consumed) continue;
    if (v.expiresAt < now) continue;
    if (!v.username || lowercaseKey(v.username) !== target) continue;
    result.push(toInviteWire(v));
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}

export function listActiveSessions(): SessionWire[] {
  ensureLoaded();
  const now = Date.now();
  const result: SessionWire[] = [];
  for (const v of sessions!.values()) {
    if (v.expiresAt < now || v.absoluteExpiresAt < now) continue;
    result.push(toSessionWire(v));
  }
  return result.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

// Self-scoped session list for the member UI. Filters by stable userId
// (StoredSession.userId is rename-stable) so a member can see and
// revoke their own devices without leaking other users' sessions.
export function listActiveSessionsForUserId(userId: string): SessionWire[] {
  ensureLoaded();
  const now = Date.now();
  const result: SessionWire[] = [];
  for (const v of sessions!.values()) {
    if (v.expiresAt < now || v.absoluteExpiresAt < now) continue;
    if (v.userId !== userId) continue;
    result.push(toSessionWire(v));
  }
  return result.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

// Scoped revoke: atomic find-check-delete inside one mutate() for the
// member self-revoke path. The non-scoped revokeInviteByPrefix would
// require a separate authorization read first, splitting the auth
// invariant across the mutex boundary; doing it all in one mutate keeps
// the check and the mutation atomic. Ambiguity is detected at the
// prefix level (so an astronomically unlikely collision between two
// outstanding invites refuses regardless of caller scope); a unique
// prefix that doesn't belong to the caller returns "not_found" so we
// don't reveal that another user holds that prefix.
export async function revokeOutstandingInviteByPrefixForUsername(
  prefix: string,
  username: string,
): Promise<RevokeResult> {
  return mutate(() => {
    ensureLoaded();
    const target = lowercaseKey(username);
    const now = Date.now();
    const matches: string[] = [];
    for (const [k, v] of invites!) {
      if (v.tokenPrefix !== prefix) continue;
      if (v.consumed) continue;
      if (v.expiresAt < now) continue;
      matches.push(k);
      if (matches.length > 1) break;
    }
    if (matches.length === 0) return "not_found";
    if (matches.length > 1) return "ambiguous";
    const k = matches[0];
    const row = invites!.get(k)!;
    if (!row.username || lowercaseKey(row.username) !== target) {
      return "not_found";
    }
    invites!.delete(k);
    try {
      persistInvites();
    } catch (err) {
      invites!.set(k, row);
      throw err;
    }
    return "ok";
  });
}

// Scoped session revoker. Extends RevokeResult with "would_strand_office"
// for the role-race case (caller's WS opened as a member but they've
// since been promoted to owner without reconnecting; revoking their
// session would now leave the office unreachable).
export type ScopedSessionRevokeResult = RevokeResult | "would_strand_office";

// Same atomic find-check-delete pattern as the scoped invite revoker.
// Identity is by stable userId (StoredSession.userId), so a rename does
// not affect the scope check. The lockout-prevention check runs ONLY
// after the row has been confirmed to belong to the caller — that
// ordering is load-bearing for confidentiality: running it on any
// prefix (as a precheck outside the scope test) would let a member
// probe whether a foreign prefix corresponds to the last owner
// session, since the "blocked" response would diverge from
// "not_found". Sockets bound to the revoked session are force-closed
// inside the same mutate so the disconnect cannot precede the
// persisted revoke.
export async function revokeActiveSessionByPrefixForUserId(
  prefix: string,
  userId: string,
): Promise<ScopedSessionRevokeResult> {
  return mutate(() => {
    ensureLoaded();
    const now = Date.now();
    const matches: string[] = [];
    for (const [k, v] of sessions!) {
      if (v.sessionPrefix !== prefix) continue;
      if (v.expiresAt < now || v.absoluteExpiresAt < now) continue;
      matches.push(k);
      if (matches.length > 1) break;
    }
    if (matches.length === 0) return "not_found";
    if (matches.length > 1) return "ambiguous";
    const hash = matches[0];
    const row = sessions!.get(hash)!;
    if (row.userId !== userId) return "not_found";
    // Confidentiality-critical: this check is *after* the scope test
    // so a foreign last-owner prefix can never produce a divergent
    // response. For a member whose role hasn't changed since WS open
    // it's a no-op (their session can't be owner-bearing); the check
    // exists for the in-flight promotion case.
    if (wouldRevokeLeaveOfficeUnreachable(hash)) {
      return "would_strand_office";
    }
    sessions!.delete(hash);
    try {
      persistSessions();
    } catch (err) {
      sessions!.set(hash, row);
      throw err;
    }
    forceExpireSocketsForSession(hash);
    fireSessionsChangedHook();
    return "ok";
  });
}

export function sessionContextFor(
  lookup: SessionLookup,
  connectionId: string,
): SessionContext {
  return {
    userId: lookup.userId,
    username: lookup.username,
    role: lookup.role,
    currentSessionPrefix: lookup.sessionPrefix,
    // Per-WS id (live-avatars). The caller owns the connectionId since
    // it's set at WS upgrade time; auth.ts deliberately stays agnostic
    // about the per-connection slot on WsData.
    connectionId,
  };
}

// ---------------------------------------------------------------------------
// Lockout-prevention helpers
//
// The invariant: the office must always retain at least one owner-role
// user with at least one active session, so an operator can recover
// from inside the browser. Without this, revoking the last owner's last
// session locks the office out (hasOwner() stays true, so the pre-claim
// form never reappears; only shell access can restore).
//
// Centralized here because both revoke_session and the WS/HTTP logout
// paths need to enforce it.

// Count of currently-valid sessions whose owner has role "owner".
export function countActiveOwnerSessions(): number {
  ensureLoaded();
  const now = Date.now();
  let n = 0;
  for (const s of sessions!.values()) {
    if (s.expiresAt < now || s.absoluteExpiresAt < now) continue;
    const u = getUserById(s.userId);
    if (u?.role === "owner") n++;
  }
  return n;
}

// True if revoking the given session hash would leave the office with
// zero active owner sessions. Used by both revoke_session and logout —
// they're the same operation from the lockout-prevention perspective.
export function wouldRevokeLeaveOfficeUnreachable(
  sessionIdHash: string,
): boolean {
  ensureLoaded();
  const target = sessions!.get(sessionIdHash);
  if (!target) return false; // revoking nothing can't lock anyone out
  const targetUser = getUserById(target.userId);
  if (targetUser?.role !== "owner") return false; // target isn't owner-bearing
  const now = Date.now();
  for (const [hash, s] of sessions!) {
    if (hash === sessionIdHash) continue;
    if (s.expiresAt < now || s.absoluteExpiresAt < now) continue;
    const u = getUserById(s.userId);
    if (u?.role === "owner") return false; // another active owner session exists
  }
  return true;
}

// Resolve an 8-char display prefix to a session id hash. Returns null
// when no session matches OR more than one matches (ambiguous). The
// caller treats both as "couldn't act on this prefix"; revoke_session
// already has the ambiguity log path, this just gives us the hash for
// the lockout pre-check.
export function resolveSessionHashByPrefix(prefix: string): string | null {
  ensureLoaded();
  let found: string | null = null;
  for (const [hash, s] of sessions!) {
    if (s.sessionPrefix === prefix) {
      if (found !== null) return null; // ambiguous
      found = hash;
    }
  }
  return found;
}

// Note: countOwners() and wouldDeleteLeaveNoOwner() live in users.ts.
// index.ts imports them directly from there; we don't re-export through
// auth.ts to keep the user-record predicates close to the data.

// ---------------------------------------------------------------------------
// Cookie + origin helpers used by the middleware.

export const COOKIE_NAME = "isomux_session";

// Precedence: process.env.ISOMUX_PUBLIC_ORIGIN > office-config.json's
// `publicOrigin` (registered via setPublicOriginFallback at boot) >
// localhost fallback. Both env and config are operator-authored; we never
// infer the origin from request headers. Both go through the same
// validator — a malformed env value falls through to config rather than
// poisoning the Origin allowlist with e.g. `https://host/path`.
let cachedFallbackOrigin: string | null = null;
let envEvaluated = false;
let envCachedOrigin: string | null = null;

export function setPublicOriginFallback(origin: string | null): void {
  cachedFallbackOrigin = origin;
}

function evaluateEnvOrigin(): string | null {
  if (envEvaluated) return envCachedOrigin;
  envEvaluated = true;
  const raw = process.env.ISOMUX_PUBLIC_ORIGIN?.trim();
  if (!raw) {
    envCachedOrigin = null;
    return null;
  }
  const normalized = normalizePublicOrigin(raw);
  if (!normalized) {
    console.error(
      `[auth] ISOMUX_PUBLIC_ORIGIN="${raw}" is not a valid public origin (need https://<host> or http://localhost; no path/query/fragment); ignoring`,
    );
    envCachedOrigin = null;
    return null;
  }
  envCachedOrigin = normalized;
  return normalized;
}

// Captured once at boot via freezeBootState(). Two predicates derive from
// the captured values:
//   isProcessPreClaim()     — true if this process started before any owner
//                             existed. Drives the SSH -L banner and the
//                             tokenless name-picker form.
//   isProcessBoundLoopback() — true if the OS bind is loopback-only (the
//                             pre-claim case OR the post-claim
//                             external-access-disabled case). Drives the
//                             public-origin policy: when bound loopback,
//                             buildPublicOrigin returns the localhost
//                             fallback regardless of env/JSON config so
//                             cookie attributes match the connection.
// The bind decision is locked at boot; widening the bind requires a
// restart, so the policy that follows it stays stable for the lifetime
// of the process even if hasOwner() flips after a successful claim.
let bootHadOwner: boolean | null = null;
let bootExternalAccess: boolean | null = null;

export function freezeBootState(opts: { externalAccess: boolean }): void {
  bootHadOwner = hasOwner();
  bootExternalAccess = opts.externalAccess;
}

// Auto-init safety net: if freezeBootState() wasn't called (e.g. tests
// importing auth.ts standalone), default to the strictest interpretation
// — pre-claim, loopback-only — so callers can't accidentally mint a
// Secure-flagged cookie over an HTTP connection.
function ensureBootCaptured(): void {
  if (bootHadOwner === null) bootHadOwner = hasOwner();
  if (bootExternalAccess === null) bootExternalAccess = false;
}

export function isProcessPreClaim(): boolean {
  ensureBootCaptured();
  return bootHadOwner === false;
}

export function isProcessBoundLoopback(): boolean {
  ensureBootCaptured();
  return bootHadOwner === false || bootExternalAccess !== true;
}

export function buildPublicOrigin(): {
  origin: string;
  isHttps: boolean;
  source: "env" | "config" | "localhost";
} {
  // Loopback-only bind (pre-claim, or post-claim with external access off):
  // the configured public origin can't be reached anyway, and using it here
  // would mismatch the bind: the cookie's Secure flag would be set
  // (configured origin is HTTPS) and the browser would reject the cookie on
  // the actual HTTP loopback connection. Force the localhost fallback so
  // cookie attributes, allowed-origin checks, and minted URLs all match
  // the bind. The env/JSON value re-engages on the next process boot
  // (which is when external access can be turned on and the bind widens).
  if (isProcessBoundLoopback()) {
    const fallback = `http://localhost:${process.env.PORT || "4000"}`;
    return { origin: fallback, isHttps: false, source: "localhost" };
  }
  const envOrigin = evaluateEnvOrigin();
  if (envOrigin) {
    return {
      origin: envOrigin,
      isHttps: envOrigin.startsWith("https://"),
      source: "env",
    };
  }
  if (cachedFallbackOrigin) {
    return {
      origin: cachedFallbackOrigin,
      isHttps: cachedFallbackOrigin.startsWith("https://"),
      source: "config",
    };
  }
  const fallback = `http://localhost:${process.env.PORT || "4000"}`;
  return { origin: fallback, isHttps: false, source: "localhost" };
}

// Build the Set-Cookie header value. Caller picks Max-Age (we anchor to the
// absolute cap so the cookie naturally expires when the session can't be
// rolled any further).
export function setCookieHeader(
  rawSessionId: string,
  absoluteExpiresAt: number,
): string {
  const { isHttps } = buildPublicOrigin();
  const maxAgeSec = Math.max(
    0,
    Math.floor((absoluteExpiresAt - Date.now()) / 1000),
  );
  const attrs = [
    `${COOKIE_NAME}=${rawSessionId}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${maxAgeSec}`,
  ];
  if (isHttps) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookieHeader(): string {
  const { isHttps } = buildPublicOrigin();
  const attrs = [
    `${COOKIE_NAME}=`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=0`,
  ];
  if (isHttps) attrs.push("Secure");
  return attrs.join("; ");
}

// Parse the `Cookie` request header and return the raw session cookie value,
// or null if absent. Multi-cookie strings ("a=1; b=2") parsed without bringing
// in a dependency.
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (name !== COOKIE_NAME) continue;
    const value = part.slice(idx + 1).trim();
    return value || null;
  }
  return null;
}

// Echoing-prevention: don't allow log lines to leak raw cookies/tokens. The
// auth code never logs raw values; this helper just gives a safe printable
// for debug paths.
export function safePrefix(rawToken: string): string {
  return rawToken.slice(0, PREFIX_LEN);
}

// ---------------------------------------------------------------------------
// Test helpers (NOT exposed via routes; only callable from in-process tests).
// Exists because the auth-core task explicitly forbids a runtime no-auth
// bypass — tests exercise the real path through this helper.

export interface TestSeedResult {
  rawToken: string;
  rawSessionId: string;
  username: string;
  role: UserRole;
}

export async function _testSeedOwner(
  displayName: string,
): Promise<TestSeedResult> {
  const m = await mintInvite({
    username: null,
    role: "owner",
    createdBy: null,
    allowExisting: false,
    bootstrap: true,
  });
  if (!m.ok) throw new Error(`seed: mint failed: ${m.error}`);
  const a = await acceptInvite(m.rawToken, {
    userAgent: "test",
    chosenName: displayName,
  });
  if (!a.ok) throw new Error(`seed: accept failed: ${a.error}`);
  return {
    rawToken: m.rawToken,
    rawSessionId: a.rawSessionId,
    username: a.username,
    role: a.role,
  };
}

// Wipe both maps; intended for tests only. Does not touch disk.
export function _testResetState() {
  invites = new Map();
  sessions = new Map();
  wsBySession.clear();
}
