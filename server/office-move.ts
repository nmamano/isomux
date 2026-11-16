// Moving an office to another machine (task 78733adf; design:
// internal-docs/office-move-design.md). This module is the old office's
// side of the pairing: the move code, the state file and its transitions.
//
// States of the old office (absent file = RUNNING):
//   "code"   - an owner minted a move code; the new box has 1 h to redeem it.
//   "paired" - the new box redeemed the code and holds a move session (24 h).
//   "move"   - the new box locked the office for the move (MOVE lock,
//              server/move-locked-office.ts). Nothing expires in "move": only
//              the cancel by code ends it.
//   "moved"  - the new office confirmed a complete, checked copy (slice 2a).
//              Terminal: the cancel by code needs confirmMoved.
// Expiry drops "code" and "paired" only (the auto-unlock of the plan: nothing
// is locked in those states).
//
// Pure over a state root, no module state (like server/lockdown.ts), so the
// running office, the MOVE-locked server and the tests share it.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { readLockState, ROOT_MARKER_DIR } from "./lockdown.ts";
import { CALVER_RELEASE_RE } from "./version.ts";

/** The state file in the state root (0600). It holds the code key and the
 *  session hash: the backup and the rescue export leave it out. */
export const MOVE_STATE_FILE = "office-move.json";
/** Written by the lock before the state "move", deleted by the cancel by
 *  code (N1): an unreadable state file with this marker still boots the
 *  MOVE-locked server. */
export const MOVE_LOCK_MARKER = "move-locked";
/** Written by the cancel by code before the state file is deleted. At boot
 *  it means "cancelled", even when the state file is still there. */
export const MOVE_CANCELLED_FILE = "move-cancelled.json";
/** The prefix of a move code. */
/** The new office's move-in state, in its state root (slice 2b). */
export const MOVE_IN_STATE_FILE = "office-move-in.json";
/** The folder under the office user's home that holds a move-in (the
 *  stage, the manifest). */
export const MOVE_IN_DIR = ".isomux-move-in";
export const MOVE_CODE_PREFIX = "isomux-move-1.";
/** How long the new box has to redeem a code. */
export const MOVE_CODE_TTL_MS = 60 * 60_000;
/** How long a pairing lives in "paired". */
export const MOVE_SESSION_TTL_MS = 24 * 60 * 60_000;
/** How long after it finished a preflight can back a lock. */
export const MOVE_PREFLIGHT_FRESH_MS = 15 * 60_000;

/** What each box tells the other about itself at the redeem. */
export interface MoveBoxInfo {
  /** The CalVer release tag when the checkout is at one, else null. */
  release: string | null;
  commit: string | null;
  /** The office user's home directory. */
  homePath: string;
  /** The office's state root, absolute (slice 2b). Both boxes refuse a move
   *  when it is not inside the home, not its own realpath, or differs. */
  stateRoot: string;
}

interface MoveStateBase {
  /** sha256 (hex) of the code's token. */
  tokenHash: string;
  /** The code's AEAD key, base64url (slice 2 seals the batches with it). */
  key: string;
  /** The origin the code carries. */
  origin: string;
  /** Epoch ms. */
  mintedAt: number;
  /** Epoch ms after which the code cannot be redeemed. */
  redeemBy: number;
  /** Who minted it: the member's name. */
  by: string;
}

export interface MoveStateCode extends MoveStateBase {
  state: "code";
}

export interface MoveStatePaired extends MoveStateBase {
  state: "paired";
  /** sha256 (hex) of the move session. */
  sessionHash: string;
  pairedAt: number;
  sessionExpiresAt: number;
  newBox: MoveBoxInfo;
}

export interface MoveStateMove extends Omit<MoveStatePaired, "state"> {
  state: "move";
  lockedAt: number;
  /** The preflight the owner agreed to. */
  preflightId: string;
  /** Epoch ms of the first batch served (slice 2a): from then on the new
   *  office may hold a copy. */
  servedAt?: number;
}

/** The new office confirmed a complete, checked copy (slice 2a). Terminal:
 *  only the cancel by code with confirmMoved ends it. */
export interface MoveStateMoved extends Omit<MoveStateMove, "state"> {
  state: "moved";
  doneAt: number;
  manifestId: string;
  /** The new office's origin (an http(s) origin, nothing more). */
  newOrigin: string;
}

export type MoveState =
  MoveStateCode | MoveStatePaired | MoveStateMove | MoveStateMoved;

export interface MintedMoveCode {
  code: string;
  origin: string;
  /** Epoch ms. */
  expiresAt: number;
  /** True when the origin is a loopback address another box cannot reach.
   *  A warning only. */
  loopbackOrigin: boolean;
}

/** Writes a new "code" state (replacing a "code" one) and returns the code.
 *  Throws MoveStateError("move_paired") in "paired" or "move". */
export function mintMoveCode(
  stateRoot: string,
  input: { origin: string; by: string; now: Date },
): MintedMoveCode {
  const { current } = readMoveState(stateRoot, input.now);
  if (current && current.state !== "code")
    throw new MoveStateError(
      "move_paired",
      "A new office is already paired with this one. Cancel that move first.",
    );
  const token = randomBytes(32).toString("base64url");
  const key = randomBytes(32).toString("base64url");
  const mintedAt = input.now.getTime();
  const state: MoveStateCode = {
    state: "code",
    tokenHash: sha256(token),
    key,
    origin: input.origin,
    mintedAt,
    redeemBy: mintedAt + MOVE_CODE_TTL_MS,
    by: input.by,
  };
  writeMoveState(stateRoot, state);
  const body = Buffer.from(
    JSON.stringify({ o: input.origin, t: token, k: key }),
  ).toString("base64url");
  return {
    code: `${MOVE_CODE_PREFIX}${body}`,
    origin: input.origin,
    expiresAt: state.redeemBy,
    loopbackOrigin: isLoopbackOrigin(input.origin),
  };
}

function isLoopbackOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "::1" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

export function parseMoveCode(
  code: string,
): { origin: string; token: string; key: string } | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(MOVE_CODE_PREFIX)) return null;
  try {
    const raw: unknown = JSON.parse(
      Buffer.from(trimmed.slice(MOVE_CODE_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    );
    if (!raw || typeof raw !== "object") return null;
    const { o, t, k } = raw as Record<string, unknown>;
    if (typeof o !== "string" || typeof t !== "string" || typeof k !== "string")
      return null;
    if (!o || !t || !k) return null;
    return { origin: o, token: t, key: k };
  } catch {
    return null;
  }
}

export interface MoveStateReading {
  /** The state now, after expiry; null = RUNNING. */
  current: MoveState | null;
  /** The state this read dropped because it expired ("code" or "paired"),
   *  so the caller can audit it; null when nothing expired. */
  dropped: MoveState | null;
}

/** Reads the state file and drops an expired "code" or "paired" state
 *  (deletes the file). A "move" state never expires. An unreadable file
 *  reads as no state and stays, so nothing guesses over it. */
export function readMoveState(stateRoot: string, now: Date): MoveStateReading {
  const state = readStateFile(stateRoot);
  if (!state) return { current: null, dropped: null };
  const t = now.getTime();
  const expired =
    (state.state === "code" && t > state.redeemBy) ||
    (state.state === "paired" && t > state.sessionExpiresAt);
  if (!expired) return { current: state, dropped: null };
  rmSync(join(stateRoot, MOVE_STATE_FILE), { force: true });
  return { current: null, dropped: state };
}

function readStateFile(stateRoot: string): MoveState | null {
  const path = join(stateRoot, MOVE_STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const s = raw as Record<string, unknown>;
    if (
      (s.state !== "code" &&
        s.state !== "paired" &&
        s.state !== "move" &&
        s.state !== "moved") ||
      typeof s.tokenHash !== "string" ||
      typeof s.key !== "string" ||
      typeof s.redeemBy !== "number"
    )
      return null;
    if (
      s.state !== "code" &&
      (typeof s.sessionHash !== "string" ||
        typeof s.sessionExpiresAt !== "number")
    )
      return null;
    return raw as MoveState;
  } catch (err) {
    console.error("[move] the move state file is unreadable:", err);
    return null;
  }
}

function writeMoveState(stateRoot: string, state: MoveState): void {
  const path = join(stateRoot, MOVE_STATE_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function hashEquals(hexA: string, hexB: string): boolean {
  const a = Buffer.from(hexA, "hex");
  const b = Buffer.from(hexB, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** Why a redeem is refused after a valid token (the code is not used up). */
export type MoveRedeemRefusal =
  | "home_path_differs"
  | "release_older"
  | "release_unknown"
  /** Slice 2b: a state root outside the home, or not its own realpath. */
  | "state_root_outside_home"
  | "state_root_differs";

export type RedeemMoveResult =
  | {
      ok: true;
      /** The move session, base64url; only its hash is stored. */
      session: string;
      sessionExpiresAt: number;
      office: MoveBoxInfo;
    }
  /** One answer for an unknown, expired or used token: no oracle. */
  | { ok: false; status: 403; error: "move_code_invalid" }
  /** Shown only to a valid token holder; does not use up the code. */
  | {
      ok: false;
      status: 409;
      error: MoveRedeemRefusal;
      ours: MoveBoxInfo;
      theirs: MoveBoxInfo;
    };

const CODE_INVALID = {
  ok: false,
  status: 403,
  error: "move_code_invalid",
} as const;

/** The redeem: checks the token first, then the refusals, then pairs. */
export function redeemMoveCode(
  stateRoot: string,
  input: {
    token: string;
    newBox: MoveBoxInfo;
    ours: MoveBoxInfo;
    /** This box's own state root on disk (moveStateRootRefusal), checked by
     *  the caller; told only to a valid token holder. */
    oursOnDisk?: MoveRedeemRefusal | null;
    now: Date;
  },
): RedeemMoveResult {
  const { current } = readMoveState(stateRoot, input.now);
  if (
    !current ||
    current.state !== "code" ||
    !hashEquals(sha256(input.token), current.tokenHash)
  )
    return CODE_INVALID;
  const refusal: MoveRedeemRefusal | null =
    input.newBox.homePath !== input.ours.homePath
      ? "home_path_differs"
      : (moveStateRootPathRefusal(input.ours) ??
        input.oursOnDisk ??
        (input.newBox.stateRoot !== input.ours.stateRoot
          ? "state_root_differs"
          : moveReleaseRefusal(input.ours, input.newBox)));
  if (refusal)
    return {
      ok: false,
      status: 409,
      error: refusal,
      ours: input.ours,
      theirs: input.newBox,
    };
  const session = randomBytes(32).toString("base64url");
  const pairedAt = input.now.getTime();
  const paired: MoveStatePaired = {
    ...current,
    state: "paired",
    sessionHash: sha256(session),
    pairedAt,
    sessionExpiresAt: pairedAt + MOVE_SESSION_TTL_MS,
    newBox: {
      release: input.newBox.release,
      commit: input.newBox.commit,
      homePath: input.newBox.homePath,
      stateRoot: input.newBox.stateRoot,
    },
  };
  writeMoveState(stateRoot, paired);
  return {
    ok: true,
    session,
    sessionExpiresAt: paired.sessionExpiresAt,
    office: input.ours,
  };
}

/** A state root that is not inside the home, by the paths alone. */
export function moveStateRootPathRefusal(
  box: MoveBoxInfo,
): "state_root_outside_home" | null {
  const rel = relative(box.homePath, box.stateRoot);
  return !box.stateRoot ||
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
    ? "state_root_outside_home"
    : null;
}

/** A state root the walk would not enter: outside the home, or not the
 *  real folder at its place in the home (~/.isomux as a link: the walk lists
 *  a link and moves no office data). Reads the disk. A home reached through
 *  a link is fine. */
export function moveStateRootRefusal(
  box: MoveBoxInfo,
): "state_root_outside_home" | null {
  if (moveStateRootPathRefusal(box)) return "state_root_outside_home";
  try {
    const expected = join(
      realpathSync(box.homePath),
      relative(box.homePath, box.stateRoot),
    );
    return realpathSync(box.stateRoot) === expected
      ? null
      : "state_root_outside_home";
  } catch {
    return "state_root_outside_home";
  }
}

/** Why the new box's release cannot take this office, or null. Both CalVer
 *  releases: refused when the new one is older. Otherwise the commits must
 *  be equal. */
export function moveReleaseRefusal(
  ours: MoveBoxInfo,
  theirs: MoveBoxInfo,
): "release_older" | "release_unknown" | null {
  const isRelease = (r: string | null): r is string =>
    r !== null && CALVER_RELEASE_RE.test(r);
  if (isRelease(ours.release) && isRelease(theirs.release))
    return compareCalver(theirs.release, ours.release) < 0
      ? "release_older"
      : null;
  if (ours.commit && theirs.commit && ours.commit === theirs.commit)
    return null;
  return "release_unknown";
}

// CalVer order, as numbers: v2026.11.9 < v2026.11.12 < v2026.11.12.2.
function compareCalver(a: string, b: string): number {
  const parse = (t: string) =>
    t
      .slice(1)
      .split(".")
      .map((n) => parseInt(n, 10));
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The state a move session opens: "paired" (not expired) or "move"; null
 *  for a missing, wrong or expired session. `authorization` is the raw
 *  Authorization header value. */
export function checkMoveSession(
  stateRoot: string,
  authorization: string | null,
  now: Date,
): MoveStatePaired | MoveStateMove | MoveStateMoved | null {
  const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization?.trim() ?? "");
  if (!m) return null;
  // Reads without dropping: the caller's readMoveState drops and audits an
  // expired pairing.
  const current = readStateFile(stateRoot);
  if (!current || current.state === "code") return null;
  if (current.state === "paired" && now.getTime() > current.sessionExpiresAt)
    return null;
  return hashEquals(sha256(m[1]), current.sessionHash) ? current : null;
}

/** "paired" -> "move". Throws MoveStateError("not_paired") otherwise. */
export function markMoveLocked(
  stateRoot: string,
  input: { preflightId: string; now: Date },
): MoveStateMove {
  const { current } = readMoveState(stateRoot, input.now);
  if (!current || current.state !== "paired")
    throw new MoveStateError("not_paired", "No new office is paired.");
  const moved: MoveStateMove = {
    ...current,
    state: "move",
    lockedAt: input.now.getTime(),
    preflightId: input.preflightId,
  };
  // The marker first (N1): an unreadable state file with it still boots
  // locked.
  writeFileSync(join(stateRoot, MOVE_LOCK_MARKER), "", { mode: 0o600 });
  writeMoveState(stateRoot, moved);
  return moved;
}

/** Records the first batch served ("move" only; later calls keep the first
 *  time). Returns true when this call set it (the caller audits
 *  office.movePulled once). */
export function markMoveServed(stateRoot: string, now: Date): boolean {
  const current = readStateFile(stateRoot);
  if (!current || current.state !== "move" || current.servedAt !== undefined)
    return false;
  writeMoveState(stateRoot, { ...current, servedAt: now.getTime() });
  return true;
}

/** "move" -> "moved". `newOrigin` must already be a bare http(s) origin
 *  (moveOriginFrom). Throws MoveStateError("not_locked") otherwise. */
export function markMoveDone(
  stateRoot: string,
  input: { manifestId: string; newOrigin: string; now: Date },
): MoveStateMoved {
  const current = readStateFile(stateRoot);
  if (!current || current.state !== "move")
    throw new MoveStateError(
      "not_locked",
      "The office is not locked for the move.",
    );
  const done: MoveStateMoved = {
    ...current,
    state: "moved",
    doneAt: input.now.getTime(),
    manifestId: input.manifestId,
    newOrigin: input.newOrigin,
  };
  writeMoveState(stateRoot, done);
  return done;
}

/** The http(s) origin of a URL the new office sends, or null for anything
 *  else. */
export function moveOriginFrom(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin;
}

/** The owner's cancel in "code" or "paired": deletes the state file and
 *  returns the state it ended; null when there was none. Throws
 *  MoveStateError("move_locked") in "move" (only the cancel by code ends a
 *  move). */
export function cancelMove(stateRoot: string, now: Date): MoveState | null {
  const { current } = readMoveState(stateRoot, now);
  if (!current) return null;
  if (current.state === "move" || current.state === "moved")
    throw new MoveStateError(
      "move_locked",
      "The office is locked for the move. Only the move code ends it.",
    );
  rmSync(join(stateRoot, MOVE_STATE_FILE), { force: true });
  return current;
}

/** The cancel by code in "move" or "moved": a code whose token hash matches
 *  writes MOVE_CANCELLED_FILE, then deletes the state file and the lock
 *  marker. Returns false (and changes nothing) for a wrong code or another
 *  state. A record that cannot be written throws, and the move stays. The
 *  route asks for confirmMoved in "moved" before it calls this. */
export function cancelMoveByCode(
  stateRoot: string,
  code: string,
  now: Date,
): boolean {
  const parts = parseMoveCode(code);
  if (!parts) return false;
  const { current } = readMoveState(stateRoot, now);
  if (!current || (current.state !== "move" && current.state !== "moved"))
    return false;
  if (!hashEquals(sha256(parts.token), current.tokenHash)) return false;
  const path = join(stateRoot, MOVE_CANCELLED_FILE);
  writeFileSync(path, `${JSON.stringify({ at: now.toISOString() })}\n`, {
    mode: 0o600,
  });
  rmSync(join(stateRoot, MOVE_STATE_FILE), { force: true });
  rmSync(join(stateRoot, MOVE_LOCK_MARKER), { force: true });
  return true;
}

/** The cancel record, or null. An unreadable record still counts as a
 *  cancel, with no time. */
export function readMoveCancelled(stateRoot: string): { at: string } | null {
  const path = join(stateRoot, MOVE_CANCELLED_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const at = (raw as { at?: unknown } | null)?.at;
    return { at: typeof at === "string" ? at : "" };
  } catch {
    return { at: "" };
  }
}

/** Deletes the cancel record (the normal boot, after its audit row). */
export function clearMoveCancelled(stateRoot: string): void {
  rmSync(join(stateRoot, MOVE_CANCELLED_FILE), {
    force: true,
    recursive: true,
  });
}

/** A security lockdown wins over a move: deletes the state file (code, key
 *  and session) and the lock marker. The units record stays, so the
 *  unlock's normal boot restores the units. Returns whether a state file was
 *  deleted. */
export function killMoveForLockdown(stateRoot: string): boolean {
  rmSync(join(stateRoot, MOVE_LOCK_MARKER), { force: true });
  const path = join(stateRoot, MOVE_STATE_FILE);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** How this process boots. "lockdown" when a lock marker locks it (it wins);
 *  else "move" when the state is "move" or "moved" and no cancel record
 *  exists, or when the state file does not read and the move's lock marker
 *  is there (N1); else "normal". A cancel record deletes a state file and a
 *  marker still there (a crash between the cancel steps). */
export function moveBootMode(
  stateRoot: string,
  opts: { rootMarkerDir?: string } = {},
): "lockdown" | "move" | "normal" {
  if (readLockState(stateRoot, opts.rootMarkerDir ?? ROOT_MARKER_DIR).locked)
    return "lockdown";
  if (existsSync(join(stateRoot, MOVE_CANCELLED_FILE))) {
    rmSync(join(stateRoot, MOVE_STATE_FILE), { force: true });
    rmSync(join(stateRoot, MOVE_LOCK_MARKER), { force: true });
    return "normal";
  }
  const state = readStateFile(stateRoot);
  if (state)
    return state.state === "move" || state.state === "moved"
      ? "move"
      : "normal";
  // N1: a state file that does not read, with the lock marker, stays locked.
  return existsSync(join(stateRoot, MOVE_STATE_FILE)) &&
    existsSync(join(stateRoot, MOVE_LOCK_MARKER))
    ? "move"
    : "normal";
}

/** The largest body a public move route reads. */
export const MOVE_BODY_MAX_BYTES = 64 * 1024;

/** A public move route's body as text, or null over `maxBytes` (default
 *  MOVE_BODY_MAX_BYTES; by Content-Length, or while it streams in), so a
 *  caller without a code cannot make the office hold a big body. */
export async function readMoveBody(
  req: Request,
  maxBytes = MOVE_BODY_MAX_BYTES,
): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class MoveStateError extends Error {
  constructor(
    readonly code: "move_paired" | "not_paired" | "move_locked" | "not_locked",
    message: string,
  ) {
    super(message);
    this.name = "MoveStateError";
  }
}
