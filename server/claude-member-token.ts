// The Claude token for members with their own OS user
// (internal-docs/member-os-user-design.md, section 1.6, slice 4a). An
// isolated member's agents never get the office's Claude account folder: on
// the fallback to the office sign-in they keep their own CLAUDE_CONFIG_DIR
// and get this token as CLAUDE_CODE_OAUTH_TOKEN. The owner makes it once
// with `claude setup-token`; it runs inference only and lasts a year.
//
// The file is in the secret store's folder, so the agent read policy refuses
// it and backups and office moves leave it out, as they do the secret store
// (the store reads only its own files there). After a restore, the owner
// sets it again. A lock does not move it aside: it is no way into the
// office, as the office's own Claude sign-in is not.

import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";

export const MEMBER_TOKEN_FILE = "claude-member-token.json";
// Claude's long-lived tokens last one year.
export const TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const TOKEN_MIN = 20;
const TOKEN_MAX = 4096;
// Printable ASCII, no whitespace.
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MemberTokenRecord {
  token: string;
  // When the owner made it (epoch ms, the start of that day in UTC).
  madeAt: number;
  // Also the token's generation: a session that started with another one
  // (or with none) restarts at its next turn.
  setAt: number;
}

export interface MemberTokenStatus {
  set: boolean;
  madeAt?: number;
  expiresAt?: number;
}

export function memberTokenPath(stateRoot: string = STATE_ROOT): string {
  return join(stateRoot, "secrets", MEMBER_TOKEN_FILE);
}

// Why `token` cannot be the token, or null. Loose on purpose: a wrong token
// is caught at its first turn.
export function memberTokenRefusal(token: unknown): string | null {
  if (typeof token !== "string") return "the token must be text";
  if (token.length < TOKEN_MIN || token.length > TOKEN_MAX)
    return "the token has the wrong length";
  if (!TOKEN_SHAPE.test(token))
    return "the token has a space or a character it cannot have";
  return null;
}

// The day the token was made, as epoch ms: today when not given; never in
// the future or over a year ago.
export function madeAtFrom(value: unknown, now: number): number | string {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  if (value === undefined || value === null || value === "") return today;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return "the date must be YYYY-MM-DD";
  const at = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(at)) return "the date must be YYYY-MM-DD";
  if (at > today) return "the date is in the future";
  if (at <= today - TOKEN_LIFETIME_MS) return "a token made then has expired";
  return at;
}

function parse(text: string): MemberTokenRecord | null {
  try {
    const value = JSON.parse(text) as Partial<MemberTokenRecord>;
    if (
      memberTokenRefusal(value.token) === null &&
      Number.isSafeInteger(value.madeAt) &&
      Number.isSafeInteger(value.setAt) &&
      (value.setAt as number) > 0
    )
      return value as MemberTokenRecord;
  } catch {}
  return null;
}

export function createMemberTokenStore(
  stateRoot: string = STATE_ROOT,
  onChange: () => void = () => {},
) {
  const path = memberTokenPath(stateRoot);
  let cached: MemberTokenRecord | null | undefined;

  function load(): MemberTokenRecord | null {
    if (cached !== undefined) return cached;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      cached = null;
      return null;
    }
    cached = parse(text);
    if (!cached)
      console.error(
        `[claude-member-token] ${path} does not read; members with their own OS user get no Claude fallback until an owner sets the token again`,
      );
    return cached;
  }

  return {
    get(): MemberTokenRecord | null {
      return load();
    },
    // The generation a session starts with: 0 when no token is set.
    generation(): number {
      return load()?.setAt ?? 0;
    },
    status(): MemberTokenStatus {
      const record = load();
      return record
        ? {
            set: true,
            madeAt: record.madeAt,
            expiresAt: record.madeAt + TOKEN_LIFETIME_MS,
          }
        : { set: false };
    },
    set(token: string, madeAt: number, now: number): void {
      // A set in the same millisecond as the last one is still new.
      const setAt = Math.max(now, (load()?.setAt ?? 0) + 1);
      const record: MemberTokenRecord = { token, madeAt, setAt };
      const dir = join(stateRoot, "secrets");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      atomicWriteFileSync(path, `${JSON.stringify(record)}\n`, 0o600);
      cached = record;
      onChange();
    },
    clear(): void {
      rmSync(path, { force: true });
      cached = null;
      onChange();
    },
  };
}

export type MemberTokenStore = ReturnType<typeof createMemberTokenStore>;

let store: MemberTokenStore | null = null;
let changed: () => void = () => {};

// The office's store. `onChange` (the server's redaction update) runs at
// each set and clear.
export function memberTokenStore(): MemberTokenStore {
  return (store ??= createMemberTokenStore(STATE_ROOT, () => changed()));
}

export function onMemberTokenChange(fn: () => void): void {
  changed = fn;
}

let rejectedHook: () => void = () => {};

// The server's page to the owners (claude-member-token-pager.ts).
export function onMemberTokenRejected(fn: () => void): void {
  rejectedHook = fn;
}

// Claude asked for a sign-in on a turn that ran on the token: it no longer
// works. Never throws.
export function memberTokenRejected(): void {
  try {
    rejectedHook();
  } catch (error) {
    console.error("[claude-member-token] the page could not be raised:", error);
  }
}

// The token an env carries for an isolated member's Claude fallback: its
// generation when it is the stored one, else undefined.
export function memberTokenGenerationIn(
  env: { [key: string]: string | undefined } | undefined,
  tokens: MemberTokenStore = memberTokenStore(),
): number | undefined {
  const record = tokens.get();
  return record && env?.CLAUDE_CODE_OAUTH_TOKEN === record.token
    ? record.setAt
    : undefined;
}
